import {
  getWorkspaceTree,
  listWorkspacePath,
  readWorkspaceFiles,
  writeWorkspaceFiles
} from "./fs.mjs";
import { runWorkspaceCommand } from "./commands.mjs";
import { parseJsonFromText } from "../utils/json-output.mjs";
import { throwIfAborted } from "../utils/abort.mjs";

const MAX_TOOL_TURNS = 8;
const WORKSPACE_TOOL_SCHEMA_LINES = [
  'Tool schema 1: {"action":"list_files","path":"relative/path","reason":"string"}',
  'Tool schema 2: {"action":"read_files","paths":["relative/path"],"reason":"string"}',
  'Tool schema 3: {"action":"write_files","files":[{"path":"relative/path","content":"string"}],"reason":"string"}',
  'Tool schema 4: {"action":"run_command","command":"string","args":["string"],"cwd":"relative/path","reason":"string"}',
  'Final schema: {"action":"final","thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"confidence":"low|medium|high","followUps":["string"],"generatedFiles":["relative/path"],"verificationStatus":"not_applicable|passed|failed"}'
];

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean).map((item) => String(item))));
}

function renderWorkspaceTree(lines) {
  return lines.length ? lines.join("\n") : "(workspace is empty)";
}

function renderToolHistory(history) {
  if (!history.length) {
    return "[]";
  }

  return JSON.stringify(history, null, 2);
}

function normalizeVerificationStatus(value, fallback = "not_applicable") {
  const normalized = String(value || "").trim();
  if (["not_applicable", "passed", "failed"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function buildRuntimeWorkerIdentity(worker) {
  return {
    agentId: worker.runtimeId || worker.id,
    agentLabel: worker.displayLabel || worker.label || worker.id,
    agentKind: worker.agentKind || "leader",
    parentAgentId: worker.parentAgentId || "",
    parentAgentLabel: worker.parentAgentLabel || "",
    modelId: worker.id,
    modelLabel: worker.label || worker.id
  };
}

function buildWorkspaceWorkerPrompt({
  originalTask,
  clusterPlan,
  worker,
  task,
  dependencyOutputs,
  workspaceRoot,
  workspaceTreeLines,
  toolHistory
}) {
  return {
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      "You can directly inspect and modify files inside the configured workspace root.",
      `Web search is ${worker.webSearch ? "available" : "not available"} for this model.`,
      "Stay scoped to the assigned task, and read files before editing existing code when needed.",
      "If current public facts or source verification are required and web search is available, use it before finalizing claims.",
      "For search-heavy research, prefer a smaller fully verified batch over a larger unverified list.",
      "Never invent sources, URLs, examples, or case studies.",
      "Never reference or request paths outside the workspace root.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      ...WORKSPACE_TOOL_SCHEMA_LINES
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Workspace root:\n${workspaceRoot}`,
      `Workspace tree snapshot:\n${renderWorkspaceTree(workspaceTreeLines)}`,
      `Tool history:\n${renderToolHistory(toolHistory)}`
    ].join("\n\n")
  };
}

function normalizeWorkspaceFinalResult(parsed, rawText, generatedFiles, history) {
  const commandHistory = history.filter((entry) => entry.action === "run_command");
  const verifiedGeneratedFiles = uniqueStrings(generatedFiles);
  return {
    thinkingSummary: String(parsed?.thinkingSummary || ""),
    summary: String(parsed?.summary || rawText || "No summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    risks: safeArray(parsed?.risks),
    deliverables: safeArray(parsed?.deliverables),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    followUps: safeArray(parsed?.followUps),
    generatedFiles: uniqueStrings([...(parsed?.generatedFiles || []), ...verifiedGeneratedFiles]),
    verifiedGeneratedFiles,
    workspaceActions: history.map((entry) => entry.action),
    verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus),
    executedCommands: commandHistory.map((entry) =>
      [entry.request.command, ...(entry.request.args || [])].join(" ").trim()
    )
  };
}

function createToolError(message, rawText) {
  return {
    thinkingSummary: "",
    summary: `Workspace tool loop failed: ${message}`,
    keyFindings: rawText ? [rawText.slice(0, 2000)] : [],
    risks: [message],
    deliverables: [],
    confidence: "low",
    followUps: ["Adjust the task or simplify the requested file changes."],
    generatedFiles: [],
    verifiedGeneratedFiles: [],
    workspaceActions: [],
    verificationStatus: "failed",
    executedCommands: []
  };
}

function normalizeToolAction(parsed) {
  const action = String(parsed?.action || "").trim();
  if (
    action === "list_files" ||
    action === "read_files" ||
    action === "write_files" ||
    action === "run_command" ||
    action === "final"
  ) {
    return action;
  }

  if (parsed?.summary || parsed?.keyFindings || parsed?.followUps) {
    return "final";
  }

  return "";
}

async function requestWorkspaceJsonRepair({
  provider,
  worker,
  task,
  rawText,
  onRetry,
  onEvent,
  signal
}) {
  if (typeof onEvent === "function") {
    onEvent({
      type: "status",
      stage: "workspace_json_repair",
      tone: "warning",
      ...buildRuntimeWorkerIdentity(worker),
      taskId: task.id,
      taskTitle: task.title,
      detail: "Repairing an invalid workspace JSON response."
    });
  }

  const response = await provider.invoke({
    instructions: [
      "You repair invalid JSON emitted by a workspace agent.",
      "Return valid JSON only.",
      "Preserve the original intent, action, paths, command arguments, and final result content whenever recoverable.",
      "Do not invent new files, commands, sources, or claims.",
      "If the payload cannot be safely recovered, return a final action with verificationStatus set to failed and explain the issue briefly.",
      ...WORKSPACE_TOOL_SCHEMA_LINES
    ].join(" "),
    input: [
      "Repair the following invalid workspace-agent output into valid JSON.",
      `Original output:\n${rawText}`
    ].join("\n\n"),
    purpose: "worker_json_repair",
    onRetry,
    signal
  });

  return parseJsonFromText(response.text);
}

async function parseWorkspaceActionPayload({
  provider,
  worker,
  task,
  rawText,
  onRetry,
  onEvent,
  signal
}) {
  let parsed;
  try {
    parsed = parseJsonFromText(rawText);
  } catch (error) {
    try {
      parsed = await requestWorkspaceJsonRepair({
        provider,
        worker,
        task,
        rawText,
        onRetry,
        onEvent,
        signal
      });
    } catch {
      throw error;
    }
  }

  const action = normalizeToolAction(parsed);
  if (action) {
    return { parsed, action };
  }

  parsed = await requestWorkspaceJsonRepair({
    provider,
    worker,
    task,
    rawText,
    onRetry,
    onEvent,
    signal
  });

  return {
    parsed,
    action: normalizeToolAction(parsed)
  };
}

export async function runWorkspaceToolLoop({
  provider,
  worker,
  task,
  originalTask,
  clusterPlan,
  dependencyOutputs,
  workspaceRoot,
  onRetry,
  onEvent,
  signal
}) {
  throwIfAborted(signal);
  const workspaceTree = await getWorkspaceTree(workspaceRoot);
  const toolHistory = [];
  const generatedFiles = [];
  let lastRawText = "";

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    throwIfAborted(signal);
    const prompt = buildWorkspaceWorkerPrompt({
      originalTask,
      clusterPlan,
      worker,
      task,
      dependencyOutputs,
      workspaceRoot,
      workspaceTreeLines: workspaceTree.lines,
      toolHistory
    });

    const response = await provider.invoke({
      instructions: prompt.instructions,
      input: prompt.input,
      purpose: "worker_execution",
      onRetry,
      signal
    });

    lastRawText = response.text;
    let parsed;
    let action = "";
    try {
      const result = await parseWorkspaceActionPayload({
        provider,
        worker,
        task,
        rawText: response.text,
        onRetry,
        onEvent,
        signal
      });
      parsed = result.parsed;
      action = result.action;
    } catch (error) {
      return createToolError(error.message, response.text);
    }

    if (!action) {
      return createToolError("Worker returned an unsupported workspace action.", response.text);
    }

    if (action === "final") {
      return normalizeWorkspaceFinalResult(parsed, response.text, generatedFiles, toolHistory);
    }

    if (action === "list_files") {
      throwIfAborted(signal);
      const targetPath = String(parsed?.path || ".").trim() || ".";
      const result = await listWorkspacePath(workspaceRoot, targetPath);
      toolHistory.push({
        action,
        request: {
          path: targetPath,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_list",
          tone: "neutral",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: `Listed workspace path: ${targetPath}`
        });
      }
      continue;
    }

    if (action === "read_files") {
      throwIfAborted(signal);
      const paths = safeArray(parsed?.paths).slice(0, 6);
      const result = await readWorkspaceFiles(workspaceRoot, paths);
      toolHistory.push({
        action,
        request: {
          paths,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_read",
          tone: "neutral",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: `Read ${paths.length} workspace file(s).`
        });
      }
      continue;
    }

    if (action === "write_files") {
      throwIfAborted(signal);
      const files = Array.isArray(parsed?.files) ? parsed.files : [];
      const result = await writeWorkspaceFiles(workspaceRoot, files);
      generatedFiles.push(...result.map((entry) => entry.path));
      toolHistory.push({
        action,
        request: {
          files: files.map((file) => ({ path: String(file?.path || "") })),
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_write",
          tone: "ok",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          generatedFiles: result.map((entry) => entry.path),
          detail: `Wrote ${result.length} workspace file(s).`
        });
      }
      continue;
    }

    if (action === "run_command") {
      throwIfAborted(signal);
      const result = await runWorkspaceCommand(
        workspaceRoot,
        String(parsed?.command || ""),
        Array.isArray(parsed?.args) ? parsed.args : [],
        {
          cwd: String(parsed?.cwd || ".").trim() || ".",
          signal
        }
      );
      toolHistory.push({
        action,
        request: {
          command: String(parsed?.command || ""),
          args: Array.isArray(parsed?.args) ? parsed.args.map((item) => String(item)) : [],
          cwd: String(parsed?.cwd || ".").trim() || ".",
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_command",
          tone: result.success ? "ok" : "warning",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: `${result.command} ${(result.args || []).join(" ").trim()}`.trim(),
          exitCode: result.exitCode
        });
      }
      continue;
    }
  }

  return createToolError("Worker exceeded the maximum workspace tool turns.", lastRawText);
}

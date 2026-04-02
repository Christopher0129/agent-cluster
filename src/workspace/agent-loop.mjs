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
  'Tool schema 5: {"action":"recall_memory","query":"string","limit":3,"tags":["string"],"reason":"string"}',
  'Tool schema 6: {"action":"remember","title":"string","content":"string","tags":["string"],"reason":"string"}',
  'Final schema: {"action":"final","thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"confidence":"low|medium|high","followUps":["string"],"generatedFiles":["relative/path"],"verificationStatus":"not_applicable|passed|failed","toolUsage":["string"],"memoryReads":0,"memoryWrites":0}'
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

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
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

function renderSessionMemorySnapshot(entries) {
  const normalized = Array.isArray(entries) ? entries.slice(0, 6) : [];
  if (!normalized.length) {
    return "[]";
  }

  return JSON.stringify(
    normalized.map((entry) => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      createdAt: entry.createdAt,
      agentLabel: entry.agentLabel,
      taskTitle: entry.taskTitle
    })),
    null,
    2
  );
}

function buildWorkspaceWorkerPrompt({
  originalTask,
  clusterPlan,
  worker,
  task,
  dependencyOutputs,
  workspaceRoot,
  workspaceTreeLines,
  toolHistory,
  sessionMemory
}) {
  return {
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      "You can directly inspect and modify files inside the configured workspace root, and you can read/write session memory for the current run.",
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
      `Session memory snapshot:\n${renderSessionMemorySnapshot(sessionMemory)}`,
      `Workspace root:\n${workspaceRoot}`,
      `Workspace tree snapshot:\n${renderWorkspaceTree(workspaceTreeLines)}`,
      `Tool history:\n${renderToolHistory(toolHistory)}`
    ].join("\n\n")
  };
}

function normalizeWorkspaceFinalResult(parsed, rawText, generatedFiles, history, counters = {}) {
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
    toolUsage: uniqueStrings([...(parsed?.toolUsage || []), ...history.map((entry) => entry.action)]),
    memoryReads: normalizeInteger(parsed?.memoryReads, normalizeInteger(counters.memoryReads)),
    memoryWrites: normalizeInteger(parsed?.memoryWrites, normalizeInteger(counters.memoryWrites)),
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
    toolUsage: [],
    memoryReads: 0,
    memoryWrites: 0,
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
    action === "recall_memory" ||
    action === "remember" ||
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
  invokeModel,
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

  const response = await invokeModel({
    provider,
    worker,
    task,
    purpose: "worker_json_repair",
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
    onRetry,
    signal
  });

  return parseJsonFromText(response.text);
}

async function parseWorkspaceActionPayload({
  provider,
  invokeModel,
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
        invokeModel,
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
    invokeModel,
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
  invokeModel,
  worker,
  task,
  originalTask,
  clusterPlan,
  dependencyOutputs,
  workspaceRoot,
  sessionRuntime = null,
  parentSpanId = "",
  onRetry,
  onEvent,
  signal
}) {
  throwIfAborted(signal);
  const workspaceTree = await getWorkspaceTree(workspaceRoot);
  const toolHistory = [];
  const generatedFiles = [];
  const toolCounters = {
    memoryReads: 0,
    memoryWrites: 0
  };
  let lastRawText = "";
  const invokeWorkerModel =
    typeof invokeModel === "function"
      ? invokeModel
      : async ({ provider: activeProvider, instructions, input, purpose, onRetry: activeOnRetry, signal: activeSignal }) =>
          activeProvider.invoke({
            instructions,
            input,
            purpose,
            onRetry: activeOnRetry,
            signal: activeSignal
          });

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
      toolHistory,
      sessionMemory: sessionRuntime?.buildSnapshot?.().memory?.recent || []
    });

    const response = await invokeWorkerModel({
      provider,
      worker,
      task,
      purpose: "worker_execution",
      instructions: prompt.instructions,
      input: prompt.input,
      onRetry,
      signal,
      parentSpanId
    });

    lastRawText = response.text;
    let parsed;
    let action = "";
    try {
      const result = await parseWorkspaceActionPayload({
        provider,
        invokeModel: invokeWorkerModel,
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
      return normalizeWorkspaceFinalResult(parsed, response.text, generatedFiles, toolHistory, toolCounters);
    }

    if (action === "list_files") {
      throwIfAborted(signal);
      const targetPath = String(parsed?.path || ".").trim() || ".";
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "list_files",
        spanLabel: `list_files · ${targetPath}`
      });
      const result = await listWorkspacePath(workspaceRoot, targetPath);
      toolHistory.push({
        action,
        request: {
          path: targetPath,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Listed workspace path: ${targetPath}`,
          resultCount: Array.isArray(result?.entries) ? result.entries.length : 0
        });
      }
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
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "read_files",
        spanLabel: `read_files · ${paths.length} file(s)`
      });
      const result = await readWorkspaceFiles(workspaceRoot, paths);
      toolHistory.push({
        action,
        request: {
          paths,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Read ${paths.length} workspace file(s).`,
          resultCount: result.length
        });
      }
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
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "write_files",
        spanLabel: `write_files · ${files.length} file(s)`
      });
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
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Wrote ${result.length} workspace file(s).`,
          resultCount: result.length
        });
      }
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
      const command = String(parsed?.command || "");
      const args = Array.isArray(parsed?.args) ? parsed.args : [];
      const cwd = String(parsed?.cwd || ".").trim() || ".";
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "run_command",
        spanLabel: `run_command · ${command}`
      });
      const result = await runWorkspaceCommand(workspaceRoot, command, args, {
        cwd,
        signal
      });
      toolHistory.push({
        action,
        request: {
          command,
          args: args.map((item) => String(item)),
          cwd,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `${result.command} ${(result.args || []).join(" ").trim()}`.trim(),
          exitCode: result.exitCode
        });
      }
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

    if (action === "recall_memory") {
      throwIfAborted(signal);
      const query = String(parsed?.query || "").trim();
      const tags = safeArray(parsed?.tags);
      const limit = normalizeInteger(parsed?.limit, 3) || 3;
      const result = sessionRuntime?.recall?.(
        {
          query,
          tags,
          limit
        },
        {
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          parentSpanId
        }
      ) || [];
      toolCounters.memoryReads += 1;
      toolHistory.push({
        action,
        request: {
          query,
          tags,
          limit,
          reason: String(parsed?.reason || "")
        },
        result
      });
      continue;
    }

    if (action === "remember") {
      throwIfAborted(signal);
      const title = String(parsed?.title || "").trim() || task.title;
      const content = String(parsed?.content || "").trim();
      const tags = safeArray(parsed?.tags);
      const result = sessionRuntime?.remember?.(
        {
          title,
          content,
          tags
        },
        {
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          parentSpanId
        }
      );
      toolCounters.memoryWrites += 1;
      toolHistory.push({
        action,
        request: {
          title,
          tags,
          reason: String(parsed?.reason || "")
        },
        result
      });
      continue;
    }
  }

  return createToolError("Worker exceeded the maximum workspace tool turns.", lastRawText);
}

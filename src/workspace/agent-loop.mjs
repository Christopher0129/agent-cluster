import {
  getWorkspaceTree,
  listWorkspacePath,
  readWorkspaceFiles,
  verifyWorkspaceArtifacts,
  writeWorkspaceFiles
} from "./fs.mjs";
import {
  buildDocxFallbackContent,
  getArtifactTitleFromPath,
  inferRequestedArtifact
} from "./artifact-fallback.mjs";
import { runWorkspaceCommand } from "./commands.mjs";
import {
  WORKSPACE_ACTIONS,
  buildWorkspaceToolSchemaLines,
  canonicalizeWorkspaceActionPayload,
  normalizeWorkspaceArtifactReferences,
  normalizeToolAction,
  normalizeWorkspaceFinalResult,
  validateWorkspaceActionPayload
} from "./action-protocol.mjs";
import { deriveTaskRequirements } from "./task-requirements.mjs";
import {
  WorkspaceCommandScopeError,
  assertWorkspaceCommandAllowedForScope
} from "./command-policy.mjs";
import { parseJsonFromText } from "../utils/json-output.mjs";
import { throwIfAborted } from "../utils/abort.mjs";
import { renderRuntimeCalendarNote } from "../utils/runtime-context.mjs";

const DEFAULT_MAX_TOOL_TURNS = 8;
const MAX_TOOL_TURNS_BY_PHASE = Object.freeze({
  research: 6,
  implementation: 8,
  validation: 6,
  handoff: 4
});
const MAX_WEB_SEARCH_CALLS_BY_PHASE = Object.freeze({
  research: 6,
  implementation: 2,
  validation: 4,
  handoff: 1
});
const MAX_BLOCKED_TOOL_ATTEMPTS = 2;

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

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function resolveMaxToolTurns(phase) {
  const normalized = String(phase || "").trim().toLowerCase();
  return MAX_TOOL_TURNS_BY_PHASE[normalized] ?? DEFAULT_MAX_TOOL_TURNS;
}

function resolveMaxWebSearchCalls(phase) {
  const normalized = String(phase || "").trim().toLowerCase();
  return MAX_WEB_SEARCH_CALLS_BY_PHASE[normalized] ?? 0;
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

function collectDependencyArtifactFocus(dependencyOutputs, workspaceRoot) {
  if (!Array.isArray(dependencyOutputs) || !dependencyOutputs.length) {
    return [];
  }

  return Array.from(
    new Set(
      dependencyOutputs.flatMap((item) => {
        const output = item?.output && typeof item.output === "object" ? item.output : {};
        const artifactTask = {
          title: item?.title || "",
          instructions: "",
          expectedOutput: Array.isArray(output?.deliverables) ? output.deliverables.join("\n") : ""
        };
        const inferredArtifact = deriveTaskRequirements(artifactTask).requiresConcreteArtifact
          ? inferRequestedArtifact(
            artifactTask,
            output,
            workspaceRoot || ".",
            output?.summary || ""
          )
          : "";
        return [
          ...(Array.isArray(output.verifiedGeneratedFiles) ? output.verifiedGeneratedFiles : []),
          ...(Array.isArray(output.generatedFiles) ? output.generatedFiles : []),
          inferredArtifact
        ]
          .map((path) => String(path || "").trim())
          .filter(Boolean);
      })
    )
  );
}

function buildWorkspaceWorkerPrompt({
  originalTask,
  clusterPlan,
  worker,
  task,
  taskRequirements,
  dependencyOutputs,
  workspaceRoot,
  workspaceTreeLines,
  toolHistory,
  sessionMemory
}) {
  const toolSchemaLines = buildWorkspaceToolSchemaLines({
    webSearchAvailable: worker.webSearch,
    workspaceWriteAvailable: taskRequirements.allowsWorkspaceWrite,
    workspaceCommandAvailable: taskRequirements.allowsWorkspaceCommand,
    workspaceCommandScopeDescription: taskRequirements.workspaceCommandScopeDescription
  });
  const dateContext = renderRuntimeCalendarNote();
  const dependencyArtifacts = collectDependencyArtifactFocus(dependencyOutputs, workspaceRoot);

  return {
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      "You can directly inspect and modify files inside the configured workspace root, and you can read/write session memory for the current run.",
      `Web search is ${worker.webSearch ? "available" : "not available"} for this model.`,
      `Workspace writes are ${taskRequirements.allowsWorkspaceWrite ? "available" : "not available"} for this task.`,
      `Workspace commands are ${taskRequirements.allowsWorkspaceCommand ? `available with scope: ${taskRequirements.workspaceCommandScopeDescription}` : "not available"} for this task.`,
      dateContext,
      "The runtime clock above is authoritative. Never claim the current actual date is anything else.",
      "Stay scoped to the assigned task, and read files before editing existing code when needed.",
      "If current public facts or source verification are required and web search is available, use it before finalizing claims.",
      "If web search is not available for this model, do not attempt web_search and do not claim live verification.",
      "If workspace writes are not available for this task, do not attempt write_files or write_docx.",
      "If workspace commands are not available for this task, do not attempt run_command.",
      "If workspace commands are available, stay within the allowed command scope and prefer the least-privileged command that solves the task.",
      "For search-heavy research, prefer a smaller fully verified batch over a larger unverified list.",
      "If a tool call is blocked by policy, adapt immediately with the remaining allowed tools or finalize with the limitation; do not repeat the same blocked tool request.",
      "Keep validation tasks tightly bounded. Once you have enough evidence to pass/fail the task, stop calling tools and return final.",
      "If the task expects a concrete file artifact, do not return final before the artifact has actually been written into the workspace.",
      "If the task expects a .docx report, prefer write_docx. The runtime will materialize a real Word document instead of raw text bytes.",
      "If the task expects another concrete binary artifact such as .pptx, .xlsx, or .pdf, you may either write base64 content with write_files or generate the file through safe workspace commands.",
      "Return exactly one workspace action object per response. Do not return an array of actions, a batched action list, or prose plus multiple actions.",
      "Never invent sources, URLs, examples, or case studies.",
      "Never reference or request paths outside the workspace root.",
      "When dependency outputs already list generated or verified files, focus implementation, validation, and review work on those files first.",
      "When dependency artifact focus is non-empty and the expected artifact is missing, do not inspect unrelated pre-existing workspace files just to fill the gap. Report the missing artifact directly.",
      "Ignore unrelated pre-existing workspace files unless the assigned task explicitly requires a broader repository or workspace audit.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      ...toolSchemaLines
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Current local date context:\n${dateContext}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      `Task execution policy:\n${JSON.stringify(taskRequirements, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      dependencyArtifacts.length
        ? `Dependency artifact focus:\n${JSON.stringify(dependencyArtifacts, null, 2)}`
        : "Dependency artifact focus:\n[]",
      `Session memory snapshot:\n${renderSessionMemorySnapshot(sessionMemory)}`,
      `Workspace root:\n${workspaceRoot}`,
      `Workspace tree snapshot:\n${renderWorkspaceTree(workspaceTreeLines)}`,
      `Tool history:\n${renderToolHistory(toolHistory)}`
    ].join("\n\n")
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

async function requestWorkspaceJsonRepair({
  provider,
  invokeModel,
  worker,
  task,
  taskRequirements,
  rawText,
  onRetry,
  onEvent,
  signal
}) {
  const toolSchemaLines = buildWorkspaceToolSchemaLines({
    webSearchAvailable: worker.webSearch,
    workspaceWriteAvailable: taskRequirements?.allowsWorkspaceWrite,
    workspaceCommandAvailable: taskRequirements?.allowsWorkspaceCommand,
    workspaceCommandScopeDescription: taskRequirements?.workspaceCommandScopeDescription
  });

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
      `Workspace writes are ${taskRequirements?.allowsWorkspaceWrite ? "available" : "not available"} for this task.`,
      `Workspace commands are ${taskRequirements?.allowsWorkspaceCommand ? `available with scope: ${taskRequirements.workspaceCommandScopeDescription}` : "not available"} for this task.`,
      "Do not repair the payload into a tool action that is unavailable for this task.",
      "If the payload cannot be safely recovered, return a final action with verificationStatus set to failed and explain the issue briefly.",
      ...toolSchemaLines
    ].join(" "),
    input: [
      "Repair the following invalid workspace-agent output into valid JSON.",
      `Original output:\n${rawText}`
    ].join("\n\n"),
    onRetry,
    signal
  });

  const repaired = parseJsonFromText(response.text);

  if (typeof onEvent === "function") {
    onEvent({
      type: "status",
      stage: "workspace_json_repair",
      tone: "neutral",
      ...buildRuntimeWorkerIdentity(worker),
      taskId: task.id,
      taskTitle: task.title,
      detail: "Detected an invalid workspace JSON response and repaired it automatically."
    });
  }

  return repaired;
}

function normalizeWorkspaceSearchResult(parsed, rawText) {
  return {
    summary: String(parsed?.summary || rawText || "No search summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    sources: uniqueStrings(safeArray(parsed?.sources)),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    rawText: String(rawText || "")
  };
}

async function executeWorkspaceWebSearch({
  provider,
  invokeModel,
  worker,
  task,
  originalTask,
  query,
  domains,
  recencyDays,
  reason,
  onRetry,
  signal,
  parentSpanId = ""
}) {
  const dateContext = renderRuntimeCalendarNote();
  const response = await invokeModel({
    provider,
    worker,
    task,
    parentSpanId,
    purpose: "worker_web_search",
    instructions: [
      `You are ${worker.label}, a web-search-enabled research assistant inside a multi-model cluster.`,
      dateContext,
      "The runtime clock above is authoritative. Do not claim the current actual date is anything else.",
      "Use native web search for this request.",
      "Return JSON only.",
      "Ground the answer in searched public sources and do not invent URLs, dates, or verification claims.",
      'Schema: {"summary":"string","keyFindings":["string"],"sources":["string"],"confidence":"low|medium|high"}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Assigned task:\n${JSON.stringify(task, null, 2)}`,
      `Search query:\n${query}`,
      `Search reason:\n${reason || "The workspace worker requested live web verification."}`,
      domains.length ? `Preferred domains:\n${domains.join(", ")}` : "Preferred domains:\n[]",
      recencyDays > 0 ? `Preferred recency window (days):\n${recencyDays}` : "Preferred recency window (days):\nnone"
    ].join("\n\n"),
    onRetry,
    signal
  });

  let parsed;
  try {
    parsed = parseJsonFromText(response.text);
  } catch {
    parsed = {
      summary: response.text,
      keyFindings: [],
      sources: []
    };
  }

  return normalizeWorkspaceSearchResult(parsed, response.text);
}

function createForcedFinalPayload(reason) {
  const summary = String(reason || "Workspace tool execution stopped before the worker returned a final result.");
  return {
    action: WORKSPACE_ACTIONS.FINAL,
    thinkingSummary: "",
    summary,
    keyFindings: [],
    risks: [summary],
    deliverables: [],
    confidence: "low",
    followUps: ["Use the available tool results to conclude with a narrower or better-bounded task."],
    generatedFiles: [],
    verificationStatus: "failed",
    toolUsage: [],
    memoryReads: 0,
    memoryWrites: 0
  };
}

async function requestForcedWorkspaceFinalResult({
  provider,
  invokeModel,
  worker,
  task,
  originalTask,
  clusterPlan,
  dependencyOutputs,
  workspaceRoot,
  toolHistory,
  sessionRuntime,
  reason,
  lastRawText,
  onRetry,
  signal
}) {
  const workspaceTree = await getWorkspaceTree(workspaceRoot);
  const response = await invokeModel({
    provider,
    worker,
    task,
    purpose: "worker_forced_final",
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      renderRuntimeCalendarNote(),
      "The runtime clock above is authoritative. Never claim the current actual date is anything else.",
      "Tool execution has been stopped for this task. No further tool calls are allowed.",
      "Return exactly one final workspace action object.",
      "Base the conclusion only on dependency outputs, current workspace state, tool history, and session memory already available.",
      "If evidence is incomplete, say so plainly and set verificationStatus to failed.",
      "Do not invent sources, files, URLs, commands, or verification claims.",
      "Return JSON only.",
      'Final schema: {"action":"final","thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"confidence":"low|medium|high","followUps":["string"],"generatedFiles":["relative/path"],"verificationStatus":"not_applicable|passed|failed","toolUsage":["string"],"memoryReads":0,"memoryWrites":0}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Session memory snapshot:\n${renderSessionMemorySnapshot(sessionRuntime?.buildSnapshot?.().memory?.recent || [])}`,
      `Workspace root:\n${workspaceRoot}`,
      `Workspace tree snapshot:\n${renderWorkspaceTree(workspaceTree.lines)}`,
      `Tool history:\n${renderToolHistory(toolHistory)}`,
      `Forced-final reason:\n${reason}`,
      lastRawText ? `Last raw worker output:\n${lastRawText}` : "Last raw worker output:\n(none)"
    ].join("\n\n"),
    onRetry,
    signal
  });

  let parsed = null;
  try {
    parsed = parseJsonFromText(response.text);
  } catch {
    parsed = null;
  }

  if (normalizeToolAction(parsed) !== WORKSPACE_ACTIONS.FINAL) {
    return {
      parsed: createForcedFinalPayload(reason),
      rawText: response.text
    };
  }

  return {
    parsed,
    rawText: response.text
  };
}

async function parseWorkspaceActionPayload({
  provider,
  invokeModel,
  worker,
  task,
  taskRequirements,
  rawText,
  onRetry,
  onEvent,
  signal
}) {
  let parsed;
  let parseError = null;
  try {
    parsed = parseJsonFromText(rawText);
  } catch (error) {
    parseError = error;
    try {
      parsed = await requestWorkspaceJsonRepair({
        provider,
        invokeModel,
        worker,
        task,
        taskRequirements,
        rawText,
        onRetry,
        onEvent,
        signal
      });
    } catch {
      throw error;
    }
  }

  const tryValidate = (candidate) => {
    const canonicalCandidate = canonicalizeWorkspaceActionPayload(candidate);
    const candidateAction = normalizeToolAction(canonicalCandidate);
    if (!candidateAction) {
      const rawAction =
        candidate?.action ??
        candidate?.toolAction ??
        candidate?.tool ??
        candidate?.name ??
        candidate?.type ??
        "";
      throw new Error(
        `Worker returned an unsupported workspace action${rawAction ? ` "${rawAction}"` : ""}.`
      );
    }
    validateWorkspaceActionPayload(canonicalCandidate, candidateAction);
    return {
      parsed: canonicalCandidate,
      action: candidateAction
    };
  };

  try {
    return tryValidate(parsed);
  } catch (error) {
    if (parseError && !parsed) {
      throw parseError;
    }
  }

  parsed = await requestWorkspaceJsonRepair({
    provider,
    invokeModel,
    worker,
    task,
    taskRequirements,
    rawText,
    onRetry,
    onEvent,
    signal
  });

  return tryValidate(parsed);
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
  const taskRequirements = deriveTaskRequirements(task);
  throwIfAborted(signal);
  const workspaceTree = await getWorkspaceTree(workspaceRoot);
  const toolHistory = [];
  const generatedFiles = [];
  const toolCounters = {
    memoryReads: 0,
    memoryWrites: 0
  };
  let lastRawText = "";
  let blockedToolAttempts = 0;
  let webSearchCount = 0;
  let forcedFinalReason = "";
  const maxToolTurns = resolveMaxToolTurns(taskRequirements.phase);
  const maxWebSearchCalls = resolveMaxWebSearchCalls(taskRequirements.phase);
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

  async function maybeAutoMaterializeDocxArtifact(parsed) {
    if (!taskRequirements.requiresConcreteArtifact || !taskRequirements.allowsWorkspaceWrite) {
      return [];
    }

    const artifactPath = inferRequestedArtifact(task, parsed, workspaceRoot, originalTask);
    if (!/\.docx$/i.test(String(artifactPath || ""))) {
      return [];
    }

    const content = buildDocxFallbackContent({
      task,
      parsed,
      dependencyOutputs,
      originalTask
    });
    if (String(content || "").trim().length < 24) {
      return [];
    }

    const result = await writeWorkspaceFiles(workspaceRoot, [
      {
        path: artifactPath,
        title: getArtifactTitleFromPath(artifactPath),
        content,
        encoding: "utf8"
      }
    ]);
    generatedFiles.push(...result.map((entry) => entry.path));
    toolHistory.push({
      action: WORKSPACE_ACTIONS.WRITE_DOCX,
      autoMaterialized: true,
      request: {
        path: artifactPath,
        reason: "Runtime auto-materialized the requested .docx artifact from structured task outputs."
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
        detail: `Auto-materialized Word document: ${artifactPath}`
      });
    }
    return result.map((entry) => entry.path);
  }

  async function finalizeWorkspaceResult(parsed, rawText) {
    if (!generatedFiles.length) {
      await maybeAutoMaterializeDocxArtifact(parsed);
    }
    const reportedGeneratedFiles = normalizeWorkspaceArtifactReferences([
      ...generatedFiles,
      ...safeArray(parsed?.generatedFiles)
    ]);
    const verification = await verifyWorkspaceArtifacts(workspaceRoot, reportedGeneratedFiles, {
      maxFiles: 12
    });
    const verifiedGeneratedFiles = verification
      .filter((entry) => entry.verified)
      .map((entry) => entry.path);
    const failedVerification = verification.filter((entry) => !entry.verified);
    const normalizedResult = normalizeWorkspaceFinalResult(
      parsed,
      rawText,
      reportedGeneratedFiles,
      verifiedGeneratedFiles,
      toolHistory,
      toolCounters
    );

    if (failedVerification.length) {
      normalizedResult.risks = uniqueStrings([
        ...normalizedResult.risks,
        ...failedVerification.map(
          (entry) => `Generated artifact "${entry.path}" could not be verified: ${entry.error}`
        )
      ]);
      if (normalizedResult.verificationStatus === "passed") {
        normalizedResult.verificationStatus = "failed";
      }
    }

    if (normalizedResult.verifiedGeneratedFiles.length && taskRequirements.requiresConcreteArtifact) {
      normalizedResult.keyFindings = uniqueStrings([
        ...normalizedResult.keyFindings,
        "The requested workspace artifact was materialized and verified."
      ]);
      normalizedResult.verificationStatus = "passed";
    }

    return normalizedResult;
  }

  function registerBlockedTool(action, request, message, extras = {}) {
    toolHistory.push({
      action,
      blocked: true,
      request,
      result: {
        blocked: true,
        message,
        ...extras
      }
    });
    if (typeof onEvent === "function") {
      onEvent({
        type: "status",
        stage: "workspace_tool_blocked",
        tone: "warning",
        toolAction: action,
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        detail: message,
        ...extras
      });
    }
    blockedToolAttempts += 1;
    return blockedToolAttempts >= MAX_BLOCKED_TOOL_ATTEMPTS;
  }

  for (let turn = 0; turn < maxToolTurns; turn += 1) {
    throwIfAborted(signal);
    const prompt = buildWorkspaceWorkerPrompt({
      originalTask,
      clusterPlan,
      worker,
      task,
      taskRequirements,
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
        taskRequirements,
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

    if (action === WORKSPACE_ACTIONS.FINAL) {
      return finalizeWorkspaceResult(parsed, response.text);
    }

    if (action === WORKSPACE_ACTIONS.LIST_FILES) {
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
          resultCount: Array.isArray(result) ? result.length : 0
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

    if (action === WORKSPACE_ACTIONS.READ_FILES) {
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

    if (action === WORKSPACE_ACTIONS.WRITE_FILES) {
      throwIfAborted(signal);
      const files = Array.isArray(parsed?.files) ? parsed.files : [];
      if (!taskRequirements.allowsWorkspaceWrite) {
        if (
          registerBlockedTool(
            action,
            {
              files: files.map((file) => ({ path: String(file?.path || "") })),
              reason: String(parsed?.reason || "")
            },
            "Blocked write_files because workspace writes are out of scope for this task."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace write attempts were blocked repeatedly for this task.";
          break;
        }
        continue;
      }
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
          files: files.map((file) => ({
            path: String(file?.path || ""),
            encoding: String(file?.encoding || "utf8").trim().toLowerCase() || "utf8"
          })),
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

    if (action === WORKSPACE_ACTIONS.WRITE_DOCX) {
      throwIfAborted(signal);
      if (!taskRequirements.allowsWorkspaceWrite) {
        if (
          registerBlockedTool(
            action,
            {
              path: String(parsed?.path || ""),
              reason: String(parsed?.reason || "")
            },
            "Blocked write_docx because workspace writes are out of scope for this task."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace document writes were blocked repeatedly for this task.";
          break;
        }
        continue;
      }

      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "write_docx",
        spanLabel: `write_docx 路 ${String(parsed?.path || "")}`
      });
      const result = await writeWorkspaceFiles(workspaceRoot, [
        {
          path: String(parsed?.path || ""),
          title: String(parsed?.title || ""),
          content: String(parsed?.content || ""),
          encoding: "utf8"
        }
      ]);
      generatedFiles.push(...result.map((entry) => entry.path));
      toolHistory.push({
        action,
        request: {
          path: String(parsed?.path || ""),
          title: String(parsed?.title || ""),
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Wrote Word document: ${String(parsed?.path || "")}`,
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
          detail: `Wrote Word document: ${String(parsed?.path || "")}`
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.WEB_SEARCH) {
      throwIfAborted(signal);
      const query = String(parsed?.query || "").trim();
      const domains = safeArray(parsed?.domains).slice(0, 6);
      const recencyDays = normalizeInteger(parsed?.recencyDays, 0);
      if (!worker.webSearch) {
        if (
          registerBlockedTool(
            action,
            {
              query,
              domains,
              recencyDays,
              reason: String(parsed?.reason || "")
            },
            "Blocked web_search because web search is not enabled for this model."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Web search was requested repeatedly on a model without web-search support.";
          break;
        }
        continue;
      }
      if (maxWebSearchCalls > 0 && webSearchCount >= maxWebSearchCalls) {
        registerBlockedTool(
          action,
          {
            query,
            domains,
            recencyDays,
            reason: String(parsed?.reason || "")
          },
          `Blocked web_search because this ${taskRequirements.phase} task already used its ${maxWebSearchCalls}-search budget.`,
          {
            searchBudget: maxWebSearchCalls
          }
        );
        forcedFinalReason =
          forcedFinalReason ||
          `Reached the ${maxWebSearchCalls}-search budget for this ${taskRequirements.phase} task; finalize with the evidence already collected.`;
        break;
      }
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: WORKSPACE_ACTIONS.WEB_SEARCH,
        spanLabel: `web_search - ${query.slice(0, 80)}`
      });
      const result = await executeWorkspaceWebSearch({
        provider,
        invokeModel: invokeWorkerModel,
        worker,
        task,
        originalTask,
        query,
        domains,
        recencyDays,
        reason: String(parsed?.reason || ""),
        onRetry,
        signal,
        parentSpanId: toolSpanId || parentSpanId
      });
      webSearchCount += 1;
      toolHistory.push({
        action,
        request: {
          query,
          domains,
          recencyDays,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Web searched: ${query}`,
          resultCount: result.sources.length
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_web_search",
          tone: "ok",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: query,
          sourceCount: result.sources.length
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.RUN_COMMAND) {
      throwIfAborted(signal);
      const command = String(parsed?.command || "");
      const args = Array.isArray(parsed?.args) ? parsed.args : [];
      const cwd = String(parsed?.cwd || ".").trim() || ".";
      if (!taskRequirements.allowsWorkspaceCommand) {
        if (
          registerBlockedTool(
            action,
            {
              command,
              args: args.map((item) => String(item)),
              cwd,
              reason: String(parsed?.reason || "")
            },
            "Blocked run_command because workspace commands are out of scope for this task."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace command attempts were blocked repeatedly for this task.";
          break;
        }
        continue;
      }
      try {
        assertWorkspaceCommandAllowedForScope(
          command,
          args,
          taskRequirements.workspaceCommandScope
        );
      } catch (error) {
        if (!(error instanceof WorkspaceCommandScopeError)) {
          throw error;
        }
        if (
          registerBlockedTool(
            action,
            {
              command,
              args: args.map((item) => String(item)),
              cwd,
              reason: String(parsed?.reason || "")
            },
            error.message,
            {
              allowedScope: error.allowedScope,
              requiredScope: error.requiredScope
            }
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace command scope mismatches kept recurring; finalize with the available inspection evidence.";
          break;
        }
        continue;
      }
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "run_command",
        spanLabel: `run_command · ${command}`
      });
      let result;
      try {
        result = await runWorkspaceCommand(workspaceRoot, command, args, {
          cwd,
          signal
        });
      } catch (error) {
        const message = String(error?.message || error || "Workspace command failed.");
        const blockedByPolicy =
          /not allowed inside the workspace command tool|contains blocked arguments|Only read-only git commands are allowed|node eval arguments are blocked|must use -File|Only workspace script files can be executed|Only \.cmd or \.bat workspace scripts can be executed/i.test(
            message
          );
        toolHistory.push({
          action,
          blocked: blockedByPolicy,
          request: {
            command,
            args: args.map((item) => String(item)),
            cwd,
            reason: String(parsed?.reason || "")
          },
          result: {
            blocked: blockedByPolicy,
            message
          }
        });
        if (toolSpanId) {
          sessionRuntime.completeToolCall(toolSpanId, {
            detail: message,
            exitCode: -1
          });
        }
        if (typeof onEvent === "function") {
          onEvent({
            type: "status",
            stage: blockedByPolicy ? "workspace_tool_blocked" : "workspace_command",
            tone: "warning",
            toolAction: WORKSPACE_ACTIONS.RUN_COMMAND,
            ...buildRuntimeWorkerIdentity(worker),
            taskId: task.id,
            taskTitle: task.title,
            detail: message,
            exitCode: -1
          });
        }
        if (blockedByPolicy) {
          blockedToolAttempts += 1;
          if (blockedToolAttempts >= MAX_BLOCKED_TOOL_ATTEMPTS) {
            forcedFinalReason =
              forcedFinalReason || `Workspace command attempts were blocked repeatedly. ${message}`;
            break;
          }
        }
        continue;
      }
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

    if (action === WORKSPACE_ACTIONS.RECALL_MEMORY) {
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

    if (action === WORKSPACE_ACTIONS.REMEMBER) {
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

  try {
    const reason =
      forcedFinalReason ||
      `Worker reached the ${maxToolTurns}-turn workspace tool budget without returning a final result.`;
    const forcedFinal = await requestForcedWorkspaceFinalResult({
      provider,
      invokeModel: invokeWorkerModel,
      worker,
      task,
      originalTask,
      clusterPlan,
      dependencyOutputs,
      workspaceRoot,
      toolHistory,
      sessionRuntime,
      reason,
      lastRawText,
      onRetry,
      signal
    });
    return finalizeWorkspaceResult(forcedFinal.parsed, forcedFinal.rawText);
  } catch (error) {
    return createToolError(
      forcedFinalReason || "Worker exceeded the maximum workspace tool turns.",
      lastRawText || String(error?.message || "")
    );
  }
}

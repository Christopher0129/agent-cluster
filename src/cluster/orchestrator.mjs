import {
  buildLeaderDelegationRequest,
  buildLeaderSynthesisRequest,
  buildPlanningRequest,
  buildSynthesisRequest,
  buildWorkerExecutionRequest
} from "./prompts.mjs";
import { parseJsonFromText } from "../utils/json-output.mjs";
import { getWorkspaceTree } from "../workspace/fs.mjs";
import { runWorkspaceToolLoop } from "../workspace/agent-loop.mjs";
import { isAbortError, throwIfAborted } from "../utils/abort.mjs";

const PHASE_ORDER = ["research", "implementation", "validation", "handoff"];
const DEFAULT_SUBORDINATE_MAX_PARALLEL = 3;
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const PHASE_CONCURRENCY_CAPS = {
  research: 2,
  handoff: 1
};
const AGENT_PREFIX = {
  research: {
    leader: "调研组长",
    subordinate: "调研下属"
  },
  implementation: {
    leader: "编码组长",
    subordinate: "编码下属"
  },
  validation: {
    leader: "验证组长",
    subordinate: "验证下属"
  },
  handoff: {
    leader: "交付组长",
    subordinate: "交付下属"
  },
  general: {
    leader: "分析组长",
    subordinate: "分析下属"
  }
};
const PHASE_HINTS = {
  research: ["long context reading", "web research", "data extraction", "cross-checking", "analysis"],
  implementation: ["coding", "debugging", "implementation critique", "patch suggestions"],
  validation: ["test planning", "code review", "cross-checking", "debugging", "qa"],
  handoff: ["document writing", "chat", "synthesis", "communication"]
};
const ROLE_PHASES = {
  controller: [...PHASE_ORDER],
  research: ["research"],
  implementation: ["implementation"],
  coding_manager: ["validation"],
  validation: ["validation"],
  handoff: ["handoff"],
  general: ["implementation"]
};

function emitEvent(onEvent, payload) {
  if (typeof onEvent === "function") {
    onEvent({
      timestamp: new Date().toISOString(),
      ...payload
    });
  }
}

function workerListFromConfig(config) {
  return Object.values(config.models).filter((model) => model.id !== config.cluster.controller);
}

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function uniqueArray(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item)).filter(Boolean)));
}

function normalizePhase(value, fallback = "implementation") {
  const normalized = String(value || "").trim().toLowerCase();
  return PHASE_ORDER.includes(normalized) ? normalized : fallback;
}

function phaseIndex(value) {
  return PHASE_ORDER.indexOf(normalizePhase(value));
}

function normalizeVerificationStatus(value) {
  const normalized = String(value || "").trim();
  return ["not_applicable", "passed", "failed"].includes(normalized)
    ? normalized
    : "not_applicable";
}

function resolveGroupLeaderMaxDelegates(config) {
  const configured = Number(config?.cluster?.groupLeaderMaxDelegates);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_GROUP_LEADER_MAX_DELEGATES;
  }

  return Math.floor(configured);
}

function resolveDelegateMaxDepth(config) {
  const configured = Number(config?.cluster?.delegateMaxDepth);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_DELEGATION_MAX_DEPTH;
  }

  return Math.floor(configured);
}

function resolveSubordinateMaxParallel(config) {
  const configured = Number(config?.cluster?.subordinateMaxParallel);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_SUBORDINATE_MAX_PARALLEL;
  }

  return Math.floor(configured);
}

function normalizeDelegateCount(value, maxDelegates = DEFAULT_GROUP_LEADER_MAX_DELEGATES) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1) {
    return 0;
  }

  if (!Number.isFinite(maxDelegates) || maxDelegates < 0) {
    return Math.min(DEFAULT_GROUP_LEADER_MAX_DELEGATES, Math.floor(count));
  }

  if (Math.floor(maxDelegates) === 0) {
    return 0;
  }

  return Math.min(Math.floor(maxDelegates), Math.floor(count));
}

function hasExplicitDelegateCount(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed !== "";
}

function taskLooksAtomic(task, phase) {
  const normalizedPhase = normalizePhase(phase, "implementation");
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);

  if (normalizedPhase === "handoff") {
    return true;
  }

  return /(atomic|single file|single document|single report|one file|one document|one report|directly|handle directly)/.test(
    text
  );
}

function shouldPreferDelegation(task, phase, groupLeaderMaxDelegates, delegateMaxDepth) {
  if (Math.floor(Number(groupLeaderMaxDelegates) || 0) <= 0) {
    return false;
  }
  if (Math.floor(Number(delegateMaxDepth) || 0) <= 0) {
    return false;
  }

  const normalizedPhase = normalizePhase(phase, "implementation");
  if (taskLooksAtomic(task, normalizedPhase)) {
    return false;
  }

  return normalizedPhase === "research" || normalizedPhase === "implementation" || normalizedPhase === "validation";
}

function inferPlannedDelegateCount(task, phase, groupLeaderMaxDelegates, delegateMaxDepth) {
  if (!shouldPreferDelegation(task, phase, groupLeaderMaxDelegates, delegateMaxDepth)) {
    return 0;
  }

  const normalizedPhase = normalizePhase(phase, "implementation");
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  let suggested = 1;

  if (normalizedPhase === "research" || normalizedPhase === "implementation") {
    suggested = 2;
  } else if (normalizedPhase === "handoff") {
    suggested = 0;
  }

  if (/(compare|survey|collect|batch|multiple|parallel|delegate|split|analyze directly and return the result)/.test(text)) {
    suggested = Math.max(suggested, 2);
  }
  if (/(small|atomic|single file|single document|one file|directly)/.test(text)) {
    suggested = Math.min(suggested, 1);
  }

  return normalizeDelegateCount(suggested, groupLeaderMaxDelegates);
}

function resolveTaskDelegateCount(task, phase, groupLeaderMaxDelegates, delegateMaxDepth) {
  const inferred = inferPlannedDelegateCount(task, phase, groupLeaderMaxDelegates, delegateMaxDepth);

  if (!hasExplicitDelegateCount(task?.delegateCount)) {
    return inferred;
  }

  const explicit = normalizeDelegateCount(task?.delegateCount, groupLeaderMaxDelegates);
  if (explicit > 0) {
    return explicit;
  }

  return inferred;
}

function safeString(value) {
  return String(value || "").trim();
}

function padAgentIndex(value) {
  return String(value).padStart(2, "0");
}

function textBlob(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function workerHasSpecialty(worker, specialty) {
  const normalizedSpecialty = safeString(specialty).toLowerCase();
  if (!normalizedSpecialty) {
    return false;
  }

  return safeArray(worker?.specialties).some(
    (item) => safeString(item).toLowerCase() === normalizedSpecialty
  );
}

function taskLooksCodeRelated(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return /(code|coding|script|patch|implement|fix|write|edit|refactor|repo|repository|workspace|test|build|lint|debug|\u7f16\u7801|\u4ee3\u7801|\u5b9e\u73b0|\u4fee\u590d|\u8865\u4e01|\u811a\u672c|\u91cd\u6784|\u4ed3\u5e93|\u5de5\u7a0b|\u6d4b\u8bd5|\u6784\u5efa|\u8c03\u8bd5|\u5ba1\u67e5|\u8bc4\u5ba1)/.test(
    text
  );
}

function taskRequiresConcreteArtifact(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return (
    /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/.test(text) ||
    /(write|create|generate|save|export|deliver).{0,40}(file|document|report|artifact)/.test(text) ||
    /(\u6587\u4ef6|\u6587\u6863|\u62a5\u544a|\u4ea4\u4ed8\u7269|\u751f\u6210doc|\u751f\u6210docx)/.test(text)
  );
}

function inferWorkerPhases(worker) {
  const specialties = safeArray(worker?.specialties).map((item) => item.toLowerCase());
  const phases = new Set();

  for (const specialty of specialties) {
    for (const phase of ROLE_PHASES[specialty] || []) {
      phases.add(phase);
    }
  }

  for (const phase of PHASE_ORDER) {
    if (PHASE_HINTS[phase].some((hint) => specialties.some((specialty) => specialty.includes(hint)))) {
      phases.add(phase);
    }
  }

  if (worker?.webSearch) {
    phases.add("research");
  }

  if (String(worker?.model || "").toLowerCase().includes("codex")) {
    phases.add("implementation");
    phases.add("validation");
  }

  if (!phases.size) {
    phases.add("implementation");
  }

  return Array.from(phases);
}

function inferPhase(task, worker) {
  const explicit = normalizePhase(task?.phase || "", "");
  if (explicit) {
    return explicit;
  }

  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput, worker?.specialties);
  if (/(search|research|source|evidence|example|compare|collect|survey|current|fact)/.test(text)) {
    return "research";
  }
  if (/(test|validate|verification|review|check|qa|lint|build)/.test(text)) {
    return "validation";
  }
  if (/(document|handoff|report|summar|explain|presentation|communicat)/.test(text)) {
    return "handoff";
  }
  if (/(code|script|patch|implement|fix|write|edit|refactor)/.test(text)) {
    return "implementation";
  }

  return inferWorkerPhases(worker)[0] || "implementation";
}

function scoreWorkerForTask(worker, phase, task) {
  const workerPhases = inferWorkerPhases(worker);
  const specialties = safeArray(worker?.specialties).map((item) => item.toLowerCase());
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  let score = workerPhases.includes(phase) ? 10 : 0;

  if (phase === "research" && worker?.webSearch) {
    score += 4;
  }

  if (phase === "implementation" && String(worker?.model || "").toLowerCase().includes("codex")) {
    score += 4;
  }

  if (phase === "validation" && workerHasSpecialty(worker, "coding_manager") && taskLooksCodeRelated(task)) {
    score += 8;
  }

  for (const hint of PHASE_HINTS[phase] || []) {
    if (specialties.some((specialty) => specialty.includes(hint))) {
      score += 2;
    }
    if (text.includes(hint)) {
      score += 1;
    }
  }

  return score;
}

function pickBestWorkerForTask(workers, phase, task) {
  return [...workers]
    .sort((left, right) => scoreWorkerForTask(right, phase, task) - scoreWorkerForTask(left, phase, task))[0];
}

function resolvePhaseConcurrency(phase, maxParallel, config) {
  const configuredCap = Number(config?.cluster?.phaseParallel?.[phase]);
  const hardCap =
    Number.isFinite(configuredCap) && configuredCap >= 0
      ? Math.floor(configuredCap)
      : PHASE_CONCURRENCY_CAPS[phase] ?? 0;
  const clusterCap = Number.isFinite(Number(maxParallel)) && Number(maxParallel) >= 0
    ? Math.floor(Number(maxParallel))
    : 1;

  if (hardCap === 0 && clusterCap === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (hardCap === 0) {
    return clusterCap === 0 ? Number.POSITIVE_INFINITY : Math.max(1, clusterCap);
  }
  if (clusterCap === 0) {
    return Math.max(1, hardCap);
  }

  return Math.max(1, Math.min(clusterCap, hardCap));
}

function countRunningResearchTasksForBaseUrl(runningTaskIds, taskById, config, baseUrl) {
  if (!baseUrl) {
    return 0;
  }

  let count = 0;
  for (const taskId of runningTaskIds) {
    const runningTask = taskById.get(taskId);
    if (!runningTask || runningTask.phase !== "research") {
      continue;
    }

    const worker = config.models[runningTask.assignedWorker];
    if (String(worker?.baseUrl || "").trim().toLowerCase() === baseUrl) {
      count += 1;
    }
  }

  return count;
}

function canStartTaskForPhase(task, runningTaskIds, taskById, config) {
  if (task.phase !== "research") {
    return true;
  }

  const worker = config.models[task.assignedWorker];
  if (!worker?.webSearch) {
    return true;
  }

  const baseUrl = String(worker?.baseUrl || "").trim().toLowerCase();
  if (!baseUrl) {
    return true;
  }

  return countRunningResearchTasksForBaseUrl(runningTaskIds, taskById, config, baseUrl) < 1;
}

function resolveAgentPrefix(phase, kind) {
  const bucket = AGENT_PREFIX[normalizePhase(phase, "general")] || AGENT_PREFIX.general;
  return bucket[kind] || AGENT_PREFIX.general[kind] || "";
}

function createLeaderRuntimeAgent(worker, task) {
  const phase = normalizePhase(task?.phase, inferWorkerPhases(worker)[0] || "implementation");
  const prefix = resolveAgentPrefix(phase, "leader");
  return {
    ...worker,
    runtimeId: `leader:${worker.id}`,
    displayLabel: `${prefix} · ${worker.label}`,
    agentKind: "leader",
    parentAgentId: null,
    phase,
    delegationDepth: 0
  };
}

function createSubordinateRuntimeAgent(leaderAgent, task, index) {
  const phase = normalizePhase(task?.phase, leaderAgent.phase || "implementation");
  const prefix = resolveAgentPrefix(phase, "subordinate");
  const ordinal = padAgentIndex(index + 1);
  return {
    ...leaderAgent,
    runtimeId: `${leaderAgent.runtimeId || leaderAgent.id}::${task.id}:${ordinal}`,
    displayLabel: `${prefix}${ordinal} · ${leaderAgent.label}`,
    agentKind: "subordinate",
    parentAgentId: leaderAgent.runtimeId,
    parentAgentLabel: leaderAgent.displayLabel,
    phase,
    delegationDepth: Math.max(0, Number(leaderAgent.delegationDepth || 0) + 1)
  };
}

function buildAgentEventBase(agent, task = null) {
  return {
    agentId: agent.runtimeId || agent.id,
    agentLabel: agent.displayLabel || agent.label || agent.id,
    agentKind: agent.agentKind || "leader",
    parentAgentId: agent.parentAgentId || "",
    parentAgentLabel: agent.parentAgentLabel || "",
    modelId: agent.id,
    modelLabel: agent.label,
    taskId: task?.id || "",
    taskTitle: task?.title || ""
  };
}

function emitAgentEvent(onEvent, agent, payload, task = null) {
  emitEvent(onEvent, {
    ...buildAgentEventBase(agent, task),
    ...payload
  });
}

function normalizeDelegationPlan(parsed, delegateCount, options = {}) {
  const defaultToRequested = options.defaultToRequested !== false;
  const preferDelegation = options.preferDelegation === true;
  const subtasks = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
  const explicitCount = Number(parsed?.delegateCount);
  const desiredCount =
    Number.isFinite(explicitCount) && explicitCount >= 0 && !(preferDelegation && explicitCount === 0 && !subtasks.length)
      ? Math.min(delegateCount, Math.floor(explicitCount))
      : subtasks.length
        ? Math.min(delegateCount, subtasks.length)
        : defaultToRequested
          ? delegateCount
          : 0;
  const normalizedSubtasks = subtasks
    .slice(0, desiredCount)
    .map((subtask, index) => ({
      id: safeString(subtask?.id) || `sub_${index + 1}`,
      title: safeString(subtask?.title) || `Subtask ${index + 1}`,
      instructions: safeString(subtask?.instructions) || `Handle part ${index + 1} of the assigned leader task.`,
      expectedOutput: safeString(subtask?.expectedOutput) || "Concrete specialist output."
    }));

  while (defaultToRequested && normalizedSubtasks.length < desiredCount) {
    const index = normalizedSubtasks.length;
    normalizedSubtasks.push({
      id: `sub_${index + 1}`,
      title: `Subtask ${index + 1}`,
      instructions: `Handle part ${index + 1} of the assigned leader task.`,
      expectedOutput: "Concrete specialist output."
    });
  }

  return {
    thinkingSummary: safeString(parsed?.thinkingSummary),
    delegationSummary: safeString(parsed?.delegationSummary),
      subtasks: normalizedSubtasks
  };
}

function summarizeExecutionForDependency(execution) {
  return {
    taskId: execution.taskId,
    title: execution.title,
    workerId: execution.workerId,
    workerLabel: execution.workerLabel,
    phase: execution.phase,
    status: execution.status,
    output: execution.output
  };
}

function summarizeSubordinateExecution(execution) {
  return {
    agentId: execution.agentId || execution.workerId,
    agentLabel: execution.agentLabel || execution.workerLabel || execution.workerId,
    status: execution.status,
    summary: execution.output?.summary || "",
    thinkingSummary: execution.output?.thinkingSummary || "",
    generatedFiles: execution.output?.generatedFiles || [],
    verifiedGeneratedFiles: execution.output?.verifiedGeneratedFiles || [],
    executedCommands: execution.output?.executedCommands || []
  };
}

function buildDefaultFallbackTasks(workers, originalTask) {
  return workers.map((worker, index) => {
    const phase = inferWorkerPhases(worker)[0] || "implementation";
    return {
      id: `task_${index + 1}`,
      phase,
      title: `${worker.label} ${phase} task`,
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: `Handle the user objective "${originalTask}" in your strongest specialty area.`,
      dependsOn: [],
      expectedOutput: "Structured findings with concrete artifacts where useful."
    };
  });
}

function injectWorkflowTasks(tasks, workers, originalTask) {
  const output = [...tasks];
  const implementationTasks = output.filter((task) => task.phase === "implementation");
  const validationWorkers = workers.filter((worker) => inferWorkerPhases(worker).includes("validation"));
  const codingManagerWorkers = validationWorkers.filter((worker) =>
    workerHasSpecialty(worker, "coding_manager")
  );
  const handoffWorkers = workers.filter((worker) => inferWorkerPhases(worker).includes("handoff"));

  if (
    implementationTasks.length &&
    !output.some((task) => task.phase === "validation") &&
    validationWorkers.length &&
    !codingManagerWorkers.length
  ) {
    const worker = pickBestWorkerForTask(validationWorkers, "validation", {
      title: "Validate generated workspace outputs",
      instructions: originalTask
    });
    output.push({
      id: "validation_gate",
      phase: "validation",
      title: "Validate generated outputs",
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions:
        "Review generated changes, run the most relevant safe tests or build commands in the workspace, and report whether the workflow result is actually usable.",
      dependsOn: implementationTasks.map((task) => task.id),
      expectedOutput: "Validation verdict with test/build results."
    });
  }

  if (
    implementationTasks.length &&
    codingManagerWorkers.length &&
    !output.some((task) => task.id === "coding_management_review")
  ) {
    const worker = pickBestWorkerForTask(codingManagerWorkers, "validation", {
      title: "Final code management review",
      instructions: originalTask,
      expectedOutput: "Final code review verdict with test/build results."
    });
    const validationDependencies = output
      .filter((task) => task.phase === "validation" && task.id !== "coding_management_review")
      .map((task) => task.id);

    output.push({
      id: "coding_management_review",
      phase: "validation",
      title: "Final code management review",
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions:
        "Perform the final code-management review for all implementation outputs. Review generated code and workspace changes, run the most relevant safe test, build, or lint commands, and report whether the coding results are cohesive and ready for handoff.",
      dependsOn: uniqueArray([
        ...implementationTasks.map((task) => task.id),
        ...validationDependencies
      ]),
      expectedOutput: "Final code review verdict with verification evidence and remaining risks."
    });
  }

  if (!output.some((task) => task.phase === "handoff") && handoffWorkers.length) {
    const worker = pickBestWorkerForTask(handoffWorkers, "handoff", {
      title: "Prepare handoff summary",
      instructions: originalTask
    });
    output.push({
      id: "handoff_summary",
      phase: "handoff",
      title: "Prepare handoff summary",
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions:
        "Prepare a concise user-facing handoff summary covering outcomes, remaining risks, and how to use the generated outputs.",
      dependsOn: output.filter((task) => task.phase !== "handoff").map((task) => task.id),
      expectedOutput: "Readable handoff notes."
    });
  }

  return output;
}

function normalizePlan(
  rawPlan,
  workers,
  originalTask,
  maxParallel,
  groupLeaderMaxDelegates,
  delegateMaxDepth
) {
  const workerIds = new Set(workers.map((worker) => worker.id));
  const fallbackTasks = buildDefaultFallbackTasks(workers, originalTask);

  const taskCandidates = Array.isArray(rawPlan?.tasks) && rawPlan.tasks.length ? rawPlan.tasks : fallbackTasks;
  const seenIds = new Set();
  const preliminaryTasks = taskCandidates
    .slice(0, Math.max(workers.length, maxParallel))
    .map((task, index) => {
    const preferredId = String(task?.id || `task_${index + 1}`).replace(/[^\w-]/g, "_");
    let taskId = preferredId || `task_${index + 1}`;
    while (seenIds.has(taskId)) {
      taskId = `${taskId}_${index + 1}`;
    }

    const requestedWorker = workerIds.has(task?.assignedWorker)
      ? workers.find((worker) => worker.id === String(task.assignedWorker))
      : workers[index % workers.length];
    const phase = inferPhase(task, requestedWorker);
    const assignedWorkerCandidate = requestedWorker || workers[index % workers.length];
    const reroutedWorker =
      scoreWorkerForTask(assignedWorkerCandidate, phase, task) > 0
        ? assignedWorkerCandidate
        : pickBestWorkerForTask(workers, phase, task) || assignedWorkerCandidate;
    seenIds.add(taskId);

    return {
      id: taskId,
      phase,
      title: String(task?.title || `Subtask ${index + 1}`),
      assignedWorker: reroutedWorker.id,
      delegateCount: resolveTaskDelegateCount(
        task,
        phase,
        groupLeaderMaxDelegates,
        delegateMaxDepth
      ),
      instructions: String(
        task?.instructions ||
          `Analyze the objective "${originalTask}" from your specialty and return concrete recommendations.`
      ),
      dependsOn: safeArray(task?.dependsOn),
      expectedOutput: String(task?.expectedOutput || "Structured specialist analysis.")
    };
  });

  const tasksWithWorkflow = injectWorkflowTasks(preliminaryTasks, workers, originalTask);
  const taskById = new Map(tasksWithWorkflow.map((task) => [task.id, task]));
  const tasks = tasksWithWorkflow
    .map((task) => ({
      ...task,
      dependsOn: safeArray(task.dependsOn).filter((dependencyId) => {
        const dependency = taskById.get(dependencyId);
        return dependency && phaseIndex(dependency.phase) <= phaseIndex(task.phase);
      })
    }))
    .sort((left, right) => {
      const phaseDelta = phaseIndex(left.phase) - phaseIndex(right.phase);
      if (phaseDelta !== 0) {
        return phaseDelta;
      }
      return left.id.localeCompare(right.id);
    });

  return {
    objective: String(rawPlan?.objective || originalTask),
    strategy: String(
      rawPlan?.strategy ||
        "Run the workflow in phases: research, implementation, validation, then handoff before the controller synthesizes the final answer."
    ),
    tasks
  };
}

function applyTaskOutputGuards(task, output, extras = {}) {
  const guarded = {
    ...output,
    keyFindings: uniqueArray(output?.keyFindings || []),
    risks: uniqueArray(output?.risks || []),
    deliverables: uniqueArray(output?.deliverables || []),
    followUps: uniqueArray(output?.followUps || []),
    generatedFiles: uniqueArray(output?.generatedFiles || []),
    verifiedGeneratedFiles: uniqueArray(output?.verifiedGeneratedFiles || []),
    workspaceActions: uniqueArray(output?.workspaceActions || []),
    executedCommands: uniqueArray(output?.executedCommands || []),
    delegationNotes: uniqueArray(output?.delegationNotes || [])
  };

  const actualGeneratedFiles = uniqueArray(
    Array.isArray(extras.actualGeneratedFiles)
      ? extras.actualGeneratedFiles
      : guarded.verifiedGeneratedFiles.length
        ? guarded.verifiedGeneratedFiles
        : guarded.generatedFiles
  );

  if (taskRequiresConcreteArtifact(task) && !actualGeneratedFiles.length) {
    guarded.verificationStatus = "failed";
    guarded.risks = uniqueArray([
      ...guarded.risks,
      "Task expected a concrete file artifact, but no generated file was verified in the workspace."
    ]);
    guarded.followUps = uniqueArray([
      ...guarded.followUps,
      "Write the requested artifact into the workspace and include it in generatedFiles."
    ]);
  }

  return guarded;
}

function normalizeWorkerResult(parsed, rawText, extras = {}) {
  return {
    thinkingSummary: String(parsed?.thinkingSummary || extras.thinkingSummary || ""),
    summary: String(parsed?.summary || rawText || "No summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    risks: safeArray(parsed?.risks),
    deliverables: safeArray(parsed?.deliverables),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    followUps: safeArray(parsed?.followUps),
    generatedFiles: uniqueArray([...(parsed?.generatedFiles || []), ...(extras.generatedFiles || [])]),
    verifiedGeneratedFiles: uniqueArray([
      ...(parsed?.verifiedGeneratedFiles || []),
      ...(extras.verifiedGeneratedFiles || [])
    ]),
    workspaceActions: uniqueArray([...(parsed?.workspaceActions || []), ...(extras.workspaceActions || [])]),
    executedCommands: uniqueArray([...(parsed?.executedCommands || []), ...(extras.executedCommands || [])]),
    verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus || extras.verificationStatus),
    delegationNotes: uniqueArray([...(parsed?.delegationNotes || []), ...(extras.delegationNotes || [])]),
    subordinateCount: Number(extras.subordinateCount || 0),
    subordinateResults: Array.isArray(extras.subordinateResults) ? extras.subordinateResults : []
  };
}

function normalizeSynthesis(parsed, rawText) {
  return {
    finalAnswer: String(parsed?.finalAnswer || rawText || "No final answer returned."),
    executiveSummary: safeArray(parsed?.executiveSummary),
    consensus: safeArray(parsed?.consensus),
    disagreements: safeArray(parsed?.disagreements),
    nextActions: safeArray(parsed?.nextActions)
  };
}

function createStructuredFallback(label, rawText, error) {
  return {
    thinkingSummary: "",
    summary: `${label} returned unstructured output.`,
    keyFindings: [rawText.slice(0, 2000)],
    risks: [String(error.message || error)],
    deliverables: [],
    confidence: "low",
    followUps: ["Tighten the prompt or use a model with more reliable JSON output."]
  };
}

function buildRetryPayload({ stage, model, retry, taskId = "", taskTitle = "" }) {
  return {
    type: "retry",
    stage,
    tone: "warning",
    modelId: model.id,
    modelLabel: model.displayLabel || model.label,
    agentId: model.runtimeId || model.id,
    agentLabel: model.displayLabel || model.label,
    agentKind: model.agentKind || "leader",
    parentAgentId: model.parentAgentId || "",
    parentAgentLabel: model.parentAgentLabel || "",
    taskId,
    taskTitle,
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
    nextDelayMs: retry.nextDelayMs,
    status: retry.status,
    detail: retry.message
  };
}

function resolveSubordinateConcurrency(agent, task, config, requestedCount) {
  const total = Math.max(1, Number(requestedCount) || 1);
  const phaseCap = resolvePhaseConcurrency(task?.phase, config?.cluster?.maxParallel, config);
  const subordinateCap = resolveSubordinateMaxParallel(config);

  if (task?.phase === "research" && agent?.webSearch) {
    return 1;
  }

  if (task?.phase === "handoff") {
    return 1;
  }

  const limits = [phaseCap, subordinateCap].filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, limits.length ? Math.min(total, ...limits) : total);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(normalizedItems.length);
  let nextIndex = 0;

  async function workerLoop() {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= normalizedItems.length) {
        return;
      }

      results[currentIndex] = await mapper(normalizedItems[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, normalizedItems.length) }, () => workerLoop())
  );

  return results;
}

async function executeSingleTask({
  task,
  originalTask,
  plan,
  completedResults,
  providerRegistry,
  config,
  onEvent,
  signal
}) {
  function buildDependencyOutputs() {
    return task.dependsOn
      .map((dependencyId) => completedResults.get(dependencyId))
      .filter(Boolean)
      .map((result) => ({
        taskId: result.taskId,
        workerId: result.workerId,
        status: result.status,
        output: result.output
      }));
  }

  function resolveLifecycleStages(agent) {
    if (agent.agentKind === "subordinate") {
      return {
        start: "subagent_start",
        done: "subagent_done",
        failed: "subagent_failed",
        retry: "subagent_retry"
      };
    }

    return {
      start: "worker_start",
      done: "worker_done",
      failed: "worker_failed",
      retry: "worker_retry"
    };
  }

  function buildFailureResult(agent, agentTask, error, startedAt) {
    const endedAt = Date.now();
    const output = applyTaskOutputGuards(
      agentTask,
      normalizeWorkerResult(
        {
          thinkingSummary: "",
          summary: `${agent.displayLabel || agent.label} execution failed: ${error.message}`,
          risks: [error.message],
          confidence: "low",
          followUps: ["Check the provider baseUrl, API key, and model id."]
        },
        "",
        {
          verificationStatus: agentTask.phase === "validation" ? "failed" : "not_applicable"
        }
      )
    );
    return {
      taskId: agentTask.id,
      title: agentTask.title,
      workerId: agent.id,
      workerLabel: agent.label,
      agentId: agent.runtimeId || agent.id,
      agentLabel: agent.displayLabel || agent.label,
      agentKind: agent.agentKind || "leader",
      phase: agentTask.phase,
      status: "failed",
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      rawText: "",
      output
    };
  }

  async function executeDirectAgentTask({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    emitLifecycle = true
  }) {
    throwIfAborted(signal);
    const lifecycle = resolveLifecycleStages(agent);
    const startedAt = Date.now();
    const prompt = buildWorkerExecutionRequest({
      originalTask,
      clusterPlan: plan,
      worker: agent,
      task: agentTask,
      dependencyOutputs
    });

    if (emitLifecycle) {
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: lifecycle.start,
          tone: "neutral"
        },
        agentTask
      );
    }

    try {
      let parsed;
      let rawText = "";
      if (config.workspace?.resolvedDir) {
        parsed = await runWorkspaceToolLoop({
          provider,
          worker: agent,
          task: agentTask,
          originalTask,
          clusterPlan: plan,
          dependencyOutputs,
          workspaceRoot: config.workspace.resolvedDir,
          onRetry(retry) {
            emitAgentEvent(
              onEvent,
              agent,
              {
                ...buildRetryPayload({
                  stage: lifecycle.retry,
                  model: agent,
                  retry,
                  taskId: agentTask.id,
                  taskTitle: agentTask.title
                }),
                agentKind: agent.agentKind || "leader"
              },
              agentTask
            );
          },
          onEvent,
          signal
        });
      } else {
        const response = await provider.invoke({
          instructions: prompt.instructions,
          input: prompt.input,
          purpose: agent.agentKind === "subordinate" ? "subordinate_execution" : "worker_execution",
          signal,
          onRetry(retry) {
            emitAgentEvent(
              onEvent,
              agent,
              {
                ...buildRetryPayload({
                  stage: lifecycle.retry,
                  model: agent,
                  retry,
                  taskId: agentTask.id,
                  taskTitle: agentTask.title
                }),
                agentKind: agent.agentKind || "leader"
              },
              agentTask
            );
          }
        });

        rawText = response.text;
        try {
          parsed = parseJsonFromText(response.text);
        } catch (error) {
          parsed = createStructuredFallback(agent.displayLabel || agent.label, response.text, error);
        }
      }

      const endedAt = Date.now();
      const output = applyTaskOutputGuards(
        agentTask,
        normalizeWorkerResult(parsed, rawText),
        {
          actualGeneratedFiles: parsed?.verifiedGeneratedFiles || parsed?.generatedFiles || []
        }
      );
      const result = {
        taskId: agentTask.id,
        title: agentTask.title,
        workerId: agent.id,
        workerLabel: agent.label,
        agentId: agent.runtimeId || agent.id,
        agentLabel: agent.displayLabel || agent.label,
        agentKind: agent.agentKind || "leader",
        phase: agentTask.phase,
        status: "completed",
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        rawText,
        output
      };

      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "status",
            stage: lifecycle.done,
            tone: "ok",
            thinkingSummary: result.output.thinkingSummary || ""
          },
          agentTask
        );
      }

      return result;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const result = buildFailureResult(agent, agentTask, error, startedAt);
      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "error",
            stage: lifecycle.failed,
            tone: "error",
            detail: error.message
          },
          agentTask
        );
      }
      return result;
    }
  }

  async function planLeaderDelegation({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    delegateCount,
    depthRemaining,
    defaultToRequested,
    preferDelegation
  }) {
    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "leader_delegate_start",
        tone: "neutral",
        detail: `Planning up to ${delegateCount} child agent(s) for this task.`
      },
      agentTask
    );

    const prompt = buildLeaderDelegationRequest({
      originalTask,
      clusterPlan: plan,
      leader: agent,
      task: agentTask,
      dependencyOutputs,
      delegateCount,
      depthRemaining
    });

    const response = await provider.invoke({
      instructions: prompt.instructions,
      input: prompt.input,
      purpose: "leader_delegation",
      signal,
      onRetry(retry) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            ...buildRetryPayload({
              stage: "leader_delegate_retry",
              model: agent,
              retry,
              taskId: agentTask.id,
              taskTitle: agentTask.title
            }),
            agentKind: agent.agentKind || "leader"
          },
          agentTask
        );
      }
    });

    let parsed;
    try {
      parsed = parseJsonFromText(response.text);
    } catch {
      parsed = null;
    }

    return normalizeDelegationPlan(parsed, delegateCount, {
      defaultToRequested,
      preferDelegation
    });
  }

  async function synthesizeLeaderResult({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    subordinateExecutions,
    delegationPlan,
    startedAt
  }) {
    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "leader_synthesis_start",
        tone: "neutral",
        detail: `Synthesizing ${subordinateExecutions.length} child result(s).`
      },
      agentTask
    );

    const prompt = buildLeaderSynthesisRequest({
      originalTask,
      clusterPlan: plan,
      leader: agent,
      task: agentTask,
      dependencyOutputs,
      subordinateResults: subordinateExecutions.map(summarizeExecutionForDependency)
    });

    const response = await provider.invoke({
      instructions: prompt.instructions,
      input: prompt.input,
      purpose: "leader_synthesis",
      signal,
      onRetry(retry) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            ...buildRetryPayload({
              stage: "leader_synthesis_retry",
              model: agent,
              retry,
              taskId: agentTask.id,
              taskTitle: agentTask.title
            }),
            agentKind: agent.agentKind || "leader"
          },
          agentTask
        );
      }
    });

    let parsed;
    try {
      parsed = parseJsonFromText(response.text);
    } catch (error) {
      parsed = createStructuredFallback(agent.displayLabel || agent.label, response.text, error);
    }

    const endedAt = Date.now();
    const mergedGeneratedFiles = subordinateExecutions.flatMap(
      (execution) => execution.output?.generatedFiles || []
    );
    const mergedVerifiedGeneratedFiles = subordinateExecutions.flatMap(
      (execution) => execution.output?.verifiedGeneratedFiles || execution.output?.generatedFiles || []
    );
    const mergedWorkspaceActions = subordinateExecutions.flatMap(
      (execution) => execution.output?.workspaceActions || []
    );
    const mergedCommands = subordinateExecutions.flatMap(
      (execution) => execution.output?.executedCommands || []
    );
    const totalDescendantCount = subordinateExecutions.reduce(
      (sum, execution) => sum + 1 + Number(execution.output?.subordinateCount || 0),
      0
    );
    const derivedVerification =
      agentTask.phase === "validation" &&
      subordinateExecutions.some((execution) => execution.output?.verificationStatus === "failed")
        ? "failed"
        : agentTask.phase === "validation" &&
            subordinateExecutions.length &&
            subordinateExecutions.every((execution) => execution.output?.verificationStatus === "passed")
          ? "passed"
          : "not_applicable";
    const output = applyTaskOutputGuards(
      agentTask,
      normalizeWorkerResult(parsed, response.text, {
        delegationNotes: [
          delegationPlan.delegationSummary,
          ...subordinateExecutions
            .filter((execution) => execution.status === "failed")
            .map((execution) => `${execution.agentLabel || execution.workerLabel} failed`)
        ],
        generatedFiles: mergedGeneratedFiles,
        verifiedGeneratedFiles: mergedVerifiedGeneratedFiles,
        workspaceActions: mergedWorkspaceActions,
        executedCommands: mergedCommands,
        subordinateCount: totalDescendantCount,
        subordinateResults: subordinateExecutions.map(summarizeSubordinateExecution),
        verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus || derivedVerification)
      }),
      {
        actualGeneratedFiles: mergedVerifiedGeneratedFiles
      }
    );

    return {
      taskId: agentTask.id,
      title: agentTask.title,
      workerId: agent.id,
      workerLabel: agent.label,
      agentId: agent.runtimeId || agent.id,
      agentLabel: agent.displayLabel || agent.label,
      agentKind: agent.agentKind || "leader",
      phase: agentTask.phase,
      status: subordinateExecutions.some((execution) => execution.status === "failed") ? "failed" : "completed",
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      rawText: response.text,
      output
    };
  }

  throwIfAborted(signal);
  const worker = config.models[task.assignedWorker];
  const provider = providerRegistry.get(task.assignedWorker);
  if (!provider) {
    throw new Error(`No provider found for worker "${task.assignedWorker}".`);
  }

  const dependencyOutputs = buildDependencyOutputs();
  const leaderAgent = createLeaderRuntimeAgent(worker, task);
  const branchFactor = resolveGroupLeaderMaxDelegates(config);
  const maxDelegationDepth = resolveDelegateMaxDepth(config);

  async function executeAgentHierarchy({
    agent,
    agentTask,
    dependencyOutputs,
    preferredDelegateCount = 0,
    depthRemaining = 0,
    defaultToRequested = false,
    emitLifecycle = true
  }) {
    throwIfAborted(signal);
    const lifecycle = resolveLifecycleStages(agent);
    const startedAt = Date.now();

    if (emitLifecycle) {
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: lifecycle.start,
          tone: "neutral",
          detail:
            preferredDelegateCount > 0 && depthRemaining > 0
              ? `Execution started with delegation budget ${preferredDelegateCount} and remaining depth ${depthRemaining}.`
              : "Execution started."
        },
        agentTask
      );
    }

    try {
      const requestedDelegateCount =
        depthRemaining > 0
          ? normalizeDelegateCount(preferredDelegateCount, branchFactor)
          : 0;

      if (!requestedDelegateCount) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || ""
            },
            agentTask
          );
        }
        return directResult;
      }

      const delegationPlan = await planLeaderDelegation({
        agent,
        provider,
        agentTask,
        dependencyOutputs,
        delegateCount: requestedDelegateCount,
        depthRemaining: Math.max(0, depthRemaining - 1),
        defaultToRequested,
        preferDelegation: shouldPreferDelegation(
          agentTask,
          agentTask.phase,
          branchFactor,
          depthRemaining
        )
      });

      if (!delegationPlan.subtasks.length) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || ""
            },
            agentTask
          );
        }
        return directResult;
      }

      const subordinateConcurrency = resolveSubordinateConcurrency(
        agent,
        agentTask,
        config,
        delegationPlan.subtasks.length
      );
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: "leader_delegate_done",
          tone: "ok",
          detail:
            subordinateConcurrency === 1
              ? `Delegated ${delegationPlan.subtasks.length} child task(s); execution continues sequentially.`
              : `Delegated ${delegationPlan.subtasks.length} child task(s); child concurrency cap is ${subordinateConcurrency}.`,
          thinkingSummary: delegationPlan.thinkingSummary || ""
        },
        agentTask
      );

      const childPreferredDelegateCount = depthRemaining > 1 ? branchFactor : 0;
      const subordinateExecutions = await mapWithConcurrency(
        delegationPlan.subtasks,
        subordinateConcurrency,
        async (subtask, index) => {
          const subordinateTask = {
            id: `${agentTask.id}__${subtask.id}`,
            phase: agentTask.phase,
            title: subtask.title,
            assignedWorker: agentTask.assignedWorker,
            delegateCount: childPreferredDelegateCount,
            instructions: subtask.instructions,
            dependsOn: [],
            expectedOutput: subtask.expectedOutput
          };
          const subordinateAgent = createSubordinateRuntimeAgent(agent, subordinateTask, index);
          emitAgentEvent(
            onEvent,
            subordinateAgent,
            {
              type: "status",
              stage: "subagent_created",
              tone: "neutral",
              detail: `Created child agent for: ${subtask.title}`,
              thinkingSummary: delegationPlan.thinkingSummary || ""
            },
            subordinateTask
          );

          return executeAgentHierarchy({
            agent: subordinateAgent,
            agentTask: subordinateTask,
            dependencyOutputs,
            preferredDelegateCount: childPreferredDelegateCount,
            depthRemaining: Math.max(0, depthRemaining - 1),
            defaultToRequested: false
          });
        }
      );

      const result = await synthesizeLeaderResult({
        agent,
        provider,
        agentTask,
        dependencyOutputs,
        subordinateExecutions,
        delegationPlan,
        startedAt
      });

      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "status",
            stage: lifecycle.done,
            tone: result.status === "failed" ? "warning" : "ok",
            thinkingSummary: result.output.thinkingSummary || ""
          },
          agentTask
        );
      }
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const result = buildFailureResult(agent, agentTask, error, startedAt);
      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "error",
            stage: lifecycle.failed,
            tone: "error",
            detail: error.message
          },
          agentTask
        );
      }
      return result;
    }
  }

  const preferredDelegateCount = normalizeDelegateCount(task.delegateCount, branchFactor);
  return executeAgentHierarchy({
    agent: leaderAgent,
    agentTask: task,
    dependencyOutputs,
    preferredDelegateCount,
    depthRemaining: maxDelegationDepth,
    defaultToRequested: preferredDelegateCount > 0
  });
}

async function executePlan(plan, originalTask, config, providerRegistry, onEvent, signal) {
  const pending = new Map(plan.tasks.map((task) => [task.id, task]));
  const running = new Map();
  const completedResults = new Map();
  const maxParallel = config.cluster.maxParallel;
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));

  for (const phase of PHASE_ORDER) {
    throwIfAborted(signal);
    const phaseTasks = Array.from(pending.values()).filter((task) => task.phase === phase);
    if (!phaseTasks.length) {
      continue;
    }

    const phaseMaxParallel = resolvePhaseConcurrency(phase, maxParallel, config);

    emitEvent(onEvent, {
      type: "status",
      stage: "phase_start",
      tone: "neutral",
      phase,
      detail: `Entering ${phase} phase.`
    });

    while (phaseTasks.some((task) => !completedResults.has(task.id))) {
      throwIfAborted(signal);
      for (const task of phaseTasks) {
        if (
          running.size >= phaseMaxParallel ||
          completedResults.has(task.id) ||
          running.has(task.id)
        ) {
          continue;
        }

        const ready = task.dependsOn.every((dependencyId) => completedResults.has(dependencyId));
        if (!ready) {
          continue;
        }

        if (!canStartTaskForPhase(task, running.keys(), taskById, config)) {
          continue;
        }

        pending.delete(task.id);
        const promise = executeSingleTask({
          task,
          originalTask,
          plan,
          completedResults,
          providerRegistry,
          config,
          onEvent,
          signal
        }).then((result) => ({ taskId: task.id, result }));
        running.set(task.id, promise);
      }

      if (!running.size) {
        const blocked = phaseTasks
          .filter((task) => !completedResults.has(task.id))
          .map((task) => ({
            taskId: task.id,
            phase: task.phase,
            dependsOn: task.dependsOn
          }));
        throw new Error(
          `Workflow phase "${phase}" contains unresolved dependencies: ${JSON.stringify(blocked)}`
        );
      }

      let settled;
      try {
        settled = await Promise.race(running.values());
      } catch (error) {
        await Promise.allSettled(running.values());
        throw error;
      }
      running.delete(settled.taskId);
      completedResults.set(settled.taskId, settled.result);
    }

    const phaseResults = phaseTasks
      .map((task) => completedResults.get(task.id))
      .filter(Boolean);

    emitEvent(onEvent, {
      type: "status",
      stage: "phase_done",
      tone: "ok",
      phase,
      detail: `Completed ${phase} phase with ${phaseResults.length} task(s).`
    });

    if (
      phase === "validation" &&
      phaseResults.some((result) => result.output?.verificationStatus === "failed")
    ) {
      emitEvent(onEvent, {
        type: "status",
        stage: "validation_gate_failed",
        tone: "warning",
        detail: "Validation phase reported failures. Final synthesis will highlight verification risks."
      });
    }
  }

  return plan.tasks.map((task) => completedResults.get(task.id));
}

export async function runClusterAnalysis({ task, config, providerRegistry, onEvent, signal }) {
  const originalTask = String(task || "").trim();
  if (!originalTask) {
    throw new Error("Task input cannot be empty.");
  }

  throwIfAborted(signal);
  const startedAt = Date.now();
  const controllerId = config.cluster.controller;
  const controller = config.models[controllerId];
  const controllerProvider = providerRegistry.get(controllerId);
  if (!controllerProvider) {
    throw new Error(`No provider found for controller "${controllerId}".`);
  }

  const workers = workerListFromConfig(config);
  const workspaceSummary = config.workspace?.resolvedDir
    ? await getWorkspaceTree(config.workspace.resolvedDir)
    : null;
  const planningPrompt = buildPlanningRequest({
    task: originalTask,
    workers,
    maxParallel: config.cluster.maxParallel,
    workspaceSummary,
    delegateMaxDepth: config.cluster.delegateMaxDepth,
    delegateBranchFactor: config.cluster.groupLeaderMaxDelegates
  });

  emitEvent(onEvent, {
    type: "status",
    stage: "planning_start",
    tone: "neutral",
    agentId: controller.id,
    agentLabel: controller.label,
    agentKind: "controller",
    modelId: controller.id,
    modelLabel: controller.label
  });

  const planningResponse = await controllerProvider.invoke({
    instructions: planningPrompt.instructions,
    input: planningPrompt.input,
    purpose: "planning",
    signal,
    onRetry(retry) {
      emitEvent(
        onEvent,
        buildRetryPayload({
          stage: "planning_retry",
          model: controller,
          retry
        })
      );
    }
  });

  let rawPlan;
  try {
    rawPlan = parseJsonFromText(planningResponse.text);
  } catch {
    rawPlan = null;
  }

  const groupLeaderMaxDelegates = resolveGroupLeaderMaxDelegates(config);
  const plan = normalizePlan(
    rawPlan,
    workers,
    originalTask,
    config.cluster.maxParallel,
    groupLeaderMaxDelegates,
    config.cluster.delegateMaxDepth
  );

  emitEvent(onEvent, {
    type: "status",
    stage: "planning_done",
    tone: "ok",
    agentId: controller.id,
    agentLabel: controller.label,
    agentKind: "controller",
    modelId: controller.id,
    modelLabel: controller.label,
    taskCount: plan.tasks.length,
    detail: plan.strategy,
    planStrategy: plan.strategy,
    planTasks: plan.tasks.map((taskItem) => ({
      id: taskItem.id,
      title: taskItem.title,
      phase: taskItem.phase,
      assignedWorker: taskItem.assignedWorker,
      delegateCount: taskItem.delegateCount
    }))
  });

  const executions = await executePlan(plan, originalTask, config, providerRegistry, onEvent, signal);

  const synthesisPrompt = buildSynthesisRequest({
    task: originalTask,
    plan,
    executions
  });

  emitEvent(onEvent, {
    type: "status",
    stage: "synthesis_start",
    tone: "neutral",
    agentId: controller.id,
    agentLabel: controller.label,
    agentKind: "controller",
    modelId: controller.id,
    modelLabel: controller.label
  });

  const synthesisResponse = await controllerProvider.invoke({
    instructions: synthesisPrompt.instructions,
    input: synthesisPrompt.input,
    purpose: "synthesis",
    signal,
    onRetry(retry) {
      emitEvent(
        onEvent,
        buildRetryPayload({
          stage: "synthesis_retry",
          model: controller,
          retry
        })
      );
    }
  });

  let synthesisParsed;
  try {
    synthesisParsed = parseJsonFromText(synthesisResponse.text);
  } catch {
    synthesisParsed = null;
  }

  const normalizedSynthesis = normalizeSynthesis(synthesisParsed, synthesisResponse.text);
  const totalMs = Date.now() - startedAt;
  emitEvent(onEvent, {
    type: "complete",
    stage: "cluster_done",
    tone: "ok",
    agentId: controller.id,
    agentLabel: controller.label,
    agentKind: "controller",
    modelId: controller.id,
    modelLabel: controller.label,
    totalMs,
    finalAnswer: normalizedSynthesis.finalAnswer,
    executiveSummary: normalizedSynthesis.executiveSummary
  });

  return {
    plan,
    executions,
    synthesis: normalizedSynthesis,
    controller: {
      id: controller.id,
      label: controller.label,
      model: controller.model
    },
    timings: {
      totalMs
    }
  };
}

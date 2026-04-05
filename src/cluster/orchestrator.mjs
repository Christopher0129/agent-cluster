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
import { createSessionRuntime } from "../session/runtime.mjs";
import {
  buildRetryPayload,
  invokeProviderWithSession
} from "./provider-session.mjs";
import {
  createMultiAgentRuntime,
  normalizeMultiAgentRuntimeSettings
} from "./multi-agent-runtime.mjs";
import {
  buildComplexityBudget,
  createRunAgentBudget,
  normalizeCapabilityRoutingPolicy,
  resolveEffectiveDelegateMaxDepth,
  resolveEffectiveGroupLeaderMaxDelegates,
  resolveTopLevelTaskLimit,
  summarizeCapabilityRoutingPolicy
} from "./policies.mjs";
import { deriveTaskRequirements } from "../workspace/task-requirements.mjs";

const PHASE_ORDER = ["research", "implementation", "validation", "handoff"];
const DEFAULT_SUBORDINATE_MAX_PARALLEL = 3;
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const PHASE_CONCURRENCY_CAPS = {};
const RETRYABLE_PROVIDER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
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
  const candidates = Object.values(config.models).filter(
    (model) => model.id !== config.cluster.controller
  );
  const workerCapableCandidates = candidates.filter((model) => modelCanActAsWorker(model));
  return workerCapableCandidates.length ? workerCapableCandidates : candidates;
}

function modelListFromConfig(config) {
  return Object.values(config?.models || {});
}

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeModelRole(value, fallback = "") {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "both" || trimmed === "dual" || trimmed === "dual-role" || trimmed === "dual_role") {
    return "hybrid";
  }

  return ["controller", "worker", "hybrid"].includes(trimmed) ? trimmed : fallback;
}

function inferModelRole(worker) {
  const explicitRole = normalizeModelRole(worker?.role);
  if (explicitRole) {
    return explicitRole;
  }

  return workerHasSpecialty(worker, "controller") ? "controller" : "worker";
}

function modelCanActAsController(worker) {
  const role = inferModelRole(worker);
  return role === "controller" || role === "hybrid";
}

function modelCanActAsWorker(worker) {
  const role = inferModelRole(worker);
  return role === "worker" || role === "hybrid";
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

function resolveSharedResearchGatewayMaxParallel(config) {
  const configured = Number(config?.cluster?.sharedResearchGatewayMaxParallel);
  if (!Number.isFinite(configured) || configured < 0) {
    return 0;
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
  const compactText = text.replace(/\s+/g, " ").trim();
  const hasScaleSignal = /(compare|survey|collect|batch|multiple|parallel|delegate|split|across|recursive|non-overlapping|several|\u591a\u4e2a|\u5e76\u884c|\u62c6\u5206|\u6279\u91cf|\u9012\u5f52|\u59d4\u6d3e)/.test(
    text
  );

  if (normalizedPhase === "handoff") {
    return true;
  }

  if (/(atomic|single file|single document|single report|one file|one document|one report|directly|handle directly|\u539f\u5b50|\u5355\u6587\u4ef6|\u5355\u6587\u6863|\u76f4\u63a5\u5904\u7406)/.test(text)) {
    return true;
  }

  return Boolean(compactText) && compactText.length <= 96 && !hasScaleSignal;
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

function taskLooksCodeReview(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return /(\bcode review\b|\breview generated code\b|\bfinal review\b|\bcoding[- ]manager\b|\bmanager review\b|\breview all generated code\b|\u4ee3\u7801\u590d\u6838|\u4ee3\u7801\u8bc4\u5ba1|\u5ba1\u67e5\u4ee3\u7801|\u6700\u7ec8\u590d\u6838)/.test(
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

function taskNeedsFreshFacts(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return /(\blatest\b|\brecent\b|\bcurrent\b|\btoday\b|\byesterday\b|\btomorrow\b|\breal[- ]time\b|\bannouncement\b|\bmarket\b|\bquote\b|\bfact[- ]check\b|\bverify\b|\bverification\b|\bsource\b|\bbrowse\b|\bweb\b|\bsearch\b|\bresearch\b|\bnews\b|\b行情\b|\b公告\b|\b最新\b|\b最近\b|\b实时\b|\b核验\b|\b验证\b|\b来源\b|\b网页\b|\b搜索\b|\b交易日\b|\b市场\b)/.test(
    text
  );
}

function filterWorkersForTask(workers, phase, task, capabilityRoutingPolicy) {
  const policy = normalizeCapabilityRoutingPolicy(capabilityRoutingPolicy);
  let eligibleWorkers = Array.isArray(workers) ? workers.slice() : [];
  if (!eligibleWorkers.length) {
    return [];
  }

  const workersWithWebSearch = eligibleWorkers.filter((worker) => worker?.webSearch);
  if (
    phase === "research" &&
    taskNeedsFreshFacts(task) &&
    policy.requireWebSearchForFreshFacts &&
    workersWithWebSearch.length
  ) {
    eligibleWorkers = workersWithWebSearch;
  }

  if (phase === "validation" && policy.requireValidationSpecialistForValidation) {
    const validationSpecialists = eligibleWorkers.filter((worker) =>
      inferWorkerPhases(worker).includes("validation")
    );
    if (validationSpecialists.length) {
      eligibleWorkers = validationSpecialists;
    }
  }

  if (
    phase === "validation" &&
    taskLooksCodeReview(task) &&
    policy.requireCodingManagerForCodeReview
  ) {
    const codingManagers = eligibleWorkers.filter((worker) =>
      workerHasSpecialty(worker, "coding_manager")
    );
    if (codingManagers.length) {
      eligibleWorkers = codingManagers;
    }
  }

  if (phase === "handoff" && policy.requirePhaseSpecialistForHandoff) {
    const handoffSpecialists = eligibleWorkers.filter((worker) =>
      inferWorkerPhases(worker).includes("handoff")
    );
    if (handoffSpecialists.length) {
      eligibleWorkers = handoffSpecialists;
    }
  }

  return eligibleWorkers;
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

function scoreWorkerForTask(worker, phase, task, capabilityRoutingPolicy = null) {
  const policy = normalizeCapabilityRoutingPolicy(capabilityRoutingPolicy);
  const workerPhases = inferWorkerPhases(worker);
  const specialties = safeArray(worker?.specialties).map((item) => item.toLowerCase());
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  let score = workerPhases.includes(phase) ? 10 : 0;

  if (phase === "research" && worker?.webSearch) {
    score += 4;
  }
  if (phase === "research" && policy.preferWebSearchForResearch && worker?.webSearch) {
    score += 4;
  }

  if (phase === "implementation" && String(worker?.model || "").toLowerCase().includes("codex")) {
    score += 4;
  }
  if (
    phase === "implementation" &&
    policy.preferCodexForImplementation &&
    String(worker?.model || "").toLowerCase().includes("codex")
  ) {
    score += 4;
  }

  if (phase === "validation" && workerHasSpecialty(worker, "coding_manager") && taskLooksCodeReview(task)) {
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

function normalizeStatusCode(value) {
  const status = Number(value);
  return Number.isFinite(status) && status > 0 ? Math.floor(status) : 0;
}

function isRetryableProviderStatus(status) {
  return RETRYABLE_PROVIDER_STATUSES.has(normalizeStatusCode(status));
}

function looksLikeRetryableProviderMessage(message) {
  const text = safeString(message).toLowerCase();
  if (!text) {
    return false;
  }

  return /timed out|timeout|gateway|bad gateway|service unavailable|temporarily down|upstream|rate limit|429|fetch failed|network|econnreset|econnrefused|socket|enotfound|eai_again|other side closed|circuit breaker/.test(
    text
  );
}

function classifyProviderTaskError(error, worker = null, sessionRuntime = null) {
  const status = normalizeStatusCode(error?.status);
  const errorMessage = safeString(error?.message || error);
  const retryableFromStatus = isRetryableProviderStatus(status);
  const retryableFromFlag = Boolean(error?.retryable);
  const retryableFromMessage = looksLikeRetryableProviderMessage(errorMessage);
  const circuitState = safeString(sessionRuntime?.getCircuitState?.(worker?.id)?.state);
  const retryableFromCircuit = /circuit breaker|circuit for/i.test(errorMessage);
  const retryableProviderFailure =
    retryableFromFlag || retryableFromStatus || retryableFromMessage || retryableFromCircuit;
  const providerFailure =
    retryableProviderFailure ||
    status > 0 ||
    /request to https?:\/\//i.test(errorMessage) ||
    /provider/i.test(errorMessage);

  return {
    failureKind: retryableProviderFailure ? "provider_retryable" : providerFailure ? "provider" : "task",
    retryableProviderFailure,
    providerFailure,
    errorStatus: status || null,
    errorMessage,
    circuitState
  };
}

function normalizeWorkerBaseUrl(worker) {
  return safeString(worker?.baseUrl).toLowerCase();
}

function normalizeWorkerProvider(worker) {
  return safeString(worker?.provider).toLowerCase();
}

function createControllerRuntimeAgent(modelConfig, currentRuntimeAgent = null) {
  return {
    ...modelConfig,
    runtimeId:
      currentRuntimeAgent?.runtimeId ||
      `controller:${currentRuntimeAgent?.id || modelConfig.id}`,
    displayLabel: modelConfig.label || modelConfig.id,
    agentKind: "controller",
    parentAgentId: null,
    parentAgentLabel: "",
    phase: "controller",
    delegationDepth: 0,
    ordinalIndex: 0
  };
}

function rebindControllerRuntimeAgent(agent, modelConfig) {
  return createControllerRuntimeAgent(modelConfig, agent);
}

function scoreControllerCandidateForPurpose(worker, purpose, primaryController) {
  const phases = inferWorkerPhases(worker);
  let score = 0;

  if (modelCanActAsController(worker)) {
    score += 10;
  }

  if (purpose === "planning") {
    if (phases.includes("research")) {
      score += 4;
    }
    if (phases.includes("validation")) {
      score += 2;
    }
    if (phases.includes("handoff")) {
      score += 1;
    }
    if (worker?.webSearch) {
      score += 1;
    }
  } else if (purpose === "synthesis") {
    if (phases.includes("handoff")) {
      score += 6;
    }
    if (phases.includes("validation")) {
      score += 2;
    }
    if (phases.includes("research")) {
      score += 1;
    }
  }

  if (
    normalizeWorkerBaseUrl(worker) &&
    normalizeWorkerBaseUrl(worker) !== normalizeWorkerBaseUrl(primaryController)
  ) {
    score += 6;
  }

  if (
    normalizeWorkerProvider(worker) &&
    normalizeWorkerProvider(worker) !== normalizeWorkerProvider(primaryController)
  ) {
    score += 3;
  }

  return score;
}

function rankFallbackControllers({
  models,
  primaryController,
  purpose,
  providerRegistry
}) {
  const candidates = (Array.isArray(models) ? models : []).filter(
    (modelConfig) =>
      modelConfig?.id &&
      modelConfig.id !== primaryController?.id &&
      providerRegistry?.get(modelConfig.id)
  );
  const controllerSpecialists = candidates.filter((modelConfig) =>
    modelCanActAsController(modelConfig)
  );
  const eligibleCandidates = controllerSpecialists.length ? controllerSpecialists : candidates;

  return eligibleCandidates
    .sort((left, right) => {
      const leftScore = scoreControllerCandidateForPurpose(left, purpose, primaryController);
      const rightScore = scoreControllerCandidateForPurpose(right, purpose, primaryController);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return safeString(left.label || left.id).localeCompare(safeString(right.label || right.id));
    });
}

function rankFallbackWorkersForTask({
  workers,
  primaryWorker,
  phase,
  task,
  capabilityRoutingPolicy,
  providerRegistry
}) {
  const eligibleWorkers = filterWorkersForTask(
    Array.isArray(workers) ? workers : [],
    phase,
    task,
    capabilityRoutingPolicy
  );
  const primaryBaseUrl = normalizeWorkerBaseUrl(primaryWorker);
  const primaryProvider = normalizeWorkerProvider(primaryWorker);

  return eligibleWorkers
    .filter(
      (worker) =>
        worker?.id &&
        worker.id !== primaryWorker?.id &&
        providerRegistry?.get(worker.id)
    )
    .sort((left, right) => {
      const leftScore =
        scoreWorkerForTask(left, phase, task, capabilityRoutingPolicy) +
        (normalizeWorkerBaseUrl(left) && normalizeWorkerBaseUrl(left) !== primaryBaseUrl ? 6 : 0) +
        (normalizeWorkerProvider(left) && normalizeWorkerProvider(left) !== primaryProvider ? 3 : 0);
      const rightScore =
        scoreWorkerForTask(right, phase, task, capabilityRoutingPolicy) +
        (normalizeWorkerBaseUrl(right) && normalizeWorkerBaseUrl(right) !== primaryBaseUrl ? 6 : 0) +
        (normalizeWorkerProvider(right) && normalizeWorkerProvider(right) !== primaryProvider ? 3 : 0);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return safeString(left.label).localeCompare(safeString(right.label));
    });
}

function pickBestWorkerForTask(workers, phase, task, capabilityRoutingPolicy = null) {
  const eligibleWorkers = filterWorkersForTask(workers, phase, task, capabilityRoutingPolicy);
  const candidateWorkers = eligibleWorkers.length ? eligibleWorkers : [...workers];
  return [...candidateWorkers]
    .sort(
      (left, right) =>
        scoreWorkerForTask(right, phase, task, capabilityRoutingPolicy) -
        scoreWorkerForTask(left, phase, task, capabilityRoutingPolicy)
    )[0];
}

function normalizeConcurrencyLimit(value, fallback = 1) {
  const configured = Number(value);
  if (!Number.isFinite(configured) || configured < 0) {
    return fallback;
  }

  return Math.floor(configured);
}

function formatConcurrencyLimit(limit) {
  return Number.isFinite(limit) && limit > 0 ? String(limit) : "unlimited";
}

function createExecutionGate(maxParallel) {
  const normalizedLimit = normalizeConcurrencyLimit(maxParallel, 1);
  if (normalizedLimit === 0) {
    return {
      limit: Number.POSITIVE_INFINITY,
      async run(work, { signal } = {}) {
        throwIfAborted(signal);
        return work();
      }
    };
  }

  let active = 0;
  const queue = [];

  function createRelease() {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      active = Math.max(0, active - 1);

      while (queue.length && active < normalizedLimit) {
        const waiter = queue.shift();
        if (!waiter || waiter.cancelled) {
          continue;
        }

        waiter.cleanup?.();
        waiter.cleanup = null;
        active += 1;
        waiter.resolve(createRelease());
        break;
      }
    };
  }

  function acquire(signal) {
    throwIfAborted(signal);

    if (active < normalizedLimit) {
      active += 1;
      return Promise.resolve(createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cancelled: false,
        cleanup: null
      };

      const abortHandler = () => {
        waiter.cancelled = true;
        const index = queue.indexOf(waiter);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        waiter.cleanup?.();
        waiter.cleanup = null;
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", abortHandler);
      }

      queue.push(waiter);
    });
  }

  return {
    limit: normalizedLimit,
    async run(work, { signal } = {}) {
      const release = await acquire(signal);

      try {
        throwIfAborted(signal);
        return await work();
      } finally {
        release();
      }
    }
  };
}

function resolvePhaseConcurrency(phase, maxParallel, config) {
  const configuredCap = Number(config?.cluster?.phaseParallel?.[phase]);
  const hardCap =
    Number.isFinite(configuredCap) && configuredCap >= 0
      ? Math.floor(configuredCap)
      : PHASE_CONCURRENCY_CAPS[phase] ?? 0;
  const clusterCap = normalizeConcurrencyLimit(maxParallel, 1);

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

  const sharedGatewayCap = resolveSharedResearchGatewayMaxParallel(config);
  if (sharedGatewayCap === 0) {
    return true;
  }

  return (
    countRunningResearchTasksForBaseUrl(runningTaskIds, taskById, config, baseUrl) < sharedGatewayCap
  );
}

function resolveAgentPrefix(phase, kind) {
  const bucket = AGENT_PREFIX[normalizePhase(phase, "general")] || AGENT_PREFIX.general;
  return bucket[kind] || AGENT_PREFIX.general[kind] || "";
}

function buildRuntimeDisplayLabel(worker, phase, kind, ordinalIndex = 0) {
  const prefix = resolveAgentPrefix(phase, kind);
  if (kind === "subordinate") {
    return `${prefix}${padAgentIndex(Math.max(1, Number(ordinalIndex) || 1))} 路 ${worker.label}`;
  }

  return `${prefix} 路 ${worker.label}`;
}

function formatRuntimeDisplayLabel(worker, phase, kind, ordinalIndex = 0) {
  const prefix = resolveAgentPrefix(phase, kind);
  if (kind === "subordinate") {
    return `${prefix}${padAgentIndex(Math.max(1, Number(ordinalIndex) || 1))} · ${worker.label}`;
  }

  return `${prefix} · ${worker.label}`;
}

function createLeaderRuntimeAgent(worker, task) {
  const phase = normalizePhase(task?.phase, inferWorkerPhases(worker)[0] || "implementation");
  return {
    ...worker,
    runtimeId: `leader:${worker.id}`,
    displayLabel: formatRuntimeDisplayLabel(worker, phase, "leader"),
    agentKind: "leader",
    parentAgentId: null,
    phase,
    delegationDepth: 0,
    ordinalIndex: 0
  };
}

function createSubordinateRuntimeAgent(leaderAgent, task, index) {
  const phase = normalizePhase(task?.phase, leaderAgent.phase || "implementation");
  const ordinalIndex = index + 1;
  return {
    ...leaderAgent,
    runtimeId: `${leaderAgent.runtimeId || leaderAgent.id}::${task.id}:${padAgentIndex(ordinalIndex)}`,
    displayLabel: formatRuntimeDisplayLabel(leaderAgent, phase, "subordinate", ordinalIndex),
    agentKind: "subordinate",
    parentAgentId: leaderAgent.runtimeId,
    parentAgentLabel: leaderAgent.displayLabel,
    phase,
    delegationDepth: Math.max(0, Number(leaderAgent.delegationDepth || 0) + 1),
    ordinalIndex
  };
}

function rebindRuntimeAgent(agent, worker) {
  const agentKind = safeString(agent?.agentKind) || "leader";
  const phase = normalizePhase(agent?.phase, inferWorkerPhases(worker)[0] || "implementation");
  return {
    ...worker,
    runtimeId: agent.runtimeId || `${agentKind}:${worker.id}`,
    displayLabel: formatRuntimeDisplayLabel(worker, phase, agentKind, agent.ordinalIndex),
    agentKind,
    parentAgentId: agent.parentAgentId || null,
    parentAgentLabel: agent.parentAgentLabel || "",
    phase,
    delegationDepth: Math.max(0, Number(agent.delegationDepth || 0)),
    ordinalIndex: Math.max(0, Number(agent.ordinalIndex || 0))
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
        "Review only the files and artifacts explicitly produced by upstream implementation tasks unless dependency outputs require a broader workspace inspection. Ignore unrelated pre-existing workspace files, run the most relevant safe tests or build commands for the produced outputs, and report whether the workflow result is actually usable.",
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
        "Perform the final code-management review for all implementation outputs. Focus first on files and artifacts explicitly produced by upstream implementation tasks, ignore unrelated pre-existing workspace files unless a dependency output points to them, run the most relevant safe test, build, or lint commands for those outputs, and report whether the coding results are cohesive and ready for handoff.",
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
  topLevelTaskLimit,
  groupLeaderMaxDelegates,
  delegateMaxDepth,
  capabilityRoutingPolicy = null,
  multiAgentConfig = null
) {
  const workerIds = new Set(workers.map((worker) => worker.id));
  const fallbackTasks = buildDefaultFallbackTasks(workers, originalTask);

  const taskCandidates = Array.isArray(rawPlan?.tasks) && rawPlan.tasks.length ? rawPlan.tasks : fallbackTasks;
  const seenIds = new Set();
  const preliminaryTasks = taskCandidates
    .slice(0, Math.max(1, Number(topLevelTaskLimit) || 1))
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
    const eligibleWorkers = filterWorkersForTask(
      workers,
      phase,
      task,
      capabilityRoutingPolicy
    );
    const reroutedWorker =
      eligibleWorkers.includes(assignedWorkerCandidate) &&
      scoreWorkerForTask(assignedWorkerCandidate, phase, task, capabilityRoutingPolicy) > 0
        ? assignedWorkerCandidate
        : pickBestWorkerForTask(
            eligibleWorkers.length ? eligibleWorkers : workers,
            phase,
            task,
            capabilityRoutingPolicy
          ) || assignedWorkerCandidate;
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
  const modeAdjustedTasks = applyMultiAgentModeToTasks(tasks, multiAgentConfig).map((task) => ({
    ...task,
    requirements: deriveTaskRequirements(task)
  }));

  return {
    objective: String(rawPlan?.objective || originalTask),
    strategy: String(
      rawPlan?.strategy ||
        "Run the workflow in phases: research, implementation, validation, then handoff before the controller synthesizes the final answer."
    ),
    tasks: modeAdjustedTasks
  };
}

function applyMultiAgentModeToTasks(tasks, multiAgentConfig = null) {
  const settings = normalizeMultiAgentRuntimeSettings(multiAgentConfig);
  const normalizedTasks = Array.isArray(tasks) ? tasks.map((task) => ({ ...task })) : [];
  if (!settings.enabled || !normalizedTasks.length) {
    return normalizedTasks;
  }

  if (settings.mode === "sequential") {
    let previousTaskId = "";
    return normalizedTasks.map((task) => {
      const nextTask = {
        ...task,
        dependsOn: uniqueArray([
          ...safeArray(task.dependsOn),
          ...(previousTaskId ? [previousTaskId] : [])
        ])
      };
      previousTaskId = task.id;
      return nextTask;
    });
  }

  if (settings.mode === "workflow") {
    const completedByPreviousPhases = [];
    let currentPhase = normalizedTasks[0]?.phase || "";

    return normalizedTasks.map((task) => {
      if (task.phase !== currentPhase) {
        currentPhase = task.phase;
        completedByPreviousPhases.push(
          ...normalizedTasks
            .filter((candidate) => phaseIndex(candidate.phase) < phaseIndex(task.phase))
            .map((candidate) => candidate.id)
        );
      }

      return {
        ...task,
        dependsOn: uniqueArray([
          ...safeArray(task.dependsOn),
          ...completedByPreviousPhases
        ])
      };
    });
  }

  return normalizedTasks;
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
    toolUsage: uniqueArray([...(parsed?.toolUsage || []), ...(extras.toolUsage || [])]),
    memoryReads: Math.max(0, Number(parsed?.memoryReads ?? extras.memoryReads ?? 0) || 0),
    memoryWrites: Math.max(0, Number(parsed?.memoryWrites ?? extras.memoryWrites ?? 0) || 0),
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

async function invokeProviderWithSessionLegacy({
  sessionRuntime,
  provider,
  agent,
  task = null,
  parentSpanId = "",
  purpose,
  instructions,
  input,
  onRetry,
  signal,
  allowEmptyText = false
}) {
  if (!sessionRuntime) {
    return provider.invoke({
      instructions,
      input,
      purpose,
      onRetry,
      signal,
      allowEmptyText
    });
  }

  const baseMeta = {
    ...buildAgentEventBase(agent, task),
    parentSpanId,
    purpose,
    spanLabel: `${agent.displayLabel || agent.label || agent.id} · ${purpose}`
  };
  const { spanId } = sessionRuntime.beginProviderCall(agent, baseMeta);

  try {
    const response = await provider.invoke({
      instructions,
      input,
      purpose,
      signal,
      allowEmptyText,
      onRetry(retry) {
        sessionRuntime.recordRetry(agent, retry, {
          ...baseMeta,
          parentSpanId: spanId
        });
        if (typeof onRetry === "function") {
          onRetry(retry);
        }
      }
    });

    sessionRuntime.completeProviderCall(agent, spanId, response.raw, {
      ...baseMeta,
      detail: `Provider call completed for ${purpose}.`
    });
    return response;
  } catch (error) {
    sessionRuntime.failProviderCall(agent, spanId, error, baseMeta);
    throw error;
  }
}

function resolveSubordinateConcurrency(agent, task, config, requestedCount) {
  const total = Math.max(1, Number(requestedCount) || 1);
  const phaseCap = resolvePhaseConcurrency(task?.phase, config?.cluster?.maxParallel, config);
  const limits = [phaseCap].filter((value) => Number.isFinite(value) && value > 0);
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
  executionGate,
  runAgentBudget = null,
  sessionRuntime,
  parentSpanId = "",
  onEvent,
  signal
}) {
  const allWorkers = workerListFromConfig(config);
  const capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
    config?.cluster?.capabilityRoutingPolicy
  );
  const primaryWorker = config.models[task.assignedWorker];
  let attemptChildAgentReservations = 0;

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
    const failure = classifyProviderTaskError(error, agent, sessionRuntime);
    const output = applyTaskOutputGuards(
      agentTask,
      normalizeWorkerResult(
        {
          thinkingSummary: "",
          summary: `${agent.displayLabel || agent.label} execution failed: ${failure.errorMessage}`,
          risks: [failure.errorMessage],
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
      output,
      failureKind: failure.failureKind,
      providerFailure: failure.providerFailure,
      retryableProviderFailure: failure.retryableProviderFailure,
      errorMessage: failure.errorMessage,
      errorStatus: failure.errorStatus,
      circuitState: failure.circuitState,
      failedWorkerId: agent.id,
      failedWorkerLabel: agent.label
    };
  }

  async function runWithExecutionGate(work) {
    if (!executionGate) {
      throwIfAborted(signal);
      return work();
    }

    return executionGate.run(work, { signal });
  }

  async function executeDirectAgentTask({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    emitLifecycle = true,
    taskSpanId = ""
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
      await runWithExecutionGate(async () => {
        if (config.workspace?.resolvedDir) {
          parsed = await runWorkspaceToolLoop({
            provider,
            invokeModel(options) {
              return invokeProviderWithSession({
                sessionRuntime,
                provider: options.provider,
                agent: options.worker,
                task: options.task,
                parentSpanId: options.parentSpanId || taskSpanId,
                purpose: options.purpose,
                instructions: options.instructions,
                input: options.input,
                onRetry: options.onRetry,
                signal: options.signal,
                buildAgentEventBase
              });
            },
            worker: agent,
            task: agentTask,
            originalTask,
            clusterPlan: plan,
            dependencyOutputs,
            workspaceRoot: config.workspace.resolvedDir,
            sessionRuntime,
            parentSpanId: taskSpanId,
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
          return;
        }

        const response = await invokeProviderWithSession({
          sessionRuntime,
          provider,
          agent,
          task: agentTask,
          parentSpanId: taskSpanId,
          instructions: prompt.instructions,
          input: prompt.input,
          purpose: agent.agentKind === "subordinate" ? "subordinate_execution" : "worker_execution",
          signal,
          buildAgentEventBase,
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
      });

      const endedAt = Date.now();
      const output = applyTaskOutputGuards(
        agentTask,
        normalizeWorkerResult(parsed, rawText),
        {
          actualGeneratedFiles: Array.isArray(parsed?.workspaceActions) && parsed.workspaceActions.length
            ? parsed?.verifiedGeneratedFiles || []
            : parsed?.verifiedGeneratedFiles || parsed?.generatedFiles || []
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
        output,
        failureKind: "",
        providerFailure: false,
        retryableProviderFailure: false,
        errorMessage: "",
        errorStatus: null,
        circuitState: "",
        failedWorkerId: "",
        failedWorkerLabel: ""
      };

      sessionRuntime?.remember(
        {
          title: `${agent.displayLabel || agent.label} · ${agentTask.title}`,
          content: output.summary || output.thinkingSummary || rawText,
          tags: uniqueArray([agentTask.phase, agent.id, agent.agentKind || "leader"])
        },
        {
          ...buildAgentEventBase(agent, agentTask),
          parentSpanId: taskSpanId
        }
      );

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
    preferDelegation,
    parentSpanId = ""
  }) {
    const delegationSpanId = sessionRuntime?.startSpan({
      ...buildAgentEventBase(agent, agentTask),
      parentSpanId,
      spanKind: "delegation",
      spanLabel: `${agent.displayLabel || agent.label} · delegation`
    });
    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "leader_delegate_start",
        tone: "neutral",
        detail:
          Number(runAgentBudget?.requestedTotalAgents) > 0
            ? `Planning up to ${delegateCount} child agent(s) for this task within the run-wide total target of ${runAgentBudget.requestedTotalAgents} agent(s).`
            : `Planning up to ${delegateCount} child agent(s) for this task.`
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
      depthRemaining,
      runAgentBudget
    });

    try {
      const response = await runWithExecutionGate(() =>
        invokeProviderWithSession({
          sessionRuntime,
          provider,
          agent,
          task: agentTask,
          parentSpanId: delegationSpanId || parentSpanId,
          instructions: prompt.instructions,
          input: prompt.input,
          purpose: "leader_delegation",
          signal,
          buildAgentEventBase,
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
        })
      );

      let parsed;
      try {
        parsed = parseJsonFromText(response.text);
      } catch {
        parsed = null;
      }

      const normalized = normalizeDelegationPlan(parsed, delegateCount, {
        defaultToRequested,
        preferDelegation
      });
      if (delegationSpanId) {
        sessionRuntime.endSpan(delegationSpanId, {
          status: "ok",
          detail: `Planned ${normalized.subtasks.length} delegated child task(s).`
        });
      }
      return normalized;
    } catch (error) {
      if (delegationSpanId) {
        sessionRuntime.endSpan(delegationSpanId, {
          status: isAbortError(error) ? "warning" : "error",
          detail: error.message
        });
      }
      throw error;
    }
  }

  async function synthesizeLeaderResult({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    subordinateExecutions,
    delegationPlan,
    startedAt,
    parentSpanId = ""
  }) {
    const synthesisSpanId = sessionRuntime?.startSpan({
      ...buildAgentEventBase(agent, agentTask),
      parentSpanId,
      spanKind: "delegation_synthesis",
      spanLabel: `${agent.displayLabel || agent.label} · child synthesis`
    });
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

    const response = await runWithExecutionGate(() =>
      invokeProviderWithSession({
        sessionRuntime,
        instructions: prompt.instructions,
        input: prompt.input,
        provider,
        agent,
        task: agentTask,
        parentSpanId: synthesisSpanId || parentSpanId,
        purpose: "leader_synthesis",
        signal,
        buildAgentEventBase,
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
      })
    );

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
        toolUsage: subordinateExecutions.flatMap((execution) => execution.output?.toolUsage || []),
        memoryReads: subordinateExecutions.reduce(
          (sum, execution) => sum + Number(execution.output?.memoryReads || 0),
          0
        ),
        memoryWrites: subordinateExecutions.reduce(
          (sum, execution) => sum + Number(execution.output?.memoryWrites || 0),
          0
        ),
        subordinateCount: totalDescendantCount,
        subordinateResults: subordinateExecutions.map(summarizeSubordinateExecution),
        verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus || derivedVerification)
      }),
      {
        actualGeneratedFiles: mergedVerifiedGeneratedFiles
      }
    );

    const retryableChildProviderFailure = subordinateExecutions.find(
      (execution) => execution.retryableProviderFailure
    );
    const status = subordinateExecutions.some((execution) => execution.status === "failed")
      ? "failed"
      : "completed";
    sessionRuntime?.remember(
      {
        title: `${agent.displayLabel || agent.label} · ${agentTask.title}`,
        content: output.summary || output.thinkingSummary || response.text,
        tags: uniqueArray([agentTask.phase, agent.id, "leader_synthesis"])
      },
      {
        ...buildAgentEventBase(agent, agentTask),
        parentSpanId: synthesisSpanId || parentSpanId
      }
    );
    if (synthesisSpanId) {
      sessionRuntime.endSpan(synthesisSpanId, {
        status: status === "failed" ? "error" : "ok",
        detail: `Synthesized ${subordinateExecutions.length} child result(s).`
      });
    }

    return {
      taskId: agentTask.id,
      title: agentTask.title,
      workerId: agent.id,
      workerLabel: agent.label,
      agentId: agent.runtimeId || agent.id,
      agentLabel: agent.displayLabel || agent.label,
      agentKind: agent.agentKind || "leader",
      phase: agentTask.phase,
      status,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      rawText: response.text,
      output,
      failureKind: retryableChildProviderFailure?.failureKind || "",
      providerFailure: Boolean(retryableChildProviderFailure?.providerFailure),
      retryableProviderFailure: Boolean(retryableChildProviderFailure),
      errorMessage: retryableChildProviderFailure?.errorMessage || "",
      errorStatus: retryableChildProviderFailure?.errorStatus ?? null,
      circuitState: retryableChildProviderFailure?.circuitState || "",
      failedWorkerId: retryableChildProviderFailure?.failedWorkerId || "",
      failedWorkerLabel: retryableChildProviderFailure?.failedWorkerLabel || ""
    };
  }

  throwIfAborted(signal);
  if (!primaryWorker) {
    throw new Error(`Worker "${task.assignedWorker}" was not found in the active scheme.`);
  }
  const primaryProvider = providerRegistry.get(task.assignedWorker);
  if (!primaryProvider) {
    throw new Error(`No provider found for worker "${task.assignedWorker}".`);
  }

  const dependencyOutputs = buildDependencyOutputs();
  const globalConcurrencyLabel = formatConcurrencyLimit(executionGate?.limit ?? Number.POSITIVE_INFINITY);
  const branchFactor = runAgentBudget
    ? Math.min(
        resolveGroupLeaderMaxDelegates(config),
        Math.max(0, Number(runAgentBudget.maxChildrenPerLeader || 0))
      )
    : resolveGroupLeaderMaxDelegates(config);
  const maxDelegationDepth = runAgentBudget
    ? Math.min(
        resolveDelegateMaxDepth(config),
        Math.max(0, Number(runAgentBudget.maxDelegationDepth || 0))
      )
    : resolveDelegateMaxDepth(config);

  async function executeAgentHierarchy({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    preferredDelegateCount = 0,
    depthRemaining = 0,
    defaultToRequested = false,
    emitLifecycle = true,
    parentSpanId: inheritedParentSpanId = ""
  }) {
    throwIfAborted(signal);
    const lifecycle = resolveLifecycleStages(agent);
    const startedAt = Date.now();
    const taskSpanId = sessionRuntime?.startSpan({
      ...buildAgentEventBase(agent, agentTask),
      parentSpanId: inheritedParentSpanId || parentSpanId,
      spanKind: agent.agentKind === "subordinate" ? "subtask" : "task",
      spanLabel: `${agent.displayLabel || agent.label} · ${agentTask.title}`
    });

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
      const remainingChildBudget = Math.max(
        0,
        Number(runAgentBudget?.remainingChildAgents ?? requestedDelegateCount)
      );
      const delegateBudgetCeiling = Math.min(requestedDelegateCount, remainingChildBudget);

      if (!delegateBudgetCeiling) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
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
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: directResult.status === "failed" ? "error" : "ok",
            detail:
              directResult.output.summary ||
              directResult.output.thinkingSummary ||
              "Task completed."
          });
        }
        return directResult;
      }

      const delegationPlan = await planLeaderDelegation({
        agent,
        provider,
        agentTask,
        dependencyOutputs,
        delegateCount: delegateBudgetCeiling,
        depthRemaining: Math.max(0, depthRemaining - 1),
        defaultToRequested,
        preferDelegation: shouldPreferDelegation(
          agentTask,
          agentTask.phase,
          branchFactor,
          depthRemaining
        ),
        parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
      });

      if (!delegationPlan.subtasks.length) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
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
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: directResult.status === "failed" ? "error" : "ok",
            detail:
              directResult.output.summary ||
              directResult.output.thinkingSummary ||
              "Task completed without delegation."
          });
        }
        return directResult;
      }

      const grantedChildCount = runAgentBudget
        ? runAgentBudget.reserveChildAgents(delegationPlan.subtasks.length)
        : delegationPlan.subtasks.length;
      attemptChildAgentReservations += grantedChildCount;
      const delegatedSubtasks = delegationPlan.subtasks.slice(0, grantedChildCount);

      if (!delegatedSubtasks.length) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
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
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: directResult.status === "failed" ? "error" : "ok",
            detail:
              directResult.output.summary ||
              directResult.output.thinkingSummary ||
              "Task completed after the run-wide child-agent budget was exhausted."
          });
        }
        return directResult;
      }

      const subordinateConcurrency = resolveSubordinateConcurrency(
        agent,
        agentTask,
        config,
        delegatedSubtasks.length
      );
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: "leader_delegate_done",
          tone: "ok",
          detail:
            grantedChildCount < delegationPlan.subtasks.length
              ? `Delegated ${delegatedSubtasks.length} child task(s) after applying the run-wide child-agent budget; local child launch cap is ${subordinateConcurrency} and the global execution cap is ${globalConcurrencyLabel}.`
              : subordinateConcurrency === 1
                ? `Delegated ${delegatedSubtasks.length} child task(s); local child launch continues sequentially and the global execution cap is ${globalConcurrencyLabel}.`
                : `Delegated ${delegatedSubtasks.length} child task(s); local child launch cap is ${subordinateConcurrency} and the global execution cap is ${globalConcurrencyLabel}.`,
          thinkingSummary: delegationPlan.thinkingSummary || ""
        },
        agentTask
      );

      const childPreferredDelegateCount = depthRemaining > 1 ? branchFactor : 0;
      const subordinateExecutions = await mapWithConcurrency(
        delegatedSubtasks,
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
          subordinateTask.requirements = deriveTaskRequirements(subordinateTask, {
            parentRequirements: agentTask.requirements,
            inheritConcreteArtifactRequirement: false
          });
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
            provider,
            agentTask: subordinateTask,
            dependencyOutputs,
            preferredDelegateCount: childPreferredDelegateCount,
            depthRemaining: Math.max(0, depthRemaining - 1),
            defaultToRequested: false,
            parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
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
        startedAt,
        parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
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
      if (taskSpanId) {
        sessionRuntime.endSpan(taskSpanId, {
          status: result.status === "failed" ? "error" : "ok",
          detail:
            result.output.summary ||
            result.output.thinkingSummary ||
            "Delegated task completed."
        });
      }
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: "warning",
            detail: error.message
          });
        }
        throw error;
      }

      const result = buildFailureResult(agent, agentTask, error, startedAt);
      if (taskSpanId) {
        sessionRuntime.endSpan(taskSpanId, {
          status: "error",
          detail: error.message
        });
      }
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
  const fallbackWorkers = rankFallbackWorkersForTask({
    workers: allWorkers,
    primaryWorker,
    phase: normalizePhase(task.phase, inferPhase(task, primaryWorker)),
    task,
    capabilityRoutingPolicy,
    providerRegistry
  });
  const executionCandidates = [primaryWorker, ...fallbackWorkers];
  let leaderAgent = createLeaderRuntimeAgent(primaryWorker, task);
  let currentTask = task;
  let lastResult = null;

  for (let attemptIndex = 0; attemptIndex < executionCandidates.length; attemptIndex += 1) {
    const currentWorker = executionCandidates[attemptIndex];
    const currentProvider =
      currentWorker.id === primaryWorker.id
        ? primaryProvider
        : providerRegistry.get(currentWorker.id);
    if (!currentProvider) {
      continue;
    }

    attemptChildAgentReservations = 0;
    currentTask =
      attemptIndex === 0
        ? task
        : {
            ...task,
            assignedWorker: currentWorker.id
          };
    leaderAgent =
      attemptIndex === 0
        ? leaderAgent
        : rebindRuntimeAgent(leaderAgent, currentWorker);

    const result = await executeAgentHierarchy({
      agent: leaderAgent,
      provider: currentProvider,
      agentTask: currentTask,
      dependencyOutputs,
      preferredDelegateCount,
      depthRemaining: maxDelegationDepth,
      defaultToRequested: preferredDelegateCount > 0,
      parentSpanId
    });

    lastResult = result;
    const hasMoreCandidates = attemptIndex < executionCandidates.length - 1;
    if (!result.retryableProviderFailure || !hasMoreCandidates) {
      return result;
    }

    if (runAgentBudget && attemptChildAgentReservations > 0) {
      runAgentBudget.releaseChildAgents(attemptChildAgentReservations);
    }

    const nextWorker = executionCandidates[attemptIndex + 1];
    emitAgentEvent(
      onEvent,
      leaderAgent,
      {
        type: "status",
        stage: "worker_fallback",
        tone: "warning",
        detail: `Retryable provider failure on ${currentWorker.label}; rerouting this task to ${nextWorker.label}.`,
        previousWorkerId: currentWorker.id,
        previousWorkerLabel: currentWorker.label,
        fallbackWorkerId: nextWorker.id,
        fallbackWorkerLabel: nextWorker.label,
        attempt: attemptIndex + 1,
        maxAttempts: executionCandidates.length
      },
      currentTask
    );
  }

  return lastResult;
}

async function executePlan(
  plan,
  originalTask,
  config,
  executionGate,
  providerRegistry,
  runAgentBudget,
  sessionRuntime,
  parentSpanId,
  onEvent,
  signal
) {
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
          executionGate,
          runAgentBudget,
          sessionRuntime,
          parentSpanId,
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
  const executionGate = createExecutionGate(config.cluster.maxParallel);
  const controllerId = config.cluster.controller;
  const controllerModel = config.models[controllerId];
  const controller = controllerModel;
  if (!controllerModel) {
    throw new Error(`Controller "${controllerId}" was not found in the active scheme.`);
  }
  const controllerProvider = providerRegistry.get(controllerId);
  if (!controllerProvider) {
    throw new Error(`No provider found for controller "${controllerId}".`);
  }
  const controllerModels = modelListFromConfig(config);
  let activeController = createControllerRuntimeAgent(controllerModel);
  let activeControllerProvider = controllerProvider;
  const multiAgentRuntime = createMultiAgentRuntime(config.multiAgent);
  
  function resolveRuntimeAgentFromEvent(payload = {}) {
    const runtimeId = safeString(
      payload.agentId || payload.parentAgentId || activeController?.runtimeId || controllerId
    );
    const displayLabel = safeString(
      payload.agentLabel ||
        payload.parentAgentLabel ||
        activeController?.displayLabel ||
        activeController?.label ||
        controllerModel?.label ||
        controllerId
    );

    return {
      runtimeId,
      displayLabel,
      label: safeString(payload.modelLabel || payload.agentLabel || displayLabel || controllerId),
      id: safeString(payload.modelId || activeController?.id || controllerId),
      agentKind: safeString(payload.agentKind || "leader") || "leader"
    };
  }

  function resolveParentRuntimeAgent(payload = {}) {
    if (!payload.parentAgentId && !payload.parentAgentLabel) {
      return null;
    }

    return {
      runtimeId: safeString(payload.parentAgentId),
      displayLabel: safeString(payload.parentAgentLabel || payload.parentAgentId),
      label: safeString(payload.parentAgentLabel || payload.parentAgentId),
      id: safeString(payload.parentAgentId || payload.parentAgentLabel),
      agentKind: "leader"
    };
  }

  function translateClusterEventToMultiAgentMessage(payload = {}) {
    const stage = safeString(payload.stage);
    const agent = resolveRuntimeAgentFromEvent(payload);
    const parentAgent = resolveParentRuntimeAgent(payload);
    const taskTitle = safeString(payload.taskTitle || payload.taskId);
    const detail = safeString(payload.detail);
    const phase = safeString(payload.phase);
    const tone = safeString(payload.tone || "neutral") || "neutral";

    switch (stage) {
      case "planning_start":
        return {
          kind: "system",
          stage,
          tone,
          speaker: agent,
          content: detail || `${agent.displayLabel} started planning the collaboration.`
        };
      case "planning_done":
        return {
          kind: "summary",
          stage,
          tone: "ok",
          speaker: agent,
          content: detail || `${agent.displayLabel} created ${payload.taskCount ?? 0} top-level task(s).`
        };
      case "phase_start":
      case "phase_done":
        return {
          kind: "system",
          stage,
          tone,
          phase,
          speaker: agent,
          content: detail || `${stage === "phase_start" ? "Entering" : "Completed"} ${phase} phase.`
        };
      case "worker_start":
      case "subagent_start":
      case "leader_delegate_start":
      case "leader_synthesis_start":
      case "workspace_list":
      case "workspace_read":
      case "workspace_write":
      case "workspace_web_search":
      case "workspace_command":
      case "workspace_tool_blocked":
      case "workspace_json_repair":
      case "memory_read":
      case "memory_write":
        return {
          kind: "message",
          stage,
          tone,
          phase,
          speaker: agent,
          content:
            detail ||
            (taskTitle ? `${agent.displayLabel} is handling ${taskTitle}.` : `${agent.displayLabel} sent an update.`)
        };
      case "subagent_created":
        return {
          kind: "message",
          stage,
          tone,
          phase,
          speaker: parentAgent || agent,
          target: agent,
          content: detail || `Created ${agent.displayLabel}${taskTitle ? ` for ${taskTitle}` : ""}.`
        };
      case "worker_done":
      case "subagent_done":
      case "worker_fallback":
      case "controller_fallback":
      case "cluster_cancelled":
      case "cluster_failed":
        return {
          kind: "summary",
          stage,
          tone,
          phase,
          speaker: agent,
          content:
            detail ||
            (taskTitle ? `${agent.displayLabel} completed ${taskTitle}.` : `${agent.displayLabel} completed an update.`)
        };
      case "planning_retry":
      case "worker_retry":
      case "subagent_retry":
      case "leader_delegate_retry":
      case "leader_synthesis_retry":
      case "synthesis_retry":
      case "circuit_opened":
      case "circuit_half_open":
      case "circuit_closed":
      case "circuit_blocked":
      case "validation_gate_failed":
      case "cancel_requested":
      case "synthesis_start":
        return {
          kind: "system",
          stage,
          tone,
          phase,
          speaker: agent,
          content:
            detail ||
            safeString(payload.finalAnswer) ||
            `${agent.displayLabel} reported ${stage.replaceAll("_", " ")}.`
        };
      default:
        return null;
    }
  }

  function captureMultiAgentFromEvent(payload = {}) {
    if (!multiAgentRuntime.isEnabled()) {
      return;
    }

    const message = translateClusterEventToMultiAgentMessage(payload);
    if (!message) {
      return;
    }

    if (message.kind === "summary") {
      multiAgentRuntime.recordSummary(message);
      return;
    }

    if (message.kind === "system") {
      multiAgentRuntime.recordSystem(message);
      return;
    }

    multiAgentRuntime.recordMessage(message);
  }

  function forwardClusterEvent(payload) {
    captureMultiAgentFromEvent(payload);
    emitEvent(onEvent, payload);
  }

  const sessionRuntime = createSessionRuntime({
    emitEvent(payload) {
      forwardClusterEvent(payload);
    }
  });
  const operationSpanId = sessionRuntime.startSpan({
    ...buildAgentEventBase(activeController, null),
    spanKind: "operation",
    spanLabel: `Cluster run · ${originalTask.slice(0, 72) || "task"}`
  });

  try {
    const workers = workerListFromConfig(config);
    const capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
      config?.cluster?.capabilityRoutingPolicy
    );
    multiAgentRuntime.start({
      task: originalTask,
      controller: activeController,
      detail: `Collaboration started in ${multiAgentRuntime.settings.mode} mode.`
    });

    async function invokeControllerStageWithFallback({
      purpose,
      prompt,
      startStage,
      retryStage
    }) {
      const primaryController = activeController;
      const primaryProvider = activeControllerProvider;
      const fallbackControllers = rankFallbackControllers({
        models: controllerModels,
        primaryController,
        purpose,
        providerRegistry
      }).map((modelConfig) => rebindControllerRuntimeAgent(primaryController, modelConfig));
      const stageCandidates = [primaryController, ...fallbackControllers];
      let lastError = null;

      for (let attemptIndex = 0; attemptIndex < stageCandidates.length; attemptIndex += 1) {
        const stageController = stageCandidates[attemptIndex];
        const stageProvider =
          attemptIndex === 0 ? primaryProvider : providerRegistry.get(stageController.id);
        if (!stageProvider) {
          continue;
        }

        const stageSpanId = sessionRuntime.startSpan({
          ...buildAgentEventBase(stageController, null),
          parentSpanId: operationSpanId,
          spanKind: purpose,
          spanLabel: `${stageController.displayLabel || stageController.label} 路 ${purpose}`
        });

        forwardClusterEvent({
          ...buildAgentEventBase(stageController, null),
          type: "status",
          stage: startStage,
          tone: "neutral"
        });

        try {
          const response = await executionGate.run(
            () =>
              invokeProviderWithSession({
                sessionRuntime,
                provider: stageProvider,
                agent: stageController,
                parentSpanId: stageSpanId,
                instructions: prompt.instructions,
                input: prompt.input,
                purpose,
                signal,
                buildAgentEventBase,
                onRetry(retry) {
                  forwardClusterEvent({
                    ...buildAgentEventBase(stageController, null),
                    ...buildRetryPayload({
                      stage: retryStage,
                      model: stageController,
                      retry
                    })
                  });
                }
              }),
            { signal }
          );

          sessionRuntime.endSpan(stageSpanId, {
            status: "ok",
            detail: `Controller ${purpose} completed.`
          });
          activeController = stageController;
          activeControllerProvider = stageProvider;
          return {
            response,
            controller: stageController,
            provider: stageProvider,
            spanId: stageSpanId
          };
        } catch (error) {
          sessionRuntime.endSpan(stageSpanId, {
            status: isAbortError(error) ? "warning" : "error",
            detail: error.message
          });

          if (isAbortError(error)) {
            throw error;
          }

          lastError = error;
          const failure = classifyProviderTaskError(error, stageController, sessionRuntime);
          const hasMoreCandidates = attemptIndex < stageCandidates.length - 1;
          if (!failure.retryableProviderFailure || !hasMoreCandidates) {
            throw error;
          }

          const nextController = stageCandidates[attemptIndex + 1];
          forwardClusterEvent({
            ...buildAgentEventBase(nextController, null),
            type: "status",
            stage: "controller_fallback",
            tone: "warning",
            detail: `Retryable provider failure on ${stageController.label}; rerouting ${purpose} to ${nextController.label}.`,
            previousControllerId: stageController.id,
            previousControllerLabel: stageController.label,
            fallbackControllerId: nextController.id,
            fallbackControllerLabel: nextController.label,
            purpose,
            attempt: attemptIndex + 1,
            maxAttempts: stageCandidates.length
          });
        }
      }

      throw lastError || new Error(`No controller provider was available for ${purpose}.`);
    }

    const prePlanningBudget = buildComplexityBudget({
      originalTask,
      workers,
      config
    });
    const workspaceSummary = config.workspace?.resolvedDir
      ? await getWorkspaceTree(config.workspace.resolvedDir)
      : null;
    const planningPrompt = buildPlanningRequest({
      task: originalTask,
      workers,
      maxParallel: resolveTopLevelTaskLimit(
        config.cluster.maxParallel,
        workers,
        prePlanningBudget
      ),
      workspaceSummary,
      delegateMaxDepth: resolveEffectiveDelegateMaxDepth(config, prePlanningBudget),
      delegateBranchFactor: resolveEffectiveGroupLeaderMaxDelegates(config, prePlanningBudget),
      complexityBudget: prePlanningBudget,
      capabilityRoutingPolicySummary: summarizeCapabilityRoutingPolicy(capabilityRoutingPolicy)
    });
    const planningStage = await invokeControllerStageWithFallback({
      purpose: "planning",
      prompt: planningPrompt,
      startStage: "planning_start",
      retryStage: "planning_retry",
      spanLabel: `${controller.label} · planning`
    });

    const planningResponse = planningStage.response;

    let rawPlan;
    try {
      rawPlan = parseJsonFromText(planningResponse.text);
    } catch {
      rawPlan = null;
    }

    const complexityBudget = buildComplexityBudget({
      originalTask,
      rawPlan,
      workers,
      config
    });
    const topLevelTaskLimit = resolveTopLevelTaskLimit(
      config.cluster.maxParallel,
      workers,
      complexityBudget
    );
    const groupLeaderMaxDelegates = resolveEffectiveGroupLeaderMaxDelegates(
      config,
      complexityBudget
    );
    const delegateMaxDepth = resolveEffectiveDelegateMaxDepth(config, complexityBudget);
    const plan = normalizePlan(
      rawPlan,
      workers,
      originalTask,
      topLevelTaskLimit,
      groupLeaderMaxDelegates,
      delegateMaxDepth,
      capabilityRoutingPolicy,
      config.multiAgent
    );
    const runAgentBudget = createRunAgentBudget(complexityBudget, plan.tasks.length);
    sessionRuntime.remember(
      {
        title: "Cluster planning",
        content: plan.strategy,
        tags: ["planning", activeController.id]
      },
      {
        ...buildAgentEventBase(activeController, null),
        parentSpanId: planningStage.spanId
      }
    );

    forwardClusterEvent({
      ...buildAgentEventBase(activeController, null),
      type: "status",
      stage: "planning_done",
      tone: "ok",
      taskCount: plan.tasks.length,
      detail: plan.strategy,
      budget: runAgentBudget.snapshot(),
      planStrategy: plan.strategy,
      planTasks: plan.tasks.map((taskItem) => ({
        id: taskItem.id,
        title: taskItem.title,
        phase: taskItem.phase,
        assignedWorker: taskItem.assignedWorker,
        delegateCount: taskItem.delegateCount
      }))
    });

    const executions = await executePlan(
      plan,
      originalTask,
      config,
      executionGate,
      providerRegistry,
      runAgentBudget,
      sessionRuntime,
      operationSpanId,
      forwardClusterEvent,
      signal
    );

    const synthesisPrompt = buildSynthesisRequest({
      task: originalTask,
      plan,
      executions
    });
    const synthesisStage = await invokeControllerStageWithFallback({
      purpose: "synthesis",
      prompt: synthesisPrompt,
      startStage: "synthesis_start",
      retryStage: "synthesis_retry",
      spanLabel: `${controller.label} · synthesis`
    });

    const synthesisResponse = synthesisStage.response;

    let synthesisParsed;
    try {
      synthesisParsed = parseJsonFromText(synthesisResponse.text);
    } catch {
      synthesisParsed = null;
    }

    const normalizedSynthesis = normalizeSynthesis(synthesisParsed, synthesisResponse.text);
    sessionRuntime.remember(
      {
        title: "Cluster synthesis",
        content: normalizedSynthesis.finalAnswer,
        tags: ["synthesis", activeController.id]
      },
      {
        ...buildAgentEventBase(activeController, null),
        parentSpanId: synthesisStage.spanId
      }
    );

    const totalMs = Date.now() - startedAt;
    sessionRuntime.endSpan(operationSpanId, {
      status: "ok",
      detail: normalizedSynthesis.finalAnswer || "Cluster run completed."
    });
    sessionRuntime.publishSessionUpdate("Cluster run completed.");
    multiAgentRuntime.complete({
      content: normalizedSynthesis.finalAnswer || "Cluster run completed.",
      tone: "ok"
    });
    forwardClusterEvent({
      ...buildAgentEventBase(activeController, null),
      type: "complete",
      stage: "cluster_done",
      tone: "ok",
      totalMs,
      finalAnswer: normalizedSynthesis.finalAnswer,
      executiveSummary: normalizedSynthesis.executiveSummary,
      session: sessionRuntime.buildSnapshot(),
      multiAgentSession: multiAgentRuntime.buildSnapshot()
    });

    return {
      plan,
      executions,
      synthesis: normalizedSynthesis,
      controller: {
        id: activeController.id,
        label: activeController.label,
        model: activeController.model
      },
      budget: runAgentBudget.snapshot(),
      timings: {
        totalMs
      },
      session: sessionRuntime.buildSnapshot(),
      multiAgentSession: multiAgentRuntime.buildSnapshot()
    };
  } catch (error) {
    sessionRuntime.endSpan(operationSpanId, {
      status: isAbortError(error) ? "warning" : "error",
      detail: error.message
    });
    sessionRuntime.publishSessionUpdate(
      isAbortError(error) ? "Cluster run cancelled." : "Cluster run failed."
    );
    multiAgentRuntime.complete({
      content: error.message,
      tone: isAbortError(error) ? "warning" : "error"
    });
    throw error;
  }
}

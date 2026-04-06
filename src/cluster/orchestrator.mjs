import {
  buildLeaderDelegationRequest,
  buildLeaderSynthesisRequest,
  buildPlanningRequest,
  buildSynthesisRequest,
  buildWorkerExecutionRequest
} from "./prompts.mjs";
import { parseJsonFromText } from "../utils/json-output.mjs";
import {
  getWorkspaceTree,
  removeWorkspaceFiles,
  verifyWorkspaceArtifacts,
  writeWorkspaceFiles
} from "../workspace/fs.mjs";
import { runWorkspaceToolLoop } from "../workspace/agent-loop.mjs";
import { combineAbortSignals, isAbortError, throwIfAborted } from "../utils/abort.mjs";
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
import {
  buildDocxFallbackContent,
  getArtifactTitleFromPath,
  inferRequestedArtifact
} from "../workspace/artifact-fallback.mjs";
import { normalizeWorkspaceArtifactReferences } from "../workspace/action-protocol.mjs";

const PHASE_ORDER = ["research", "implementation", "validation", "handoff"];
const DEFAULT_SUBORDINATE_MAX_PARALLEL = 3;
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const DEFAULT_SUBAGENT_RETRY_FALLBACK_THRESHOLD = 5;
const PHASE_CONCURRENCY_CAPS = {};
const RETRYABLE_PROVIDER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const DELEGATION_FILE_REFERENCE_PATTERNS = [
  /`([^`\r\n]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))`/gi,
  /"([^"\r\n]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))"/gi,
  /'([^'\r\n]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))'/gi,
  /([A-Za-z0-9_./\\-]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))/gi
];
const DELEGATION_PRODUCER_HINTS = [
  /\b(write|create|generate|save|produce|output|materialize|build|assemble|deliver)\b/i,
  /(写入|生成|创建|保存|产出|输出|落地|交付)/
];
const DELEGATION_CONSUMER_HINTS = [
  /\b(read|use|verify|validate|check|open|load|parse|review|summarize|merge|combine|consume|based on|using)\b/i,
  /(读取|使用|基于|核验|验证|检查|打开|加载|解析|审阅|汇总|合并|依赖)/
];
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

function normalizeArtifactEntry(value) {
  if (typeof value === "string") {
    return String(value).trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  return String(
    value.path ??
      value.filePath ??
      value.file_path ??
      value.filename ??
      value.fileName ??
      value.targetPath ??
      value.target_path ??
      ""
  ).trim();
}

function normalizeArtifactArray(value) {
  return Array.isArray(value)
    ? normalizeWorkspaceArtifactReferences(
      value
        .map((item) => normalizeArtifactEntry(item))
        .filter(Boolean)
    )
    : [];
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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDelegationFileReference(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`.,;:!?]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function extractDelegationFileReferences(text) {
  const source = String(text || "");
  const matches = [];
  for (const pattern of DELEGATION_FILE_REFERENCE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const normalized = normalizeDelegationFileReference(match[1]);
      if (normalized) {
        matches.push(normalized);
      }
    }
  }
  return uniqueArray(matches);
}

function matchesDelegationHint(text, patterns) {
  return patterns.some((pattern) => pattern.test(String(text || "")));
}

function inferImplicitDelegationDependencies(subtasks) {
  const metadata = (Array.isArray(subtasks) ? subtasks : []).map((subtask, index) => {
    const combinedText = [subtask?.title, subtask?.instructions, subtask?.expectedOutput]
      .filter(Boolean)
      .join("\n");
    return {
      id: subtask.id,
      ordinal: index + 1,
      combinedText,
      normalizedText: combinedText.toLowerCase(),
      references: extractDelegationFileReferences(combinedText),
      producerHints: matchesDelegationHint(combinedText, DELEGATION_PRODUCER_HINTS),
      consumerHints: matchesDelegationHint(combinedText, DELEGATION_CONSUMER_HINTS)
    };
  });
  const dependencies = new Map();

  metadata.forEach((current, currentIndex) => {
    const inferred = [];
    for (let priorIndex = 0; priorIndex < currentIndex; priorIndex += 1) {
      const prior = metadata[priorIndex];
      const sharedReferences = prior.references.filter((reference) =>
        current.references.includes(reference)
      );
      const referencesPriorId =
        new RegExp(`\\b${escapeRegExp(prior.id)}\\b`, "i").test(current.combinedText) ||
        new RegExp(`\\b(?:subtask|subagent|child(?:\\s+agent)?|sibling)\\s*0*${prior.ordinal}\\b`, "i").test(
          current.combinedText
        ) ||
        new RegExp(`(?:子任务|子代理|下属)\\s*0*${prior.ordinal}`).test(current.combinedText);
      if (referencesPriorId) {
        inferred.push(prior.id);
        continue;
      }

      if (!sharedReferences.length || !prior.producerHints || !current.consumerHints) {
        continue;
      }

      inferred.push(prior.id);
    }
    dependencies.set(current.id, uniqueArray(inferred));
  });

  return dependencies;
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

function resolveSubagentRetryFallbackThreshold(config) {
  const configured = Number(config?.cluster?.subagentRetryFallbackThreshold);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_SUBAGENT_RETRY_FALLBACK_THRESHOLD;
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

function hasBroadDelegationSignal(text) {
  return /(compare|survey|batch(?:es)?|multiple|parallel|delegate|split|across|recursive|non-overlapping|several|workstreams?|source\s+buckets?|evidence\s+batches?|multiple\s+sources?|multi-source|cross-market|cross-country|cross-region|matrix|\u591a\u4e2a|\u5e76\u884c|\u62c6\u5206|\u6279\u91cf|\u9012\u5f52|\u59d4\u6d3e|\u591a\u6765\u6e90|\u591a\u5e02\u573a|\u591a\u56fd\u5bb6|\u591a\u5730\u533a|\u5de5\u4f5c\u6d41|\u6e90\u6876|\u8bc1\u636e\u6279\u6b21)/.test(
    text
  );
}

function hasDelegationAvoidanceSignal(text) {
  return /(do not split|don't split|without splitting|without delegation|keep (?:the work )?centralized|keep (?:it )?centralized|single topic|single question|single path|direct verification|direct summary|no child agents|avoid delegation|\u4e0d\u8981\u62c6\u5206|\u65e0\u9700\u62c6\u5206|\u4e0d\u8981\u5206\u5de5|\u96c6\u4e2d\u5904\u7406|\u5355\u70b9\u6838\u5b9e|\u5355\u4e00\u4e3b\u9898|\u5355\u4e2a\u95ee\u9898)/.test(
    text
  );
}

function taskLooksDirectResearch(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  const compactText = text.replace(/\s+/g, " ").trim();
  const hasResearchSignal = /(verify|fact-check|check|confirm|lookup|summarize|summarise|brief|concise|latest|current|today|announcement|quote|market|source|news|verify the latest|one topic|one question|\u6838\u5b9e|\u67e5\u8bc1|\u786e\u8ba4|\u67e5\u627e|\u603b\u7ed3|\u7b80\u8981|\u7b80\u77ed|\u6700\u65b0|\u5f53\u524d|\u4eca\u65e5|\u516c\u544a|\u65b0\u95fb|\u884c\u60c5|\u6765\u6e90|\u4e00\u4e2a\u95ee\u9898|\u5355\u4e2a\u4e3b\u9898)/.test(
    text
  );
  const hasDirectSignal = /(directly|handle directly|quick|brief|concise|short answer|single answer|one question|single question|one topic|single topic|just|only|\u76f4\u63a5|\u5feb\u901f|\u7b80\u8981|\u7b80\u77ed|\u53ea\u9700|\u4ec5\u9700|\u5355\u4e2a\u95ee\u9898|\u4e00\u4e2a\u95ee\u9898|\u5355\u4e2a\u4e3b\u9898)/.test(
    text
  );
  const hasAvoidanceSignal = hasDelegationAvoidanceSignal(text);

  return (
    hasResearchSignal &&
    Boolean(compactText) &&
    (hasAvoidanceSignal || hasDirectSignal || compactText.length <= 140) &&
    (!hasBroadDelegationSignal(text) || hasAvoidanceSignal)
  );
}

function taskLooksAtomic(task, phase) {
  const normalizedPhase = normalizePhase(phase, "implementation");
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  const compactText = text.replace(/\s+/g, " ").trim();
  const hasScaleSignal = hasBroadDelegationSignal(text);

  if (normalizedPhase === "handoff") {
    return true;
  }

  if (normalizedPhase === "research" && taskLooksDirectResearch(task)) {
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
  if (normalizedPhase === "research" && taskLooksDirectResearch(task)) {
    return 0;
  }
  let suggested = 1;

  if (normalizedPhase === "research" || normalizedPhase === "implementation") {
    suggested = 2;
  } else if (normalizedPhase === "handoff") {
    suggested = 0;
  }

  if (/(compare|survey|batch|multiple|parallel|delegate|split|source\s+buckets?|evidence\s+batches?|multiple\s+sources?|analyze directly and return the result|\u6e90\u6876|\u8bc1\u636e\u6279\u6b21)/.test(text)) {
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

function normalizeRunLocale(value) {
  return safeString(value) === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeRunText(locale, englishText, chineseText) {
  return normalizeRunLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function createRunLanguagePack(locale) {
  const normalizedLocale = normalizeRunLocale(locale);
  return {
    taskTitle(index) {
      return normalizedLocale === "zh-CN" ? `任务 ${index + 1}` : `Task ${index + 1}`;
    },
    subtaskTitle(index) {
      return normalizedLocale === "zh-CN" ? `子任务 ${index + 1}` : `Subtask ${index + 1}`;
    },
    subtaskInstructions(index) {
      return normalizedLocale === "zh-CN"
        ? `处理组长任务中的第 ${index + 1} 部分。`
        : `Handle part ${index + 1} of the assigned leader task.`;
    },
    subtaskExpectedOutput() {
      return normalizedLocale === "zh-CN" ? "输出具体的专业结果。" : "Concrete specialist output.";
    },
    fallbackTaskTitle(worker, phase) {
      return normalizedLocale === "zh-CN"
        ? `${worker.label} 的${phase}任务`
        : `${worker.label} ${phase} task`;
    },
    fallbackTaskInstructions(originalTask) {
      return normalizedLocale === "zh-CN"
        ? `从你最擅长的专业方向处理用户目标“${originalTask}”。`
        : `Handle the user objective "${originalTask}" in your strongest specialty area.`;
    },
    fallbackTaskExpectedOutput() {
      return normalizedLocale === "zh-CN"
        ? "输出结构化结论，并在合适时给出具体产物。"
        : "Structured findings with concrete artifacts where useful.";
    },
    structuredSpecialistAnalysis() {
      return normalizedLocale === "zh-CN" ? "结构化的专业分析结果。" : "Structured specialist analysis.";
    },
    analyzeObjective(originalTask) {
      return normalizedLocale === "zh-CN"
        ? `从你的专业角度分析目标“${originalTask}”，并返回具体建议。`
        : `Analyze the objective "${originalTask}" from your specialty and return concrete recommendations.`;
    },
    validateGeneratedWorkspaceOutputsTitle() {
      return normalizedLocale === "zh-CN" ? "校验生成的工作区产物" : "Validate generated workspace outputs";
    },
    validateGeneratedOutputsTitle() {
      return normalizedLocale === "zh-CN" ? "校验生成结果" : "Validate generated outputs";
    },
    validationGateInstructions() {
      return normalizedLocale === "zh-CN"
        ? "仅审查上游实现任务明确产出的文件和产物；除非依赖结果要求扩大范围，否则忽略无关的既有工作区文件。对这些产物执行最相关且安全的测试或构建命令，并报告该工作流结果是否真正可用。"
        : "Review only the files and artifacts explicitly produced by upstream implementation tasks unless dependency outputs require a broader workspace inspection. Ignore unrelated pre-existing workspace files, run the most relevant safe tests or build commands for the produced outputs, and report whether the workflow result is actually usable.";
    },
    validationGateExpectedOutput() {
      return normalizedLocale === "zh-CN" ? "给出带测试/构建结果的验证结论。" : "Validation verdict with test/build results.";
    },
    finalCodeManagementReviewTitle() {
      return normalizedLocale === "zh-CN" ? "最终代码管理复核" : "Final code management review";
    },
    finalCodeManagementReviewInstructions() {
      return normalizedLocale === "zh-CN"
        ? "对所有实现产物执行最终代码管理复核。优先关注上游实现任务明确产出的文件和产物；除非依赖输出指向其他文件，否则忽略无关的既有工作区内容。针对这些产物运行最相关且安全的测试、构建或 lint 命令，并报告编码结果是否一致、可验收、可交付。"
        : "Perform the final code-management review for all implementation outputs. Focus first on files and artifacts explicitly produced by upstream implementation tasks, ignore unrelated pre-existing workspace files unless a dependency output points to them, run the most relevant safe test, build, or lint commands for those outputs, and report whether the coding results are cohesive and ready for handoff.";
    },
    finalCodeManagementReviewExpectedOutput() {
      return normalizedLocale === "zh-CN"
        ? "给出带验证证据和剩余风险的最终代码复核结论。"
        : "Final code review verdict with verification evidence and remaining risks.";
    },
    prepareHandoffSummaryTitle() {
      return normalizedLocale === "zh-CN" ? "准备交付摘要" : "Prepare handoff summary";
    },
    prepareHandoffSummaryInstructions() {
      return normalizedLocale === "zh-CN"
        ? "整理一份面向用户的精简交付摘要，覆盖产出结果、剩余风险，以及如何使用生成的内容。"
        : "Prepare a concise user-facing handoff summary covering outcomes, remaining risks, and how to use the generated outputs.";
    },
    prepareHandoffSummaryExpectedOutput() {
      return normalizedLocale === "zh-CN" ? "输出可直接阅读的交付说明。" : "Readable handoff notes.";
    },
    planningChildAgents(delegateCount, requestedTotalAgents) {
      if (normalizedLocale === "zh-CN") {
        return Number(requestedTotalAgents) > 0
          ? `计划在本任务内最多分配 ${delegateCount} 个子 agent，对应整轮全局目标 ${requestedTotalAgents} 个 agent。`
          : `计划在本任务内最多分配 ${delegateCount} 个子 agent。`;
      }
      return Number(requestedTotalAgents) > 0
        ? `Planning up to ${delegateCount} child agent(s) for this task within the run-wide total target of ${requestedTotalAgents} agent(s).`
        : `Planning up to ${delegateCount} child agent(s) for this task.`;
    },
    leaderSynthesisContent(childCount) {
      return normalizedLocale === "zh-CN"
        ? `把 ${childCount} 个子任务结果汇总成一份统一结论。`
        : `Merge ${childCount} child result(s) into one consolidated answer.`;
    },
    leaderSynthesisDetail(childCount) {
      return normalizedLocale === "zh-CN"
        ? `正在汇总 ${childCount} 个子任务结果。`
        : `Synthesizing ${childCount} child result(s).`;
    },
    taskCompletedWithoutDelegation() {
      return normalizedLocale === "zh-CN" ? "任务已直接完成，未继续委派。" : "Task completed without delegation.";
    },
    taskCompletedAfterBudgetExhausted() {
      return normalizedLocale === "zh-CN"
        ? "整轮子 agent 预算已用尽，本任务已改为直接完成。"
        : "Task completed after the run-wide child-agent budget was exhausted.";
    },
    delegationDone(delegatedCount, subordinateConcurrency, hasDependencies, globalConcurrencyLabel) {
      if (normalizedLocale === "zh-CN") {
        return delegatedCount < 0
          ? ""
          : `已分派 ${delegatedCount} 个子任务；本地子任务启动上限 ${subordinateConcurrency}，依赖感知调度${hasDependencies ? "已启用" : "无需启用"}，全局执行上限 ${globalConcurrencyLabel}。`;
      }
      return `Delegated ${delegatedCount} child task(s); local child launch cap is ${subordinateConcurrency}, dependency-aware scheduling is ${hasDependencies ? "enabled" : "not needed"}, and the global execution cap is ${globalConcurrencyLabel}.`;
    },
    delegationDoneBudgeted(delegatedCount, subordinateConcurrency, hasDependencies, globalConcurrencyLabel) {
      if (normalizedLocale === "zh-CN") {
        return `应用整轮子 agent 预算后，已分派 ${delegatedCount} 个子任务；本地子任务启动上限 ${subordinateConcurrency}，依赖感知调度${hasDependencies ? "已启用" : "无需启用"}，全局执行上限 ${globalConcurrencyLabel}。`;
      }
      return `Delegated ${delegatedCount} child task(s) after applying the run-wide child-agent budget; local child launch cap is ${subordinateConcurrency}, dependency-aware scheduling is ${hasDependencies ? "enabled" : "not needed"}, and the global execution cap is ${globalConcurrencyLabel}.`;
    },
    delegationDoneSequential(delegatedCount, globalConcurrencyLabel) {
      return normalizedLocale === "zh-CN"
        ? `已分派 ${delegatedCount} 个子任务；本地子任务将顺序启动，全局执行上限 ${globalConcurrencyLabel}。`
        : `Delegated ${delegatedCount} child task(s); local child launch continues sequentially and the global execution cap is ${globalConcurrencyLabel}.`;
    },
    collaborationStarted(mode) {
      return normalizedLocale === "zh-CN"
        ? `协作已启动，当前模式：${mode}。`
        : `Collaboration started in ${mode} mode.`;
    }
  };
}

function isGenericEnglishTaskTitle(value, kind = "task") {
  const normalized = safeString(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  if (kind === "subtask") {
    return /^(subtask|child task|task)\s*#?:?\s*\d+$/.test(normalized);
  }

  return /^task\s*#?:?\s*\d+$/.test(normalized);
}

function resolveLocalizedTaskTitle(rawTitle, fallbackTitle, kind = "task") {
  const normalized = safeString(rawTitle);
  if (!normalized) {
    return fallbackTitle;
  }

  return isGenericEnglishTaskTitle(normalized, kind) ? fallbackTitle : normalized;
}

function joinConversationParts(parts) {
  return parts
    .map((value) => safeString(value))
    .filter(Boolean)
    .join(" ");
}

function resolveQuotedTaskTitle(taskTitle, fallback, locale = "en-US") {
  const normalized = safeString(taskTitle);
  if (normalized) {
    return normalizeRunLocale(locale) === "zh-CN" ? `“${normalized}”` : `"${normalized}"`;
  }
  return fallback;
}

function resolveConversationSnippet(stage, payload = {}) {
  switch (stage) {
    case "leader_delegate_done":
      return safeString(payload.detail || payload.summary || payload.thinkingSummary || payload.content);
    case "worker_done":
    case "subagent_done":
      return safeString(payload.summary || payload.content || payload.thinkingSummary || payload.detail);
    default:
      return safeString(payload.content || payload.summary || payload.thinkingSummary || payload.detail);
  }
}

function extractEventDetailValue(detail, patterns = []) {
  const normalized = safeString(detail);
  if (!normalized) {
    return "";
  }

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return safeString(match[1] || match[0]);
    }
  }

  return normalized;
}

function buildConversationStyleContent(stage, payload = {}, taskTitle = "", locale = "en-US") {
  const normalizedLocale = normalizeRunLocale(locale);
  const snippet = resolveConversationSnippet(stage, payload);
  const taskLabel = resolveQuotedTaskTitle(
    taskTitle,
    normalizedLocale === "zh-CN" ? "该任务" : "this task",
    normalizedLocale
  );
  const childTaskLabel = resolveQuotedTaskTitle(
    taskTitle,
    normalizedLocale === "zh-CN" ? "该子任务" : "this child task",
    normalizedLocale
  );

  switch (stage) {
    case "planning_start":
      return localizeRunText(
        normalizedLocale,
        "I'm planning the overall collaboration.",
        "我正在规划整个协作流程。"
      );
    case "planning_done":
      return localizeRunText(
        normalizedLocale,
        `The top-level plan is ready with ${payload.taskCount ?? 0} task(s).`,
        `顶层计划已完成，共拆分 ${payload.taskCount ?? 0} 个任务。`
      );
    case "phase_start":
      return localizeRunText(
        normalizedLocale,
        `Entering the ${safeString(payload.phase) || "current"} phase.`,
        `进入${safeString(payload.phase) || "当前"}阶段。`
      );
    case "phase_done":
      return localizeRunText(
        normalizedLocale,
        `Completed the ${safeString(payload.phase) || "current"} phase.`,
        `已完成${safeString(payload.phase) || "当前"}阶段。`
      );
    case "leader_delegate_start":
      return joinConversationParts([
        localizeRunText(
          normalizedLocale,
          `I'm splitting ${taskLabel} into child assignments.`,
          `我来把 ${taskLabel} 拆成若干子任务。`
        ),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Focus: ${snippet}`, `重点：${snippet}`)
          : ""
      ]);
    case "leader_delegate_done":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "Delegation plan ready.", "分工计划已确定。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "worker_start":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `I'm taking ${taskLabel}.`, `我来处理 ${taskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Plan: ${snippet}`, `计划：${snippet}`)
          : ""
      ]);
    case "subagent_created":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Please take ${childTaskLabel}.`, `请接手 ${childTaskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Focus: ${snippet}`, `重点：${snippet}`)
          : ""
      ]);
    case "subagent_start":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Acknowledged ${childTaskLabel}.`, `已接单，开始处理 ${childTaskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Plan: ${snippet}`, `计划：${snippet}`)
          : localizeRunText(normalizedLocale, "Starting now.", "马上开始。")
      ]);
    case "leader_synthesis_start":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I'm merging the child outputs into one answer.", "我正在汇总子任务结果。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "worker_done":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Finished ${taskLabel}.`, `已完成 ${taskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Result: ${snippet}`, `结果：${snippet}`)
          : ""
      ]);
    case "subagent_done":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Completed ${childTaskLabel}.`, `已完成 ${childTaskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Result: ${snippet}`, `结果：${snippet}`)
          : ""
      ]);
    case "workspace_list":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I checked the workspace path.", "我已查看工作区路径。"),
        extractEventDetailValue(snippet) ? localizeRunText(normalizedLocale, `Path: ${extractEventDetailValue(snippet)}`, `路径：${extractEventDetailValue(snippet)}`) : ""
      ]);
    case "workspace_read":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I read the required files.", "我已读取所需文件。"),
        extractEventDetailValue(snippet) ? localizeRunText(normalizedLocale, `Files: ${extractEventDetailValue(snippet)}`, `文件：${extractEventDetailValue(snippet)}`) : ""
      ]);
    case "workspace_write": {
      const artifactPath = extractEventDetailValue(snippet, [
        /^Auto-materialized requested artifact(?: but verification failed)?:\s*(.+)$/i,
        /^已自动生成(?:并校验|但校验失败的)?目标产物[：:]\s*(.+)$/i
      ]);
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I wrote files into the workspace.", "我已向工作区写入文件。"),
        artifactPath
          ? localizeRunText(
              normalizedLocale,
              `Artifact: ${artifactPath}`,
              `产物：${artifactPath}`
            )
          : extractEventDetailValue(snippet)
            ? localizeRunText(
                normalizedLocale,
                `Files: ${extractEventDetailValue(snippet)}`,
                `文件：${extractEventDetailValue(snippet)}`
              )
            : ""
      ]);
    }
    case "workspace_web_search":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I finished a web search.", "我已完成一次网页搜索。"),
        extractEventDetailValue(snippet)
          ? localizeRunText(
              normalizedLocale,
              `Query: ${extractEventDetailValue(snippet)}`,
              `查询：${extractEventDetailValue(snippet)}`
            )
          : ""
      ]);
    case "workspace_json_repair":
      return localizeRunText(
        normalizedLocale,
        "I detected an invalid workspace JSON response and repaired it automatically.",
        "我检测到无效的 workspace JSON 响应，并已自动修复。"
      );
    case "memory_write": {
      const title = extractEventDetailValue(snippet, [
        /^Stored session memory:\s*(.+)$/i,
        /^已写入会话记忆[：:]\s*(.+)$/i
      ]);
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I stored the latest session memory.", "我已写入最新的会话记忆。"),
        title ? localizeRunText(normalizedLocale, `Title: ${title}`, `标题：${title}`) : ""
      ]);
    }
    case "memory_read": {
      const memoryCount = extractEventDetailValue(snippet, [
        /^Recalled\s+(\d+)\s+session memory item\(s\)\.?$/i,
        /^已召回\s+(\d+)\s+条会话记忆。?$/i
      ]);
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I recalled the relevant session memory.", "我已召回相关会话记忆。"),
        memoryCount
          ? localizeRunText(normalizedLocale, `Items: ${memoryCount}`, `条目：${memoryCount}`)
          : ""
      ]);
    }
    case "worker_fallback":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "Rerouted after a provider failure.", "因 provider 故障已切换执行者。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "controller_fallback":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "Controller fallback engaged.", "主控已切换到备用模型。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "cancel_requested":
      return localizeRunText(
        normalizedLocale,
        "The user requested cancellation and I'm stopping the current run.",
        "用户已请求终止，我正在停止当前运行。"
      );
    default:
      return snippet;
  }
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
  const hasExplicitArtifactPath = /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/.test(text);
  const hasNegatedArtifactWrite =
    /(\bdo not\b|\bdon't\b|\bwithout\b|\bavoid\b|\bnever\b).{0,20}\b(write|create|generate|save|export|deliver)\b/.test(text) ||
    /\b(write|create|generate|save|export|deliver)\b.{0,20}\b(no|without)\b.{0,12}\b(file|document|report|artifact|files|documents|reports|artifacts)\b/.test(text) ||
    /(?:不要|勿|禁止|无需|不必).{0,8}(?:写入|生成|创建|导出|保存).{0,8}(?:文件|文档|报告|交付物)/.test(text);

  if (hasExplicitArtifactPath) {
    return true;
  }
  if (hasNegatedArtifactWrite) {
    return false;
  }

  return (
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

function normalizeExcludedIdSet(values) {
  const result = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = safeString(value);
    if (normalized) {
      result.add(normalized);
    }
  }
  return result;
}

function scoreFailureIsolation(candidate, failedWorker) {
  const candidateBaseUrl = normalizeWorkerBaseUrl(candidate);
  const failedBaseUrl = normalizeWorkerBaseUrl(failedWorker);
  const candidateProvider = normalizeWorkerProvider(candidate);
  const failedProvider = normalizeWorkerProvider(failedWorker);
  const sameBaseUrl = Boolean(candidateBaseUrl && failedBaseUrl && candidateBaseUrl === failedBaseUrl);
  const sameProvider = Boolean(candidateProvider && failedProvider && candidateProvider === failedProvider);

  if (!sameBaseUrl && !sameProvider) {
    return 0;
  }
  if (!sameBaseUrl) {
    return 1;
  }
  if (!sameProvider) {
    return 2;
  }

  return 3;
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
  providerRegistry,
  excludeModelIds = null
}) {
  const excludedModelIds = normalizeExcludedIdSet(excludeModelIds);
  const candidates = (Array.isArray(models) ? models : []).filter(
    (modelConfig) =>
      modelConfig?.id &&
      modelConfig.id !== primaryController?.id &&
      !excludedModelIds.has(modelConfig.id) &&
      providerRegistry?.get(modelConfig.id)
  );
  const controllerSpecialists = candidates.filter((modelConfig) =>
    modelCanActAsController(modelConfig)
  );
  const eligibleCandidates = controllerSpecialists.length ? controllerSpecialists : candidates;

  return eligibleCandidates
    .sort((left, right) => {
      const leftIsolation = scoreFailureIsolation(left, primaryController);
      const rightIsolation = scoreFailureIsolation(right, primaryController);
      if (leftIsolation !== rightIsolation) {
        return leftIsolation - rightIsolation;
      }

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
  providerRegistry,
  excludeWorkerIds = null
}) {
  const excludedWorkerIds = normalizeExcludedIdSet(excludeWorkerIds);
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
        !excludedWorkerIds.has(worker.id) &&
        providerRegistry?.get(worker.id)
    )
    .sort((left, right) => {
      const leftIsolation = scoreFailureIsolation(left, primaryWorker);
      const rightIsolation = scoreFailureIsolation(right, primaryWorker);
      if (leftIsolation !== rightIsolation) {
        return leftIsolation - rightIsolation;
      }

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
  const languagePack = createRunLanguagePack(options.outputLocale);
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
  const seenIds = new Set();
  const normalizedSubtasks = subtasks
    .slice(0, desiredCount)
    .map((subtask, index) => {
      const preferredId = safeString(subtask?.id).replace(/[^\w-]/g, "_") || `sub_${index + 1}`;
      let subtaskId = preferredId;
      while (seenIds.has(subtaskId)) {
        subtaskId = `${preferredId}_${index + 1}`;
      }
      seenIds.add(subtaskId);
      const fallbackTitle = languagePack.subtaskTitle(index);
      return {
        id: subtaskId,
        title: resolveLocalizedTaskTitle(subtask?.title, fallbackTitle, "subtask"),
        instructions: safeString(subtask?.instructions) || languagePack.subtaskInstructions(index),
        dependsOn: safeArray(subtask?.dependsOn),
        expectedOutput: safeString(subtask?.expectedOutput) || languagePack.subtaskExpectedOutput()
      };
    });

  while (defaultToRequested && normalizedSubtasks.length < desiredCount) {
    const index = normalizedSubtasks.length;
    const subtaskId = `sub_${index + 1}`;
    seenIds.add(subtaskId);
    normalizedSubtasks.push({
      id: subtaskId,
      title: languagePack.subtaskTitle(index),
      instructions: languagePack.subtaskInstructions(index),
      dependsOn: [],
      expectedOutput: languagePack.subtaskExpectedOutput()
    });
  }

  const subtaskIdSet = new Set(normalizedSubtasks.map((subtask) => subtask.id));
  const implicitDependencies = inferImplicitDelegationDependencies(normalizedSubtasks);
  const finalizedSubtasks = normalizedSubtasks.map((subtask) => ({
    ...subtask,
    dependsOn: uniqueArray([
      ...safeArray(subtask.dependsOn).filter(
        (dependencyId) => dependencyId !== subtask.id && subtaskIdSet.has(dependencyId)
      ),
      ...(implicitDependencies.get(subtask.id) || [])
    ])
  }));

  return {
    thinkingSummary: safeString(parsed?.thinkingSummary),
    delegationSummary: safeString(parsed?.delegationSummary),
      subtasks: finalizedSubtasks
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

function buildDefaultFallbackTasks(workers, originalTask, outputLocale = "en-US") {
  const languagePack = createRunLanguagePack(outputLocale);
  return workers.map((worker, index) => {
    const phase = inferWorkerPhases(worker)[0] || "implementation";
    return {
      id: `task_${index + 1}`,
      phase,
      title: languagePack.fallbackTaskTitle(worker, phase),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.fallbackTaskInstructions(originalTask),
      dependsOn: [],
      expectedOutput: languagePack.fallbackTaskExpectedOutput()
    };
  });
}

function shouldForceCentralizedResearchPlan(originalTask, tasks) {
  if (!taskLooksDirectResearch({ title: originalTask, instructions: originalTask }, "research")) {
    return false;
  }

  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  if (!normalizedTasks.length) {
    return false;
  }

  return normalizedTasks.every((task) => normalizePhase(task?.phase, "implementation") === "research");
}

function buildCentralizedResearchTask(preliminaryTasks, workers, originalTask, capabilityRoutingPolicy, outputLocale = "en-US") {
  const languagePack = createRunLanguagePack(outputLocale);
  const firstTask = Array.isArray(preliminaryTasks) && preliminaryTasks.length ? preliminaryTasks[0] : null;
  const preservedWorker =
    workers.find((worker) => worker.id === safeString(firstTask?.assignedWorker)) || null;
  const bestWorker =
    preservedWorker ||
    pickBestWorkerForTask(
      workers,
      "research",
      {
        title: originalTask,
        instructions: originalTask,
        expectedOutput: firstTask?.expectedOutput || ""
      },
      capabilityRoutingPolicy
    ) || workers[0];

  return {
    id: safeString(firstTask?.id) || "task_1",
    phase: "research",
    title:
      safeString(firstTask?.title) ||
      resolveLocalizedTaskTitle(originalTask, languagePack.taskTitle(0), "task"),
    assignedWorker: bestWorker.id,
    delegateCount: 0,
    instructions:
      safeString(firstTask?.instructions) ||
      safeString(originalTask) ||
      languagePack.analyzeObjective(originalTask),
    dependsOn: [],
    expectedOutput:
      safeString(firstTask?.expectedOutput) ||
      languagePack.structuredSpecialistAnalysis()
  };
}

function injectWorkflowTasks(tasks, workers, originalTask, outputLocale = "en-US") {
  const languagePack = createRunLanguagePack(outputLocale);
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
      title: languagePack.validateGeneratedWorkspaceOutputsTitle(),
      instructions: originalTask
    });
    output.push({
      id: "validation_gate",
      phase: "validation",
      title: languagePack.validateGeneratedOutputsTitle(),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.validationGateInstructions(),
      dependsOn: implementationTasks.map((task) => task.id),
      expectedOutput: languagePack.validationGateExpectedOutput()
    });
  }

  if (
    implementationTasks.length &&
    codingManagerWorkers.length &&
    !output.some((task) => task.id === "coding_management_review")
  ) {
    const worker = pickBestWorkerForTask(codingManagerWorkers, "validation", {
      title: languagePack.finalCodeManagementReviewTitle(),
      instructions: originalTask,
      expectedOutput: languagePack.validationGateExpectedOutput()
    });
    const validationDependencies = output
      .filter((task) => task.phase === "validation" && task.id !== "coding_management_review")
      .map((task) => task.id);

    output.push({
      id: "coding_management_review",
      phase: "validation",
      title: languagePack.finalCodeManagementReviewTitle(),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.finalCodeManagementReviewInstructions(),
      dependsOn: uniqueArray([
        ...implementationTasks.map((task) => task.id),
        ...validationDependencies
      ]),
      expectedOutput: languagePack.finalCodeManagementReviewExpectedOutput()
    });
  }

  if (!output.some((task) => task.phase === "handoff") && handoffWorkers.length) {
    const worker = pickBestWorkerForTask(handoffWorkers, "handoff", {
      title: languagePack.prepareHandoffSummaryTitle(),
      instructions: originalTask
    });
    output.push({
      id: "handoff_summary",
      phase: "handoff",
      title: languagePack.prepareHandoffSummaryTitle(),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.prepareHandoffSummaryInstructions(),
      dependsOn: output.filter((task) => task.phase !== "handoff").map((task) => task.id),
      expectedOutput: languagePack.prepareHandoffSummaryExpectedOutput()
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
  multiAgentConfig = null,
  outputLocale = "en-US"
) {
  const languagePack = createRunLanguagePack(outputLocale);
  const workerIds = new Set(workers.map((worker) => worker.id));
  const fallbackTasks = buildDefaultFallbackTasks(workers, originalTask, outputLocale);

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
      title: resolveLocalizedTaskTitle(task?.title, languagePack.taskTitle(index), "task"),
      assignedWorker: reroutedWorker.id,
      delegateCount: resolveTaskDelegateCount(
        task,
        phase,
        groupLeaderMaxDelegates,
        delegateMaxDepth
      ),
      instructions: String(
        task?.instructions ||
          languagePack.analyzeObjective(originalTask)
      ),
      dependsOn: safeArray(task?.dependsOn),
      expectedOutput: String(task?.expectedOutput || languagePack.structuredSpecialistAnalysis())
    };
  });

  const centralizedPreliminaryTasks = shouldForceCentralizedResearchPlan(originalTask, preliminaryTasks)
    ? [
        buildCentralizedResearchTask(
          preliminaryTasks,
          workers,
          originalTask,
          capabilityRoutingPolicy,
          outputLocale
        )
      ]
    : preliminaryTasks;
  const tasksWithWorkflow = injectWorkflowTasks(
    centralizedPreliminaryTasks,
    workers,
    originalTask,
    outputLocale
  );
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
      : guarded.verifiedGeneratedFiles
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
    generatedFiles: uniqueArray([
      ...normalizeArtifactArray(parsed?.generatedFiles),
      ...normalizeArtifactArray(extras.generatedFiles)
    ]),
    verifiedGeneratedFiles: uniqueArray([
      ...normalizeArtifactArray(parsed?.verifiedGeneratedFiles),
      ...normalizeArtifactArray(extras.verifiedGeneratedFiles)
    ]),
    workspaceActions: uniqueArray([...(parsed?.workspaceActions || []), ...(extras.workspaceActions || [])]),
    executedCommands: uniqueArray([...(parsed?.executedCommands || []), ...(extras.executedCommands || [])]),
    toolUsage: uniqueArray([...(parsed?.toolUsage || []), ...(extras.toolUsage || [])]),
    memoryReads: Math.max(0, Number(parsed?.memoryReads ?? extras.memoryReads ?? 0) || 0),
    memoryWrites: Math.max(0, Number(parsed?.memoryWrites ?? extras.memoryWrites ?? 0) || 0),
    verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus || extras.verificationStatus),
    delegationNotes: uniqueArray([...(parsed?.delegationNotes || []), ...(extras.delegationNotes || [])]),
    unstructuredOutput: Boolean(parsed?.unstructuredOutput || extras.unstructuredOutput),
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

function collectExecutionArtifacts(output = {}) {
  const verified = normalizeWorkspaceArtifactReferences(output?.verifiedGeneratedFiles || []);
  if (verified.length) {
    return verified;
  }
  return normalizeWorkspaceArtifactReferences(output?.generatedFiles || []);
}

function collectSubordinateArtifacts(output = {}) {
  const subordinateResults = Array.isArray(output?.subordinateResults) ? output.subordinateResults : [];
  return uniqueArray(
    subordinateResults.flatMap((entry) =>
      collectExecutionArtifacts(entry?.output || entry || {})
    )
  );
}

function buildWorkspaceCleanupPlan({
  plan,
  executions,
  workspaceRoot,
  originalTask
}) {
  if (!workspaceRoot || !Array.isArray(plan?.tasks) || !Array.isArray(executions)) {
    return {
      keepFiles: [],
      removeFiles: []
    };
  }

  const taskById = new Map(plan.tasks.map((task) => [safeString(task?.id), task]));
  const downstreamByTaskId = new Map();
  for (const task of plan.tasks) {
    const dependencies = safeArray(task?.dependsOn);
    for (const dependencyId of dependencies) {
      const normalizedDependencyId = safeString(dependencyId);
      if (!normalizedDependencyId) {
        continue;
      }
      const dependents = downstreamByTaskId.get(normalizedDependencyId) || new Set();
      dependents.add(safeString(task?.id));
      downstreamByTaskId.set(normalizedDependencyId, dependents);
    }
  }
  const executionArtifactRecords = executions
    .map((execution) => {
      const task = taskById.get(safeString(execution?.taskId));
      const realizedArtifacts = collectExecutionArtifacts(execution?.output);
      if (!task || !realizedArtifacts.length) {
        return null;
      }

      const subordinateArtifacts = collectSubordinateArtifacts(execution?.output);
      const requestedArtifact = taskRequiresConcreteArtifact(task)
        ? safeString(
            inferRequestedArtifact(
              task,
              {
                ...(execution?.output || {}),
                generatedFiles: [],
                verifiedGeneratedFiles: []
              },
              workspaceRoot,
              originalTask
            )
          )
        : "";

      return {
        execution,
        task,
        realizedArtifacts,
        subordinateArtifacts,
        requestedArtifact,
        hasRequestedArtifact: Boolean(requestedArtifact && realizedArtifacts.includes(requestedArtifact)),
        phaseOrder: Math.max(0, phaseIndex(task.phase))
      };
    })
    .filter(Boolean);
  const artifactProducerTaskIds = new Set(
    executionArtifactRecords.map((record) => safeString(record.task?.id)).filter(Boolean)
  );
  const highestArtifactPhaseOrder = executionArtifactRecords.reduce(
    (max, record) => Math.max(max, record.phaseOrder),
    -1
  );
  const downstreamArtifactProducerCache = new Map();

  function hasDownstreamArtifactProducer(taskId, ancestry = new Set()) {
    const normalizedTaskId = safeString(taskId);
    if (!normalizedTaskId) {
      return false;
    }
    if (downstreamArtifactProducerCache.has(normalizedTaskId)) {
      return downstreamArtifactProducerCache.get(normalizedTaskId);
    }
    if (ancestry.has(normalizedTaskId)) {
      return false;
    }

    ancestry.add(normalizedTaskId);
    const downstreamDependents = downstreamByTaskId.get(normalizedTaskId) || new Set();
    for (const dependentId of downstreamDependents) {
      if (artifactProducerTaskIds.has(dependentId) || hasDownstreamArtifactProducer(dependentId, ancestry)) {
        downstreamArtifactProducerCache.set(normalizedTaskId, true);
        ancestry.delete(normalizedTaskId);
        return true;
      }
    }

    ancestry.delete(normalizedTaskId);
    downstreamArtifactProducerCache.set(normalizedTaskId, false);
    return false;
  }

  const keepFiles = new Set();
  const removableFiles = new Set();

  for (const record of executionArtifactRecords) {
    const { task, realizedArtifacts, subordinateArtifacts, requestedArtifact, hasRequestedArtifact, phaseOrder } =
      record;
    const isFinalArtifactProducer = !hasDownstreamArtifactProducer(task.id);
    const supersededByLaterPhase = highestArtifactPhaseOrder > phaseOrder;

    if (supersededByLaterPhase) {
      for (const artifact of realizedArtifacts) {
        removableFiles.add(artifact);
      }
      continue;
    }

    if (isFinalArtifactProducer) {
      if (subordinateArtifacts.length && hasRequestedArtifact) {
        keepFiles.add(requestedArtifact);
        for (const artifact of realizedArtifacts) {
          if (!subordinateArtifacts.includes(artifact)) {
            keepFiles.add(artifact);
          }
        }
        for (const artifact of subordinateArtifacts) {
          if (artifact !== requestedArtifact) {
            removableFiles.add(artifact);
          }
        }
        continue;
      }

      for (const artifact of realizedArtifacts) {
        keepFiles.add(artifact);
      }
      continue;
    }

    for (const artifact of realizedArtifacts) {
      removableFiles.add(artifact);
    }
  }

  return {
    keepFiles: Array.from(keepFiles),
    removeFiles: Array.from(removableFiles).filter((artifact) => !keepFiles.has(artifact))
  };
}

function createStructuredFallback(label, rawText, error) {
  return {
    unstructuredOutput: true,
    thinkingSummary: "",
    summary: `${label} returned unstructured output.`,
    keyFindings: [rawText.slice(0, 2000)],
    risks: [String(error.message || error)],
    deliverables: [],
    confidence: "low",
    followUps: ["Tighten the prompt or use a model with more reliable JSON output."]
  };
}

function parseStructuredJsonOrFallback(label, rawText) {
  try {
    const parsed = parseJsonFromText(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Model output did not parse into a JSON object.");
    }
    return parsed;
  } catch (error) {
    return createStructuredFallback(label, rawText, error);
  }
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
  signal,
  outputLocale = "en-US"
}) {
  const runLocale = normalizeRunLocale(outputLocale);
  const languagePack = createRunLanguagePack(runLocale);
  const allWorkers = workerListFromConfig(config);
  const capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
    config?.cluster?.capabilityRoutingPolicy
  );
  const primaryWorker = config.models[task.assignedWorker];
  const subagentRetryFallbackThreshold = resolveSubagentRetryFallbackThreshold(config);
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
      failedWorkerId: safeString(error?.failedWorkerId) || agent.id,
      failedWorkerLabel: safeString(error?.failedWorkerLabel) || agent.label
    };
  }

  function maybeEscalateSubagentRetry(agent, agentTask, retry) {
    if (agent.agentKind !== "subordinate") {
      return;
    }
    if (subagentRetryFallbackThreshold <= 0) {
      return;
    }
    if (Number(retry?.attempt || 0) < subagentRetryFallbackThreshold) {
      return;
    }

    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "subagent_retry_threshold_reached",
        tone: "warning",
        detail: localizeRunText(
          runLocale,
          `${agent.displayLabel || agent.label} reached the subagent retry fallback threshold (${subagentRetryFallbackThreshold}). The controller will hand this task to a standby leader.`,
          `${agent.displayLabel || agent.label} 已达到子 Agent 重试接管阈值（${subagentRetryFallbackThreshold} 次），主控将把当前任务改派给备用组长。`
        ),
        attempt: retry?.attempt ?? 0,
        maxRetries: retry?.maxRetries ?? 0
      },
      agentTask
    );

    const error = new Error(
      localizeRunText(
        runLocale,
        `${agent.displayLabel || agent.label} reached the subagent retry fallback threshold (${subagentRetryFallbackThreshold}).`,
        `${agent.displayLabel || agent.label} 达到子 Agent 重试接管阈值（${subagentRetryFallbackThreshold} 次）。`
      )
    );
    error.status = retry?.status || 524;
    error.retryable = true;
    error.failedWorkerId = agent.id;
    error.failedWorkerLabel = agent.label;
    throw error;
  }

  function buildDelegatedRetryableFailure(agent, agentTask, childExecution) {
    const childLabel =
      childExecution?.agentLabel ||
      childExecution?.workerLabel ||
      childExecution?.failedWorkerLabel ||
      childExecution?.failedWorkerId ||
      languagePack.subtaskTitle(0);
    const error = new Error(
      localizeRunText(
        runLocale,
        `Delegated child ${childLabel} hit a retryable provider failure. Reroute this task to a standby leader immediately.`,
        `委派子 Agent ${childLabel} 触发了可重试的 provider 故障，当前任务将立即改派给备用组长接手。`
      )
    );
    error.status = childExecution?.errorStatus || 524;
    error.retryable = true;
    error.failedWorkerId = childExecution?.failedWorkerId || agent.id;
    error.failedWorkerLabel = childExecution?.failedWorkerLabel || agent.label;
    return error;
  }

  async function runWithExecutionGate(work, signalOverride = signal) {
    if (!executionGate) {
      throwIfAborted(signalOverride);
      return work();
    }

    return executionGate.run(work, { signal: signalOverride });
  }

  async function executeDirectAgentTask({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    emitLifecycle = true,
    taskSpanId = "",
    signalOverride = signal
  }) {
    throwIfAborted(signalOverride);
    const lifecycle = resolveLifecycleStages(agent);
    const startedAt = Date.now();
    const prompt = buildWorkerExecutionRequest({
      originalTask,
      clusterPlan: plan,
      worker: agent,
      task: agentTask,
      dependencyOutputs,
      outputLocale: runLocale
    });

    if (emitLifecycle) {
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: lifecycle.start,
          tone: "neutral",
          content: agentTask.instructions || agentTask.title || ""
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
              maybeEscalateSubagentRetry(agent, agentTask, retry);
            },
            onEvent,
            signal: signalOverride
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
          signal: signalOverride,
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
            maybeEscalateSubagentRetry(agent, agentTask, retry);
          }
        });

        rawText = response.text;
        parsed = parseStructuredJsonOrFallback(agent.displayLabel || agent.label, response.text);
      }, signalOverride);

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
            thinkingSummary: result.output.thinkingSummary || "",
            summary: result.output.summary || "",
            content: result.output.summary || result.output.thinkingSummary || "",
            targetAgentLabel: agent.parentAgentLabel || ""
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
    parentSpanId = "",
    signalOverride = signal
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
        content: agentTask.instructions || agentTask.title || "",
        detail:
          languagePack.planningChildAgents(
            delegateCount,
            Number(runAgentBudget?.requestedTotalAgents) || 0
          )
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
      runAgentBudget,
      outputLocale: runLocale
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
          signal: signalOverride,
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
      , signalOverride);

      let parsed;
      try {
        parsed = parseJsonFromText(response.text);
      } catch {
        parsed = null;
      }

      const normalized = normalizeDelegationPlan(parsed, delegateCount, {
        defaultToRequested,
        preferDelegation,
        outputLocale: runLocale
      });
      if (delegationSpanId) {
        sessionRuntime.endSpan(delegationSpanId, {
          status: "ok",
          detail: localizeRunText(
            runLocale,
            `Planned ${normalized.subtasks.length} delegated child task(s).`,
            `已规划 ${normalized.subtasks.length} 个子任务。`
          )
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

  async function maybeAutoMaterializeLeaderArtifact({
    agent,
    agentTask,
    output,
    dependencyOutputs,
    subordinateExecutions,
    parentSpanId = ""
  }) {
    const workspaceRoot = config.workspace?.resolvedDir;
    if (!workspaceRoot || !taskRequiresConcreteArtifact(agentTask)) {
      return output;
    }
    if (output?.unstructuredOutput) {
      return output;
    }

    const artifactPath = inferRequestedArtifact(
      agentTask,
      output,
      workspaceRoot,
      originalTask
    );
    const reportedArtifacts = normalizeWorkspaceArtifactReferences([
      ...(output?.verifiedGeneratedFiles || []),
      ...(output?.generatedFiles || [])
    ]);
    const reportedVerification = reportedArtifacts.length
      ? await verifyWorkspaceArtifacts(workspaceRoot, reportedArtifacts, {
        maxFiles: Math.min(12, reportedArtifacts.length)
      })
      : [];
    const verifiedReportedArtifacts = reportedVerification
      .filter((entry) => entry.verified)
      .map((entry) => entry.path);
    const filteredOutput = {
      ...output,
      generatedFiles: uniqueArray(verifiedReportedArtifacts),
      verifiedGeneratedFiles: uniqueArray(verifiedReportedArtifacts)
    };
    const hasVerifiedRequestedArtifact = verifiedReportedArtifacts.includes(artifactPath);
    const failedReportedArtifacts = reportedVerification.filter(
      (entry) => !entry.verified && entry.path !== artifactPath
    );
    filteredOutput.risks = uniqueArray([
      ...(filteredOutput?.risks || []),
      ...failedReportedArtifacts.map(
        (entry) => `Reported artifact "${entry.path}" was not actually present in the workspace: ${entry.error}`
      )
    ]);

    if (hasVerifiedRequestedArtifact) {
      return filteredOutput;
    }
    if (!/\.docx$/i.test(String(artifactPath || ""))) {
      return filteredOutput;
    }

    const content = buildDocxFallbackContent({
      task: agentTask,
      parsed: filteredOutput,
      dependencyOutputs: [
        ...dependencyOutputs,
        ...subordinateExecutions.map(summarizeExecutionForDependency)
      ],
      originalTask
    });
    if (!safeString(content) || safeString(content).length < 24) {
      return filteredOutput;
    }

    const writtenFiles = await writeWorkspaceFiles(workspaceRoot, [
      {
        path: artifactPath,
        title: getArtifactTitleFromPath(artifactPath),
        content,
        encoding: "utf8"
      }
    ]);
    const verification = await verifyWorkspaceArtifacts(workspaceRoot, [artifactPath], {
      maxFiles: 1
    });
    const verifiedGeneratedFiles = verification
      .filter((entry) => entry.verified)
      .map((entry) => entry.path);
    const failedVerification = verification.filter((entry) => !entry.verified);

    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "workspace_write",
        tone: verifiedGeneratedFiles.length ? "ok" : "warning",
        detail: verifiedGeneratedFiles.length
          ? localizeRunText(
              runLocale,
              `Auto-materialized requested artifact: ${artifactPath}`,
              `已自动生成目标产物：${artifactPath}`
            )
          : localizeRunText(
              runLocale,
              `Auto-materialized requested artifact but verification failed: ${artifactPath}`,
              `已自动生成目标产物但校验失败：${artifactPath}`
            )
      },
      agentTask
    );
    sessionRuntime?.remember(
      {
        title: localizeRunText(
          runLocale,
          `${agent.displayLabel || agent.label} artifact materialization`,
          `${agent.displayLabel || agent.label} 产物生成`
        ),
        content: verifiedGeneratedFiles.length
          ? localizeRunText(
              runLocale,
              `Auto-materialized ${artifactPath}`,
              `已自动生成 ${artifactPath}`
            )
          : localizeRunText(
              runLocale,
              `Attempted to auto-materialize ${artifactPath}, but verification failed.`,
              `已尝试自动生成 ${artifactPath}，但校验失败。`
            ),
        tags: uniqueArray([agentTask.phase, agent.id, "artifact_materialization"])
      },
      {
        ...buildAgentEventBase(agent, agentTask),
        parentSpanId
      }
    );

    return {
      ...filteredOutput,
      keyFindings: uniqueArray([
        ...(filteredOutput?.keyFindings || []),
        verifiedGeneratedFiles.length
          ? "The requested workspace artifact was auto-materialized from the leader synthesis output."
          : ""
      ]),
      risks: uniqueArray([
        ...(filteredOutput?.risks || []),
        ...failedVerification.map(
          (entry) => `Auto-materialized artifact "${entry.path}" could not be verified: ${entry.error}`
        )
      ]),
      generatedFiles: uniqueArray([
        ...(filteredOutput?.generatedFiles || []),
        ...writtenFiles.map((entry) => entry.path)
      ]),
      verifiedGeneratedFiles: uniqueArray([
        ...(filteredOutput?.verifiedGeneratedFiles || []),
        ...verifiedGeneratedFiles
      ]),
      workspaceActions: uniqueArray([...(filteredOutput?.workspaceActions || []), "write_docx"]),
      toolUsage: uniqueArray([...(filteredOutput?.toolUsage || []), "write_docx"]),
      verificationStatus: verifiedGeneratedFiles.length
        ? "passed"
        : filteredOutput?.verificationStatus || "not_applicable"
    };
  }

  async function synthesizeLeaderResult({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    subordinateExecutions,
    delegationPlan,
    startedAt,
    parentSpanId = "",
    signalOverride = signal
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
        content:
          delegationPlan.delegationSummary ||
          languagePack.leaderSynthesisContent(subordinateExecutions.length),
        detail: languagePack.leaderSynthesisDetail(subordinateExecutions.length)
      },
      agentTask
    );

    const prompt = buildLeaderSynthesisRequest({
      originalTask,
      clusterPlan: plan,
      leader: agent,
      task: agentTask,
      dependencyOutputs,
      subordinateResults: subordinateExecutions.map(summarizeExecutionForDependency),
      outputLocale: runLocale
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
        signal: signalOverride,
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
    , signalOverride);

    let parsed;
    parsed = parseStructuredJsonOrFallback(agent.displayLabel || agent.label, response.text);

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
    let normalizedLeaderOutput = normalizeWorkerResult(parsed, response.text, {
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
    });
    normalizedLeaderOutput = await maybeAutoMaterializeLeaderArtifact({
      agent,
      agentTask,
      output: normalizedLeaderOutput,
      dependencyOutputs,
      subordinateExecutions,
      parentSpanId: synthesisSpanId || parentSpanId
    });
    const realizedArtifacts = uniqueArray(
      normalizedLeaderOutput.verifiedGeneratedFiles.length
        ? normalizedLeaderOutput.verifiedGeneratedFiles
        : normalizedLeaderOutput.generatedFiles
    );
    const output = applyTaskOutputGuards(
      agentTask,
      normalizedLeaderOutput,
      {
        actualGeneratedFiles: realizedArtifacts
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
    parentSpanId: inheritedParentSpanId = "",
    signalOverride = signal
  }) {
    throwIfAborted(signalOverride);
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
          content: agentTask.instructions || agentTask.title || "",
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
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId,
          signalOverride
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || "",
              summary: directResult.output.summary || "",
              content: directResult.output.summary || directResult.output.thinkingSummary || "",
              targetAgentLabel: agent.parentAgentLabel || ""
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
        parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId,
        signalOverride
      });

      if (!delegationPlan.subtasks.length) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId,
          signalOverride
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || "",
              summary: directResult.output.summary || "",
              content: directResult.output.summary || directResult.output.thinkingSummary || "",
              targetAgentLabel: agent.parentAgentLabel || ""
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
              languagePack.taskCompletedWithoutDelegation()
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
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId,
          signalOverride
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || "",
              summary: directResult.output.summary || "",
              content: directResult.output.summary || directResult.output.thinkingSummary || "",
              targetAgentLabel: agent.parentAgentLabel || ""
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
              languagePack.taskCompletedAfterBudgetExhausted()
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
      const hasDelegatedDependencies = delegatedSubtasks.some(
        (subtask) => Array.isArray(subtask?.dependsOn) && subtask.dependsOn.length
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
              ? languagePack.delegationDoneBudgeted(
                  delegatedSubtasks.length,
                  subordinateConcurrency,
                  hasDelegatedDependencies,
                  globalConcurrencyLabel
                )
              : subordinateConcurrency === 1
                ? languagePack.delegationDoneSequential(
                    delegatedSubtasks.length,
                    globalConcurrencyLabel
                  )
                : languagePack.delegationDone(
                    delegatedSubtasks.length,
                    subordinateConcurrency,
                    hasDelegatedDependencies,
                    globalConcurrencyLabel
                  ),
          thinkingSummary: delegationPlan.thinkingSummary || ""
        },
        agentTask
      );

      const childPreferredDelegateCount = depthRemaining > 1 ? branchFactor : 0;
      const delegatedEntries = delegatedSubtasks.map((subtask, index) => {
        const subordinateTask = {
          id: `${agentTask.id}__${subtask.id}`,
          phase: agentTask.phase,
          title: subtask.title,
          assignedWorker: agentTask.assignedWorker,
          delegateCount: childPreferredDelegateCount,
          instructions: subtask.instructions,
          dependsOn: safeArray(subtask.dependsOn),
          expectedOutput: subtask.expectedOutput
        };
        subordinateTask.requirements = deriveTaskRequirements(subordinateTask, {
          parentRequirements: agentTask.requirements,
          inheritConcreteArtifactRequirement: false
        });
        return {
          index,
          subtask,
          subordinateTask,
          subordinateAgent: createSubordinateRuntimeAgent(agent, subordinateTask, index)
        };
      });
      const completedSubordinateExecutions = new Map();
      const runningSubordinateExecutions = new Map();
      const subordinateBatchAbortController = new AbortController();

      while (completedSubordinateExecutions.size < delegatedEntries.length) {
        for (const entry of delegatedEntries) {
          if (
            runningSubordinateExecutions.size >= subordinateConcurrency ||
            completedSubordinateExecutions.has(entry.subtask.id) ||
            runningSubordinateExecutions.has(entry.subtask.id)
          ) {
            continue;
          }

          const ready = entry.subordinateTask.dependsOn.every((dependencyId) =>
            completedSubordinateExecutions.has(dependencyId)
          );
          if (!ready) {
            continue;
          }

          emitAgentEvent(
            onEvent,
            entry.subordinateAgent,
            {
              type: "status",
              stage: "subagent_created",
              tone: "neutral",
              content: entry.subtask.instructions || entry.subtask.title || "",
              detail: localizeRunText(
                runLocale,
                `Created child agent for: ${entry.subtask.title}`,
                `已为该任务创建子 Agent：${entry.subtask.title}`
              ),
              thinkingSummary: delegationPlan.thinkingSummary || "",
              targetAgentLabel: entry.subordinateAgent.displayLabel || entry.subordinateAgent.label || ""
            },
            entry.subordinateTask
          );

          const childDependencyOutputs = [
            ...dependencyOutputs,
            ...entry.subordinateTask.dependsOn
              .map((dependencyId) => completedSubordinateExecutions.get(dependencyId))
              .filter(Boolean)
              .map(summarizeExecutionForDependency)
          ];
          const childSignal = combineAbortSignals(
            signalOverride,
            subordinateBatchAbortController.signal
          );
          const executionPromise = executeAgentHierarchy({
            agent: entry.subordinateAgent,
            provider,
            agentTask: entry.subordinateTask,
            dependencyOutputs: childDependencyOutputs,
            preferredDelegateCount: childPreferredDelegateCount,
            depthRemaining: Math.max(0, depthRemaining - 1),
            defaultToRequested: false,
            parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId,
            signalOverride: childSignal
          }).then((execution) => ({
            subtaskId: entry.subtask.id,
            execution
          }));
          runningSubordinateExecutions.set(entry.subtask.id, executionPromise);
        }

        if (!runningSubordinateExecutions.size) {
          const blocked = delegatedEntries
            .filter((entry) => !completedSubordinateExecutions.has(entry.subtask.id))
            .map((entry) => ({
              subtaskId: entry.subtask.id,
              dependsOn: entry.subordinateTask.dependsOn
            }));
          throw new Error(
            `Delegated child tasks contain unresolved dependencies: ${JSON.stringify(blocked)}`
          );
        }

        const settled = await Promise.race(runningSubordinateExecutions.values());
        runningSubordinateExecutions.delete(settled.subtaskId);
        completedSubordinateExecutions.set(settled.subtaskId, settled.execution);
        if (settled.execution?.retryableProviderFailure) {
          if (!subordinateBatchAbortController.signal.aborted) {
            subordinateBatchAbortController.abort(
              new Error("Delegated child batch aborted after a retryable failure.")
            );
          }
          await Promise.allSettled(runningSubordinateExecutions.values());
          throw buildDelegatedRetryableFailure(agent, agentTask, settled.execution);
        }
      }

      const subordinateExecutions = delegatedEntries.map((entry) =>
        completedSubordinateExecutions.get(entry.subtask.id)
      );

      const result = await synthesizeLeaderResult({
        agent,
        provider,
        agentTask,
        dependencyOutputs,
        subordinateExecutions,
        delegationPlan,
        startedAt,
        parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId,
        signalOverride
      });

      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "status",
            stage: lifecycle.done,
            tone: result.status === "failed" ? "warning" : "ok",
            thinkingSummary: result.output.thinkingSummary || "",
            summary: result.output.summary || "",
            content: result.output.summary || result.output.thinkingSummary || "",
            targetAgentLabel: agent.parentAgentLabel || ""
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
  const taskPhase = normalizePhase(task.phase, inferPhase(task, primaryWorker));
  const maxWorkerAttempts =
    1 +
    rankFallbackWorkersForTask({
      workers: allWorkers,
      primaryWorker,
      phase: taskPhase,
      task,
      capabilityRoutingPolicy,
      providerRegistry
    }).length;
  let leaderAgent = createLeaderRuntimeAgent(primaryWorker, task);
  let currentTask = task;
  let lastResult = null;
  let currentWorker = primaryWorker;
  let currentProvider = primaryProvider;
  const attemptedWorkerIds = new Set();

  for (;;) {
    if (!currentProvider) {
      return lastResult;
    }

    attemptChildAgentReservations = 0;
    currentTask =
      currentWorker.id === primaryWorker.id && !attemptedWorkerIds.size
        ? task
        : {
            ...task,
            assignedWorker: currentWorker.id
          };
    leaderAgent =
      currentWorker.id === primaryWorker.id && !attemptedWorkerIds.size
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
    attemptedWorkerIds.add(currentWorker.id);
    if (!result.retryableProviderFailure) {
      return result;
    }

    if (runAgentBudget && attemptChildAgentReservations > 0) {
      runAgentBudget.releaseChildAgents(attemptChildAgentReservations);
    }

    const nextWorker = rankFallbackWorkersForTask({
      workers: allWorkers,
      primaryWorker: currentWorker,
      phase: taskPhase,
      task: currentTask,
      capabilityRoutingPolicy,
      providerRegistry,
      excludeWorkerIds: Array.from(attemptedWorkerIds)
    })[0];
    if (!nextWorker) {
      return result;
    }

    emitAgentEvent(
      onEvent,
      leaderAgent,
      {
        type: "status",
        stage: "worker_fallback",
        tone: "warning",
        detail: localizeRunText(
          runLocale,
          `Retryable provider failure on ${currentWorker.label}; rerouting this task to ${nextWorker.label}.`,
          `${currentWorker.label} 发生可重试的 provider 故障；本任务已切换给 ${nextWorker.label}。`
        ),
        previousWorkerId: currentWorker.id,
        previousWorkerLabel: currentWorker.label,
        fallbackWorkerId: nextWorker.id,
        fallbackWorkerLabel: nextWorker.label,
        attempt: attemptedWorkerIds.size,
        maxAttempts: maxWorkerAttempts
      },
      currentTask
    );

    currentWorker = nextWorker;
    currentProvider = providerRegistry.get(nextWorker.id);
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
  signal,
  outputLocale = "en-US"
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
      detail: localizeRunText(
        outputLocale,
        `Entering ${phase} phase.`,
        `进入${phase}阶段。`
      )
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
          signal,
          outputLocale
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
      detail: localizeRunText(
        outputLocale,
        `Completed ${phase} phase with ${phaseResults.length} task(s).`,
        `已完成${phase}阶段，共处理 ${phaseResults.length} 个任务。`
      )
    });

    if (
      phase === "validation" &&
      phaseResults.some((result) => result.output?.verificationStatus === "failed")
    ) {
      emitEvent(onEvent, {
        type: "status",
        stage: "validation_gate_failed",
        tone: "warning",
        detail: localizeRunText(
          outputLocale,
          "Validation phase reported failures. Final synthesis will highlight verification risks.",
          "验证阶段报告了失败项，最终综合会明确标出这些校验风险。"
        )
      });
    }
  }

  return plan.tasks.map((task) => completedResults.get(task.id));
}

export async function runClusterAnalysis({
  task,
  config,
  providerRegistry,
  onEvent,
  signal,
  outputLocale = "en-US"
}) {
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
  const runLocale = normalizeRunLocale(outputLocale);
  const languagePack = createRunLanguagePack(runLocale);
  let activeController = createControllerRuntimeAgent(controllerModel);
  let activeControllerProvider = controllerProvider;
  const multiAgentRuntime = createMultiAgentRuntime(config.multiAgent);
  const multiAgentConversationState = {
    topLevelAssignments: [],
    childAssignmentsByParent: new Map(),
    roundRobinCursor: 0
  };

  function hashConversationSeed(value) {
    const normalized = safeString(value);
    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
    }
    return hash;
  }

  function createSyntheticRuntimeAgent(label, kind = "agent", fallbackId = "") {
    const normalizedLabel = safeString(label);
    const normalizedId =
      safeString(fallbackId) ||
      normalizedLabel.toLowerCase().replace(/[^\w-]+/g, "_") ||
      `synthetic_${kind}`;
    return {
      runtimeId: `synthetic:${normalizedId}`,
      displayLabel: normalizedLabel || normalizedId,
      label: normalizedLabel || normalizedId,
      id: normalizedId,
      agentKind: kind
    };
  }

  function rememberTopLevelAssignments(planTasks = []) {
    const normalizedTasks = Array.isArray(planTasks) ? planTasks : [];
    multiAgentConversationState.topLevelAssignments = normalizedTasks
      .map((taskItem) => {
        const assignedWorker = config.models[safeString(taskItem?.assignedWorker)];
        if (!assignedWorker) {
          return null;
        }
        return {
          id: safeString(taskItem?.id),
          title: safeString(taskItem?.title || taskItem?.id),
          phase: safeString(taskItem?.phase),
          assignedWorker: assignedWorker.id,
          agent: createLeaderRuntimeAgent(assignedWorker, {
            phase: taskItem?.phase,
            title: taskItem?.title
          })
        };
      })
      .filter(Boolean);
  }

  function rememberChildAssignment(parentAgent, childAgent, taskTitle = "", phase = "") {
    const parentId = safeString(parentAgent?.runtimeId || parentAgent?.id);
    const childId = safeString(childAgent?.runtimeId || childAgent?.id);
    if (!parentId || !childId) {
      return [];
    }

    const roster = multiAgentConversationState.childAssignmentsByParent.get(parentId) || [];
    if (!roster.some((entry) => entry.id === childId)) {
      roster.push({
        id: childId,
        title: safeString(taskTitle),
        phase: safeString(phase),
        agent: childAgent
      });
      multiAgentConversationState.childAssignmentsByParent.set(parentId, roster);
    }

    return roster;
  }

  function resolveRoundRobinIndex(size = 0) {
    if (!size) {
      return 0;
    }
    const nextIndex = multiAgentConversationState.roundRobinCursor % size;
    multiAgentConversationState.roundRobinCursor += 1;
    return nextIndex;
  }

  function pickStrategicTarget(candidates, seed = "") {
    const filtered = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
    if (!filtered.length) {
      return null;
    }

    switch (multiAgentRuntime.settings.speakerStrategy) {
      case "random":
        return filtered[hashConversationSeed(seed || filtered[0]?.id) % filtered.length];
      case "round_robin":
        return filtered[resolveRoundRobinIndex(filtered.length)];
      default:
        return filtered[0];
    }
  }

  function buildAllocationSummary(assignments, locale = "en-US") {
    const normalizedAssignments = (Array.isArray(assignments) ? assignments : []).filter(Boolean);
    if (!normalizedAssignments.length) {
      return "";
    }

    return normalizedAssignments
      .slice(0, 4)
      .map((assignment) =>
        localizeRunText(
          locale,
          `${resolveQuotedTaskTitle(assignment.title, "this task", locale)} -> ${assignment.agent.displayLabel}`,
          `${resolveQuotedTaskTitle(assignment.title, "该任务", locale)} -> ${assignment.agent.displayLabel}`
        )
      )
      .join(localizeRunText(locale, "; ", "；"));
  }

  function createSyntheticMultiAgentMessage({
    speaker,
    target = null,
    phase = "",
    tone = "neutral",
    kind = "message",
    summaryType = "",
    content = "",
    taskTitle = "",
    artifactPath = "",
    query = "",
    sourceStage = ""
  } = {}) {
    const normalizedContent = safeString(content);
    if (!normalizedContent) {
      return null;
    }

    return {
      kind,
      stage: "multi_agent_chat",
      tone: safeString(tone) || "neutral",
      phase: safeString(phase),
      speaker,
      target,
      content: normalizedContent,
      summaryType: safeString(summaryType),
      taskTitle: safeString(taskTitle),
      artifactPath: safeString(artifactPath),
      query: safeString(query),
      sourceStage: safeString(sourceStage)
    };
  }
  
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

  function resolveTopLevelAssignmentsByPhase(phase = "") {
    const normalizedPhase = safeString(phase);
    return multiAgentConversationState.topLevelAssignments.filter(
      (assignment) => !normalizedPhase || safeString(assignment.phase) === normalizedPhase
    );
  }

  function findTopLevelAssignmentForAgent(agent = null, phase = "") {
    const runtimeId = safeString(agent?.runtimeId || agent?.id);
    const modelId = safeString(agent?.id);
    const normalizedPhase = safeString(phase);
    return (
      multiAgentConversationState.topLevelAssignments.find((assignment) => {
        const assignmentRuntimeId = safeString(assignment?.agent?.runtimeId || assignment?.agent?.id);
        return (
          (!normalizedPhase || safeString(assignment?.phase) === normalizedPhase) &&
          (assignmentRuntimeId === runtimeId || safeString(assignment?.assignedWorker) === modelId)
        );
      }) || null
    );
  }

  function resolveSiblingAssignments(parentAgent = null, excludeAgent = null) {
    const parentId = safeString(parentAgent?.runtimeId || parentAgent?.id);
    const excludedId = safeString(excludeAgent?.runtimeId || excludeAgent?.id);
    if (!parentId) {
      return [];
    }
    return (multiAgentConversationState.childAssignmentsByParent.get(parentId) || []).filter(
      (assignment) => assignment && assignment.id !== excludedId
    );
  }

  function resolveNextPhaseAssignments(phase = "") {
    const currentIndex = PHASE_ORDER.indexOf(safeString(phase));
    if (currentIndex < 0) {
      return [];
    }
    for (let index = currentIndex + 1; index < PHASE_ORDER.length; index += 1) {
      const assignments = resolveTopLevelAssignmentsByPhase(PHASE_ORDER[index]);
      if (assignments.length) {
        return assignments;
      }
    }
    return [];
  }

  function resolveWorkspaceArtifactHint(payload = {}) {
    const generatedFiles = normalizeWorkspaceArtifactReferences(payload.generatedFiles || []);
    if (generatedFiles.length) {
      return generatedFiles[0];
    }
    return extractEventDetailValue(safeString(payload.detail), [
      /^Auto-materialized requested artifact(?: but verification failed)?:\s*(.+)$/i,
      /^Artifact:\s*(.+)$/i,
      /^Files:\s*(.+)$/i
    ]);
  }

  function resolveConversationArtifactContext(stage, payload = {}) {
    const normalizedStage = safeString(stage || payload.stage);
    if (normalizedStage === "workspace_write") {
      return resolveWorkspaceArtifactHint(payload);
    }
    if (normalizedStage === "workspace_read") {
      return normalizeWorkspaceArtifactReferences(payload.paths || [])[0] || "";
    }
    if (
      normalizedStage === "worker_done" ||
      normalizedStage === "subagent_done" ||
      normalizedStage === "cluster_done"
    ) {
      return (
        normalizeWorkspaceArtifactReferences(payload.verifiedGeneratedFiles || [])[0] ||
        normalizeWorkspaceArtifactReferences(payload.generatedFiles || [])[0] ||
        ""
      );
    }
    return "";
  }

  function resolveConversationQueryContext(stage, payload = {}) {
    const normalizedStage = safeString(stage || payload.stage);
    if (normalizedStage !== "workspace_web_search") {
      return "";
    }
    return safeString(payload.query || extractEventDetailValue(safeString(payload.detail)));
  }

  function buildSequentialSyntheticMessages({ stage, agent, taskTitle, phase }) {
    if (stage === "planning_done") {
      return [
        createSyntheticMultiAgentMessage({
          speaker: activeController,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            "Sequential mode locked the queue. Top-level tasks will be released one at a time.",
            "顺序协作已锁定队列，顶层任务会按顺序逐个释放。"
          )
        })
      ];
    }

    if (stage === "worker_done" && taskTitle) {
      return [
        createSyntheticMultiAgentMessage({
          speaker: agent,
          phase,
          tone: "ok",
          content: localizeRunText(
            runLocale,
            `Queue advanced after ${resolveQuotedTaskTitle(taskTitle, "this task", runLocale)}.`,
            `${resolveQuotedTaskTitle(taskTitle, "该任务", runLocale)} 已完成，队列推进到下一项。`
          )
        })
      ];
    }

    return [];
  }

  function buildGroupChatSyntheticMessages({ stage, payload, agent, parentAgent, taskTitle, phase }) {
    const messages = [];
    const taskLabel = resolveQuotedTaskTitle(taskTitle, "this task", runLocale);

    if (stage === "planning_done") {
      const assignments = multiAgentConversationState.topLevelAssignments;
      if (assignments.length > 1) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: activeController,
            tone: "ok",
            content: localizeRunText(
              runLocale,
              `Parallel discussion lanes are open. ${buildAllocationSummary(assignments, runLocale)}. Share overlaps early instead of waiting for the final merge.`,
              `并行讨论通道已打开。${buildAllocationSummary(assignments, runLocale)}。如有交叉信息，请尽早互相校对，不要等到最终汇总时才暴露冲突。`
            )
          })
        );
        const speakerAssignment = pickStrategicTarget(assignments, payload.planStrategy || payload.detail || taskTitle);
        const peerAssignment = pickStrategicTarget(
          assignments.filter((assignment) => assignment.id !== speakerAssignment?.id),
          payload.planStrategy || payload.detail || taskTitle
        );
        if (speakerAssignment && peerAssignment) {
          messages.push(
            createSyntheticMultiAgentMessage({
              speaker: speakerAssignment.agent,
              target: peerAssignment.agent,
              phase: safeString(speakerAssignment.phase),
              tone: "neutral",
              content: localizeRunText(
                runLocale,
                "My lane may affect yours. I will surface overlapping evidence early; please call out contradictions as soon as you see them.",
                "我的任务线可能会影响你的判断。我会尽早同步重叠证据，也请你在发现矛盾时第一时间指出。"
              )
            })
          );
          messages.push(
            createSyntheticMultiAgentMessage({
              speaker: peerAssignment.agent,
              target: speakerAssignment.agent,
              phase: safeString(peerAssignment.phase),
              tone: "neutral",
              content: localizeRunText(
                runLocale,
                "Understood. I will challenge weak assumptions early instead of waiting for the final synthesis.",
                "收到。我会尽早质疑薄弱假设，不会等到最终综合时才提出。"
              )
            })
          );
        }
      }
      return messages.filter(Boolean);
    }

    if (stage === "worker_start") {
      const assignment = findTopLevelAssignmentForAgent(agent, phase);
      if (assignment) {
        const peerAssignment = pickStrategicTarget(
          multiAgentConversationState.topLevelAssignments.filter((entry) => entry.id !== assignment.id),
          taskTitle || payload.detail
        );
        if (peerAssignment) {
          messages.push(
            createSyntheticMultiAgentMessage({
              speaker: agent,
              target: peerAssignment.agent,
              phase,
              tone: "neutral",
              content: localizeRunText(
                runLocale,
                `I started ${taskLabel}. If your branch touches the same sources or files, flag it early and I will compare notes before synthesis.`,
                `我已开始处理 ${taskLabel}。如果你的分支碰到相同来源或文件，请尽早提醒，我会在综合前先对齐口径。`
              )
            })
          );
          messages.push(
            createSyntheticMultiAgentMessage({
              speaker: peerAssignment.agent,
              target: agent,
              phase: safeString(peerAssignment.phase),
              tone: "neutral",
              content: localizeRunText(
                runLocale,
                "I see your lane. If my evidence conflicts with yours, I will surface the mismatch immediately.",
                "我看到你的任务线了。如果我的证据和你冲突，我会立刻把冲突点抛出来。"
              )
            })
          );
        }
      }
      return messages.filter(Boolean);
    }

    if (stage === "subagent_created") {
      const siblings = resolveSiblingAssignments(parentAgent, agent);
      const peerAssignment = pickStrategicTarget(siblings, taskTitle || payload.detail);
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: parentAgent || activeController,
          target: agent,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            `Take ${taskLabel}. Keep me posted if you discover overlap with any sibling lane.`,
            `请接手 ${taskLabel}。如果你发现和其他兄弟任务线有重叠，第一时间同步给我。`
          )
        })
      );
      if (peerAssignment) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: peerAssignment.agent,
            target: agent,
            phase: safeString(peerAssignment.phase),
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              "I am working on a nearby branch. Ping me if our evidence or files start to overlap.",
              "我在处理相邻分支。如果我们的证据或文件开始重叠，直接来找我。"
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "subagent_start") {
      const siblings = resolveSiblingAssignments(parentAgent, agent);
      const peerAssignment = pickStrategicTarget(siblings, taskTitle || payload.detail);
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: agent,
          target: parentAgent || activeController,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            `Accepted ${taskLabel}. I will flag overlaps instead of silently diverging from sibling branches.`,
            `已接手 ${taskLabel}。如果我发现和兄弟分支存在重叠，不会闷头各做各的，我会直接提示。`
          )
        })
      );
      if (peerAssignment) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: agent,
            target: peerAssignment.agent,
            phase,
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              `I am covering ${taskLabel}. If you hit the same evidence or files, tell me before the leader merges our branches.`,
              `我负责 ${taskLabel}。如果你碰到相同证据或文件，请在组长合并我们分支前先告诉我。`
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "subagent_done" || stage === "worker_done") {
      const siblings = parentAgent
        ? resolveSiblingAssignments(parentAgent, agent)
        : multiAgentConversationState.topLevelAssignments.filter(
            (assignment) => assignment.id !== findTopLevelAssignmentForAgent(agent, phase)?.id
          );
      const peerAssignment = pickStrategicTarget(siblings, taskTitle || payload.summary || payload.detail);
      if (peerAssignment) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: agent,
            target: peerAssignment.agent,
            phase,
            tone: "ok",
            content: localizeRunText(
              runLocale,
              `My branch for ${taskLabel} is ready. Cross-check it against your lane before the final merge.`,
              `我这条关于 ${taskLabel} 的分支已经完成。请在最终合并前和你的任务线做一次交叉核对。`
            )
          })
        );
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: peerAssignment.agent,
            target: agent,
            phase: safeString(peerAssignment.phase),
            tone: "ok",
            content: localizeRunText(
              runLocale,
              "I will compare your branch against mine now and call out any mismatch before we merge.",
              "我现在就拿你的分支和我的分支做比对，在合并前把不一致点挑出来。"
            )
          })
        );
      } else if (parentAgent) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: agent,
            target: parentAgent,
            phase,
            tone: "ok",
            content: localizeRunText(
              runLocale,
              `My branch for ${taskLabel} is ready. Please compare it against the other lanes before synthesis.`,
              `我这条关于 ${taskLabel} 的分支已经完成。请在综合前和其他任务线做一次比对。`
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "workspace_read") {
      const peerAssignment = parentAgent
        ? pickStrategicTarget(resolveSiblingAssignments(parentAgent, agent), payload.detail)
        : pickStrategicTarget(
            multiAgentConversationState.topLevelAssignments.filter(
              (assignment) => assignment.id !== findTopLevelAssignmentForAgent(agent, phase)?.id
            ),
            payload.detail
          );
      const targetAgent = peerAssignment?.agent || parentAgent || null;
      if (targetAgent) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: agent,
            target: targetAgent,
            phase,
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              "I am reading the latest artifact bundle now. If you already depend on it, tell me what assumption matters most.",
              "我正在读取最新的产物包。如果你也依赖它，告诉我你最关心哪条前提假设。"
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "workspace_write") {
      const artifactPath = resolveWorkspaceArtifactHint(payload);
      const peerAssignment = parentAgent
        ? pickStrategicTarget(resolveSiblingAssignments(parentAgent, agent), artifactPath || payload.detail)
        : pickStrategicTarget(
            multiAgentConversationState.topLevelAssignments.filter(
              (assignment) => assignment.id !== findTopLevelAssignmentForAgent(agent, phase)?.id
            ),
            artifactPath || payload.detail
          );
      const targetAgent = peerAssignment?.agent || parentAgent || null;
      if (targetAgent) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: agent,
            target: targetAgent,
            phase,
            tone: "ok",
            content: localizeRunText(
              runLocale,
              artifactPath
                ? `I wrote ${artifactPath}. Pull it directly if it changes your lane, and challenge anything that looks inconsistent.`
                : "I wrote a new workspace artifact. Pull it directly if it affects your lane, and challenge anything inconsistent.",
              artifactPath
                ? `我已经写入 ${artifactPath}。如果它会影响你的任务线，直接拿去用；若发现不一致，马上指出。`
                : "我已经写入新的工作区产物。如果它会影响你的任务线，直接拿去用；若发现不一致，马上指出。"
            )
          })
        );
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: targetAgent,
            target: agent,
            phase: safeString(peerAssignment?.phase || phase),
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              artifactPath
                ? `Received ${artifactPath}. I will consume it directly and flag any contradiction instead of silently patching around it.`
                : "Received the new artifact. I will consume it directly and flag any contradiction instead of silently patching around it.",
              artifactPath
                ? `收到 ${artifactPath}。我会直接消费它，不会悄悄绕过去；如果有矛盾我会直接指出。`
                : "收到新的产物。我会直接消费它，不会悄悄绕过去；如果有矛盾我会直接指出。"
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "workspace_web_search") {
      const peerAssignment = parentAgent
        ? pickStrategicTarget(resolveSiblingAssignments(parentAgent, agent), payload.detail)
        : pickStrategicTarget(
            multiAgentConversationState.topLevelAssignments.filter(
              (assignment) => assignment.id !== findTopLevelAssignmentForAgent(agent, phase)?.id
            ),
            payload.detail
          );
      const targetAgent = peerAssignment?.agent || parentAgent || null;
      if (targetAgent) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: agent,
            target: targetAgent,
            phase,
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              `Fresh web evidence is in. Please check whether it changes your assumptions before we merge.`,
              "新的联网证据已经补进来了。请先检查它是否会改变你的分支判断，再进入合并。"
            )
          })
        );
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: targetAgent,
            target: agent,
            phase: safeString(peerAssignment?.phase || phase),
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              "I will update my assumptions against the fresh evidence now. If anything no longer holds, I will say it explicitly.",
              "我现在就用这批新证据回刷我的判断。如果有前提站不住了，我会明确说出来。"
            )
          })
        );
      }
    }

    return messages.filter(Boolean);
  }

  function buildWorkflowSyntheticMessages({ stage, payload, agent, parentAgent, taskTitle, phase }) {
    const messages = [];
    const taskLabel = resolveQuotedTaskTitle(taskTitle, "this task", runLocale);
    const nextPhaseAssignments = resolveNextPhaseAssignments(phase);

    if (stage === "planning_done") {
      const assignments = multiAgentConversationState.topLevelAssignments;
      if (assignments.length) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: activeController,
            tone: "ok",
            content: localizeRunText(
              runLocale,
              `Nested tool flow locked. ${buildAllocationSummary(assignments, runLocale)}. Downstream phases should consume verified outputs from the previous phase only.`,
              `嵌套工具流已锁定。${buildAllocationSummary(assignments, runLocale)}。下游阶段只能消费上游阶段已校验的输出。`
            )
          })
        );
      }
      const researchAssignments = resolveTopLevelAssignmentsByPhase("research");
      const implementationAssignments = resolveTopLevelAssignmentsByPhase("implementation");
      const upstream = pickStrategicTarget(researchAssignments, payload.planStrategy || payload.detail);
      const downstream = pickStrategicTarget(implementationAssignments, payload.planStrategy || payload.detail);
      if (upstream && downstream) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: upstream.agent,
            target: downstream.agent,
            phase: "research",
            tone: "neutral",
            content: localizeRunText(
              runLocale,
              "I will hand off explicit artifact paths and assumptions so your phase can continue without rescanning the whole workspace.",
              "我会交付明确的产物路径和前提假设，这样你的阶段就不必重新全量扫描整个工作区。"
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "phase_done") {
      const currentAssignments = resolveTopLevelAssignmentsByPhase(phase);
      const sourceAssignment = pickStrategicTarget(currentAssignments, phase);
      const targetAssignment = pickStrategicTarget(nextPhaseAssignments, phase);
      if (sourceAssignment && targetAssignment) {
        messages.push(
          createSyntheticMultiAgentMessage({
            speaker: sourceAssignment.agent,
            target: targetAssignment.agent,
            phase,
            tone: "ok",
            content: localizeRunText(
              runLocale,
              `The ${phase || "current"} handoff pack is ready. Continue from the verified outputs only and avoid unrelated workspace scans.`,
              `${phase || "当前"}阶段的交接包已准备好。请仅基于已校验输出继续推进，不要再去扫描无关的工作区内容。`
            )
          })
        );
      }
      return messages.filter(Boolean);
    }

    if (stage === "worker_start") {
      if (nextPhaseAssignments.length) {
        const downstream = pickStrategicTarget(nextPhaseAssignments, taskTitle || payload.detail);
        if (downstream) {
          messages.push(
            createSyntheticMultiAgentMessage({
              speaker: agent,
              target: downstream.agent,
              phase,
              tone: "neutral",
              content: localizeRunText(
                runLocale,
                `I started ${taskLabel}. I will keep the output structured and tool-safe for the downstream phase.`,
                `我已开始处理 ${taskLabel}。我会保持输出结构稳定、工具链可消费，方便下游阶段直接接续。`
              )
            })
          );
        }
      }
      return messages.filter(Boolean);
    }

    if (stage === "subagent_created") {
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: parentAgent || activeController,
          target: agent,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            `For ${taskLabel}, produce explicit artifact paths and interface notes so the next step can consume your output directly.`,
            `针对 ${taskLabel}，请输出明确的产物路径和接口说明，让下一步可以直接消费你的结果。`
          )
        })
      );
      return messages.filter(Boolean);
    }

    if (stage === "subagent_start") {
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: agent,
          target: parentAgent || activeController,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            "Accepted. I will keep filenames stable and report contract changes immediately.",
            "已接手。我会保持文件名和接口稳定，一旦发生契约变化会立刻回报。"
          )
        })
      );
      return messages.filter(Boolean);
    }

    if (stage === "subagent_done" || stage === "worker_done") {
      const downstream = pickStrategicTarget(nextPhaseAssignments, taskTitle || payload.summary || payload.detail);
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: agent,
          target: downstream?.agent || parentAgent || activeController,
          phase,
          tone: "ok",
          content: localizeRunText(
            runLocale,
            `Handoff for ${taskLabel} is ready. Continue from the verified artifact set only.`,
            `${taskLabel} 的交接结果已经准备好。请仅从已校验的产物集合继续推进。`
          )
        })
      );
      return messages.filter(Boolean);
    }

    if (stage === "workspace_read") {
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: agent,
          target: parentAgent || pickStrategicTarget(nextPhaseAssignments, payload.detail)?.agent || null,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            "I am reading the upstream artifact bundle directly instead of rescanning the whole workspace.",
            "我正在直接读取上游产物包，而不是重新全量扫描整个工作区。"
          )
        })
      );
      return messages.filter(Boolean);
    }

    if (stage === "workspace_write") {
      const artifactPath = resolveWorkspaceArtifactHint(payload);
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: agent,
          target: parentAgent || pickStrategicTarget(nextPhaseAssignments, artifactPath || payload.detail)?.agent || null,
          phase,
          tone: "ok",
          content: localizeRunText(
            runLocale,
            artifactPath
              ? `Artifact ready for downstream consumption: ${artifactPath}. Use this path as the workflow input.`
              : "The workflow artifact bundle is ready for downstream consumption.",
            artifactPath
              ? `下游可消费的产物已就绪：${artifactPath}。请把这个路径作为后续工作流输入。`
              : "工作流产物包已就绪，可直接交给下游消费。"
          )
        })
      );
      return messages.filter(Boolean);
    }

    if (stage === "workspace_web_search") {
      messages.push(
        createSyntheticMultiAgentMessage({
          speaker: agent,
          target: parentAgent || pickStrategicTarget(nextPhaseAssignments, payload.detail)?.agent || null,
          phase,
          tone: "neutral",
          content: localizeRunText(
            runLocale,
            "Verified external evidence has been added to the handoff pack. Downstream steps should cite it from the validated bundle only.",
            "已校验的外部证据已经写入交接包。下游步骤引用时只应使用这个经过验证的证据集合。"
          )
        })
      );
    }

    return messages.filter(Boolean);
  }

  function buildExpandedMultiAgentMessages(payload = {}) {
    const stage = safeString(payload.stage);
    const agent = resolveRuntimeAgentFromEvent(payload);
    const parentAgent = resolveParentRuntimeAgent(payload);
    const taskTitle = safeString(payload.taskTitle || payload.taskId);
    const phase = safeString(payload.phase);
    const artifactPath = resolveConversationArtifactContext(stage, payload);
    const query = resolveConversationQueryContext(stage, payload);
    const baseMessage = translateClusterEventToMultiAgentMessage(payload);

    if (stage === "planning_done") {
      rememberTopLevelAssignments(payload.planTasks);
    } else if (stage === "subagent_created" || stage === "subagent_start" || stage === "subagent_done") {
      rememberChildAssignment(parentAgent, agent, taskTitle, phase);
    }

    const messages = baseMessage ? [baseMessage] : [];
    if (!multiAgentRuntime.isEnabled()) {
      return messages;
    }

    const modeSpecificMessages =
      multiAgentRuntime.settings.mode === "group_chat"
        ? buildGroupChatSyntheticMessages({ stage, payload, agent, parentAgent, taskTitle, phase })
        : multiAgentRuntime.settings.mode === "workflow"
          ? buildWorkflowSyntheticMessages({ stage, payload, agent, parentAgent, taskTitle, phase })
          : buildSequentialSyntheticMessages({ stage, agent, taskTitle, phase });

    const enrichedModeSpecificMessages = modeSpecificMessages.map((message) =>
      message
        ? {
            ...message,
            taskTitle: safeString(message.taskTitle || taskTitle),
            artifactPath: safeString(message.artifactPath || artifactPath),
            query: safeString(message.query || query),
            sourceStage: safeString(message.sourceStage || stage)
          }
        : null
    );

    return [...messages, ...enrichedModeSpecificMessages].filter(Boolean);
  }

  function translateClusterEventToMultiAgentMessage(payload = {}) {
    const stage = safeString(payload.stage);
    const agent = resolveRuntimeAgentFromEvent(payload);
    const parentAgent = resolveParentRuntimeAgent(payload);
    const taskTitle = safeString(payload.taskTitle || payload.taskId);
    const phase = safeString(payload.phase);
    const tone = safeString(payload.tone || "neutral") || "neutral";
    const content = buildConversationStyleContent(stage, payload, taskTitle, runLocale);
    const artifactPath = resolveConversationArtifactContext(stage, payload);
    const query = resolveConversationQueryContext(stage, payload);

    switch (stage) {
      case "planning_start":
        return {
          kind: "system",
          stage,
          tone,
          speaker: agent,
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content:
            content ||
            localizeRunText(
              runLocale,
              `${agent.displayLabel} started planning the collaboration.`,
              `${agent.displayLabel} 已开始规划协作流程。`
            )
        };
      case "planning_done":
        return {
          kind: "summary",
          stage,
          tone: "ok",
          speaker: agent,
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content:
            content ||
            localizeRunText(
              runLocale,
              `${agent.displayLabel} created ${payload.taskCount ?? 0} top-level task(s).`,
              `${agent.displayLabel} 已创建 ${payload.taskCount ?? 0} 个顶层任务。`
            )
        };
      case "phase_start":
      case "phase_done":
        return {
          kind: "system",
          stage,
          tone,
          phase,
          speaker: agent,
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content: content || `${stage === "phase_start" ? "Entering" : "Completed"} ${phase} phase.`
        };
      case "worker_start":
      case "subagent_start":
      case "leader_delegate_start":
      case "leader_delegate_done":
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
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content:
            content ||
            (taskTitle
              ? localizeRunText(
                  runLocale,
                  `${agent.displayLabel} is handling ${taskTitle}.`,
                  `${agent.displayLabel} 正在处理 ${taskTitle}。`
                )
              : localizeRunText(
                  runLocale,
                  `${agent.displayLabel} sent an update.`,
                  `${agent.displayLabel} 发送了一条进展更新。`
                ))
        };
      case "subagent_created":
        return {
          kind: "message",
          stage,
          tone,
          phase,
          speaker: parentAgent || agent,
          target: agent,
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content:
            content ||
            localizeRunText(
              runLocale,
              `Created ${agent.displayLabel}${taskTitle ? ` for ${taskTitle}` : ""}.`,
              `已创建 ${agent.displayLabel}${taskTitle ? `，负责 ${taskTitle}` : ""}。`
            )
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
          target: parentAgent || null,
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content:
            content ||
            (taskTitle
              ? localizeRunText(
                  runLocale,
                  `${agent.displayLabel} completed ${taskTitle}.`,
                  `${agent.displayLabel} 已完成 ${taskTitle}。`
                )
              : localizeRunText(
                  runLocale,
                  `${agent.displayLabel} completed an update.`,
                  `${agent.displayLabel} 已完成一条更新。`
                ))
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
          taskTitle,
          artifactPath,
          query,
          sourceStage: stage,
          content:
            content ||
            safeString(payload.finalAnswer) ||
            localizeRunText(
              runLocale,
              `${agent.displayLabel} reported ${stage.replaceAll("_", " ")}.`,
              `${agent.displayLabel} 已报告 ${stage.replaceAll("_", " ")}。`
            )
        };
      default:
        return null;
    }
  }

  function captureMultiAgentFromEvent(payload = {}) {
    if (!multiAgentRuntime.isEnabled()) {
      return [];
    }

    const recordedMessages = [];
    for (const message of buildExpandedMultiAgentMessages(payload)) {
      if (!message) {
        continue;
      }

      const recorded =
        message.kind === "summary"
          ? multiAgentRuntime.recordSummary(message)
          : message.kind === "system"
            ? multiAgentRuntime.recordSystem(message)
            : multiAgentRuntime.recordMessage(message);
      if (recorded) {
        recordedMessages.push(recorded);
      }
    }

    return recordedMessages;
  }

  function forwardClusterEvent(payload) {
    const recordedMessages = captureMultiAgentFromEvent(payload);
    emitEvent(
      onEvent,
      recordedMessages.length ? { ...payload, multiAgentMessages: recordedMessages } : payload
    );
  }

  const sessionRuntime = createSessionRuntime({
    locale: runLocale,
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
      detail: languagePack.collaborationStarted(multiAgentRuntime.settings.mode)
    });

    async function invokeControllerStageWithFallback({
      purpose,
      prompt,
      startStage,
      retryStage
    }) {
      const primaryController = activeController;
      const primaryProvider = activeControllerProvider;
      const maxControllerAttempts =
        1 +
        rankFallbackControllers({
          models: controllerModels,
          primaryController,
          purpose,
          providerRegistry
        }).length;
      const attemptedControllerIds = new Set();
      let lastError = null;

      let stageController = primaryController;
      let stageProvider = primaryProvider;

      for (;;) {
        if (!stageProvider) {
          attemptedControllerIds.add(stageController.id);
          const nextControllerModel = rankFallbackControllers({
            models: controllerModels,
            primaryController: stageController,
            purpose,
            providerRegistry,
            excludeModelIds: Array.from(attemptedControllerIds)
          })[0];
          if (!nextControllerModel) {
            break;
          }
          stageController = rebindControllerRuntimeAgent(primaryController, nextControllerModel);
          stageProvider = providerRegistry.get(stageController.id);
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
          attemptedControllerIds.add(stageController.id);
          const failure = classifyProviderTaskError(error, stageController, sessionRuntime);
          if (!failure.retryableProviderFailure) {
            throw error;
          }

          const nextControllerModel = rankFallbackControllers({
            models: controllerModels,
            primaryController: stageController,
            purpose,
            providerRegistry,
            excludeModelIds: Array.from(attemptedControllerIds)
          })[0];
          if (!nextControllerModel) {
            throw error;
          }
          const nextController = rebindControllerRuntimeAgent(primaryController, nextControllerModel);

          forwardClusterEvent({
            ...buildAgentEventBase(nextController, null),
            type: "status",
            stage: "controller_fallback",
            tone: "warning",
            detail: localizeRunText(
              runLocale,
              `Retryable provider failure on ${stageController.label}; rerouting ${purpose} to ${nextController.label}.`,
              `${stageController.label} 发生可重试的 provider 故障；${purpose} 已切换到 ${nextController.label}。`
            ),
            previousControllerId: stageController.id,
            previousControllerLabel: stageController.label,
            fallbackControllerId: nextController.id,
            fallbackControllerLabel: nextController.label,
            purpose,
            attempt: attemptedControllerIds.size,
            maxAttempts: maxControllerAttempts
          });

          stageController = nextController;
          stageProvider = providerRegistry.get(nextController.id);
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
      capabilityRoutingPolicySummary: summarizeCapabilityRoutingPolicy(capabilityRoutingPolicy),
      outputLocale: runLocale
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
      config.multiAgent,
      runLocale
    );
    const runAgentBudget = createRunAgentBudget(complexityBudget, plan.tasks.length);
    sessionRuntime.remember(
      {
        title: localizeRunText(runLocale, "Cluster planning", "集群规划"),
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
      signal,
      runLocale
    );

    const synthesisPrompt = buildSynthesisRequest({
      task: originalTask,
      plan,
      executions,
      outputLocale: runLocale
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
        title: localizeRunText(runLocale, "Cluster synthesis", "集群综合"),
        content: normalizedSynthesis.finalAnswer,
        tags: ["synthesis", activeController.id]
      },
      {
        ...buildAgentEventBase(activeController, null),
        parentSpanId: synthesisStage.spanId
      }
    );
    const cleanupPlan = buildWorkspaceCleanupPlan({
      plan,
      executions,
      workspaceRoot: config.workspace?.resolvedDir,
      originalTask
    });
    const workspaceCleanup = {
      keepFiles: cleanupPlan.keepFiles,
      removedFiles: [],
      failedFiles: []
    };
    if (config.workspace?.resolvedDir && cleanupPlan.removeFiles.length) {
      const cleanupResult = await removeWorkspaceFiles(config.workspace.resolvedDir, cleanupPlan.removeFiles);
      workspaceCleanup.removedFiles = cleanupResult.removedFiles;
      workspaceCleanup.failedFiles = cleanupResult.failedFiles;
      forwardClusterEvent({
        ...buildAgentEventBase(activeController, null),
        type: cleanupResult.failedFiles.length ? "error" : "status",
        stage: "workspace_cleanup",
        tone: cleanupResult.failedFiles.length ? "warning" : "ok",
        detail: localizeRunText(
          runLocale,
          `Removed ${cleanupResult.removedFiles.length} intermediate workspace file(s) and kept ${cleanupPlan.keepFiles.length} final deliverable artifact(s).`,
          `已删除 ${cleanupResult.removedFiles.length} 个中间工作区文件，并保留 ${cleanupPlan.keepFiles.length} 个最终交付产物。`
        ),
        removedFiles: cleanupResult.removedFiles,
        keptFiles: cleanupPlan.keepFiles,
        failedFiles: cleanupResult.failedFiles
      });
    }

    const totalMs = Date.now() - startedAt;
    sessionRuntime.endSpan(operationSpanId, {
      status: "ok",
      detail:
        normalizedSynthesis.finalAnswer ||
        localizeRunText(runLocale, "Cluster run completed.", "集群运行已完成。")
    });
    sessionRuntime.publishSessionUpdate(
      localizeRunText(runLocale, "Cluster run completed.", "集群运行已完成。")
    );
    multiAgentRuntime.complete({
      content:
        normalizedSynthesis.finalAnswer ||
        localizeRunText(runLocale, "Cluster run completed.", "集群运行已完成。"),
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
      workspaceCleanup,
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
      workspaceCleanup,
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

const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const AGENT_COUNT_UNIT_PATTERN = String.raw`(?:\u4e2a|\u540d|\u4f4d|\u53f0)`;
const AGENT_COUNT_TERM_PATTERN = String.raw`(?:child\s+agents?|sub-?agents?|agents?|agent|workers?|worker|\u667a\u80fd\u4f53|\u4ee3\u7406|\u5b50\u4ee3\u7406|\u5b50agent)`;
const GLOBAL_AGENT_COUNT_PATTERNS = [
  new RegExp(
    String.raw`(?:\u603b\u5171|\u4e00\u5171|\u603b\u6570|\u603b\u8ba1|\u6574\u4f53|\u5168\u90e8|\u5168\u5c40|overall|total(?:\s+of)?|in\s+total)\s*(?:\u8c03\u7528|\u8c03\u5ea6|\u5b89\u6392|\u4f7f\u7528|\u542f\u7528|use|run|launch|spawn|create|start|deploy|assign|schedule|call)?\s*(\d{1,4})\s*(?:${AGENT_COUNT_UNIT_PATTERN})?\s*(?:${AGENT_COUNT_TERM_PATTERN})`,
    "giu"
  ),
  new RegExp(
    String.raw`(?:${AGENT_COUNT_TERM_PATTERN})\s*(?:\u603b\u6570|\u603b\u5171|overall|total)\s*(?::|=|\u4e3a)?\s*(\d{1,4})`,
    "giu"
  )
];
const DIRECT_AGENT_COUNT_PATTERNS = [
  new RegExp(
    String.raw`(?:\u8c03\u7528|\u8c03\u5ea6|\u5b89\u6392|\u4f7f\u7528|\u542f\u7528|\u751f\u6210|\u521b\u5efa|use|run|launch|spawn|create|start|deploy|assign|schedule|call)\s*(\d{1,4})\s*(?:${AGENT_COUNT_UNIT_PATTERN})?\s*(?:${AGENT_COUNT_TERM_PATTERN})`,
    "giu"
  ),
  new RegExp(
    String.raw`(\d{1,4})\s*(?:${AGENT_COUNT_UNIT_PATTERN})?\s*(?:${AGENT_COUNT_TERM_PATTERN})`,
    "giu"
  )
];

export const DEFAULT_AGENT_BUDGET_PROFILES = Object.freeze({
  simple: Object.freeze({
    maxScore: 1,
    maxTopLevelTasks: 1,
    maxChildrenPerLeader: 0,
    maxDelegationDepth: 0,
    maxTotalAgents: 2
  }),
  moderate: Object.freeze({
    maxScore: 4,
    maxTopLevelTasks: 2,
    maxChildrenPerLeader: 2,
    maxDelegationDepth: 1,
    maxTotalAgents: 5
  }),
  complex: Object.freeze({
    maxScore: 7,
    maxTopLevelTasks: 3,
    maxChildrenPerLeader: 3,
    maxDelegationDepth: 2,
    maxTotalAgents: 8
  }),
  veryComplex: Object.freeze({
    maxScore: Number.POSITIVE_INFINITY,
    maxTopLevelTasks: 4,
    maxChildrenPerLeader: 4,
    maxDelegationDepth: 2,
    maxTotalAgents: 12
  })
});

export const DEFAULT_CAPABILITY_ROUTING_POLICY = Object.freeze({
  requireWebSearchForFreshFacts: true,
  preferWebSearchForResearch: true,
  requireValidationSpecialistForValidation: true,
  requireCodingManagerForCodeReview: true,
  preferCodexForImplementation: true,
  requirePhaseSpecialistForHandoff: false
});

function safeString(value) {
  return String(value || "").trim();
}

function clampNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

function collectPositiveMatches(text, patterns) {
  const source = safeString(text);
  if (!source) {
    return [];
  }

  return patterns.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => clampNonNegativeInt(match[1], 0)).filter(
      (value) => value > 0
    )
  );
}

function textBlob(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function normalizeBudgetProfile(profile, fallbackProfile) {
  const fallback = fallbackProfile && typeof fallbackProfile === "object" ? fallbackProfile : {};
  const source = profile && typeof profile === "object" ? profile : {};

  return {
    maxScore: Math.max(0, Number(source.maxScore ?? fallback.maxScore ?? 0) || 0),
    maxTopLevelTasks: Math.max(
      1,
      clampNonNegativeInt(source.maxTopLevelTasks, clampNonNegativeInt(fallback.maxTopLevelTasks, 1))
    ),
    maxChildrenPerLeader: Math.max(
      0,
      clampNonNegativeInt(
        source.maxChildrenPerLeader,
        clampNonNegativeInt(fallback.maxChildrenPerLeader, 0)
      )
    ),
    maxDelegationDepth: Math.max(
      0,
      clampNonNegativeInt(
        source.maxDelegationDepth,
        clampNonNegativeInt(fallback.maxDelegationDepth, 0)
      )
    ),
    maxTotalAgents: Math.max(
      1,
      clampNonNegativeInt(source.maxTotalAgents, clampNonNegativeInt(fallback.maxTotalAgents, 1))
    )
  };
}

export function normalizeAgentBudgetProfiles(value, fallback = DEFAULT_AGENT_BUDGET_PROFILES) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_AGENT_BUDGET_PROFILES;

  return {
    simple: normalizeBudgetProfile(source.simple, backup.simple),
    moderate: normalizeBudgetProfile(source.moderate, backup.moderate),
    complex: normalizeBudgetProfile(source.complex, backup.complex),
    veryComplex: normalizeBudgetProfile(source.veryComplex, backup.veryComplex)
  };
}

export function normalizeCapabilityRoutingPolicy(value, fallback = DEFAULT_CAPABILITY_ROUTING_POLICY) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_CAPABILITY_ROUTING_POLICY;

  return {
    requireWebSearchForFreshFacts: Boolean(
      source.requireWebSearchForFreshFacts ?? backup.requireWebSearchForFreshFacts
    ),
    preferWebSearchForResearch: Boolean(
      source.preferWebSearchForResearch ?? backup.preferWebSearchForResearch
    ),
    requireValidationSpecialistForValidation: Boolean(
      source.requireValidationSpecialistForValidation ?? backup.requireValidationSpecialistForValidation
    ),
    requireCodingManagerForCodeReview: Boolean(
      source.requireCodingManagerForCodeReview ?? backup.requireCodingManagerForCodeReview
    ),
    preferCodexForImplementation: Boolean(
      source.preferCodexForImplementation ?? backup.preferCodexForImplementation
    ),
    requirePhaseSpecialistForHandoff: Boolean(
      source.requirePhaseSpecialistForHandoff ?? backup.requirePhaseSpecialistForHandoff
    )
  };
}

function getOrderedAgentBudgetProfiles(value) {
  const profiles = normalizeAgentBudgetProfiles(value);
  return [
    { level: "simple", ...profiles.simple },
    { level: "moderate", ...profiles.moderate },
    { level: "complex", ...profiles.complex },
    { level: "very_complex", ...profiles.veryComplex }
  ].sort((left, right) => left.maxScore - right.maxScore);
}

function scoreTextComplexity(text) {
  const normalized = safeString(text).toLowerCase();
  if (!normalized) {
    return {
      score: 0,
      atomic: false
    };
  }

  let score = 0;
  if (normalized.length >= 80) {
    score += 1;
  }
  if (normalized.length >= 180) {
    score += 1;
  }
  if (normalized.length >= 320) {
    score += 1;
  }

  const signalBuckets = [
    /\b(multiple|several|many|parallel|split|batch|compare|survey|collect|across|cross-check|recursive|hierarchical|delegate|coordinate|streams?|tracks?)\b|(?:多个|并行|拆分|批量|对比|调研|收集|跨|递归|层级|委派|分线)/,
    /\b(implementation|implement|refactor|debug|fix(?:es|ing)?|changes?|validate|validation|review|test|build|migrate|integrate|workspace|repository|repo|code|document|report|artifact)\b|(?:实现|重构|调试|修复|变更|验证|测试|构建|工作区|仓库|代码|文档|报告|交付)/,
    /\b(research|evidence|sources?|facts?|current|fresh|web|search|browse|verification)\b|(?:研究|证据|来源|事实|最新|实时|网页|搜索|浏览|核验)/,
    /\b(2|3|4|5|6|7|8|9|two|three|four|five|six|seven|eight|nine|double|triple)\b|(?:两个|三个|四个|五个|六个|七个|八个|九个|两名|三名)/
  ];
  for (const bucket of signalBuckets) {
    if (bucket.test(normalized)) {
      score += 1;
    }
  }

  if (
    /\b(end-to-end|across the codebase|multiple independent|non-overlapping|source clusters?|handoff|pipeline|workflow)\b|(?:端到端|跨代码库|跨文件|多个独立|不重叠|交付|流程)/.test(
      normalized
    )
  ) {
    score += 1;
  }
  if (
    /\b(recursive|hierarchical|nested|tree|grandchild|depth)\b|(?:递归|层级|嵌套|树形|子孙|深度)/.test(
      normalized
    )
  ) {
    score += 1;
  }

  const atomic =
    /(atomic|single(?: file| document| report)?|one file|one document|one report|directly|quick fix|minor|typo|small change|one step)|(?:单个|单文件|单文档|单报告|直接|快速修复|小改动|错字|一步)/.test(
      normalized
    );
  const strongScaleSignal =
    /\b(multiple|parallel|split|compare|survey|collect|recursive|hierarchical|across|delegate)\b|(?:多个|并行|拆分|对比|调研|收集|递归|层级|委派|跨)/.test(
      normalized
    );

  if (atomic && !strongScaleSignal) {
    score = Math.max(0, score - 2);
  }

  return {
    score: Math.max(0, score),
    atomic
  };
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

function scorePlanComplexity(rawPlan) {
  const tasks = Array.isArray(rawPlan?.tasks) ? rawPlan.tasks : [];
  let score = 0;

  if (tasks.length >= 2) {
    score += 2;
  }
  if (tasks.length >= 4) {
    score += 1;
  }

  const uniqueWorkers = new Set(tasks.map((task) => safeString(task?.assignedWorker)).filter(Boolean));
  if (uniqueWorkers.size >= 2) {
    score += 1;
  }

  const uniquePhases = new Set(
    tasks.map((task) => safeString(task?.phase).toLowerCase() || "implementation")
  );
  if (uniquePhases.size >= 2) {
    score += 1;
  }
  if (uniquePhases.size >= 3) {
    score += 1;
  }

  const dependencyCount = tasks.reduce(
    (sum, task) => sum + (Array.isArray(task?.dependsOn) ? task.dependsOn.length : 0),
    0
  );
  if (dependencyCount > 0) {
    score += 1;
  }

  const explicitDelegates = tasks.reduce(
    (sum, task) => sum + normalizeDelegateCount(task?.delegateCount, DEFAULT_GROUP_LEADER_MAX_DELEGATES),
    0
  );
  if (explicitDelegates >= 2) {
    score += 1;
  }
  if (explicitDelegates >= 5) {
    score += 1;
  }

  const planText = textBlob(
    rawPlan?.objective,
    rawPlan?.strategy,
    tasks.flatMap((task) => [task?.title, task?.instructions, task?.expectedOutput])
  );
  score += Math.min(3, scoreTextComplexity(planText).score);

  return score;
}

function selectComplexityBudgetProfile(score, profiles) {
  return (
    profiles.find((profile) => score <= profile.maxScore) ||
    profiles[profiles.length - 1]
  );
}

function buildStructuralAgentCeiling(topLevelLimit, childrenPerLeader, delegationDepth) {
  let total = Math.max(1, topLevelLimit);
  let frontier = Math.max(1, topLevelLimit);

  for (let depth = 0; depth < delegationDepth; depth += 1) {
    frontier *= Math.max(0, childrenPerLeader);
    if (!frontier) {
      break;
    }
    total += frontier;
  }

  return total;
}

export function parseExplicitTotalAgentRequest(text) {
  const globalMatches = collectPositiveMatches(text, GLOBAL_AGENT_COUNT_PATTERNS);
  if (globalMatches.length) {
    return Math.max(...globalMatches);
  }

  const directMatches = collectPositiveMatches(text, DIRECT_AGENT_COUNT_PATTERNS);
  if (directMatches.length) {
    return Math.max(...directMatches);
  }

  return null;
}

export function resolveTopLevelTaskLimit(maxParallel, workers, complexityBudget = null) {
  const budgetLimit = clampNonNegativeInt(complexityBudget?.maxTopLevelTasks, 0);
  if (budgetLimit > 0) {
    return budgetLimit;
  }

  return Math.max(1, Math.max(workers.length, clampNonNegativeInt(maxParallel, 0)));
}

export function resolveEffectiveGroupLeaderMaxDelegates(config, complexityBudget = null) {
  const configured = clampNonNegativeInt(
    config?.cluster?.groupLeaderMaxDelegates,
    DEFAULT_GROUP_LEADER_MAX_DELEGATES
  );
  const budgeted = clampNonNegativeInt(complexityBudget?.maxChildrenPerLeader, configured);
  return Math.min(configured, budgeted);
}

export function resolveEffectiveDelegateMaxDepth(config, complexityBudget = null) {
  const configured = clampNonNegativeInt(
    config?.cluster?.delegateMaxDepth,
    DEFAULT_DELEGATION_MAX_DEPTH
  );
  const budgeted = clampNonNegativeInt(complexityBudget?.maxDelegationDepth, configured);
  return Math.min(configured, budgeted);
}

export function buildComplexityBudget({ originalTask, rawPlan = null, workers = [], config }) {
  const profiles = getOrderedAgentBudgetProfiles(config?.cluster?.agentBudgetProfiles);
  const workerCount = Math.max(1, workers.length || 0);
  const objectiveComplexity = scoreTextComplexity(originalTask);
  const requestedTotalAgents = parseExplicitTotalAgentRequest(originalTask);
  let score = objectiveComplexity.score;

  if (rawPlan) {
    score += scorePlanComplexity(rawPlan);
  }
  if (objectiveComplexity.atomic) {
    score = Math.min(score, 1);
  }

  const profile = selectComplexityBudgetProfile(score, profiles);
  const configuredTopLevelLimit = (() => {
    const configured = clampNonNegativeInt(config?.cluster?.maxParallel, 0);
    return configured > 0 ? Math.max(1, configured) : workerCount;
  })();
  const profileMaxTopLevelTasks = Math.max(1, Math.min(profile.maxTopLevelTasks, configuredTopLevelLimit));
  const profileMaxDelegationDepth = resolveEffectiveDelegateMaxDepth(config, {
    maxDelegationDepth: profile.maxDelegationDepth
  });
  const profileMaxChildrenPerLeader =
    profileMaxDelegationDepth > 0
      ? resolveEffectiveGroupLeaderMaxDelegates(config, {
        maxChildrenPerLeader: profile.maxChildrenPerLeader
      })
      : 0;
  let maxTopLevelTasks = profileMaxTopLevelTasks;
  let maxDelegationDepth = profileMaxDelegationDepth;
  let maxChildrenPerLeader = profileMaxChildrenPerLeader;
  let structuralAgentCeiling = buildStructuralAgentCeiling(
    maxTopLevelTasks,
    maxChildrenPerLeader,
    maxDelegationDepth
  );
  let maxTotalAgents = Math.max(
    maxTopLevelTasks,
    Math.min(profile.maxTotalAgents, structuralAgentCeiling)
  );
  let budgetSource = "complexity_profile";

  if (requestedTotalAgents) {
    const configuredMaxDelegationDepth = resolveEffectiveDelegateMaxDepth(config, null);
    const configuredMaxChildrenPerLeader =
      configuredMaxDelegationDepth > 0 ? resolveEffectiveGroupLeaderMaxDelegates(config, null) : 0;
    const perLeaderCapacity = buildStructuralAgentCeiling(
      1,
      configuredMaxChildrenPerLeader,
      configuredMaxDelegationDepth
    );
    const minimumTopLevelTasksNeeded = Math.max(
      1,
      Math.ceil(requestedTotalAgents / Math.max(1, perLeaderCapacity))
    );

    maxDelegationDepth = configuredMaxDelegationDepth;
    maxChildrenPerLeader = configuredMaxChildrenPerLeader;
    maxTopLevelTasks = Math.max(
      1,
      Math.min(
        configuredTopLevelLimit,
        Math.max(
          Math.min(profileMaxTopLevelTasks, requestedTotalAgents),
          minimumTopLevelTasksNeeded
        )
      )
    );
    structuralAgentCeiling = buildStructuralAgentCeiling(
      maxTopLevelTasks,
      maxChildrenPerLeader,
      maxDelegationDepth
    );
    maxTotalAgents = Math.max(
      maxTopLevelTasks,
      Math.min(requestedTotalAgents, structuralAgentCeiling)
    );
    budgetSource =
      maxTotalAgents >= requestedTotalAgents ? "user_request" : "user_request_capped_by_runtime";
  }

  return {
    level: profile.level,
    score,
    maxTopLevelTasks,
    maxChildrenPerLeader,
    maxDelegationDepth,
    maxTotalAgents,
    requestedTotalAgents,
    autoBudgetMaxTotalAgents: profile.maxTotalAgents,
    budgetSource
  };
}

export function createRunAgentBudget(complexityBudget, topLevelTaskCount) {
  const normalizedTopLevelCount = Math.max(0, clampNonNegativeInt(topLevelTaskCount, 0));
  const initialMaxTotalAgents = Math.max(
    normalizedTopLevelCount || 1,
    clampNonNegativeInt(complexityBudget?.maxTotalAgents, normalizedTopLevelCount || 1)
  );
  const initialChildBudget = Math.max(0, initialMaxTotalAgents - normalizedTopLevelCount);
  const requestedTotalAgents = clampNonNegativeInt(complexityBudget?.requestedTotalAgents, 0) || null;
  const autoBudgetMaxTotalAgents =
    clampNonNegativeInt(complexityBudget?.autoBudgetMaxTotalAgents, 0) || null;
  const budgetSource = safeString(complexityBudget?.budgetSource) || "complexity_profile";
  let remainingChildAgents = initialChildBudget;

  return {
    level: safeString(complexityBudget?.level) || "moderate",
    score: clampNonNegativeInt(complexityBudget?.score, 0),
    maxTopLevelTasks: Math.max(1, clampNonNegativeInt(complexityBudget?.maxTopLevelTasks, 1)),
    maxChildrenPerLeader: Math.max(0, clampNonNegativeInt(complexityBudget?.maxChildrenPerLeader, 0)),
    maxDelegationDepth: Math.max(0, clampNonNegativeInt(complexityBudget?.maxDelegationDepth, 0)),
    maxTotalAgents: initialMaxTotalAgents,
    requestedTotalAgents,
    autoBudgetMaxTotalAgents,
    budgetSource,
    topLevelTaskCount: normalizedTopLevelCount,
    initialChildAgentBudget: initialChildBudget,
    get remainingChildAgents() {
      return remainingChildAgents;
    },
    reserveChildAgents(requested) {
      const normalizedRequest = Math.max(0, clampNonNegativeInt(requested, 0));
      const granted = Math.min(normalizedRequest, remainingChildAgents);
      remainingChildAgents -= granted;
      return granted;
    },
    releaseChildAgents(count) {
      const normalizedRelease = Math.max(0, clampNonNegativeInt(count, 0));
      remainingChildAgents = Math.min(initialChildBudget, remainingChildAgents + normalizedRelease);
    },
    snapshot() {
      return {
        level: this.level,
        score: this.score,
        maxTopLevelTasks: this.maxTopLevelTasks,
        maxChildrenPerLeader: this.maxChildrenPerLeader,
        maxDelegationDepth: this.maxDelegationDepth,
        maxTotalAgents: this.maxTotalAgents,
        requestedTotalAgents: this.requestedTotalAgents,
        autoBudgetMaxTotalAgents: this.autoBudgetMaxTotalAgents,
        budgetSource: this.budgetSource,
        topLevelTaskCount: this.topLevelTaskCount,
        initialChildAgentBudget: this.initialChildAgentBudget,
        remainingChildAgents
      };
    }
  };
}

export function summarizeCapabilityRoutingPolicy(policy) {
  const normalized = normalizeCapabilityRoutingPolicy(policy);
  return [
    `require_web_search_for_fresh_facts=${normalized.requireWebSearchForFreshFacts ? "true" : "false"}`,
    `prefer_web_search_for_research=${normalized.preferWebSearchForResearch ? "true" : "false"}`,
    `prefer_codex_for_implementation=${normalized.preferCodexForImplementation ? "true" : "false"}`,
    `require_validation_specialist=${normalized.requireValidationSpecialistForValidation ? "true" : "false"}`,
    `require_coding_manager_for_code_review=${normalized.requireCodingManagerForCodeReview ? "true" : "false"}`,
    `require_handoff_specialist=${normalized.requirePhaseSpecialistForHandoff ? "true" : "false"}`
  ].join("\n");
}

const DEFAULT_MAX_MEMORY_ENTRIES = 96;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

function safeString(value) {
  return String(value || "").trim();
}

function normalizeRuntimeLocale(value) {
  return safeString(value) === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeRuntimeText(locale, englishText, chineseText) {
  return normalizeRuntimeLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function uniqueStrings(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function compactText(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildModelLabel(modelConfig) {
  return safeString(modelConfig?.label || modelConfig?.id || "model");
}

function normalizeUsage(raw) {
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {};
  const inputTokens = normalizeInteger(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens
  );
  const outputTokens = normalizeInteger(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens
  );
  const explicitTotalTokens = normalizeInteger(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = explicitTotalTokens || inputTokens + outputTokens;
  const hasUsage =
    Object.keys(usage).length > 0 || inputTokens > 0 || outputTokens > 0 || totalTokens > 0;

  if (!hasUsage) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function normalizePricing(modelConfig) {
  const pricing = modelConfig?.pricing;
  if (!pricing || typeof pricing !== "object") {
    return null;
  }

  let inputPer1kUsd = normalizeNumber(
    pricing.inputPer1kUsd ?? pricing.promptPer1kUsd
  );
  let outputPer1kUsd = normalizeNumber(
    pricing.outputPer1kUsd ?? pricing.completionPer1kUsd
  );

  if (!inputPer1kUsd) {
    inputPer1kUsd = normalizeNumber(pricing.inputPer1mUsd ?? pricing.promptPer1mUsd) / 1000;
  }
  if (!outputPer1kUsd) {
    outputPer1kUsd =
      normalizeNumber(pricing.outputPer1mUsd ?? pricing.completionPer1mUsd) / 1000;
  }

  if (inputPer1kUsd <= 0 && outputPer1kUsd <= 0) {
    return null;
  }

  return {
    inputPer1kUsd,
    outputPer1kUsd
  };
}

function estimateCostUsd(usage, pricing) {
  if (!usage || !pricing) {
    return null;
  }

  const inputCost = (usage.inputTokens / 1000) * normalizeNumber(pricing.inputPer1kUsd);
  const outputCost = (usage.outputTokens / 1000) * normalizeNumber(pricing.outputPer1kUsd);
  return roundNumber(inputCost + outputCost, 6);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatCircuitDetail(state) {
  if (state.state === "open" && state.openUntil) {
    return `Circuit open until ${new Date(state.openUntil).toISOString()}.`;
  }
  if (state.state === "half_open") {
    return "Circuit is probing in half-open mode.";
  }
  return "Circuit is closed.";
}

export function createSessionRuntime({ emitEvent, locale = "en-US" } = {}) {
  const runLocale = normalizeRuntimeLocale(locale);
  const memoryEntries = [];
  const modelStatsById = new Map();
  const circuitByModelId = new Map();
  const spans = new Map();
  let spanSequence = 0;
  let memorySequence = 0;

  const totals = {
    providerCalls: 0,
    providerFailures: 0,
    retries: 0,
    toolCalls: 0,
    memoryReads: 0,
    memoryWrites: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    pricedCallCount: 0,
    unpricedCallCount: 0
  };

  function publish(payload) {
    if (typeof emitEvent === "function") {
      emitEvent(payload);
    }
  }

  function ensureModelStats(modelConfig) {
    const modelId = safeString(modelConfig?.id);
    if (!modelId) {
      throw new Error("Model config must include an id for session tracking.");
    }

    if (!modelStatsById.has(modelId)) {
      modelStatsById.set(modelId, {
        modelId,
        modelLabel: buildModelLabel(modelConfig),
        provider: safeString(modelConfig?.provider),
        model: safeString(modelConfig?.model),
        providerCalls: 0,
        providerFailures: 0,
        retries: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        pricedCallCount: 0,
        unpricedCallCount: 0
      });
    }

    return modelStatsById.get(modelId);
  }

  function ensureCircuitState(modelConfig) {
    const modelId = safeString(modelConfig?.id);
    if (!modelId) {
      throw new Error("Model config must include an id for circuit tracking.");
    }

    if (!circuitByModelId.has(modelId)) {
      circuitByModelId.set(modelId, {
        modelId,
        modelLabel: buildModelLabel(modelConfig),
        state: "closed",
        consecutiveFailures: 0,
        openUntil: 0,
        lastError: "",
        threshold: Math.max(
          1,
          normalizeInteger(modelConfig?.circuitBreakerThreshold) ||
            DEFAULT_CIRCUIT_FAILURE_THRESHOLD
        ),
        cooldownMs: Math.max(
          1_000,
          normalizeInteger(modelConfig?.circuitBreakerCooldownMs) ||
            DEFAULT_CIRCUIT_COOLDOWN_MS
        )
      });
    }

    return circuitByModelId.get(modelId);
  }

  function buildSnapshot() {
    return {
      totals: {
        ...totals,
        estimatedCostUsd: roundNumber(totals.estimatedCostUsd, 6)
      },
      models: Array.from(modelStatsById.values()).map((entry) => ({
        ...entry,
        estimatedCostUsd: roundNumber(entry.estimatedCostUsd, 6)
      })),
      memory: {
        count: memoryEntries.length,
        recent: memoryEntries.slice(0, 8).map((entry) => ({
          id: entry.id,
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          createdAt: entry.createdAt,
          agentId: entry.agentId,
          agentLabel: entry.agentLabel,
          taskId: entry.taskId,
          taskTitle: entry.taskTitle
        }))
      },
      circuits: Array.from(circuitByModelId.values()).map((entry) => ({
        modelId: entry.modelId,
        modelLabel: entry.modelLabel,
        state: entry.state,
        consecutiveFailures: entry.consecutiveFailures,
        openUntil: entry.openUntil || 0,
        lastError: entry.lastError || ""
      }))
    };
  }

  function publishSessionUpdate(detail = "") {
    publish({
      type: "session",
      stage: "session_update",
      tone: "neutral",
      detail: safeString(detail),
      session: buildSnapshot()
    });
  }

  function startSpan(meta = {}) {
    const spanId = `trace_${String(++spanSequence).padStart(4, "0")}`;
    const span = {
      spanId,
      parentSpanId: safeString(meta.parentSpanId),
      spanKind: safeString(meta.spanKind || "span") || "span",
      spanLabel: safeString(meta.spanLabel || meta.label || meta.spanKind || "Span") || "Span",
      startedAt: Date.now(),
      agentId: safeString(meta.agentId),
      agentLabel: safeString(meta.agentLabel),
      agentKind: safeString(meta.agentKind),
      taskId: safeString(meta.taskId),
      taskTitle: safeString(meta.taskTitle),
      modelId: safeString(meta.modelId),
      modelLabel: safeString(meta.modelLabel),
      purpose: safeString(meta.purpose),
      toolAction: safeString(meta.toolAction),
      detail: safeString(meta.detail)
    };
    spans.set(spanId, span);

    publish({
      type: "trace",
      stage: "trace_span_start",
      tone: "neutral",
      ...span
    });

    return spanId;
  }

  function endSpan(spanId, payload = {}) {
    const existing = spans.get(spanId) || {
      spanId,
      parentSpanId: safeString(payload.parentSpanId),
      spanKind: safeString(payload.spanKind || "span") || "span",
      spanLabel: safeString(payload.spanLabel || payload.label || "Span") || "Span",
      startedAt: Date.now(),
      agentId: safeString(payload.agentId),
      agentLabel: safeString(payload.agentLabel),
      agentKind: safeString(payload.agentKind),
      taskId: safeString(payload.taskId),
      taskTitle: safeString(payload.taskTitle),
      modelId: safeString(payload.modelId),
      modelLabel: safeString(payload.modelLabel),
      purpose: safeString(payload.purpose),
      toolAction: safeString(payload.toolAction)
    };

    const endedAt = Date.now();
    const durationMs = Math.max(0, endedAt - Number(existing.startedAt || endedAt));
    const event = {
      ...existing,
      stage: "trace_span_end",
      type: "trace",
      tone:
        payload.status === "error"
          ? "error"
          : payload.status === "warning"
            ? "warning"
            : "ok",
      status: safeString(payload.status || "ok") || "ok",
      detail: safeString(payload.detail || existing.detail),
      durationMs,
      usage: payload.usage || null,
      estimatedCostUsd:
        Number.isFinite(Number(payload.estimatedCostUsd))
          ? roundNumber(Number(payload.estimatedCostUsd), 6)
          : null,
      memoryCount: normalizeInteger(payload.memoryCount),
      resultCount: normalizeInteger(payload.resultCount),
      exitCode:
        payload.exitCode === null || payload.exitCode === undefined
          ? null
          : Number(payload.exitCode),
      circuitState: safeString(payload.circuitState)
    };

    spans.set(spanId, {
      ...existing,
      ...event,
      endedAt
    });
    publish(event);
    return event;
  }

  function ensureCircuitClosed(modelConfig, meta = {}) {
    const state = ensureCircuitState(modelConfig);
    const now = Date.now();

    if (state.state === "open" && state.openUntil > now) {
      publish({
        type: "status",
        stage: "circuit_blocked",
        tone: "warning",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        detail: `Circuit for ${buildModelLabel(modelConfig)} is open. Retry after ${new Date(state.openUntil).toLocaleTimeString("zh-CN", { hour12: false })}.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker blocked a provider call.");
      throw new Error(
        `Model "${buildModelLabel(modelConfig)}" is temporarily blocked by the circuit breaker after repeated failures.`
      );
    }

    if (state.state === "open" && state.openUntil <= now) {
      state.state = "half_open";
      publish({
        type: "status",
        stage: "circuit_half_open",
        tone: "warning",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        detail: `Circuit for ${buildModelLabel(modelConfig)} entered half-open probe mode.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker moved to half-open mode.");
    }

    return state;
  }

  function markCircuitSuccess(modelConfig, meta = {}) {
    const state = ensureCircuitState(modelConfig);
    const shouldAnnounce =
      state.state !== "closed" || state.consecutiveFailures > 0 || state.lastError;
    state.state = "closed";
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.lastError = "";

    if (shouldAnnounce) {
      publish({
        type: "status",
        stage: "circuit_closed",
        tone: "ok",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        detail: `Circuit for ${buildModelLabel(modelConfig)} has closed and recovered.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker recovered.");
    }

    return state;
  }

  function markCircuitFailure(modelConfig, error, meta = {}) {
    const state = ensureCircuitState(modelConfig);
    state.lastError = String(error?.message || error || "Unknown failure");
    if (state.state === "half_open") {
      state.consecutiveFailures = state.threshold;
    } else {
      state.consecutiveFailures += 1;
    }

    if (state.consecutiveFailures >= state.threshold) {
      state.state = "open";
      state.openUntil = Date.now() + state.cooldownMs;
      publish({
        type: "status",
        stage: "circuit_opened",
        tone: "error",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        consecutiveFailures: state.consecutiveFailures,
        cooldownMs: state.cooldownMs,
        detail: `Circuit for ${buildModelLabel(modelConfig)} opened after ${state.consecutiveFailures} consecutive failures.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker opened.");
      return state;
    }

    publishSessionUpdate("Provider failure recorded.");
    return state;
  }

  function beginProviderCall(modelConfig, meta = {}) {
    ensureCircuitClosed(modelConfig, meta);
    const modelStats = ensureModelStats(modelConfig);
    totals.providerCalls += 1;
    modelStats.providerCalls += 1;

    const spanId = startSpan({
      spanKind: "provider_call",
      spanLabel:
        safeString(meta.spanLabel) ||
        `${buildModelLabel(modelConfig)} · ${safeString(meta.purpose || "invoke")}`,
      modelId: modelConfig.id,
      modelLabel: buildModelLabel(modelConfig),
      ...meta
    });
    publishSessionUpdate("Provider call started.");
    return { spanId };
  }

  function completeProviderCall(modelConfig, spanId, raw, meta = {}) {
    const usage = normalizeUsage(raw);
    const pricing = normalizePricing(modelConfig);
    const estimatedCostUsd = estimateCostUsd(usage, pricing);
    const modelStats = ensureModelStats(modelConfig);

    if (usage) {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.totalTokens += usage.totalTokens;
      modelStats.inputTokens += usage.inputTokens;
      modelStats.outputTokens += usage.outputTokens;
      modelStats.totalTokens += usage.totalTokens;
    }

    if (estimatedCostUsd !== null) {
      totals.estimatedCostUsd += estimatedCostUsd;
      totals.pricedCallCount += 1;
      modelStats.estimatedCostUsd += estimatedCostUsd;
      modelStats.pricedCallCount += 1;
    } else {
      totals.unpricedCallCount += 1;
      modelStats.unpricedCallCount += 1;
    }

    const circuitState = markCircuitSuccess(modelConfig, meta).state;
    const event = endSpan(spanId, {
      status: "ok",
      detail:
        safeString(meta.detail) ||
        `Provider call completed for ${buildModelLabel(modelConfig)}.`,
      usage,
      estimatedCostUsd,
      circuitState
    });
    publishSessionUpdate("Provider call completed.");
    return {
      usage,
      estimatedCostUsd,
      event
    };
  }

  function failProviderCall(modelConfig, spanId, error, meta = {}) {
    totals.providerFailures += 1;
    const modelStats = ensureModelStats(modelConfig);
    modelStats.providerFailures += 1;
    const circuitState = markCircuitFailure(modelConfig, error, meta).state;
    const event = endSpan(spanId, {
      status: "error",
      detail:
        safeString(meta.detail) ||
        String(error?.message || error || "Provider call failed."),
      circuitState
    });
    return {
      circuitState,
      event
    };
  }

  function recordRetry(modelConfig, retry, meta = {}) {
    totals.retries += 1;
    const modelStats = ensureModelStats(modelConfig);
    modelStats.retries += 1;
    publish({
      type: "trace",
      stage: "trace_retry",
      tone: "warning",
      modelId: modelConfig.id,
      modelLabel: buildModelLabel(modelConfig),
      attempt: retry.attempt,
      maxRetries: retry.maxRetries,
      nextDelayMs: retry.nextDelayMs,
      status: retry.status,
      detail: retry.message,
      ...meta
    });
    publishSessionUpdate("Retry scheduled.");
  }

  function beginToolCall(meta = {}) {
    totals.toolCalls += 1;
    return startSpan({
      spanKind: safeString(meta.spanKind || "tool") || "tool",
      spanLabel: safeString(meta.spanLabel || meta.toolAction || "Tool call") || "Tool call",
      toolAction: safeString(meta.toolAction),
      ...meta
    });
  }

  function completeToolCall(spanId, meta = {}) {
    endSpan(spanId, {
      status: safeString(meta.status || "ok") || "ok",
      detail: meta.detail,
      resultCount: meta.resultCount,
      exitCode: meta.exitCode
    });
    publishSessionUpdate("Tool call completed.");
  }

  function failToolCall(spanId, error, meta = {}) {
    endSpan(spanId, {
      status: "error",
      detail: safeString(meta.detail || error?.message || error || "Tool call failed."),
      exitCode: meta.exitCode
    });
    publishSessionUpdate("Tool call failed.");
  }

  function remember(entry = {}, meta = {}) {
    totals.memoryWrites += 1;
    const memoryTitle =
      safeString(entry.title || entry.taskTitle || "") ||
      localizeRuntimeText(runLocale, "Session memory", "会话记忆");
    const spanId = beginToolCall({
      ...meta,
      spanKind: "memory_write",
      toolAction: "remember",
      spanLabel: safeString(meta.spanLabel || `Remember · ${entry.title || "note"}`) || "Remember"
    });

    const memoryEntry = {
      id: `mem_${String(++memorySequence).padStart(4, "0")}`,
      title: memoryTitle,
      content: compactText(entry.content, 500),
      tags: uniqueStrings(entry.tags),
      createdAt: new Date().toISOString(),
      agentId: safeString(meta.agentId),
      agentLabel: safeString(meta.agentLabel),
      taskId: safeString(meta.taskId),
      taskTitle: safeString(meta.taskTitle)
    };

    if (!memoryEntry.content) {
      completeToolCall(spanId, {
        detail: localizeRuntimeText(
          runLocale,
          "Skipped empty session memory write.",
          "已跳过空白会话记忆写入。"
        ),
        resultCount: memoryEntries.length
      });
      return null;
    }

    memoryEntries.unshift(memoryEntry);
    if (memoryEntries.length > DEFAULT_MAX_MEMORY_ENTRIES) {
      memoryEntries.length = DEFAULT_MAX_MEMORY_ENTRIES;
    }

    publish({
      type: "status",
      stage: "memory_write",
      tone: "ok",
      detail: localizeRuntimeText(
        runLocale,
        `Stored session memory: ${memoryEntry.title}`,
        `已写入会话记忆：${memoryEntry.title}`
      ),
      memoryEntry: cloneJson(memoryEntry),
      ...meta
    });

    endSpan(spanId, {
      status: "ok",
      detail: localizeRuntimeText(
        runLocale,
        `Stored session memory: ${memoryEntry.title}`,
        `已写入会话记忆：${memoryEntry.title}`
      ),
      memoryCount: memoryEntries.length
    });
    publishSessionUpdate("Session memory updated.");
    return memoryEntry;
  }

  function recall(queryInput = {}, meta = {}) {
    totals.memoryReads += 1;
    const queryText = safeString(queryInput.query);
    const requestedTags = uniqueStrings(queryInput.tags).map((item) => item.toLowerCase());
    const limit = Math.max(1, Math.min(12, normalizeInteger(queryInput.limit) || 3));
    const spanId = beginToolCall({
      ...meta,
      spanKind: "memory_read",
      toolAction: "recall_memory",
      spanLabel: safeString(meta.spanLabel || `Recall · ${queryText || "recent"}`) || "Recall"
    });

    const tokens = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const ranked = memoryEntries
      .map((entry, index) => {
        const haystack = [entry.title, entry.content, ...(entry.tags || [])]
          .join(" ")
          .toLowerCase();
        let score = 0;

        for (const token of tokens) {
          if (haystack.includes(token)) {
            score += 3;
          }
        }

        for (const tag of requestedTags) {
          if ((entry.tags || []).some((item) => item.toLowerCase() === tag)) {
            score += 4;
          }
        }

        score += Math.max(0, 40 - index);
        return {
          entry,
          score
        };
      })
      .filter((item) => item.score > 0 || (!tokens.length && !requestedTags.length))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.entry);

    publish({
      type: "status",
      stage: "memory_read",
      tone: "neutral",
      detail: localizeRuntimeText(
        runLocale,
        `Recalled ${ranked.length} session memory item(s).`,
        `已召回 ${ranked.length} 条会话记忆。`
      ),
      memoryCount: ranked.length,
      ...meta
    });

    endSpan(spanId, {
      status: "ok",
      detail: localizeRuntimeText(
        runLocale,
        `Recalled ${ranked.length} session memory item(s).`,
        `已召回 ${ranked.length} 条会话记忆。`
      ),
      resultCount: ranked.length,
      memoryCount: memoryEntries.length
    });
    publishSessionUpdate("Session memory recalled.");
    return ranked.map((entry) => cloneJson(entry));
  }

  return {
    startSpan,
    endSpan,
    beginProviderCall,
    completeProviderCall,
    failProviderCall,
    recordRetry,
    beginToolCall,
    completeToolCall,
    failToolCall,
    remember,
    recall,
    buildSnapshot,
    publishSessionUpdate,
    getCircuitState(modelId) {
      return circuitByModelId.get(String(modelId || "").trim()) || null;
    },
    getMemoryEntries() {
      return memoryEntries.map((entry) => cloneJson(entry));
    },
    describeCircuitState(modelId) {
      const state = this.getCircuitState(modelId);
      return state ? formatCircuitDetail(state) : "Circuit state unavailable.";
    }
  };
}

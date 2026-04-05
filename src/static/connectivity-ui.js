function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function resolveRuntimeLocale() {
  if (typeof document !== "undefined" && String(document.documentElement?.lang || "").toLowerCase().startsWith("en")) {
    return "en-US";
  }
  return "zh-CN";
}

function createFallbackTranslator() {
  const catalog = {
    "zh-CN": {
      "scheme.none": "无方案",
      "connectivity.waiting": "等待检测",
      "connectivity.untitledModel": "未命名模型",
      "connectivity.untested": "未测试",
      "connectivity.available": "可用",
      "connectivity.availableDegraded": "可用（降级）",
      "connectivity.workflowFallback": "Workflow 探针使用了兼容回退。",
      "connectivity.webSearchVerified": "联网搜索：已通过实际探针验证。",
      "connectivity.webSearchUnavailable": "联网搜索：探针未观测到成功执行。",
      "connectivity.thinkingVerified": "Thinking 模式：已验证可用。",
      "connectivity.thinkingUnavailable": "Thinking 模式：未确认成功执行。",
      "connectivity.basicReply": "基础回复：{reply}",
      "connectivity.noModels": "当前方案没有模型",
      "connectivity.summary.testing": "并发检测中 {completed}/{total} · 可用 {available} · 失败 {error}",
      "connectivity.summary.doneWarning": "检测完成 · 可用 {available}/{total} · 降级 {warning} · 失败 {error}",
      "connectivity.summary.doneOk": "检测完成 · 全部可用 {ok}/{total}",
      "connectivity.placeholder.addScheme": "请先添加至少一个方案。",
      "connectivity.placeholder.noModels": "当前方案还没有可检测的模型。",
      "connectivity.result.waiting": "等待连接测试结果。",
      "connectivity.stats.total": "总数",
      "connectivity.stats.available": "可用",
      "connectivity.stats.degraded": "降级",
      "connectivity.stats.failed": "失败",
      "connectivity.stats.testing": "检测中",
      "connectivity.dirty": "配置已修改，请重新检测。",
      "connectivity.testing": "检测中",
      "connectivity.submitted": "已提交测试请求...",
      "connectivity.requesting": "正在发送连接测试请求...",
      "connectivity.failedPrefix": "连接失败："
    },
    "en-US": {
      "scheme.none": "No scheme",
      "connectivity.waiting": "Waiting for checks",
      "connectivity.untitledModel": "Untitled model",
      "connectivity.untested": "Untested",
      "connectivity.available": "Available",
      "connectivity.availableDegraded": "Available (degraded)",
      "connectivity.workflowFallback": "Workflow probe used compatibility fallback.",
      "connectivity.webSearchVerified": "Web search: verified by live probe.",
      "connectivity.webSearchUnavailable": "Web search: the probe did not observe a successful run.",
      "connectivity.thinkingVerified": "Thinking: verified.",
      "connectivity.thinkingUnavailable": "Thinking: execution was not confirmed.",
      "connectivity.basicReply": "Basic reply: {reply}",
      "connectivity.noModels": "The current scheme has no models.",
      "connectivity.summary.testing": "Testing {completed}/{total} · Available {available} · Failed {error}",
      "connectivity.summary.doneWarning": "Checks complete · Available {available}/{total} · Degraded {warning} · Failed {error}",
      "connectivity.summary.doneOk": "Checks complete · All available {ok}/{total}",
      "connectivity.placeholder.addScheme": "Add at least one scheme first.",
      "connectivity.placeholder.noModels": "The current scheme has no models to test yet.",
      "connectivity.result.waiting": "Waiting for connectivity test results.",
      "connectivity.stats.total": "Total",
      "connectivity.stats.available": "Available",
      "connectivity.stats.degraded": "Degraded",
      "connectivity.stats.failed": "Failed",
      "connectivity.stats.testing": "Testing",
      "connectivity.dirty": "Configuration changed. Re-run the test.",
      "connectivity.testing": "Testing",
      "connectivity.submitted": "Test request submitted...",
      "connectivity.requesting": "Sending connectivity test request...",
      "connectivity.failedPrefix": "Connection failed: "
    }
  };

  return (key, values = {}) =>
    interpolate(catalog[resolveRuntimeLocale()]?.[key] ?? catalog["zh-CN"]?.[key] ?? key, values);
}

export function createConnectivityUi({
  state,
  elements,
  escapeHtml,
  escapeAttribute,
  getCurrentScheme,
  setModelTestStatus,
  collectSecrets,
  collectModelFromCard,
  runModelConnectivityTest,
  formatModelTestRetryStatus,
  translate = createFallbackTranslator()
}) {
  const {
    schemeConnectivityStatus,
    schemeConnectivityList,
    schemeConnectivityRetestButton,
    modelList
  } = elements;

  function getSchemeById(schemeId) {
    return state.schemes.find((item) => item.id === schemeId) || null;
  }

  function ensureState(schemeId, models = []) {
    const normalizedSchemeId = String(schemeId || "").trim();
    if (!normalizedSchemeId) {
      return {
        tone: "neutral",
        message: translate("connectivity.waiting"),
        results: []
      };
    }

    const existing = state.connectivityBySchemeId.get(normalizedSchemeId) || {
      tone: "neutral",
      message: translate("connectivity.waiting"),
      results: []
    };
    const existingById = new Map(existing.results.map((item) => [item.id, item]));
    const normalizedResults = (Array.isArray(models) ? models : []).map((model) => ({
      id: model.id || "",
      label: model.label || model.id || translate("connectivity.untitledModel"),
      tone: existingById.get(model.id)?.tone || "neutral",
      status: existingById.get(model.id)?.status || translate("connectivity.untested"),
      detail: existingById.get(model.id)?.detail || ""
    }));

    const next = {
      tone: existing.tone || "neutral",
      message: existing.message || translate("connectivity.waiting"),
      results: normalizedResults
    };
    state.connectivityBySchemeId.set(normalizedSchemeId, next);
    return next;
  }

  function updateEntry(schemeId, modelId, patch = {}) {
    const scheme = getSchemeById(schemeId);
    const currentState = ensureState(schemeId, scheme?.models || []);
    const index = currentState.results.findIndex((item) => item.id === modelId);
    if (index === -1) {
      return currentState;
    }

    currentState.results[index] = {
      ...currentState.results[index],
      ...patch
    };
    state.connectivityBySchemeId.set(schemeId, currentState);
    return currentState;
  }

  function buildDisplay(payload = {}) {
    const degraded = Boolean(payload?.degraded);
    const workflowMode = String(payload?.diagnostics?.workflowProbe?.mode || "").trim();
    const summary = String(payload?.summary || "").trim();
    const reply = String(payload?.reply || "").trim();
    const parts = [];

    if (summary) {
      parts.push(summary);
    }
    if (workflowMode === "fallback" && !degraded) {
      parts.push(translate("connectivity.workflowFallback"));
    }
    if (payload?.diagnostics?.webSearch?.enabled) {
      parts.push(
        translate(
          payload?.diagnostics?.webSearch?.used
            ? "connectivity.webSearchVerified"
            : "connectivity.webSearchUnavailable"
        )
      );
    }
    if (payload?.diagnostics?.thinking?.enabled) {
      parts.push(
        translate(
          payload?.diagnostics?.thinking?.verified
            ? "connectivity.thinkingVerified"
            : "connectivity.thinkingUnavailable"
        )
      );
    }
    if (reply) {
      parts.push(translate("connectivity.basicReply", { reply }));
    }

    return {
      tone: degraded ? "warning" : "ok",
      status: degraded
        ? translate("connectivity.availableDegraded")
        : translate("connectivity.available"),
      detail: parts.join(" ")
    };
  }

  function getCounts(results = []) {
    const counts = {
      total: Array.isArray(results) ? results.length : 0,
      ok: 0,
      warning: 0,
      error: 0,
      testing: 0,
      neutral: 0
    };

    for (const item of Array.isArray(results) ? results : []) {
      const tone = String(item?.tone || "neutral").trim();
      if (tone === "ok") {
        counts.ok += 1;
        continue;
      }
      if (tone === "warning") {
        counts.warning += 1;
        continue;
      }
      if (tone === "error") {
        counts.error += 1;
        continue;
      }
      if (tone === "testing") {
        counts.testing += 1;
        continue;
      }
      counts.neutral += 1;
    }

    counts.available = counts.ok + counts.warning;
    counts.completed = counts.ok + counts.warning + counts.error;
    return counts;
  }

  function buildSummaryMessage(results = []) {
    const counts = getCounts(results);
    if (!counts.total) {
      return {
        tone: "neutral",
        message: translate("connectivity.noModels"),
        counts
      };
    }

    if (counts.testing > 0) {
      return {
        tone: "testing",
        message: translate("connectivity.summary.testing", counts),
        counts
      };
    }

    if (counts.error > 0 || counts.warning > 0) {
      return {
        tone: "warning",
        message: translate("connectivity.summary.doneWarning", counts),
        counts
      };
    }

    if (counts.ok === counts.total) {
      return {
        tone: "ok",
        message: translate("connectivity.summary.doneOk", counts),
        counts
      };
    }

    return {
      tone: "neutral",
      message: translate("connectivity.waiting"),
      counts
    };
  }

  function sortResults(results = []) {
    const rank = {
      error: 0,
      testing: 1,
      warning: 2,
      ok: 3,
      neutral: 4
    };

    return [...results].sort((left, right) => {
      const toneDelta =
        (rank[String(left?.tone || "neutral")] ?? 99) -
        (rank[String(right?.tone || "neutral")] ?? 99);
      if (toneDelta !== 0) {
        return toneDelta;
      }

      return String(left?.label || left?.id || "").localeCompare(
        String(right?.label || right?.id || ""),
        resolveRuntimeLocale()
      );
    });
  }

  function syncSummaryState(schemeId) {
    const scheme = getSchemeById(schemeId);
    const currentState = ensureState(schemeId, scheme?.models || []);
    const summary = buildSummaryMessage(currentState.results);
    const next = {
      ...currentState,
      tone: summary.tone,
      message: summary.message
    };
    state.connectivityBySchemeId.set(schemeId, next);
    return next;
  }

  function renderList() {
    if (!schemeConnectivityList || !schemeConnectivityStatus) {
      return;
    }

    const currentScheme = getCurrentScheme();
    if (!currentScheme) {
      schemeConnectivityStatus.textContent = translate("scheme.none");
      schemeConnectivityStatus.dataset.tone = "neutral";
      schemeConnectivityList.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("connectivity.placeholder.addScheme")
      )}</p>`;
      return;
    }

    const currentState = syncSummaryState(currentScheme.id);
    const summary = buildSummaryMessage(currentState.results);
    const modelById = new Map((currentScheme.models || []).map((model) => [model.id, model]));
    const sortedResults = sortResults(currentState.results);
    const progressPercent = summary.counts.total
      ? Math.round((summary.counts.completed / summary.counts.total) * 100)
      : 0;
    const overviewCards = [
      { label: translate("connectivity.stats.total"), value: summary.counts.total, tone: "neutral" },
      { label: translate("connectivity.stats.available"), value: summary.counts.available, tone: "ok" },
      { label: translate("connectivity.stats.degraded"), value: summary.counts.warning, tone: "warning" },
      { label: translate("connectivity.stats.failed"), value: summary.counts.error, tone: "error" },
      { label: translate("connectivity.stats.testing"), value: summary.counts.testing, tone: "testing" }
    ];

    schemeConnectivityStatus.textContent = summary.message || translate("connectivity.waiting");
    schemeConnectivityStatus.dataset.tone = summary.tone || "neutral";

    if (!sortedResults.length) {
      schemeConnectivityList.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("connectivity.placeholder.noModels")
      )}</p>`;
      return;
    }

    schemeConnectivityList.innerHTML = [
      '<section class="scheme-connectivity-overview">',
      '  <div class="scheme-connectivity-progress">',
      `    <div class="scheme-connectivity-progress-bar" aria-hidden="true"><span style="width:${progressPercent}%"></span></div>`,
      `    <p class="scheme-connectivity-progress-copy">${escapeHtml(summary.message || translate("connectivity.waiting"))}</p>`,
      "  </div>",
      '  <div class="scheme-connectivity-stats">',
      overviewCards
        .map(
          (item) =>
            `<span class="scheme-connectivity-stat" data-tone="${escapeAttribute(item.tone)}">${escapeHtml(item.label)} ${escapeHtml(item.value)}</span>`
        )
        .join(""),
      "  </div>",
      "</section>",
      '<section class="scheme-connectivity-results">',
      sortedResults
        .map((result) => {
          const model = modelById.get(result.id) || {};
          const meta = [model.provider, model.model].filter(Boolean).join(" / ");
          return [
            `<article class="scheme-connectivity-row" data-tone="${escapeAttribute(result.tone || "neutral")}">`,
            '  <div class="scheme-connectivity-head">',
            '    <div class="scheme-connectivity-title">',
            `      <strong>${escapeHtml(result.label || result.id || translate("connectivity.untitledModel"))}</strong>`,
            `      <span class="scheme-connectivity-meta">${escapeHtml(meta || result.id || "")}</span>`,
            "    </div>",
            `    <span class="chip" data-tone="${escapeAttribute(result.tone || "neutral")}">${escapeHtml(result.status || translate("connectivity.untested"))}</span>`,
            "  </div>",
            `  <p class="scheme-connectivity-copy">${escapeHtml(result.detail || translate("connectivity.result.waiting"))}</p>`,
            "</article>"
          ].join("");
        })
        .join(""),
      "</section>"
    ].join("");
  }

  function applyStoredStatusesToVisibleCards() {
    const currentScheme = getCurrentScheme();
    if (!currentScheme || !modelList) {
      return;
    }

    const currentState = ensureState(currentScheme.id, currentScheme.models);
    const resultsById = new Map(currentState.results.map((result) => [result.id, result]));
    for (const card of Array.from(modelList.querySelectorAll(".model-card"))) {
      const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
      const result = resultsById.get(modelId);
      if (!result) {
        setModelTestStatus(card, translate("connectivity.untested"));
        continue;
      }
      setModelTestStatus(card, result.status || translate("connectivity.untested"), result.tone || "neutral");
    }
  }

  function markModelDirty(modelId) {
    const currentScheme = getCurrentScheme();
    const normalizedModelId = String(modelId || "").trim();
    if (!currentScheme?.id || !normalizedModelId) {
      return;
    }

    updateEntry(currentScheme.id, normalizedModelId, {
      tone: "neutral",
      status: translate("connectivity.untested"),
      detail: translate("connectivity.dirty")
    });
    renderList();
  }

  async function testSingleModel(card) {
    const button = card.querySelector("[data-model-test]");
    const model = collectModelFromCard(card);

    button.disabled = true;
    setModelTestStatus(card, translate("connectivity.testing"), "testing");

    try {
      const payload = await runModelConnectivityTest(model, {
        secrets: collectSecrets(),
        onEvent(event) {
          if (event.stage === "submitted") {
            setModelTestStatus(card, translate("connectivity.submitted"), "testing");
            return;
          }

          if (event.stage === "model_test_retry") {
            setModelTestStatus(card, formatModelTestRetryStatus(event), "testing");
            return;
          }

          if (event.stage === "model_test_failed") {
            setModelTestStatus(
              card,
              `${translate("connectivity.failedPrefix")}${event.detail || "Unknown error"}`,
              "error"
            );
          }
        }
      });

      const display = buildDisplay(payload);
      setModelTestStatus(card, display.detail || display.status, display.tone);
      const currentScheme = getCurrentScheme();
      if (currentScheme?.id) {
        updateEntry(currentScheme.id, model.id, display);
        renderList();
      }
    } catch (error) {
      const detail = `${translate("connectivity.failedPrefix")}${error.message}`;
      setModelTestStatus(card, detail, "error");
      const currentScheme = getCurrentScheme();
      if (currentScheme?.id) {
        updateEntry(currentScheme.id, model.id, {
          tone: "error",
          status: translate("connectivity.stats.failed"),
          detail
        });
        renderList();
      }
    } finally {
      button.disabled = false;
    }
  }

  async function runCurrentSchemeConnectivityTests(options = {}) {
    const { force = false } = options;
    const currentScheme = getCurrentScheme();
    if (!currentScheme?.id) {
      renderList();
      return;
    }

    const existingState = ensureState(currentScheme.id, currentScheme.models);
    const shouldSkip =
      !force &&
      existingState.results.length === currentScheme.models.length &&
      existingState.results.every(
        (item) =>
          item.status &&
          item.status !== translate("connectivity.untested") &&
          item.status !== translate("connectivity.testing")
      );
    if (shouldSkip) {
      renderList();
      return;
    }

    const runToken = Date.now();
    state.connectivityRunToken = runToken;
    const secrets = collectSecrets();
    const total = currentScheme.models.length;

    if (!total) {
      state.connectivityBySchemeId.set(currentScheme.id, {
        tone: "neutral",
        message: translate("connectivity.noModels"),
        results: []
      });
      renderList();
      return;
    }

    state.connectivityBySchemeId.set(currentScheme.id, {
      tone: "testing",
      message: translate("connectivity.summary.testing", {
        completed: 0,
        total,
        available: 0,
        error: 0
      }),
      results: currentScheme.models.map((model) => ({
        id: model.id || "",
        label: model.label || model.id || translate("connectivity.untitledModel"),
        tone: "testing",
        status: translate("connectivity.testing"),
        detail: translate("connectivity.requesting")
      }))
    });
    renderList();
    applyStoredStatusesToVisibleCards();
    if (schemeConnectivityRetestButton) {
      schemeConnectivityRetestButton.disabled = true;
    }

    try {
      await Promise.allSettled(
        currentScheme.models.map(async (model) => {
          if (state.connectivityRunToken !== runToken) {
            return;
          }

          updateEntry(currentScheme.id, model.id, {
            tone: "testing",
            status: translate("connectivity.testing"),
            detail: translate("connectivity.requesting")
          });
          renderList();
          applyStoredStatusesToVisibleCards();

          try {
            const payload = await runModelConnectivityTest(model, {
              secrets,
              onEvent(event) {
                if (state.connectivityRunToken !== runToken) {
                  return;
                }

                if (event.stage === "model_test_retry") {
                  updateEntry(currentScheme.id, model.id, {
                    tone: "testing",
                    status: translate("connectivity.testing"),
                    detail: formatModelTestRetryStatus(event)
                  });
                  renderList();
                  applyStoredStatusesToVisibleCards();
                }
              }
            });

            if (state.connectivityRunToken !== runToken) {
              return;
            }

            updateEntry(currentScheme.id, model.id, buildDisplay(payload));
          } catch (error) {
            if (state.connectivityRunToken !== runToken) {
              return;
            }

            updateEntry(currentScheme.id, model.id, {
              tone: "error",
              status: translate("connectivity.stats.failed"),
              detail: `${translate("connectivity.failedPrefix")}${error.message}`
            });
          }

          if (state.connectivityRunToken !== runToken) {
            return;
          }

          syncSummaryState(currentScheme.id);
          renderList();
          applyStoredStatusesToVisibleCards();
        })
      );
    } finally {
      if (state.connectivityRunToken === runToken) {
        syncSummaryState(currentScheme.id);
        renderList();
        applyStoredStatusesToVisibleCards();
      }
      if (state.connectivityRunToken === runToken && schemeConnectivityRetestButton) {
        schemeConnectivityRetestButton.disabled = false;
      }
    }
  }

  function refreshLocale() {
    renderList();
    applyStoredStatusesToVisibleCards();
  }

  return {
    applyStoredStatusesToVisibleCards,
    ensureState,
    markModelDirty,
    refreshLocale,
    renderList,
    runCurrentSchemeConnectivityTests,
    testSingleModel,
    updateEntry
  };
}

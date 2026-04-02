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
  formatModelTestRetryStatus
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
        message: "等待检测",
        results: []
      };
    }

    const existing = state.connectivityBySchemeId.get(normalizedSchemeId) || {
      tone: "neutral",
      message: "等待检测",
      results: []
    };
    const existingById = new Map(existing.results.map((item) => [item.id, item]));
    const normalizedResults = (Array.isArray(models) ? models : []).map((model) => ({
      id: model.id || "",
      label: model.label || model.id || "未命名模型",
      tone: existingById.get(model.id)?.tone || "neutral",
      status: existingById.get(model.id)?.status || "未测试",
      detail: existingById.get(model.id)?.detail || ""
    }));

    const next = {
      tone: existing.tone || "neutral",
      message: existing.message || "等待检测",
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
      parts.push("Workflow probe used compatibility fallback.");
    }
    if (reply) {
      parts.push(`Basic reply: ${reply}`);
    }

    return {
      tone: degraded ? "warning" : "ok",
      status: degraded ? "可用(降级)" : "可用",
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
        message: "当前方案没有模型",
        counts
      };
    }

    if (counts.testing > 0) {
      return {
        tone: "testing",
        message: `并发检测中 ${counts.completed}/${counts.total} · 可用 ${counts.available} · 失败 ${counts.error}`,
        counts
      };
    }

    if (counts.error > 0 || counts.warning > 0) {
      return {
        tone: "warning",
        message: `检测完成 · 可用 ${counts.available}/${counts.total} · 降级 ${counts.warning} · 失败 ${counts.error}`,
        counts
      };
    }

    if (counts.ok === counts.total) {
      return {
        tone: "ok",
        message: `检测完成 · 全部可用 ${counts.ok}/${counts.total}`,
        counts
      };
    }

    return {
      tone: "neutral",
      message: "等待检测",
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
        "zh-CN"
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
      schemeConnectivityStatus.textContent = "无方案";
      schemeConnectivityStatus.dataset.tone = "neutral";
      schemeConnectivityList.innerHTML = '<p class="placeholder">请先添加至少一个方案。</p>';
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
      { label: "总数", value: summary.counts.total, tone: "neutral" },
      { label: "可用", value: summary.counts.available, tone: "ok" },
      { label: "降级", value: summary.counts.warning, tone: "warning" },
      { label: "失败", value: summary.counts.error, tone: "error" },
      { label: "检测中", value: summary.counts.testing, tone: "testing" }
    ];

    schemeConnectivityStatus.textContent = summary.message || "等待检测";
    schemeConnectivityStatus.dataset.tone = summary.tone || "neutral";

    if (!sortedResults.length) {
      schemeConnectivityList.innerHTML = '<p class="placeholder">当前方案还没有可检测的模型。</p>';
      return;
    }

    schemeConnectivityList.innerHTML = [
      '<section class="scheme-connectivity-overview">',
      '  <div class="scheme-connectivity-progress">',
      `    <div class="scheme-connectivity-progress-bar" aria-hidden="true"><span style="width:${progressPercent}%"></span></div>`,
      `    <p class="scheme-connectivity-progress-copy">${escapeHtml(summary.message || "等待检测")}</p>`,
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
            `      <strong>${escapeHtml(result.label || result.id || "未命名模型")}</strong>`,
            `      <span class="scheme-connectivity-meta">${escapeHtml(meta || result.id || "")}</span>`,
            "    </div>",
            `    <span class="chip" data-tone="${escapeAttribute(result.tone || "neutral")}">${escapeHtml(result.status || "未测试")}</span>`,
            "  </div>",
            `  <p class="scheme-connectivity-copy">${escapeHtml(result.detail || "等待连接测试结果。")}</p>`,
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
        setModelTestStatus(card, "未测试");
        continue;
      }
      setModelTestStatus(card, result.status || "未测试", result.tone || "neutral");
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
      status: "未测试",
      detail: "配置已修改，请重新检测。"
    });
    renderList();
  }

  async function testSingleModel(card) {
    const button = card.querySelector("[data-model-test]");
    const model = collectModelFromCard(card);

    button.disabled = true;
    setModelTestStatus(card, "测试中...", "testing");

    try {
      const payload = await runModelConnectivityTest(model, {
        secrets: collectSecrets(),
        onEvent(event) {
          if (event.stage === "submitted") {
            setModelTestStatus(card, "已提交测试请求...", "testing");
            return;
          }

          if (event.stage === "model_test_retry") {
            setModelTestStatus(card, formatModelTestRetryStatus(event), "testing");
            return;
          }

          if (event.stage === "model_test_failed") {
            setModelTestStatus(card, `连接失败：${event.detail || "未知错误"}`, "error");
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
      const detail = `连接失败：${error.message}`;
      setModelTestStatus(card, detail, "error");
      const currentScheme = getCurrentScheme();
      if (currentScheme?.id) {
        updateEntry(currentScheme.id, model.id, {
          tone: "error",
          status: "失败",
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
          item.status !== "未测试" &&
          item.status !== "检测中" &&
          item.status !== "排队中"
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
        message: "当前方案没有模型",
        results: []
      });
      renderList();
      return;
    }

    state.connectivityBySchemeId.set(currentScheme.id, {
      tone: "testing",
      message: `并发检测中 0/${total}`,
      results: currentScheme.models.map((model) => ({
        id: model.id || "",
        label: model.label || model.id || "未命名模型",
        tone: "testing",
        status: "检测中",
        detail: "正在发送连接测试请求..."
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
            status: "检测中",
            detail: "正在发送连接测试请求..."
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
                    status: "重试中",
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
              status: "失败",
              detail: `连接失败：${error.message}`
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

  return {
    applyStoredStatusesToVisibleCards,
    ensureState,
    markModelDirty,
    renderList,
    runCurrentSchemeConnectivityTests,
    testSingleModel,
    updateEntry
  };
}

import { describeOperationEvent as describeOperationEventMessage } from "./operation-events.js";

const LIVE_EVENT_LIMIT = 60;

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
      "run.state.planning": "规划中",
      "run.state.research": "调研中",
      "run.state.validation": "验证中",
      "run.state.handoff": "交付中",
      "run.state.implementation": "执行中",
      "run.state.retrying": "重试中 {attempt}/{maxRetries}",
      "run.state.delegating": "分配中",
      "run.state.subagent": "子代理执行中",
      "run.state.leaderSynthesis": "组长汇总中",
      "run.state.cancelling": "终止中...",
      "run.state.synthesizing": "汇总中",
      "run.state.cancelled": "已终止",
      "run.state.done": "已完成",
      "run.state.failed": "失败",
      "run.state.needTask": "需填写任务",
      "run.state.missingScheme": "缺少方案",
      "run.state.starting": "启动中",
      "run.livePlaceholder": "运行后会在这里显示计划、重试和完成状态。",
      "run.synthesis.meta": "总耗时: {totalMs} ms",
      "run.synthesis.executiveSummary": "执行摘要",
      "run.synthesis.consensus": "共识",
      "run.synthesis.disagreements": "分歧",
      "run.synthesis.nextActions": "下一步",
      "run.synthesis.noFinalAnswer": "未返回最终结论。",
      "run.synthesis.noExecutiveSummary": "未提供执行摘要。",
      "run.synthesis.noConsensus": "未提供共识项。",
      "run.synthesis.noDisagreements": "未提供分歧项。",
      "run.synthesis.noNextActions": "未提供下一步建议。",
      "run.cancelled.default": "运行已被手动取消。",
      "run.cancelled.plan": "任务已终止: {message}",
      "run.cancelled.workers": "任务已终止，已停止等待剩余工作模型结果。",
      "run.cancelled.synthesis": "任务已终止: {message}",
      "run.toast.missingScheme": "请先配置至少一个可运行方案。",
      "run.plan.planning": "主控模型正在规划...",
      "run.workers.waiting": "工作模型等待任务分配...",
      "run.synthesis.waiting": "等待主控模型汇总...",
      "run.failed.plan": "执行失败: {error}",
      "run.failed.workers": "未生成工作模型结果。",
      "run.failed.synthesis": "执行失败: {error}",
      "run.cancel.requestLocal": "已立即终止本地等待，正在请求后端停止任务。",
      "run.cancel.renderLocal": "已立即终止当前任务，正在清理远端请求。",
      "run.cancel.renderRemote": "任务已立即终止，并已通知后端停止当前请求。",
      "run.cancel.renderRemoteFailed": "本地等待已停止，但后端终止请求失败，请再次点击“终止任务”。",
      "run.cancel.failed": "终止任务失败: {error}"
    },
    "en-US": {
      "run.state.planning": "Planning",
      "run.state.research": "Researching",
      "run.state.validation": "Validating",
      "run.state.handoff": "Handing Off",
      "run.state.implementation": "Executing",
      "run.state.retrying": "Retrying {attempt}/{maxRetries}",
      "run.state.delegating": "Delegating",
      "run.state.subagent": "Subagent Running",
      "run.state.leaderSynthesis": "Leader Synthesizing",
      "run.state.cancelling": "Cancelling...",
      "run.state.synthesizing": "Synthesizing",
      "run.state.cancelled": "Cancelled",
      "run.state.done": "Completed",
      "run.state.failed": "Failed",
      "run.state.needTask": "Task required",
      "run.state.missingScheme": "No scheme",
      "run.state.starting": "Starting",
      "run.livePlaceholder": "The live feed shows planning, retries, and completion status here.",
      "run.synthesis.meta": "Total time: {totalMs} ms",
      "run.synthesis.executiveSummary": "Executive Summary",
      "run.synthesis.consensus": "Consensus",
      "run.synthesis.disagreements": "Disagreements",
      "run.synthesis.nextActions": "Next Actions",
      "run.synthesis.noFinalAnswer": "No final answer returned.",
      "run.synthesis.noExecutiveSummary": "No executive summary provided.",
      "run.synthesis.noConsensus": "No consensus items were provided.",
      "run.synthesis.noDisagreements": "No disagreements were provided.",
      "run.synthesis.noNextActions": "No next actions were suggested.",
      "run.cancelled.default": "The run was cancelled manually.",
      "run.cancelled.plan": "Task cancelled: {message}",
      "run.cancelled.workers": "The task was cancelled. Waiting for remaining worker results has stopped.",
      "run.cancelled.synthesis": "Task cancelled: {message}",
      "run.toast.missingScheme": "Configure at least one runnable scheme first.",
      "run.plan.planning": "The controller model is planning...",
      "run.workers.waiting": "Workers are waiting for task assignment...",
      "run.synthesis.waiting": "Waiting for controller synthesis...",
      "run.failed.plan": "Execution failed: {error}",
      "run.failed.workers": "No worker results were generated.",
      "run.failed.synthesis": "Execution failed: {error}",
      "run.cancel.requestLocal": "Local waiting stopped. Requesting backend cancellation now.",
      "run.cancel.renderLocal": "The current task was stopped locally. Cleaning up remote requests.",
      "run.cancel.renderRemote": "The task was cancelled and the backend was notified to stop the request.",
      "run.cancel.renderRemoteFailed": "Local waiting stopped, but backend cancellation failed. Click Cancel Task again.",
      "run.cancel.failed": "Failed to cancel task: {error}"
    }
  };

  return (key, values = {}) => {
    const locale = resolveRuntimeLocale();
    return interpolate(catalog[locale]?.[key] ?? catalog["zh-CN"]?.[key] ?? key, values);
  };
}

export function getRunStateTextForEvent(event, translate = createFallbackTranslator()) {
  switch (event.stage) {
    case "planning_start":
      return translate("run.state.planning");
    case "phase_start":
      if (event.phase === "research") {
        return translate("run.state.research");
      }
      if (event.phase === "validation") {
        return translate("run.state.validation");
      }
      if (event.phase === "handoff") {
        return translate("run.state.handoff");
      }
      return translate("run.state.implementation");
    case "planning_retry":
    case "worker_retry":
    case "synthesis_retry":
    case "model_test_retry":
    case "subagent_retry":
    case "leader_delegate_retry":
    case "leader_synthesis_retry":
      return translate("run.state.retrying", event);
    case "leader_delegate_start":
      return translate("run.state.delegating");
    case "subagent_start":
      return translate("run.state.subagent");
    case "leader_synthesis_start":
      return translate("run.state.leaderSynthesis");
    case "cancel_requested":
      return translate("run.state.cancelling");
    case "synthesis_start":
      return translate("run.state.synthesizing");
    case "cluster_cancelled":
      return translate("run.state.cancelled");
    case "cluster_done":
      return translate("run.state.done");
    case "cluster_failed":
      return translate("run.state.failed");
    default:
      return "";
  }
}

export function createClusterRunUi({
  elements,
  runConsoleUi,
  agentVizUi,
  escapeHtml,
  renderList,
  setActiveConsolePanel,
  setSaveStatus,
  formatDelay,
  formatTimestamp,
  getCurrentScheme,
  captureCurrentSchemeDraft,
  openOperationStream,
  createOperationId,
  translate = createFallbackTranslator()
}) {
  const {
    taskInput,
    runButton,
    cancelButton,
    runState,
    planOutput,
    workerOutput,
    synthesisOutput,
    liveOutput
  } = elements;

  let currentOperationId = "";
  let currentOperationStream = null;
  let currentClusterRequestController = null;
  let lastRunStateEvent = null;
  let lastSynthesisResult = null;
  let lastSynthesisTimings = null;
  let liveEvents = [];

  function getCurrentOperationId() {
    return currentOperationId;
  }

  function resetLiveFeed() {
    if (!liveOutput) {
      return;
    }

    liveOutput.innerHTML = `<p class="placeholder">${escapeHtml(translate("run.livePlaceholder"))}</p>`;
  }

  function renderPlan(plan) {
    if (planOutput) {
      planOutput.textContent = JSON.stringify(plan, null, 2);
    }
  }

  function renderSynthesis(result, timings) {
    if (!synthesisOutput) {
      return;
    }

    synthesisOutput.innerHTML = `
      <article class="synthesis-card">
        <p class="final-answer">${escapeHtml(
          result?.finalAnswer || translate("run.synthesis.noFinalAnswer")
        )}</p>
        <div class="meta-row">${escapeHtml(
          translate("run.synthesis.meta", { totalMs: timings?.totalMs ?? "n/a" })
        )}</div>
        <h3>${escapeHtml(translate("run.synthesis.executiveSummary"))}</h3>
        ${renderList(result?.executiveSummary, translate("run.synthesis.noExecutiveSummary"))}
        <h3>${escapeHtml(translate("run.synthesis.consensus"))}</h3>
        ${renderList(result?.consensus, translate("run.synthesis.noConsensus"))}
        <h3>${escapeHtml(translate("run.synthesis.disagreements"))}</h3>
        ${renderList(result?.disagreements, translate("run.synthesis.noDisagreements"))}
        <h3>${escapeHtml(translate("run.synthesis.nextActions"))}</h3>
        ${renderList(result?.nextActions, translate("run.synthesis.noNextActions"))}
      </article>
    `;
  }

  function closeCurrentOperationStream() {
    if (currentOperationStream) {
      currentOperationStream.close();
      currentOperationStream = null;
    }
  }

  function beginOperation(operationId, onEvent) {
    currentOperationId = operationId;
    closeCurrentOperationStream();
    currentOperationStream = openOperationStream(operationId, onEvent);
    agentVizUi.startRunTimer();
  }

  function finishOperation() {
    currentOperationId = "";
    if (cancelButton) {
      cancelButton.disabled = true;
    }
    agentVizUi.stopRunTimer();
    if (currentOperationStream) {
      const stream = currentOperationStream;
      currentOperationStream = null;
      setTimeout(() => stream.close(), 300);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function renderClusterCancelledState(detail = translate("run.cancelled.default")) {
    const message = String(detail || translate("run.cancelled.default"));
    if (planOutput) {
      planOutput.textContent = translate("run.cancelled.plan", { message });
    }
    if (workerOutput) {
      workerOutput.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("run.cancelled.workers")
      )}</p>`;
    }
    if (synthesisOutput) {
      synthesisOutput.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("run.cancelled.synthesis", { message })
      )}</p>`;
    }
    if (runState) {
      runState.textContent = translate("run.state.cancelled");
    }
  }

  async function requestOperationCancellation(operationId, maxAttempts = 4) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`/api/operations/${encodeURIComponent(operationId)}/cancel`, {
          method: "POST"
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) {
          const error = new Error(payload.error || `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (error?.status !== 404 || attempt === maxAttempts) {
          throw error;
        }
        await sleep(120 * attempt);
      }
    }

    throw lastError || new Error("Cancel request failed.");
  }

  function appendLiveEvent(event) {
    if (!liveOutput) {
      return;
    }

    if (event.stage === "session_update" || String(event.stage || "").startsWith("trace_")) {
      return;
    }

    liveEvents.push(event);
    if (liveEvents.length > LIVE_EVENT_LIMIT) {
      liveEvents = liveEvents.slice(-LIVE_EVENT_LIMIT);
    }

    if (liveOutput.querySelector(".placeholder")) {
      liveOutput.innerHTML = "";
    }

    const item = document.createElement("article");
    item.className = "feed-item";
    item.dataset.tone = event.tone || "neutral";
    item.innerHTML = `
      <div class="feed-time">${escapeHtml(formatTimestamp(event.timestamp) || "--:--:--")}</div>
      <div class="feed-message">${escapeHtml(
        describeOperationEventMessage(event, { formatDelay, translate })
      )}</div>
    `;
    liveOutput.append(item);

    const items = Array.from(liveOutput.querySelectorAll(".feed-item"));
    if (items.length > LIVE_EVENT_LIMIT) {
      items[0].remove();
    }
    liveOutput.scrollTop = liveOutput.scrollHeight;
  }

  function setRunStateFromEvent(event) {
    if (!runState) {
      return;
    }

    lastRunStateEvent = event;
    const nextText = getRunStateTextForEvent(event, translate);
    if (nextText) {
      runState.textContent = nextText;
    }
  }

  function handleOperationEvent(event) {
    agentVizUi.updateFromEvent(event);
    runConsoleUi.updateTraceStateFromEvent(event);
    runConsoleUi.updateSessionStateFromEvent(event);
    appendLiveEvent(event);
    setRunStateFromEvent(event);
  }

  function abortActiveRequest(reason = "Cluster run cancelled locally.") {
    if (currentClusterRequestController && !currentClusterRequestController.signal.aborted) {
      const abortReason = reason instanceof Error ? reason : new Error(String(reason));
      currentClusterRequestController.abort(abortReason);
    }
  }

  async function runCluster() {
    setActiveConsolePanel("run");
    const task = taskInput?.value.trim() || "";
    if (!task) {
      if (runState) {
        runState.textContent = translate("run.state.needTask");
      }
      taskInput?.focus();
      return;
    }

    captureCurrentSchemeDraft();
    const currentScheme = getCurrentScheme();
    if (!currentScheme?.id) {
      if (runState) {
        runState.textContent = translate("run.state.missingScheme");
      }
      setSaveStatus(translate("run.toast.missingScheme"), "error");
      return;
    }

    const operationId = createOperationId("cluster");
    liveEvents = [];
    lastRunStateEvent = null;
    lastSynthesisResult = null;
    lastSynthesisTimings = null;
    resetLiveFeed();
    agentVizUi.reset();
    runConsoleUi.resetTracePanels();
    beginOperation(operationId, handleOperationEvent);

    if (runButton) {
      runButton.disabled = true;
    }
    if (cancelButton) {
      cancelButton.disabled = false;
    }
    if (runState) {
      runState.textContent = translate("run.state.starting");
    }
    if (planOutput) {
      planOutput.textContent = translate("run.plan.planning");
    }
    if (workerOutput) {
      workerOutput.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("run.workers.waiting")
      )}</p>`;
    }
    if (synthesisOutput) {
      synthesisOutput.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("run.synthesis.waiting")
      )}</p>`;
    }

    const requestController = new AbortController();
    currentClusterRequestController = requestController;

    try {
      const response = await fetch("/api/cluster/run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ task, operationId, schemeId: currentScheme.id }),
        signal: requestController.signal
      });

      const payload = await response.json();
      if (!payload.ok) {
        if (payload.cancelled) {
          renderClusterCancelledState(payload.error || translate("run.cancelled.default"));
          return;
        }
        throw new Error(payload.error);
      }

      renderPlan(payload.plan);
      runConsoleUi.renderWorkers(payload.executions);
      lastSynthesisResult = payload.synthesis;
      lastSynthesisTimings = payload.timings;
      renderSynthesis(payload.synthesis, payload.timings);
      if (payload.session) {
        runConsoleUi.updateSessionStateFromEvent({
          stage: "cluster_done",
          session: payload.session
        });
      }
      if (runState) {
        runState.textContent = translate("run.state.done");
      }
    } catch (error) {
      if (requestController.signal.aborted) {
        return;
      }

      if (planOutput) {
        planOutput.textContent = translate("run.failed.plan", { error: error.message });
      }
      if (workerOutput) {
        workerOutput.innerHTML = `<p class="placeholder">${escapeHtml(
          translate("run.failed.workers")
        )}</p>`;
      }
      if (synthesisOutput) {
        synthesisOutput.innerHTML = `<p class="error">${escapeHtml(
          translate("run.failed.synthesis", { error: error.message })
        )}</p>`;
      }
      if (runState) {
        runState.textContent = translate("run.state.failed");
      }
      appendLiveEvent({
        timestamp: new Date().toISOString(),
        tone: "error",
        stage: "cluster_failed",
        detail: error.message
      });
    } finally {
      if (currentClusterRequestController === requestController) {
        currentClusterRequestController = null;
      }

      if (!requestController.signal.aborted) {
        if (runButton) {
          runButton.disabled = false;
        }
        finishOperation();
      }
    }
  }

  async function cancelClusterRun() {
    if (!currentOperationId) {
      return;
    }

    if (cancelButton) {
      cancelButton.disabled = true;
    }
    if (runState) {
      runState.textContent = translate("run.state.cancelling");
    }

    abortActiveRequest("Cluster run cancelled locally.");

    const localCancelEvent = {
      timestamp: new Date().toISOString(),
      tone: "warning",
      stage: "cancel_requested",
      detail: translate("run.cancel.requestLocal"),
      ...agentVizUi.resolveControllerEventMeta()
    };
    handleOperationEvent(localCancelEvent);
    renderClusterCancelledState(translate("run.cancel.renderLocal"));

    try {
      const operationId = currentOperationId;
      await requestOperationCancellation(operationId);

      const cancelledEvent = {
        timestamp: new Date().toISOString(),
        tone: "warning",
        stage: "cluster_cancelled",
        detail: translate("run.cancel.renderRemote"),
        ...agentVizUi.resolveControllerEventMeta()
      };
      handleOperationEvent(cancelledEvent);
      renderClusterCancelledState(translate("run.cancel.renderRemote"));
      if (runButton) {
        runButton.disabled = false;
      }
      finishOperation();
    } catch (error) {
      if (cancelButton) {
        cancelButton.disabled = false;
      }
      renderClusterCancelledState(translate("run.cancel.renderRemoteFailed"));
      appendLiveEvent({
        timestamp: new Date().toISOString(),
        tone: "error",
        stage: "cluster_failed",
        detail: translate("run.cancel.failed", { error: error.message })
      });
      if (runState) {
        runState.textContent = translate("run.state.failed");
      }
    }
  }

  function refreshLocale() {
    if (!liveOutput) {
      return;
    }

    if (!liveEvents.length) {
      resetLiveFeed();
    } else {
      const events = [...liveEvents];
      liveEvents = [];
      liveOutput.innerHTML = "";
      for (const event of events) {
        appendLiveEvent(event);
      }
    }

    if (lastRunStateEvent && runState) {
      const nextText = getRunStateTextForEvent(lastRunStateEvent, translate);
      if (nextText) {
        runState.textContent = nextText;
      }
    }

    if (lastSynthesisResult && lastSynthesisTimings) {
      renderSynthesis(lastSynthesisResult, lastSynthesisTimings);
    }
  }

  function bindEvents() {
    runButton?.addEventListener("click", runCluster);
    cancelButton?.addEventListener("click", cancelClusterRun);
  }

  return {
    abortActiveRequest,
    bindEvents,
    cancelClusterRun,
    getCurrentOperationId,
    refreshLocale,
    runCluster
  };
}

import { describeOperationEvent as describeOperationEventMessage } from "./operation-events.js";

const LIVE_EVENT_LIMIT = 60;
const CANCEL_REQUEST_TIMEOUT_MS = 4000;
const CANCEL_REQUEST_MAX_ATTEMPTS = 3;

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
      "run.state.planning": "\u89c4\u5212\u4e2d",
      "run.state.research": "\u8c03\u7814\u4e2d",
      "run.state.validation": "\u9a8c\u8bc1\u4e2d",
      "run.state.handoff": "\u4ea4\u4ed8\u4e2d",
      "run.state.implementation": "\u6267\u884c\u4e2d",
      "run.state.retrying": "\u91cd\u8bd5\u4e2d {attempt}/{maxRetries}",
      "run.state.fallback": "\u5207\u6362\u5de5\u4f5c\u6a21\u578b\u4e2d",
      "run.state.controllerFallback": "\u5207\u6362\u4e3b\u63a7\u4e2d",
      "run.state.delegating": "\u5206\u914d\u4e2d",
      "run.state.subagent": "\u5b50\u4ee3\u7406\u6267\u884c\u4e2d",
      "run.state.leaderSynthesis": "\u7ec4\u957f\u6c47\u603b\u4e2d",
      "run.state.cancelling": "\u7ec8\u6b62\u4e2d...",
      "run.state.synthesizing": "\u6c47\u603b\u4e2d",
      "run.state.cancelled": "\u5df2\u7ec8\u6b62",
      "run.state.done": "\u5df2\u5b8c\u6210",
      "run.state.failed": "\u5931\u8d25",
      "run.state.needTask": "\u9700\u8981\u586b\u5199\u4efb\u52a1",
      "run.state.missingScheme": "\u7f3a\u5c11\u65b9\u6848",
      "run.state.starting": "\u542f\u52a8\u4e2d",
      "run.livePlaceholder": "\u8fd0\u884c\u540e\u4f1a\u5728\u8fd9\u91cc\u663e\u793a\u8ba1\u5212\u3001\u91cd\u8bd5\u548c\u5b8c\u6210\u72b6\u6001\u3002",
      "run.synthesis.meta": "\u603b\u8017\u65f6: {totalMs} ms",
      "run.synthesis.executiveSummary": "\u6267\u884c\u6458\u8981",
      "run.synthesis.consensus": "\u5171\u8bc6",
      "run.synthesis.disagreements": "\u5206\u6b67",
      "run.synthesis.nextActions": "\u4e0b\u4e00\u6b65",
      "run.synthesis.noFinalAnswer": "\u672a\u8fd4\u56de\u6700\u7ec8\u7ed3\u8bba\u3002",
      "run.synthesis.noExecutiveSummary": "\u672a\u63d0\u4f9b\u6267\u884c\u6458\u8981\u3002",
      "run.synthesis.noConsensus": "\u672a\u63d0\u4f9b\u5171\u8bc6\u9879\u3002",
      "run.synthesis.noDisagreements": "\u672a\u63d0\u4f9b\u5206\u6b67\u9879\u3002",
      "run.synthesis.noNextActions": "\u672a\u63d0\u4f9b\u4e0b\u4e00\u6b65\u5efa\u8bae\u3002",
      "run.cancelled.default": "\u8fd0\u884c\u5df2\u88ab\u624b\u52a8\u53d6\u6d88\u3002",
      "run.cancelled.plan": "\u4efb\u52a1\u5df2\u7ec8\u6b62\uff1a{message}",
      "run.cancelled.workers": "\u4efb\u52a1\u5df2\u7ec8\u6b62\uff0c\u5df2\u505c\u6b62\u7b49\u5f85\u5269\u4f59\u5de5\u4f5c\u6a21\u578b\u7ed3\u679c\u3002",
      "run.cancelled.synthesis": "\u4efb\u52a1\u5df2\u7ec8\u6b62\uff1a{message}",
      "run.toast.missingScheme": "\u8bf7\u5148\u914d\u7f6e\u81f3\u5c11\u4e00\u4e2a\u53ef\u8fd0\u884c\u65b9\u6848\u3002",
      "run.plan.planning": "\u4e3b\u63a7\u6a21\u578b\u6b63\u5728\u89c4\u5212...",
      "run.workers.waiting": "\u5de5\u4f5c\u6a21\u578b\u7b49\u5f85\u4efb\u52a1\u5206\u914d...",
      "run.synthesis.waiting": "\u7b49\u5f85\u4e3b\u63a7\u6a21\u578b\u6c47\u603b...",
      "run.failed.plan": "\u6267\u884c\u5931\u8d25\uff1a{error}",
      "run.failed.workers": "\u672a\u751f\u6210\u5de5\u4f5c\u6a21\u578b\u7ed3\u679c\u3002",
      "run.failed.synthesis": "\u6267\u884c\u5931\u8d25\uff1a{error}",
      "run.cancel.requestLocal": "\u5df2\u7acb\u5373\u7ec8\u6b62\u672c\u5730\u7b49\u5f85\uff0c\u6b63\u5728\u8bf7\u6c42\u540e\u7aef\u505c\u6b62\u4efb\u52a1\u3002",
      "run.cancel.renderLocal": "\u5df2\u7acb\u5373\u7ec8\u6b62\u5f53\u524d\u4efb\u52a1\uff0c\u6b63\u5728\u6e05\u7406\u8fdc\u7aef\u8bf7\u6c42\u3002",
      "run.cancel.renderRemote": "\u4efb\u52a1\u5df2\u7acb\u5373\u7ec8\u6b62\uff0c\u5e76\u5df2\u901a\u77e5\u540e\u7aef\u505c\u6b62\u5f53\u524d\u8bf7\u6c42\u3002",
      "run.cancel.renderRemoteSettled": "\u4efb\u52a1\u5df2\u7ec8\u6b62\uff0c\u540e\u7aef\u4efb\u52a1\u5df2\u505c\u6b62\u6216\u5df2\u7ed3\u675f\u3002",
      "run.cancel.renderRemoteFailed": "\u672c\u5730\u7b49\u5f85\u5df2\u505c\u6b62\uff0c\u4f46\u540e\u7aef\u53d6\u6d88\u5931\u8d25\uff0c\u8bf7\u518d\u70b9\u4e00\u6b21\u201c\u7ec8\u6b62\u4efb\u52a1\u201d\u3002",
      "run.cancel.failed": "\u7ec8\u6b62\u4efb\u52a1\u5931\u8d25\uff1a{error}"
    },
    "en-US": {
      "run.state.planning": "Planning",
      "run.state.research": "Researching",
      "run.state.validation": "Validating",
      "run.state.handoff": "Handing Off",
      "run.state.implementation": "Executing",
      "run.state.retrying": "Retrying {attempt}/{maxRetries}",
      "run.state.fallback": "Switching Worker",
      "run.state.controllerFallback": "Switching Controller",
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
      "run.cancel.renderRemoteSettled": "The task was cancelled and the backend run was already stopped or already finished.",
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
      return translate("run.state.retrying", {
        attempt: event.attempt,
        maxRetries: event.maxRetries,
        nextDelayMs: event.nextDelayMs
      });
    case "worker_fallback":
      return translate("run.state.fallback");
    case "controller_fallback":
      return translate("run.state.controllerFallback");
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
  getLocale = () => resolveRuntimeLocale(),
  captureCurrentSchemeDraft,
  openOperationStream,
  createOperationId,
  multiAgentUi,
  onOperationEvent = null,
  onOperationStart = null,
  onOperationFinish = null,
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
    try {
      onOperationStart?.(operationId);
    } catch {
      // Ignore auxiliary UI callback failures.
    }
  }

  function finishOperation(options = {}) {
    const closeDelayMs = Math.max(
      0,
      Number.isFinite(Number(options.closeDelayMs)) ? Number(options.closeDelayMs) : 300
    );
    const finishedOperationId = currentOperationId;
    currentOperationId = "";
    if (cancelButton) {
      cancelButton.disabled = true;
    }
    agentVizUi.stopRunTimer();
    try {
      onOperationFinish?.(finishedOperationId);
    } catch {
      // Ignore auxiliary UI callback failures.
    }
    if (currentOperationStream) {
      const stream = currentOperationStream;
      currentOperationStream = null;
      if (closeDelayMs === 0) {
        stream.close();
      } else {
        setTimeout(() => stream.close(), closeDelayMs);
      }
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

  async function requestOperationCancellation(
    operationId,
    {
      maxAttempts = CANCEL_REQUEST_MAX_ATTEMPTS,
      timeoutMs = CANCEL_REQUEST_TIMEOUT_MS
    } = {}
  ) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requestController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        requestController.abort(new Error("Cancel request timed out."));
      }, timeoutMs);

      try {
        const response = await fetch(`/api/operations/${encodeURIComponent(operationId)}/cancel`, {
          method: "POST",
          signal: requestController.signal
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) {
          const error = new Error(payload.error || `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return payload;
      } catch (error) {
        if (error?.status === 404 || error?.status === 409) {
          return {
            ok: true,
            operationId,
            alreadyStopped: true
          };
        }
        lastError = error;
        const isTimeout =
          error?.name === "AbortError" || error?.message === "Cancel request timed out.";
        if ((!isTimeout && error?.status !== 404) || attempt === maxAttempts) {
          throw error;
        }
        await sleep(120 * attempt);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw lastError || new Error("Cancel request failed.");
  }

  async function finalizeRemoteCancellation(operationId) {
    const canReportStatus = () => !currentOperationId || currentOperationId === operationId;

    try {
      const payload = await requestOperationCancellation(operationId);
      if (canReportStatus()) {
        setSaveStatus?.(
          translate(
            payload?.alreadyStopped
              ? "run.cancel.renderRemoteSettled"
              : "run.cancel.renderRemote"
          ),
          "ok"
        );
      }
    } catch (error) {
      if (canReportStatus()) {
        setSaveStatus?.(translate("run.cancel.renderRemoteFailed"), "warning");
      }
      if (!currentOperationId) {
        appendLiveEvent({
          timestamp: new Date().toISOString(),
          tone: "warning",
          stage: "cluster_failed",
          detail: translate("run.cancel.failed", { error: error.message })
        });
      }
    }
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
        describeOperationEventMessage(event, { formatDelay })
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
    multiAgentUi?.updateFromEvent?.(event);
    try {
      onOperationEvent?.(event, currentOperationId);
    } catch {
      // Ignore auxiliary UI callback failures.
    }
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
    multiAgentUi?.resetChatroom?.();
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
        body: JSON.stringify({
          task,
          operationId,
          schemeId: currentScheme.id,
          locale: typeof getLocale === "function" ? getLocale() : resolveRuntimeLocale()
        }),
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
      if (payload.multiAgentSession) {
        multiAgentUi?.applySession?.(payload.multiAgentSession);
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
        finishOperation({ closeDelayMs: 300 });
      }
    }
  }

  async function cancelClusterRun() {
    if (!currentOperationId) {
      return;
    }
    const operationId = currentOperationId;

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
    handleOperationEvent({
      timestamp: new Date().toISOString(),
      tone: "warning",
      stage: "cluster_cancelled",
      detail: translate("run.cancel.renderLocal"),
      ...agentVizUi.resolveControllerEventMeta()
    });
    renderClusterCancelledState(translate("run.cancel.renderLocal"));
    if (runButton) {
      runButton.disabled = false;
    }
    finishOperation({ closeDelayMs: 0 });
    void finalizeRemoteCancellation(operationId);
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

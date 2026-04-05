import { createCatalogTranslator } from "./i18n-core.js";

const OPERATION_EVENT_CATALOG = {
  "zh-CN": {
    "label.controller": "主控 Agent",
    "label.leader": "组长 Agent",
    "label.subordinate": "子 Agent",
    "label.task": "任务",
    "fallback.unknownError": "未知错误",
    "fallback.toolBlocked": "当前任务不允许使用该工具。",
    "fallback.memoryRead": "已完成记忆召回。",
    "fallback.memoryWrite": "已写入新的会话记忆。",
    "fallback.circuitOpened": "连续失败已达到阈值。",
    "fallback.clusterCancelled": "本次运行已被手动取消。",
    "phase.research": "调研",
    "phase.implementation": "实现",
    "phase.validation": "验证",
    "phase.handoff": "交付",
    "event.submitted": "请求已提交，等待后端处理。",
    "event.modelTestRetry": "模型 {actor} 正在重试，第 {attempt}/{maxRetries} 次，{nextDelay} 后再次请求。",
    "event.modelTestDone": "模型通联测试已完成。",
    "event.modelTestFailed": "模型通联测试失败：{detail}",
    "event.planningStart": "{actor} 正在规划任务。",
    "event.planningDone": "主控已完成规划，共拆分 {taskCount} 个子任务。",
    "event.planningRetry": "{actor} 正在重试规划，第 {attempt}/{maxRetries} 次，{nextDelay} 后再次请求。",
    "event.controllerFallback": "{actor} 在 provider 故障后已从 {previousController} 切换到 {fallbackController}。",
    "event.cancelRequested": "已请求取消，正在停止当前运行。",
    "event.phaseStart": "进入 {phase} 阶段。",
    "event.phaseDone": "已完成 {phase} 阶段。",
    "event.workerStart": "{actor} 已开始：{taskTitle}",
    "event.workerDone": "{actor} 已完成：{taskTitle}",
    "event.workspaceList": "{actor} 已查看工作区路径：{detail}",
    "event.workspaceRead": "{actor} 已读取文件：{detail}",
    "event.workspaceWrite": "{actor} 已写入文件：{detail}",
    "event.workspaceWebSearch": "{actor} 已完成网页搜索：{detail}",
    "event.workspaceCommand": "{actor} 已执行命令：{detail}（退出码 {exitCode}）",
    "event.workspaceJsonRepair": "{actor} 已自动修复无效的 workspace JSON 响应。",
    "event.workspaceToolBlocked.webSearch": "{actor} 的工具调用被限制：当前任务不允许网页搜索。",
    "event.workspaceToolBlocked.runCommand": "{actor} 的工具调用被限制：当前任务不允许执行工作区命令。",
    "event.workspaceToolBlocked.writeFiles": "{actor} 的工具调用被限制：当前任务不允许写入工作区文件。",
    "event.workspaceToolBlocked.default": "{actor} 的工具调用被限制：{detail}",
    "event.memoryRead": "{actor} 已召回会话记忆：{detail}",
    "event.memoryWrite": "{actor} 已写入会话记忆：{detail}",
    "event.circuitOpened": "{actor} 的熔断器已打开：{detail}",
    "event.circuitClosed": "{actor} 的熔断器已关闭。",
    "event.circuitHalfOpen": "{actor} 的熔断器已进入半开状态。",
    "event.circuitBlocked": "{actor} 当前被熔断器阻止。",
    "event.workerRetry": "{actor} 正在重试，第 {attempt}/{maxRetries} 次，{nextDelay} 后再次请求。",
    "event.workerFallback": "{actor} 在 provider 故障后已从 {previousWorker} 切换到 {fallbackWorker}。",
    "event.workerFailed": "{actor} 执行失败：{detail}",
    "event.leaderDelegateStart": "{actor} 正在规划下属分工。",
    "event.leaderDelegateDone": "{actor} 已完成下属分工。",
    "event.leaderDelegateRetry": "{actor} 正在重试分工规划，第 {attempt}/{maxRetries} 次。",
    "event.subagentCreated": "已创建 {actor}：{taskTitle}",
    "event.subagentStart": "{actor} 已开始：{taskTitle}",
    "event.subagentDone": "{actor} 已完成：{taskTitle}",
    "event.subagentRetry": "{actor} 正在重试，第 {attempt}/{maxRetries} 次，{nextDelay} 后再次请求。",
    "event.subagentFailed": "{actor} 执行失败：{detail}",
    "event.leaderSynthesisStart": "{actor} 正在汇总并合并下属结果。",
    "event.leaderSynthesisRetry": "{actor} 正在重试汇总，第 {attempt}/{maxRetries} 次。",
    "event.validationGateFailed": "验证阶段未通过。",
    "event.synthesisStart": "{actor} 正在汇总最终答案。",
    "event.synthesisRetry": "{actor} 正在重试汇总，第 {attempt}/{maxRetries} 次，{nextDelay} 后再次请求。",
    "event.clusterDone": "集群运行完成，总耗时 {totalMs} ms。",
    "event.clusterCancelled": "集群运行已取消：{detail}",
    "event.clusterFailed": "集群运行失败：{detail}",
    "event.default": "收到新的运行时事件。"
  },
  "en-US": {
    "label.controller": "Controller agent",
    "label.leader": "Leader agent",
    "label.subordinate": "Sub-agent",
    "label.task": "task",
    "fallback.unknownError": "unknown error",
    "fallback.toolBlocked": "This tool is not allowed for the current task.",
    "fallback.memoryRead": "Memory recall completed.",
    "fallback.memoryWrite": "Stored new session memory.",
    "fallback.circuitOpened": "Repeated failures reached the threshold.",
    "fallback.clusterCancelled": "The run was cancelled manually.",
    "event.submitted": "Request submitted. Waiting for the backend to process it.",
    "event.modelTestRetry": "Model {actor} retrying, attempt {attempt}/{maxRetries}. Next request in {nextDelay}.",
    "event.modelTestDone": "Model connectivity test completed.",
    "event.modelTestFailed": "Model connectivity test failed: {detail}",
    "event.planningStart": "{actor} is planning the task.",
    "event.planningDone": "The controller finished planning with {taskCount} subtasks.",
    "event.planningRetry": "{actor} retrying, attempt {attempt}/{maxRetries}. Next request in {nextDelay}.",
    "event.controllerFallback": "{actor} switched from {previousController} to {fallbackController} after a provider failure.",
    "event.cancelRequested": "Cancellation requested. Stopping the current run.",
    "event.phaseStart": "Entering the {phase} phase.",
    "event.phaseDone": "Completed the {phase} phase.",
    "event.workerStart": "{actor} started: {taskTitle}",
    "event.workerDone": "{actor} completed: {taskTitle}",
    "event.workspaceList": "{actor} listed the workspace path: {detail}",
    "event.workspaceRead": "{actor} read files: {detail}",
    "event.workspaceWrite": "{actor} wrote files: {detail}",
    "event.workspaceWebSearch": "{actor} ran a web search: {detail}",
    "event.workspaceCommand": "{actor} ran a command: {detail} (exit code {exitCode})",
    "event.workspaceJsonRepair": "{actor} repaired an invalid workspace JSON response automatically.",
    "event.workspaceToolBlocked.webSearch": "{actor} had a tool call blocked: web search is out of scope for this task.",
    "event.workspaceToolBlocked.runCommand": "{actor} had a tool call blocked: workspace commands are out of scope for this task.",
    "event.workspaceToolBlocked.writeFiles": "{actor} had a tool call blocked: workspace writes are out of scope for this task.",
    "event.workspaceToolBlocked.default": "{actor} had a tool call blocked: {detail}",
    "event.memoryRead": "{actor} recalled session memory: {detail}",
    "event.memoryWrite": "{actor} stored session memory: {detail}",
    "event.circuitOpened": "The circuit breaker for {actor} opened: {detail}",
    "event.circuitClosed": "The circuit breaker for {actor} closed again.",
    "event.circuitHalfOpen": "The circuit breaker for {actor} is now half-open.",
    "event.circuitBlocked": "{actor} is currently blocked by the circuit breaker.",
    "event.workerRetry": "{actor} retrying, attempt {attempt}/{maxRetries}. Next request in {nextDelay}.",
    "event.workerFallback": "{actor} switched from {previousWorker} to {fallbackWorker} after a provider failure.",
    "event.workerFailed": "{actor} failed: {detail}",
    "event.leaderDelegateStart": "{actor} is planning subordinate assignments.",
    "event.leaderDelegateDone": "{actor} finished assigning subordinate tasks.",
    "event.leaderDelegateRetry": "{actor} is retrying delegation planning, attempt {attempt}/{maxRetries}.",
    "event.subagentCreated": "Created {actor}: {taskTitle}",
    "event.subagentStart": "{actor} started: {taskTitle}",
    "event.subagentDone": "{actor} completed: {taskTitle}",
    "event.subagentRetry": "{actor} retrying, attempt {attempt}/{maxRetries}. Next request in {nextDelay}.",
    "event.subagentFailed": "{actor} failed: {detail}",
    "event.leaderSynthesisStart": "{actor} is collecting and merging subordinate results.",
    "event.leaderSynthesisRetry": "{actor} is retrying synthesis, attempt {attempt}/{maxRetries}.",
    "event.validationGateFailed": "Validation phase reported failures.",
    "event.synthesisStart": "{actor} is synthesizing the final answer.",
    "event.synthesisRetry": "{actor} retrying, attempt {attempt}/{maxRetries}. Next request in {nextDelay}.",
    "event.clusterDone": "Cluster run completed in {totalMs} ms.",
    "event.clusterCancelled": "Run cancelled: {detail}",
    "event.clusterFailed": "Cluster run failed: {detail}",
    "event.default": "Received a new runtime event."
  }
};

export function createOperationEventTranslator(locale = "") {
  const normalizedLocale = String(locale || "").trim() === "en-US" ? "en-US" : "zh-CN";
  return createCatalogTranslator(OPERATION_EVENT_CATALOG, {
    fallbackLocale: "zh-CN",
    resolveLocale: () => normalizedLocale
  });
}

const translateOperationEvent = createOperationEventTranslator();

function resolveLabels(translate) {
  return {
    controller: translate("label.controller"),
    leader: translate("label.leader"),
    subordinate: translate("label.subordinate"),
    task: translate("label.task"),
    unknownError: translate("fallback.unknownError"),
    toolBlocked: translate("fallback.toolBlocked"),
    memoryRead: translate("fallback.memoryRead"),
    memoryWrite: translate("fallback.memoryWrite"),
    circuitOpened: translate("fallback.circuitOpened"),
    clusterCancelled: translate("fallback.clusterCancelled")
  };
}

function resolvePhaseLabel(phase, translate) {
  const normalized = String(phase || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const key = `phase.${normalized}`;
  const translated = translate(key);
  return translated === key ? phase : translated;
}

function describeWorkspaceToolBlocked(event, actor, translate) {
  const toolAction = String(event.toolAction || "").trim().toLowerCase();
  const detail = String(event.detail || "").trim();
  if (toolAction === "web_search" || /\bweb_search\b/i.test(detail)) {
    return translate("event.workspaceToolBlocked.webSearch", { actor });
  }
  if (toolAction === "run_command" || /\brun_command\b/i.test(detail)) {
    return translate("event.workspaceToolBlocked.runCommand", { actor });
  }
  if (
    toolAction === "write_docx" ||
    toolAction === "write_files" ||
    /\bwrite_docx\b/i.test(detail) ||
    /\bwrite_files\b/i.test(detail)
  ) {
    return translate("event.workspaceToolBlocked.writeFiles", { actor });
  }
  return translate("event.workspaceToolBlocked.default", {
    actor,
    detail: detail || translate("fallback.toolBlocked")
  });
}

function localizeOperationText(locale, englishText, chineseText) {
  return String(locale || "").trim() === "en-US" ? englishText : chineseText;
}

function unwrapSessionMemoryDetail(detail = "") {
  const normalized = String(detail || "").trim();
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/^(?:Stored session memory|已写入会话记忆)[：:]\s*(.+)$/i);
  return match ? String(match[1] || "").trim() : normalized;
}

export function describeOperationEvent(
  event,
  {
    formatDelay = (value) => `${value ?? 0} ms`,
    translate = translateOperationEvent,
    locale = ""
  } = {}
) {
  const resolvedLocale = String(locale || "").trim() === "en-US" ? "en-US" : "zh-CN";
  const resolvedTranslate =
    translate === translateOperationEvent && locale ? createOperationEventTranslator(locale) : translate;
  const actor = event.agentLabel || event.modelLabel || event.modelId || "";
  const labels = resolveLabels(resolvedTranslate);

  switch (event.stage) {
    case "submitted":
      return resolvedTranslate("event.submitted");
    case "model_test_retry":
      return resolvedTranslate("event.modelTestRetry", {
        actor: event.modelId || "",
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0,
        nextDelay: formatDelay(event.nextDelayMs)
      });
    case "model_test_done":
      return resolvedTranslate("event.modelTestDone");
    case "model_test_failed":
      return resolvedTranslate("event.modelTestFailed", {
        detail: event.detail || labels.unknownError
      });
    case "planning_start":
      return resolvedTranslate("event.planningStart", {
        actor: actor || labels.controller
      });
    case "planning_done":
      return resolvedTranslate("event.planningDone", {
        taskCount: event.taskCount ?? 0
      });
    case "planning_retry":
      return resolvedTranslate("event.planningRetry", {
        actor: actor || labels.controller,
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0,
        nextDelay: formatDelay(event.nextDelayMs)
      });
    case "controller_fallback":
      return resolvedTranslate("event.controllerFallback", {
        actor: actor || labels.controller,
        previousController:
          event.previousControllerLabel || event.previousControllerId || labels.controller,
        fallbackController:
          event.fallbackControllerLabel || event.fallbackControllerId || labels.controller
      });
    case "cancel_requested":
      return event.detail || resolvedTranslate("event.cancelRequested");
    case "phase_start":
      return resolvedTranslate("event.phaseStart", {
        phase: resolvePhaseLabel(event.phase, resolvedTranslate)
      });
    case "phase_done":
      return resolvedTranslate("event.phaseDone", {
        phase: resolvePhaseLabel(event.phase, resolvedTranslate)
      });
    case "worker_start":
      return resolvedTranslate("event.workerStart", {
        actor: actor || labels.leader,
        taskTitle: event.taskTitle || event.taskId || labels.task
      });
    case "worker_done":
      return resolvedTranslate("event.workerDone", {
        actor: actor || labels.leader,
        taskTitle: event.taskTitle || event.taskId || labels.task
      });
    case "workspace_list":
      return resolvedTranslate("event.workspaceList", {
        actor: actor || labels.leader,
        detail: event.detail || ""
      });
    case "workspace_read":
      return resolvedTranslate("event.workspaceRead", {
        actor: actor || labels.leader,
        detail: event.detail || ""
      });
    case "workspace_write":
      return resolvedTranslate("event.workspaceWrite", {
        actor: actor || labels.leader,
        detail: (event.generatedFiles || []).join(", ") || event.detail || ""
      });
    case "workspace_web_search":
      return resolvedTranslate("event.workspaceWebSearch", {
        actor: actor || labels.leader,
        detail: event.detail || ""
      });
    case "workspace_command":
      return resolvedTranslate("event.workspaceCommand", {
        actor: actor || labels.leader,
        detail: event.detail || "",
        exitCode: event.exitCode ?? "n/a"
      });
    case "workspace_json_repair":
      return resolvedTranslate("event.workspaceJsonRepair", {
        actor: actor || labels.leader
      });
    case "workspace_tool_blocked":
      return describeWorkspaceToolBlocked(event, actor || labels.leader, resolvedTranslate);
    case "memory_read":
      return resolvedTranslate("event.memoryRead", {
        actor: actor || labels.leader,
        detail: event.detail || labels.memoryRead
      });
    case "memory_write":
      return resolvedTranslate("event.memoryWrite", {
        actor: actor || labels.leader,
        detail: unwrapSessionMemoryDetail(event.detail || labels.memoryWrite)
      });
    case "workspace_cleanup":
      return (
        event.detail ||
        localizeOperationText(
          resolvedLocale,
          `Removed ${(event.removedFiles || []).length} intermediate workspace file(s) and kept ${(event.keptFiles || []).length} final deliverable artifact(s).`,
          `已删除 ${(event.removedFiles || []).length} 个中间工作区文件，并保留 ${(event.keptFiles || []).length} 个最终交付产物。`
        )
      );
    case "circuit_opened":
      return resolvedTranslate("event.circuitOpened", {
        actor: event.modelLabel || event.modelId || actor,
        detail: event.detail || labels.circuitOpened
      });
    case "circuit_closed":
      return resolvedTranslate("event.circuitClosed", {
        actor: event.modelLabel || event.modelId || actor
      });
    case "circuit_half_open":
      return resolvedTranslate("event.circuitHalfOpen", {
        actor: event.modelLabel || event.modelId || actor
      });
    case "circuit_blocked":
      return resolvedTranslate("event.circuitBlocked", {
        actor: event.modelLabel || event.modelId || actor
      });
    case "worker_retry":
      return resolvedTranslate("event.workerRetry", {
        actor: actor || labels.leader,
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0,
        nextDelay: formatDelay(event.nextDelayMs)
      });
    case "worker_fallback":
      return resolvedTranslate("event.workerFallback", {
        actor: actor || labels.leader,
        previousWorker: event.previousWorkerLabel || event.previousWorkerId || labels.leader,
        fallbackWorker: event.fallbackWorkerLabel || event.fallbackWorkerId || labels.leader
      });
    case "worker_failed":
      return resolvedTranslate("event.workerFailed", {
        actor: actor || labels.leader,
        detail: event.detail || labels.unknownError
      });
    case "leader_delegate_start":
      return resolvedTranslate("event.leaderDelegateStart", {
        actor: actor || labels.leader
      });
    case "leader_delegate_done":
      return resolvedTranslate("event.leaderDelegateDone", {
        actor: actor || labels.leader
      });
    case "leader_delegate_retry":
      return resolvedTranslate("event.leaderDelegateRetry", {
        actor: actor || labels.leader,
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0
      });
    case "subagent_created":
      return resolvedTranslate("event.subagentCreated", {
        actor: actor || labels.subordinate,
        taskTitle: event.taskTitle || event.detail || labels.task
      });
    case "subagent_start":
      return resolvedTranslate("event.subagentStart", {
        actor: actor || labels.subordinate,
        taskTitle: event.taskTitle || event.taskId || labels.task
      });
    case "subagent_done":
      return resolvedTranslate("event.subagentDone", {
        actor: actor || labels.subordinate,
        taskTitle: event.taskTitle || event.taskId || labels.task
      });
    case "subagent_retry":
      return resolvedTranslate("event.subagentRetry", {
        actor: actor || labels.subordinate,
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0,
        nextDelay: formatDelay(event.nextDelayMs)
      });
    case "subagent_failed":
      return resolvedTranslate("event.subagentFailed", {
        actor: actor || labels.subordinate,
        detail: event.detail || labels.unknownError
      });
    case "leader_synthesis_start":
      return resolvedTranslate("event.leaderSynthesisStart", {
        actor: actor || labels.leader
      });
    case "leader_synthesis_retry":
      return resolvedTranslate("event.leaderSynthesisRetry", {
        actor: actor || labels.leader,
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0
      });
    case "validation_gate_failed":
      return resolvedTranslate("event.validationGateFailed");
    case "synthesis_start":
      return resolvedTranslate("event.synthesisStart", {
        actor: actor || labels.controller
      });
    case "synthesis_retry":
      return resolvedTranslate("event.synthesisRetry", {
        actor: actor || labels.controller,
        attempt: event.attempt ?? 0,
        maxRetries: event.maxRetries ?? 0,
        nextDelay: formatDelay(event.nextDelayMs)
      });
    case "cluster_done":
      return resolvedTranslate("event.clusterDone", {
        totalMs: event.totalMs ?? "n/a"
      });
    case "cluster_cancelled":
      return resolvedTranslate("event.clusterCancelled", {
        detail: event.detail || labels.clusterCancelled
      });
    case "cluster_failed":
      return resolvedTranslate("event.clusterFailed", {
        detail: event.detail || labels.unknownError
      });
    case "run_log_saved":
      return localizeOperationText(
        resolvedLocale,
        `Run log saved: ${event.logPath || ""}`,
        `本次任务日志已保存：${event.logPath || ""}`
      );
    case "run_log_save_failed":
      return (
        event.detail ||
        localizeOperationText(
          resolvedLocale,
          `Run finished, but saving the log failed: ${event.error || ""}`,
          `任务已结束，但保存日志失败：${event.error || ""}`
        )
      );
    default:
      if (event.detail) {
        return event.detail;
      }
      if (event.message) {
        return event.message;
      }
      return resolvedTranslate("event.default");
  }
}

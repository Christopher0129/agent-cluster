export function describeOperationEvent(event, { formatDelay }) {
  const actor = event.agentLabel || event.modelLabel || event.modelId || "";
  switch (event.stage) {
    case "submitted":
      return "请求已提交，等待后端处理。";
    case "model_test_retry":
      return `模型 ${event.modelId || ""} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "model_test_done":
      return "模型连通性测试完成。";
    case "model_test_failed":
      return `模型连通性测试失败：${event.detail || "未知错误"}`;
    case "planning_start":
      return `主控 Agent ${actor} 正在拆解任务。`;
    case "planning_done":
      return `主控 Agent 已生成计划，共 ${event.taskCount ?? 0} 个子任务。`;
    case "planning_retry":
      return `主控 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "cancel_requested":
      return event.detail || "已收到终止任务请求，正在停止运行。";
    case "phase_start":
      return `进入 ${event.phase || ""} 阶段。`;
    case "phase_done":
      return `已完成 ${event.phase || ""} 阶段。`;
    case "worker_start":
      return `组长 Agent ${actor} 开始执行：${event.taskTitle || event.taskId || "子任务"}`;
    case "worker_done":
      return `组长 Agent ${actor} 已完成：${event.taskTitle || event.taskId || "子任务"}`;
    case "workspace_list":
      return `${actor} 已查看目录：${event.detail || ""}`;
    case "workspace_read":
      return `${actor} 已读取文件：${event.detail || ""}`;
    case "workspace_write":
      return `${actor} 已写入文件：${(event.generatedFiles || []).join(", ") || event.detail || ""}`;
    case "workspace_command":
      return `${actor} 已执行命令：${event.detail || ""}，退出码 ${event.exitCode ?? "n/a"}`;
    case "workspace_json_repair":
      return `${actor} 正在修复无效的 workspace JSON 响应。`;
    case "memory_read":
      return `${actor} 读取了会话记忆：${event.detail || "已完成记忆检索。"}`;
    case "memory_write":
      return `${actor} 写入了会话记忆：${event.detail || "已记录新的会话信息。"}`;
    case "circuit_opened":
      return `${event.modelLabel || event.modelId || actor} 的熔断器已打开：${event.detail || "连续失败达到阈值。"}`;
    case "circuit_closed":
      return `${event.modelLabel || event.modelId || actor} 的熔断器已恢复关闭。`;
    case "circuit_half_open":
      return `${event.modelLabel || event.modelId || actor} 的熔断器进入半开探测状态。`;
    case "circuit_blocked":
      return `${event.modelLabel || event.modelId || actor} 当前被熔断器阻止调用。`;
    case "worker_retry":
      return `组长 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "worker_failed":
      return `组长 Agent ${actor} 执行失败：${event.detail || "未知错误"}`;
    case "leader_delegate_start":
      return `组长 Agent ${actor} 正在思考如何分配下属任务。`;
    case "leader_delegate_done":
      return `组长 Agent ${actor} 已完成下属任务分配。`;
    case "leader_delegate_retry":
      return `组长 Agent ${actor} 的分配方案正在重试，第 ${event.attempt}/${event.maxRetries} 次。`;
    case "subagent_created":
      return `已创建下属 Agent ${actor}：${event.taskTitle || event.detail || "等待执行"}`;
    case "subagent_start":
      return `下属 Agent ${actor} 开始执行：${event.taskTitle || event.taskId || "子任务"}`;
    case "subagent_done":
      return `下属 Agent ${actor} 已完成：${event.taskTitle || event.taskId || "子任务"}`;
    case "subagent_retry":
      return `下属 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "subagent_failed":
      return `下属 Agent ${actor} 执行失败：${event.detail || "未知错误"}`;
    case "leader_synthesis_start":
      return `组长 Agent ${actor} 正在回收并汇总下属结果。`;
    case "leader_synthesis_retry":
      return `组长 Agent ${actor} 的汇总过程正在重试，第 ${event.attempt}/${event.maxRetries} 次。`;
    case "validation_gate_failed":
      return event.detail || "验证阶段未通过。";
    case "synthesis_start":
      return `主控 Agent ${actor} 正在汇总结论。`;
    case "synthesis_retry":
      return `主控 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "cluster_done":
      return `集群运行完成，总耗时 ${event.totalMs ?? "n/a"} ms。`;
    case "cluster_cancelled":
      return `任务已终止：${event.detail || "运行已被手动取消。"}`;
    case "cluster_failed":
      return `集群运行失败：${event.detail || "未知错误"}`;
    default:
      if (event.detail) {
        return event.detail;
      }
      if (event.message) {
        return event.message;
      }
      return "收到新的运行事件。";
  }
}

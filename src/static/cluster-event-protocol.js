export const CLUSTER_EVENT_STAGE = Object.freeze({
  SUBMITTED: "submitted",
  MODEL_TEST_RETRY: "model_test_retry",
  MODEL_TEST_DONE: "model_test_done",
  MODEL_TEST_FAILED: "model_test_failed",
  PLANNING_START: "planning_start",
  PLANNING_DONE: "planning_done",
  PLANNING_RETRY: "planning_retry",
  CANCEL_REQUESTED: "cancel_requested",
  PHASE_START: "phase_start",
  PHASE_DONE: "phase_done",
  WORKER_START: "worker_start",
  WORKER_DONE: "worker_done",
  WORKER_RETRY: "worker_retry",
  WORKER_FAILED: "worker_failed",
  LEADER_DELEGATE_START: "leader_delegate_start",
  LEADER_DELEGATE_DONE: "leader_delegate_done",
  LEADER_DELEGATE_RETRY: "leader_delegate_retry",
  SUBAGENT_CREATED: "subagent_created",
  SUBAGENT_START: "subagent_start",
  SUBAGENT_DONE: "subagent_done",
  SUBAGENT_RETRY: "subagent_retry",
  SUBAGENT_FAILED: "subagent_failed",
  LEADER_SYNTHESIS_START: "leader_synthesis_start",
  LEADER_SYNTHESIS_RETRY: "leader_synthesis_retry",
  VALIDATION_GATE_FAILED: "validation_gate_failed",
  SYNTHESIS_START: "synthesis_start",
  SYNTHESIS_RETRY: "synthesis_retry",
  CLUSTER_DONE: "cluster_done",
  CLUSTER_CANCELLED: "cluster_cancelled",
  CLUSTER_FAILED: "cluster_failed",
  WORKSPACE_LIST: "workspace_list",
  WORKSPACE_READ: "workspace_read",
  WORKSPACE_WRITE: "workspace_write",
  WORKSPACE_COMMAND: "workspace_command",
  WORKSPACE_JSON_REPAIR: "workspace_json_repair",
  WORKSPACE_TOOL_BLOCKED: "workspace_tool_blocked",
  MEMORY_READ: "memory_read",
  MEMORY_WRITE: "memory_write",
  CIRCUIT_OPENED: "circuit_opened",
  CIRCUIT_CLOSED: "circuit_closed",
  CIRCUIT_HALF_OPEN: "circuit_half_open",
  CIRCUIT_BLOCKED: "circuit_blocked",
  SESSION_UPDATE: "session_update"
});

export const CONTROLLER_LIFECYCLE_STAGES = Object.freeze([
  CLUSTER_EVENT_STAGE.PLANNING_START,
  CLUSTER_EVENT_STAGE.PLANNING_DONE,
  CLUSTER_EVENT_STAGE.PLANNING_RETRY,
  CLUSTER_EVENT_STAGE.SYNTHESIS_START,
  CLUSTER_EVENT_STAGE.SYNTHESIS_RETRY,
  CLUSTER_EVENT_STAGE.CLUSTER_DONE,
  CLUSTER_EVENT_STAGE.CLUSTER_FAILED,
  CLUSTER_EVENT_STAGE.CLUSTER_CANCELLED
]);

export const RETRY_EVENT_STAGES = Object.freeze([
  CLUSTER_EVENT_STAGE.MODEL_TEST_RETRY,
  CLUSTER_EVENT_STAGE.PLANNING_RETRY,
  CLUSTER_EVENT_STAGE.WORKER_RETRY,
  CLUSTER_EVENT_STAGE.LEADER_DELEGATE_RETRY,
  CLUSTER_EVENT_STAGE.SUBAGENT_RETRY,
  CLUSTER_EVENT_STAGE.LEADER_SYNTHESIS_RETRY,
  CLUSTER_EVENT_STAGE.SYNTHESIS_RETRY
]);

export const CLUSTER_PROGRESS_STAGES = Object.freeze([
  CLUSTER_EVENT_STAGE.PLANNING_START,
  CLUSTER_EVENT_STAGE.PLANNING_DONE,
  CLUSTER_EVENT_STAGE.PLANNING_RETRY,
  CLUSTER_EVENT_STAGE.WORKER_RETRY,
  CLUSTER_EVENT_STAGE.LEADER_DELEGATE_START,
  CLUSTER_EVENT_STAGE.LEADER_DELEGATE_DONE,
  CLUSTER_EVENT_STAGE.LEADER_SYNTHESIS_START,
  CLUSTER_EVENT_STAGE.LEADER_SYNTHESIS_RETRY,
  CLUSTER_EVENT_STAGE.SUBAGENT_RETRY,
  CLUSTER_EVENT_STAGE.SYNTHESIS_START,
  CLUSTER_EVENT_STAGE.SYNTHESIS_RETRY
]);

export function isControllerLifecycleStage(stage) {
  return CONTROLLER_LIFECYCLE_STAGES.includes(String(stage || "").trim());
}

export function isRetryEventStage(stage) {
  return RETRY_EVENT_STAGES.includes(String(stage || "").trim());
}

export function isClusterProgressStage(stage) {
  return CLUSTER_PROGRESS_STAGES.includes(String(stage || "").trim());
}

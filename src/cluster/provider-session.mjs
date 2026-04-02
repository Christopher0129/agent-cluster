export function buildRetryPayload({ stage, model, retry, taskId = "", taskTitle = "" }) {
  return {
    type: "retry",
    stage,
    tone: "warning",
    modelId: model.id,
    attempt: retry.attempt,
    maxRetries: retry.maxRetries,
    nextDelayMs: retry.nextDelayMs,
    status: retry.status,
    detail: retry.message,
    taskId,
    taskTitle
  };
}

export async function invokeProviderWithSession({
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
  allowEmptyText = false,
  buildAgentEventBase
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
    spanLabel: `${agent.displayLabel || agent.label || agent.id} 路 ${purpose}`
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

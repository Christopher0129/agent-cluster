import { createProviderRegistry } from "../providers/factory.mjs";
import { testModelConnectivity } from "../providers/connectivity-test.mjs";
import { runClusterAnalysis } from "../cluster/orchestrator.mjs";
import { loadRuntimeConfig } from "../config.mjs";
import { isAbortError } from "../utils/abort.mjs";
import { readRequestBody, resolveOperationId, sendJson } from "./common.mjs";

export async function executeClusterOperation({
  task,
  operationId,
  schemeId = "",
  projectDir,
  runtimeConfigOptions,
  operationTracker
}) {
  try {
    operationTracker.ensureOperation(operationId, { kind: "cluster_run" });
    operationTracker.publish(operationId, {
      type: "status",
      stage: "submitted",
      tone: "neutral"
    });

    const config = loadRuntimeConfig(projectDir, {
      ...runtimeConfigOptions,
      ...(schemeId ? { schemeId } : {})
    });
    const providers = createProviderRegistry(config);
    return await runClusterAnalysis({
      task,
      config,
      signal: operationTracker.getSignal(operationId),
      providerRegistry: providers,
      onEvent(event) {
        operationTracker.publish(operationId, event);
      }
    });
  } catch (error) {
    if (isAbortError(error)) {
      operationTracker.publish(operationId, {
        type: "cancelled",
        stage: "cluster_cancelled",
        tone: "warning",
        detail: error.message
      });
      throw error;
    }

    operationTracker.publish(operationId, {
      type: "error",
      stage: "cluster_failed",
      tone: "error",
      detail: error.message
    });
    throw error;
  }
}

export async function handleClusterRun(
  request,
  response,
  projectDir,
  runtimeConfigOptions,
  operationTracker,
  randomUuid
) {
  let operationId = "";
  try {
    const body = await readRequestBody(request);
    operationId = resolveOperationId(body, "cluster", randomUuid);
    const task = String(body?.task || "").trim();
    const schemeId = String(body?.schemeId || "").trim();
    if (!task) {
      sendJson(response, 400, {
        ok: false,
        operationId,
        error: "Request body must include a non-empty task string."
      });
      return;
    }

    const result = await executeClusterOperation({
      task,
      operationId,
      schemeId,
      projectDir,
      runtimeConfigOptions,
      operationTracker
    });

    sendJson(response, 200, {
      ok: true,
      operationId,
      ...result
    });
  } catch (error) {
    if (operationId && isAbortError(error)) {
      sendJson(response, 200, {
        ok: false,
        cancelled: true,
        operationId,
        error: error.message
      });
      return;
    }

    sendJson(response, 500, {
      ok: false,
      operationId,
      error: error.message
    });
  }
}

export async function handleOperationCancel(response, operationId, operationTracker) {
  const result = operationTracker.cancel(operationId, {
    detail: "User requested task cancellation.",
    message: "Operation cancelled by user."
  });

  if (!result.ok && result.code === "not_found") {
    sendJson(response, 404, {
      ok: false,
      operationId,
      error: "Operation not found."
    });
    return;
  }

  if (!result.ok && result.code === "already_finished") {
    sendJson(response, 409, {
      ok: false,
      operationId,
      error: "Operation has already finished."
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    operationId,
    cancellationRequested: true,
    alreadyRequested: Boolean(result.alreadyRequested)
  });
}

export async function handleModelTest(request, response, operationTracker, randomUuid) {
  let operationId = "";
  try {
    const body = await readRequestBody(request);
    operationId = resolveOperationId(body, "model_test", randomUuid);
    operationTracker.ensureOperation(operationId, { kind: "model_test" });
    operationTracker.publish(operationId, {
      type: "status",
      stage: "submitted",
      tone: "neutral"
    });
    const result = await testModelConnectivity(body, {
      onRetry(retry) {
        operationTracker.publish(operationId, {
          type: "retry",
          stage: "model_test_retry",
          tone: "warning",
          modelId: retry.modelId,
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          nextDelayMs: retry.nextDelayMs,
          status: retry.status,
          detail: retry.message
        });
      }
    });
    operationTracker.publish(operationId, {
      type: "complete",
      stage: "model_test_done",
      tone: "ok",
      modelId: result.model.id
    });
    sendJson(response, 200, {
      operationId,
      ...result
    });
  } catch (error) {
    if (operationId) {
      operationTracker.publish(operationId, {
        type: "error",
        stage: "model_test_failed",
        tone: "error",
        detail: error.message
      });
    }
    sendJson(response, 400, {
      ok: false,
      operationId,
      error: error.message
    });
  }
}

export async function handleOperationSnapshot(response, url, operationId, operationTracker) {
  const afterSeq = Math.max(0, Number(url.searchParams.get("afterSeq") || 0));
  const snapshot = operationTracker.getSnapshot(decodeURIComponent(operationId), {
    afterSeq
  });

  if (!snapshot) {
    sendJson(response, 404, {
      ok: false,
      error: "Operation not found."
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    ...snapshot
  });
}

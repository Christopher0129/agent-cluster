import { resolve } from "node:path";
import { createProviderRegistry } from "../providers/factory.mjs";
import { testModelConnectivity } from "../providers/connectivity-test.mjs";
import { runClusterAnalysis } from "../cluster/orchestrator.mjs";
import { loadRuntimeConfig, summarizeConfig } from "../config.mjs";
import { writeClusterRunLog } from "../run-log-store.mjs";
import { isAbortError } from "../utils/abort.mjs";
import { readRequestBody, resolveOperationId, sendJson } from "./common.mjs";

function normalizeRunLocale(value) {
  return String(value || "").trim() === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeRunText(locale, englishText, chineseText) {
  return normalizeRunLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function resolveLogWorkspaceDir(projectDir, runtimeConfigOptions, schemeId = "", config = null) {
  if (config?.workspace?.resolvedDir) {
    return config.workspace.resolvedDir;
  }

  try {
    return loadRuntimeConfig(projectDir, {
      ...runtimeConfigOptions,
      ...(schemeId ? { schemeId } : {})
    }).workspace.resolvedDir;
  } catch {
    return resolve(projectDir, "workspace");
  }
}

async function persistClusterOperationLog({
  task,
  operationId,
  schemeId,
  locale = "en-US",
  projectDir,
  runtimeConfigOptions,
  operationTracker,
  config = null,
  status,
  result = null,
  error = null
}) {
  const workspaceDir = resolveLogWorkspaceDir(projectDir, runtimeConfigOptions, schemeId, config);
  const snapshot = operationTracker.getSnapshot(operationId, { afterSeq: 0 });
  const payload = {
    version: 1,
    kind: "cluster_run_log",
    operationId,
    status,
    savedAt: new Date().toISOString(),
    task,
    schemeId,
    locale: normalizeRunLocale(locale),
    workspace: {
      dir: config?.workspace?.dir || "./workspace",
      resolvedDir: workspaceDir
    },
    configSummary: config ? summarizeConfig(config) : null,
    operation: snapshot,
    result,
    error: error
      ? {
          message: error.message,
          stack: String(error.stack || "")
        }
      : null
  };

  try {
    const written = await writeClusterRunLog(projectDir, operationId, payload);
    operationTracker.publish(operationId, {
      type: "status",
      stage: "run_log_saved",
      tone: "ok",
      detail: `鏈浠诲姟鏃ュ織宸蹭繚瀛橈細${written.textPath}`,
      logPath: written.textPath,
      jsonPath: written.jsonPath
    });
    return written;
  } catch (logError) {
    operationTracker.publish(operationId, {
      type: "status",
      stage: "run_log_save_failed",
      tone: "warning",
      detail: `浠诲姟宸茬粨鏉燂紝浣嗕繚瀛樻棩蹇楀け璐ワ細${logError.message}`
    });
    return null;
  }
}

export async function executeClusterOperation({
  task,
  operationId,
  schemeId = "",
  locale = "en-US",
  projectDir,
  runtimeConfigOptions,
  operationTracker
}) {
  const outputLocale = normalizeRunLocale(locale);
  let config = null;
  try {
    operationTracker.ensureOperation(operationId, {
      kind: "cluster_run",
      task,
      schemeId,
      locale: outputLocale
    });
    operationTracker.publish(operationId, {
      type: "status",
      stage: "submitted",
      tone: "neutral"
    });

    config = loadRuntimeConfig(projectDir, {
      ...runtimeConfigOptions,
      ...(schemeId ? { schemeId } : {})
    });
    const providers = createProviderRegistry(config);
    const result = await runClusterAnalysis({
      task,
      config,
      outputLocale,
      signal: operationTracker.getSignal(operationId),
      providerRegistry: providers,
      onEvent(event) {
        operationTracker.publish(operationId, event);
      }
    });
    const log = await persistClusterOperationLog({
      task,
      operationId,
      schemeId,
      locale: outputLocale,
      projectDir,
      runtimeConfigOptions,
      operationTracker,
      config,
        status: "completed",
        result
    });
    return {
      ...result,
      log
    };
  } catch (error) {
    if (isAbortError(error)) {
      operationTracker.publish(operationId, {
        type: "cancelled",
        stage: "cluster_cancelled",
        tone: "warning",
        detail: error.message
      });
      await persistClusterOperationLog({
        task,
        operationId,
        schemeId,
        locale: outputLocale,
        projectDir,
        runtimeConfigOptions,
        operationTracker,
        config,
        status: "cancelled",
        error
      });
      throw error;
    }

    operationTracker.publish(operationId, {
      type: "error",
      stage: "cluster_failed",
      tone: "error",
      detail: error.message
    });
    await persistClusterOperationLog({
      task,
      operationId,
      schemeId,
      locale: outputLocale,
      projectDir,
      runtimeConfigOptions,
      operationTracker,
      config,
      status: "failed",
      error
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
    const locale = normalizeRunLocale(body?.locale);
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
      locale,
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

export async function handleOperationCancel(
  response,
  operationId,
  operationTracker,
  projectDir,
  runtimeConfigOptions = {}
) {
  const locale = normalizeRunLocale(
    operationTracker.getSnapshot(operationId, { afterSeq: 0 })?.meta?.locale
  );
  const result = operationTracker.cancel(operationId, {
    detail: localizeRunText(locale, "User requested task cancellation.", "用户请求终止任务。"),
    message: localizeRunText(locale, "Operation cancelled by user.", "任务已由用户终止。")
  });

  if (!result.ok && result.code === "not_found") {
    sendJson(response, 200, {
      ok: true,
      operationId,
      cancellationRequested: false,
      alreadyStopped: true,
      notFound: true
    });
    return;
  }

  if (!result.ok && result.code === "already_finished") {
    sendJson(response, 200, {
      ok: true,
      operationId,
      cancellationRequested: false,
      alreadyStopped: true,
      alreadyFinished: true
    });
    return;
  }

  const snapshot = operationTracker.getSnapshot(operationId, { afterSeq: 0 });
  const cancelLog =
    snapshot && snapshot.meta
      ? await persistClusterOperationLog({
      task: String(snapshot.meta.task || "").trim(),
      operationId,
      schemeId: String(snapshot.meta.schemeId || "").trim(),
      locale: normalizeRunLocale(snapshot.meta.locale),
      projectDir,
      runtimeConfigOptions,
      operationTracker,
          status: "cancel_requested",
          error: new Error(
            localizeRunText(
              locale,
              "Cancellation requested by user before the task completed.",
              "用户在任务完成前请求了终止。"
            )
          )
        })
      : null;

  sendJson(response, 200, {
    ok: true,
    operationId,
    cancellationRequested: true,
    alreadyRequested: Boolean(result.alreadyRequested),
    log: cancelLog
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


import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { loadRuntimeConfig, summarizeConfig, getEditableSettings, saveEditableSettings } from "./config.mjs";
import { createProviderRegistry } from "./providers/factory.mjs";
import { testModelConnectivity } from "./providers/connectivity-test.mjs";
import { runClusterAnalysis } from "./cluster/orchestrator.mjs";
import { createOperationTracker } from "./operations.mjs";
import { isAbortError } from "./utils/abort.mjs";
import {
  ensureWorkspaceDirectory,
  getWorkspaceFilePreview,
  getWorkspaceTree,
  writeWorkspaceFiles
} from "./workspace/fs.mjs";
import { pickFolderDialog } from "./system/dialogs.mjs";
import {
  installBotCustomCommand,
  installBotPluginPreset,
  listBotPluginPresets
} from "./system/bot-plugins.mjs";
import { createBotRuntimeManager } from "./system/bot-runtime.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function resolveOperationId(body, fallbackPrefix) {
  const explicit = String(body?.operationId || "").trim();
  return explicit || `${fallbackPrefix}_${randomUUID()}`;
}

function resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, overrideDir = "") {
  const config = loadRuntimeConfig(projectDir, runtimeConfigOptions);
  const normalizedOverride = String(overrideDir || "").trim();
  if (!normalizedOverride) {
    return {
      dir: config.workspace.dir,
      resolvedDir: config.workspace.resolvedDir
    };
  }

  return {
    dir: normalizedOverride,
    resolvedDir: isAbsolute(normalizedOverride)
      ? normalizedOverride
      : resolve(projectDir, normalizedOverride)
  };
}

async function handleConfigRequest(response, projectDir, runtimeConfigOptions) {
  try {
    const config = loadRuntimeConfig(projectDir, runtimeConfigOptions);
    sendJson(response, 200, {
      ok: true,
      config: summarizeConfig(config)
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

async function handleSettingsRequest(response, projectDir, runtimeConfigOptions) {
  try {
    const payload = getEditableSettings(projectDir, runtimeConfigOptions);
    sendJson(response, 200, {
      ok: true,
      ...payload
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

async function handleSettingsSave(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const saved = await saveEditableSettings(projectDir, body, runtimeConfigOptions);
    sendJson(response, 200, {
      ok: true,
      ...saved
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function executeClusterOperation({
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

async function handleClusterRun(request, response, projectDir, runtimeConfigOptions, operationTracker) {
  let operationId = "";
  try {
    const body = await readRequestBody(request);
    operationId = resolveOperationId(body, "cluster");
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

async function handleOperationCancel(response, operationId, operationTracker) {
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

async function handleModelTest(request, response, operationTracker) {
  let operationId = "";
  try {
    const body = await readRequestBody(request);
    operationId = resolveOperationId(body, "model_test");
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

async function handleWorkspaceSummary(response, url, projectDir, runtimeConfigOptions) {
  try {
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(url.searchParams.get("workspaceDir") || "").trim()
    );
    const rootDir = await ensureWorkspaceDirectory(workspace.resolvedDir);
    const tree = await getWorkspaceTree(rootDir);
    sendJson(response, 200, {
      ok: true,
      workspace: {
        dir: workspace.dir,
        resolvedDir: rootDir,
        tree: tree.lines
      }
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleWorkspaceFileRead(response, url, projectDir, runtimeConfigOptions) {
  try {
    const filePath = String(url.searchParams.get("path") || "").trim();
    const workspaceDir = String(url.searchParams.get("workspaceDir") || "").trim();
    if (!filePath) {
      sendJson(response, 400, {
        ok: false,
        error: "Workspace file path is required."
      });
      return;
    }

    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const preview = await getWorkspaceFilePreview(workspace.resolvedDir, filePath);
    sendJson(response, 200, {
      ok: true,
      workspace,
      file: preview
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleWorkspaceFileWrite(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const filePath = String(body?.path || "").trim();
    const workspaceDir = String(body?.workspaceDir || "").trim();
    if (!filePath) {
      sendJson(response, 400, {
        ok: false,
        error: "Workspace file path is required."
      });
      return;
    }

    const content = String(body?.content ?? "");
    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const written = await writeWorkspaceFiles(workspace.resolvedDir, [
      {
        path: filePath,
        content
      }
    ]);
    sendJson(response, 200, {
      ok: true,
      workspace,
      written
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleWorkspaceImport(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspaceDir = String(body?.workspaceDir || "").trim();
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) {
      sendJson(response, 400, {
        ok: false,
        error: "At least one file is required for import."
      });
      return;
    }

    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const written = await writeWorkspaceFiles(
      workspace.resolvedDir,
      files.map((file) => ({
        path: file?.path,
        content: file?.contentBase64,
        encoding: "base64"
      })),
      {
        maxFiles: 50
      }
    );

    sendJson(response, 200, {
      ok: true,
      workspace,
      written
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleFolderPick(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(body?.currentDir || "").trim()
    );
    const selectedPath = await pickFolderDialog(workspace.resolvedDir);
    sendJson(response, 200, {
      ok: true,
      path: selectedPath || ""
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotPresets(response) {
  try {
    sendJson(response, 200, {
      ok: true,
      presets: listBotPluginPresets()
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotPresetInstall(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const config = loadRuntimeConfig(projectDir, runtimeConfigOptions);
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(body?.workspaceDir || "").trim()
    );

    const result = await installBotPluginPreset({
      workspaceDir: workspace.resolvedDir,
      installDir: String(body?.installDir || "").trim() || config.bot.installDir,
      presetId: String(body?.presetId || "").trim()
    });

    sendJson(response, 200, {
      ok: true,
      workspace,
      ...result
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotCustomInstall(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const config = loadRuntimeConfig(projectDir, runtimeConfigOptions);
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(body?.workspaceDir || "").trim()
    );

    const result = await installBotCustomCommand({
      workspaceDir: workspace.resolvedDir,
      installDir: String(body?.installDir || "").trim() || config.bot.installDir,
      commandText: String(body?.command || "").trim()
    });

    sendJson(response, 200, {
      ok: true,
      workspace,
      ...result
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

function resolveServerUrl(request) {
  const port = request?.socket?.localPort || 0;
  return `http://127.0.0.1:${port}`;
}

async function handleOperationSnapshot(response, url, operationId, operationTracker) {
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

async function handleBotIncoming(request, response, projectDir, runtimeConfigOptions, operationTracker) {
  try {
    const body = await readRequestBody(request);
    const text = String(body?.text || "").trim();
    if (!text) {
      sendJson(response, 400, {
        ok: false,
        error: "Incoming bot message must include non-empty text."
      });
      return;
    }

    const operationId = resolveOperationId(body, "bot_cluster");
    const botId = String(body?.botId || "").trim() || "bot";
    const senderId = String(body?.senderId || "").trim();
    const senderName = String(body?.senderName || "").trim();
    const chatId = String(body?.chatId || "").trim();
    const channelId = String(body?.channelId || "").trim();

    operationTracker.ensureOperation(operationId, {
      kind: "bot_cluster_run",
      botId,
      senderId,
      senderName,
      chatId,
      channelId
    });

    void executeClusterOperation({
      task: text,
      operationId,
      schemeId: String(body?.schemeId || "").trim(),
      projectDir,
      runtimeConfigOptions,
      operationTracker
    }).catch(() => {
      // Error events are already published by executeClusterOperation/runClusterAnalysis callers.
    });

    sendJson(response, 202, {
      ok: true,
      accepted: true,
      operationId
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotRuntimeSnapshot(response, botRuntimeManager) {
  try {
    sendJson(response, 200, {
      ok: true,
      runtime: botRuntimeManager.buildSnapshot()
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotRuntimeStart(request, response, botRuntimeManager) {
  try {
    const body = await readRequestBody(request);
    const botId = String(body?.botId || "").trim();
    const serverUrl = resolveServerUrl(request);
    const result = botId
      ? botRuntimeManager.startBot(botId, serverUrl)
      : botRuntimeManager.startEnabledBots(serverUrl);

    sendJson(response, 200, {
      ok: true,
      ...result
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotRuntimeStop(request, response, botRuntimeManager) {
  try {
    const body = await readRequestBody(request);
    const botId = String(body?.botId || "").trim();
    const result = botId ? botRuntimeManager.stopBot(botId) : botRuntimeManager.stopAllBots();
    sendJson(response, 200, {
      ok: true,
      ...result,
      runtime: botRuntimeManager.buildSnapshot()
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBotRuntimeAutoStart(request, response, botRuntimeManager) {
  try {
    const result = botRuntimeManager.ensureAutoStart(resolveServerUrl(request));
    sendJson(response, 200, {
      ok: true,
      ...result
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleSystemExit(response, request, performShutdown) {
  sendJson(response, 200, {
    ok: true,
    shuttingDown: true
  });

  response.on("finish", () => {
    setTimeout(() => {
      void performShutdown({
        reason: "User requested application exit."
      });
    }, 20);
  });

  request.resume();
}

async function serveStaticFile(response, assetPath, staticAssetLoader) {
  const body = await staticAssetLoader(assetPath);
  const extension = assetPath.slice(assetPath.lastIndexOf("."));
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

export function createAppServer({
  projectDir,
  staticAssetLoader,
  runtimeConfigOptions = {},
  exitProcess = (code) => process.exit(code)
}) {
  if (typeof staticAssetLoader !== "function") {
    throw new Error("createAppServer requires a staticAssetLoader function.");
  }

  const operationTracker = createOperationTracker();
  const botRuntimeManager = createBotRuntimeManager({
    projectDir,
    runtimeConfigOptions
  });
  const sockets = new Set();
  let shutdownPromise = null;
  let shuttingDown = false;

  async function performShutdown(options = {}) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shuttingDown = true;
    shutdownPromise = (async () => {
      operationTracker.cancelAll({
        detail: options.reason || "Application is shutting down.",
        message: "Application is exiting."
      });

      await botRuntimeManager.shutdownAllBots({
        force: true,
        timeoutMs: 900
      });

      const closePromise = new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });

      const gracefulClosed = await Promise.race([
        closePromise.then(() => true),
        delay(600).then(() => false)
      ]);

      if (!gracefulClosed) {
        for (const socket of Array.from(sockets)) {
          try {
            socket.destroy();
          } catch {
            // Ignore socket teardown failures during shutdown.
          }
        }
        await Promise.race([closePromise, delay(250)]);
      }
    })()
      .catch((error) => {
        console.error("Application shutdown failed:", error);
      })
      .finally(() => {
        try {
          exitProcess(0);
        } catch (error) {
          console.error("Failed to exit process:", error);
        }
      });

    return shutdownPromise;
  }

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const operationEventsMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/events$/);
    const operationCancelMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/cancel$/);
    const operationSnapshotMatch = url.pathname.match(/^\/api\/operations\/([^/]+)\/snapshot$/);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        await serveStaticFile(response, "index.html", staticAssetLoader);
        return;
      }

      if (request.method === "GET" && url.pathname === "/assets/app.js") {
        await serveStaticFile(response, "app.js", staticAssetLoader);
        return;
      }

      if (request.method === "GET" && url.pathname === "/assets/provider-catalog.js") {
        await serveStaticFile(response, "provider-catalog.js", staticAssetLoader);
        return;
      }

      if (request.method === "GET" && url.pathname === "/assets/style.css") {
        await serveStaticFile(response, "style.css", staticAssetLoader);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        await handleSettingsRequest(response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/settings") {
        await handleSettingsSave(request, response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        await handleConfigRequest(response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/workspace") {
        await handleWorkspaceSummary(response, url, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/system/pick-folder") {
        await handleFolderPick(request, response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/system/exit") {
        await handleSystemExit(response, request, performShutdown);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/workspace/file") {
        await handleWorkspaceFileRead(response, url, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/file") {
        await handleWorkspaceFileWrite(request, response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspace/import") {
        await handleWorkspaceImport(request, response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/bot/presets") {
        await handleBotPresets(response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bot/install") {
        await handleBotPresetInstall(request, response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bot/install-custom") {
        await handleBotCustomInstall(request, response, projectDir, runtimeConfigOptions);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/bot/runtime") {
        await handleBotRuntimeSnapshot(response, botRuntimeManager);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bot/runtime/start") {
        await handleBotRuntimeStart(request, response, botRuntimeManager);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bot/runtime/stop") {
        await handleBotRuntimeStop(request, response, botRuntimeManager);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bot/runtime/ensure-auto-start") {
        await handleBotRuntimeAutoStart(request, response, botRuntimeManager);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/bot/incoming") {
        await handleBotIncoming(
          request,
          response,
          projectDir,
          runtimeConfigOptions,
          operationTracker
        );
        return;
      }

      if (request.method === "GET" && operationEventsMatch) {
        operationTracker.attachStream(decodeURIComponent(operationEventsMatch[1]), request, response);
        return;
      }

      if (request.method === "GET" && operationSnapshotMatch) {
        await handleOperationSnapshot(
          response,
          url,
          operationSnapshotMatch[1],
          operationTracker
        );
        return;
      }

      if (request.method === "POST" && operationCancelMatch) {
        await handleOperationCancel(
          response,
          decodeURIComponent(operationCancelMatch[1]),
          operationTracker
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cluster/run") {
        await handleClusterRun(request, response, projectDir, runtimeConfigOptions, operationTracker);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/model/test") {
        await handleModelTest(request, response, operationTracker);
        return;
      }

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        sendText(response, 204, "");
        return;
      }

      sendJson(response, 404, {
        ok: false,
        error: `Route not found: ${request.method} ${url.pathname}`
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error.message
      });
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    if (shuttingDown) {
      socket.destroy();
      return;
    }

    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  server.on("close", () => {
    botRuntimeManager.stopAllBots();
  });

  return server;
}

export function resolveRuntimePort({ projectDir, runtimeConfigOptions = {} }) {
  try {
    return loadRuntimeConfig(projectDir, runtimeConfigOptions).server.port;
  } catch {
    return Number(process.env.PORT || 4040);
  }
}

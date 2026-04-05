import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "./config.mjs";
import { createOperationTracker } from "./operations.mjs";
import { createBotRuntimeManager } from "./system/bot-runtime.mjs";
import {
  delay,
  resolveStaticAssetPath,
  sendJson,
  sendText,
  serveStaticFile
} from "./http/common.mjs";
import {
  handleConfigRequest,
  handleSettingsRequest,
  handleSettingsSave
} from "./http/settings-routes.mjs";
import {
  handleClusterRun,
  handleModelTest,
  handleOperationCancel,
  handleOperationSnapshot
} from "./http/cluster-routes.mjs";
import {
  handleWorkspaceCacheClear,
  handleFolderPick,
  handleWorkspaceFileRead,
  handleWorkspaceFileWrite,
  handleWorkspaceImport,
  handleWorkspaceSummary
} from "./http/workspace-routes.mjs";
import {
  handleBotCustomInstall,
  handleBotIncoming,
  handleBotPresetInstall,
  handleBotPresets,
  handleBotRuntimeAutoStart,
  handleBotRuntimeSnapshot,
  handleBotRuntimeStart,
  handleBotRuntimeStop
} from "./http/bot-routes.mjs";
import { handleSystemExit } from "./http/system-routes.mjs";

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
    const staticAssetPath =
      request.method === "GET" ? resolveStaticAssetPath(url.pathname) : "";

    try {
      if (request.method === "GET" && url.pathname === "/") {
        await serveStaticFile(response, "index.html", staticAssetLoader);
        return;
      }

      if (staticAssetPath) {
        await serveStaticFile(response, staticAssetPath, staticAssetLoader);
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

      if (request.method === "POST" && url.pathname === "/api/workspace/cache/clear") {
        await handleWorkspaceCacheClear(request, response, projectDir, runtimeConfigOptions);
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
          operationTracker,
          randomUUID
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
          operationTracker,
          projectDir,
          runtimeConfigOptions
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/cluster/run") {
        await handleClusterRun(
          request,
          response,
          projectDir,
          runtimeConfigOptions,
          operationTracker,
          randomUUID
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/model/test") {
        await handleModelTest(request, response, operationTracker, randomUUID);
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

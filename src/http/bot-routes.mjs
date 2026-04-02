import { loadRuntimeConfig } from "../config.mjs";
import {
  installBotCustomCommand,
  installBotPluginPreset,
  listBotPluginPresets
} from "../system/bot-plugins.mjs";
import { readRequestBody, resolveOperationId, resolveServerUrl, sendJson } from "./common.mjs";
import { executeClusterOperation } from "./cluster-routes.mjs";
import { resolveWorkspaceRequestContext } from "./workspace-routes.mjs";

export async function handleBotPresets(response) {
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

export async function handleBotPresetInstall(request, response, projectDir, runtimeConfigOptions) {
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

export async function handleBotCustomInstall(request, response, projectDir, runtimeConfigOptions) {
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

export async function handleBotIncoming(
  request,
  response,
  projectDir,
  runtimeConfigOptions,
  operationTracker,
  randomUuid
) {
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

    const operationId = resolveOperationId(body, "bot_cluster", randomUuid);
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

export async function handleBotRuntimeSnapshot(response, botRuntimeManager) {
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

export async function handleBotRuntimeStart(request, response, botRuntimeManager) {
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

export async function handleBotRuntimeStop(request, response, botRuntimeManager) {
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

export async function handleBotRuntimeAutoStart(request, response, botRuntimeManager) {
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

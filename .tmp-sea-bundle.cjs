"use strict";
const __modules = {
"/src/sea-main.mjs": function(module, exports, __require) {
const { spawn } = require("node:child_process");
const { appendFileSync, mkdirSync } = require("node:fs");
const { getAsset } = require("node:sea");
const { dirname, join } = require("node:path");
const __importedModule5 = require("node:process");
const process = __importedModule5;
const { argv, execPath } = __importedModule5;
const { createAppServer, resolveRuntimePort } = __require("/src/app.mjs");
const HIDDEN_LAUNCH_ARG = "--sea-hidden-launch";
const SHOW_CONSOLE_ARG = "--show-console";

function getProjectDir() {
  return dirname(execPath);
}

function getAssetBuffer(assetPath) {
  return Buffer.from(getAsset(assetPath));
}

function shouldRelaunchHiddenOnWindows() {
  return (
    process.platform === "win32" &&
    !argv.includes(HIDDEN_LAUNCH_ARG) &&
    !argv.includes(SHOW_CONSOLE_ARG)
  );
}

function relaunchHiddenOnWindows() {
  const child = spawn(execPath, [...argv.slice(1), HIDDEN_LAUNCH_ARG], {
    cwd: getProjectDir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function openBrowser(url) {
  const child = spawn("cmd", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function logStartupFailure(error) {
  try {
    const projectDir = getProjectDir();
    const logDir = join(projectDir, "task-logs");
    const logPath = join(logDir, "app-startup.log");
    const detail = error instanceof Error ? error.stack || error.message : String(error || "Unknown startup error");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}] ${detail}\n\n`,
      "utf8"
    );
  } catch {
    // Swallow secondary logging failures.
  }
}

process.on("uncaughtException", (error) => {
  logStartupFailure(error);
  throw error;
});

process.on("unhandledRejection", (reason) => {
  logStartupFailure(reason);
  throw reason instanceof Error ? reason : new Error(String(reason || "Unhandled rejection"));
});

if (shouldRelaunchHiddenOnWindows()) {
  relaunchHiddenOnWindows();
  process.exit(0);
}

const projectDir = getProjectDir();
const runtimeConfigOptions = {
  baseConfig: JSON.parse(getAssetBuffer("cluster.config.json").toString("utf8")),
  configPathLabel: "[embedded default config]",
  settingsPath: join(projectDir, "runtime.settings.json")
};

async function staticAssetLoader(assetPath) {
  return getAssetBuffer(`static/${assetPath}`);
}

const server = createAppServer({
  projectDir,
  staticAssetLoader,
  runtimeConfigOptions
});

const port = resolveRuntimePort({
  projectDir,
  runtimeConfigOptions
});

server.on("error", (error) => {
  logStartupFailure(error);
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Cluster Workbench listening at ${url}`);
  if (!argv.includes("--no-open")) {
    openBrowser(url);
  }
});

module.exports = {  };

},
"/src/app.mjs": function(module, exports, __require) {
const { createServer : createHttpServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const { loadRuntimeConfig } = __require("/src/config.mjs");
const { createOperationTracker } = __require("/src/operations.mjs");
const { createBotRuntimeManager } = __require("/src/system/bot-runtime.mjs");
const { delay, resolveStaticAssetPath, sendJson, sendText, serveStaticFile } = __require("/src/http/common.mjs");
const { handleConfigRequest, handleSettingsRequest, handleSettingsSave } = __require("/src/http/settings-routes.mjs");
const { handleClusterRun, handleModelTest, handleOperationCancel, handleOperationSnapshot } = __require("/src/http/cluster-routes.mjs");
const { handleWorkspaceCacheClear, handleFolderPick, handleFolderPickStatus, handleWorkspaceFileRead, handleWorkspaceFileWrite, handleWorkspaceImport, handleWorkspaceSummary } = __require("/src/http/workspace-routes.mjs");
const { handleBotCustomInstall, handleBotIncoming, handleBotPresetInstall, handleBotPresets, handleBotRuntimeAutoStart, handleBotRuntimeSnapshot, handleBotRuntimeStart, handleBotRuntimeStop } = __require("/src/http/bot-routes.mjs");
const { handleSystemExit } = __require("/src/http/system-routes.mjs");
function createAppServer({
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

      if (request.method === "GET" && url.pathname === "/api/system/pick-folder") {
        await handleFolderPickStatus(response, url);
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

function resolveRuntimePort({ projectDir, runtimeConfigOptions = {} }) {
  try {
    return loadRuntimeConfig(projectDir, runtimeConfigOptions).server.port;
  } catch {
    return Number(process.env.PORT || 4040);
  }
}

module.exports = { createAppServer, resolveRuntimePort };

},
"/src/config.mjs": function(module, exports, __require) {
const { existsSync, readFileSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, isAbsolute, resolve } = require("node:path");
const { materializeSavedSettingsSync, serializeSavedSettingsSync } = __require("/src/security/secrets.mjs");
const { applySecretMapToProcessEnv } = __require("/src/security/process-env.mjs");
const { getProviderDefinition, isSupportedProvider, listProviderDefinitions, providerSupportsCapability } = __require("/src/static/provider-catalog.js");
const { normalizeAgentBudgetProfiles, normalizeCapabilityRoutingPolicy } = __require("/src/cluster/policies.mjs");
const SUPPORTED_AUTH_STYLES = new Set(["bearer", "api-key", "none"]);
const DEFAULT_SETTINGS_PATH = "./runtime.settings.json";
const DEFAULT_WORKSPACE_DIR = "./workspace";
const DEFAULT_BOT_INSTALL_DIR = "bot-connectors";
const DEFAULT_SUBORDINATE_MAX_PARALLEL = 3;
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const DEFAULT_SCHEME_ID = "gpt_scheme";
const DEFAULT_SCHEME_LABEL = "gpt方案";
const DEFAULT_MULTI_AGENT_MODE = "group_chat";
const DEFAULT_MULTI_AGENT_SPEAKER_STRATEGY = "phase_priority";
const DEFAULT_MULTI_AGENT_MAX_ROUNDS = 16;
const DEFAULT_MULTI_AGENT_TERMINATION_KEYWORD = "TERMINATE";
const DEFAULT_MULTI_AGENT_MESSAGE_WINDOW = 28;
const CLUSTER_PHASES = ["research", "implementation", "validation", "handoff"];
const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const SUPPORTED_MULTI_AGENT_MODES = new Set(["group_chat", "sequential", "workflow"]);
const SUPPORTED_MULTI_AGENT_SPEAKER_STRATEGIES = new Set([
  "round_robin",
  "phase_priority",
  "random"
]);
const SUPPORTED_MODEL_ROLES = new Set(["controller", "worker", "hybrid"]);

function normalizeProviderBaseUrl(provider, baseUrl) {
  const normalizedProvider = String(provider || "").trim();
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");

  if (
    normalizedProvider === "kimi-coding" &&
    /^https:\/\/api\.moonshot\.cn\/v1$/i.test(normalizedBaseUrl)
  ) {
    return getProviderDefinition("kimi-coding")?.defaultBaseUrl || normalizedBaseUrl;
  }

  return normalizedBaseUrl;
}
const MODEL_ROLE_ALIASES = new Map([
  ["both", "hybrid"],
  ["dual", "hybrid"],
  ["dual-role", "hybrid"],
  ["dual_role", "hybrid"]
]);

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
  if (!match) {
    return null;
  }

  let value = match[2] ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeModelId(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w-]/g, "_");
  return normalized || fallback;
}

function sanitizeSchemeId(value, fallback) {
  return sanitizeModelId(value, fallback);
}

function normalizePort(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 65535) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeNonNegativeInteger(value, fallback) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeOptionalPositiveInteger(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 1) {
    return null;
  }

  return Math.floor(number);
}

function normalizeOptionalNonNegativeInteger(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Math.floor(number);
}

function normalizeWorkspaceDir(value, fallback = DEFAULT_WORKSPACE_DIR) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeWorkspaceSubdir(value, fallback = DEFAULT_BOT_INSTALL_DIR) {
  const normalized = String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || fallback;
}

function normalizeSchemeLabel(value, fallback = DEFAULT_SCHEME_LABEL) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeMultiAgentChoice(value, supportedValues, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return supportedValues.has(normalized) ? normalized : fallback;
}

function normalizeMultiAgentSettings(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : {};

  return {
    enabled: Boolean(source.enabled ?? backup.enabled ?? false),
    mode: normalizeMultiAgentChoice(
      source.mode ?? backup.mode,
      SUPPORTED_MULTI_AGENT_MODES,
      DEFAULT_MULTI_AGENT_MODE
    ),
    speakerStrategy: normalizeMultiAgentChoice(
      source.speakerStrategy ?? backup.speakerStrategy,
      SUPPORTED_MULTI_AGENT_SPEAKER_STRATEGIES,
      DEFAULT_MULTI_AGENT_SPEAKER_STRATEGY
    ),
    maxRounds: normalizePositiveInteger(
      source.maxRounds,
      normalizePositiveInteger(backup.maxRounds, DEFAULT_MULTI_AGENT_MAX_ROUNDS)
    ),
    terminationKeyword:
      String(source.terminationKeyword ?? backup.terminationKeyword ?? "").trim() ||
      DEFAULT_MULTI_AGENT_TERMINATION_KEYWORD,
    messageWindow: normalizePositiveInteger(
      source.messageWindow,
      normalizePositiveInteger(backup.messageWindow, DEFAULT_MULTI_AGENT_MESSAGE_WINDOW)
    ),
    summarizeLongMessages: source.summarizeLongMessages ?? backup.summarizeLongMessages ?? true,
    includeSystemMessages: source.includeSystemMessages ?? backup.includeSystemMessages ?? true
  };
}

function normalizePhaseParallelSettings(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : {};
  const normalized = {};

  for (const phase of CLUSTER_PHASES) {
    const resolved = normalizeOptionalNonNegativeInteger(source[phase]);
    if (resolved !== null) {
      normalized[phase] = resolved;
      continue;
    }

    const fallbackValue = normalizeOptionalNonNegativeInteger(backup[phase]);
    if (fallbackValue !== null) {
      normalized[phase] = fallbackValue;
    }
  }

  return normalized;
}

function parseSpecialties(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseModelRole(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  const normalized = MODEL_ROLE_ALIASES.get(trimmed) || trimmed;
  return SUPPORTED_MODEL_ROLES.has(normalized) ? normalized : null;
}

function inferModelRole(modelConfig, modelId, controllerId) {
  const explicitRole = parseModelRole(modelConfig?.role);
  if (explicitRole === null) {
    throw new Error(`Model "${modelId}" has unsupported role "${modelConfig?.role}".`);
  }
  if (explicitRole) {
    return explicitRole;
  }
  return modelId === controllerId ? "controller" : "worker";
}

function modelRoleAllowsController(role) {
  return role === "controller" || role === "hybrid";
}

function modelRoleAllowsWorker(role) {
  return role === "worker" || role === "hybrid";
}

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : Array.isArray(fallback)
        ? fallback
        : [];

  return Array.from(
    new Set(
      source
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeJsonObjectSetting(value, fallback, label) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSON for ${label}: ${error.message}`);
    }
  }

  if (value && typeof value === "object") {
    return value;
  }

  return fallback;
}

function normalizeReasoningEffort(value, fallback = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return SUPPORTED_REASONING_EFFORTS.has(normalized) ? normalized : fallback;
}

function inferThinkingEnabled(modelConfig, provider, fallback = false) {
  if (!providerSupportsCapability(provider, "thinking")) {
    return false;
  }

  if (typeof modelConfig?.thinkingEnabled === "boolean") {
    return modelConfig.thinkingEnabled;
  }

  if (typeof modelConfig?.thinking === "boolean") {
    return modelConfig.thinking;
  }

  if (modelConfig?.thinking && typeof modelConfig.thinking === "object") {
    if (typeof modelConfig.thinking.enabled === "boolean") {
      return modelConfig.thinking.enabled;
    }

    const thinkingType = String(modelConfig.thinking.type || "")
      .trim()
      .toLowerCase();
    if (thinkingType === "enabled") {
      return true;
    }
    if (thinkingType === "disabled") {
      return false;
    }
  }

  if (providerSupportsCapability(provider, "reasoning")) {
    const reasoningEffort = normalizeReasoningEffort(
      modelConfig?.reasoning?.effort || modelConfig?.reasoningEffort || ""
    );
    if (reasoningEffort) {
      return true;
    }
  }

  return fallback;
}

function normalizeBotConfig(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : {};
  const rawPresetConfigs =
    source.presetConfigs && typeof source.presetConfigs === "object" ? source.presetConfigs : {};
  const fallbackPresetConfigs =
    backup.presetConfigs && typeof backup.presetConfigs === "object" ? backup.presetConfigs : {};
  const presetConfigs = {};

  for (const presetId of new Set([
    ...Object.keys(fallbackPresetConfigs),
    ...Object.keys(rawPresetConfigs)
  ])) {
    const entry = rawPresetConfigs[presetId];
    const fallbackEntry = fallbackPresetConfigs[presetId];
    presetConfigs[presetId] = {
      envText: String(entry?.envText ?? fallbackEntry?.envText ?? "").trim()
    };
  }

  return {
    installDir: normalizeWorkspaceSubdir(source.installDir, backup.installDir || DEFAULT_BOT_INSTALL_DIR),
    customCommand: String(source.customCommand ?? backup.customCommand ?? "").trim(),
    enabledPresets: normalizeStringList(source.enabledPresets, backup.enabledPresets),
    commandPrefix: String(source.commandPrefix ?? backup.commandPrefix ?? "/agent").trim() || "/agent",
    autoStart: Boolean(source.autoStart ?? backup.autoStart),
    progressUpdates: source.progressUpdates ?? backup.progressUpdates ?? true,
    presetConfigs
  };
}

function buildLegacySchemeDefinition(config, fallbackId = DEFAULT_SCHEME_ID, fallbackLabel = DEFAULT_SCHEME_LABEL) {
  const models = config?.models;
  const controller = String(config?.cluster?.controller || "").trim();
  if (!models || typeof models !== "object" || !Object.keys(models).length) {
    return null;
  }

  return {
    id: sanitizeSchemeId(config?.cluster?.activeSchemeId, fallbackId),
    label: normalizeSchemeLabel(config?.cluster?.activeSchemeLabel, fallbackLabel),
    controller,
    models: cloneJson(models)
  };
}

function extractConfiguredSchemes(config) {
  const rawSchemes = config?.schemes;
  const schemes = [];
  const seenIds = new Set();

  function appendScheme(id, value, index) {
    const fallbackId = index === 0 ? DEFAULT_SCHEME_ID : `scheme_${index + 1}`;
    let schemeId = sanitizeSchemeId(id || value?.id, fallbackId);
    while (seenIds.has(schemeId)) {
      schemeId = `${schemeId}_${index + 1}`;
    }
    seenIds.add(schemeId);

    schemes.push({
      id: schemeId,
      label: normalizeSchemeLabel(value?.label, schemeId === DEFAULT_SCHEME_ID ? DEFAULT_SCHEME_LABEL : schemeId),
      controller: String(value?.controller || "").trim(),
      models: cloneJson(value?.models && typeof value.models === "object" ? value.models : {})
    });
  }

  if (Array.isArray(rawSchemes)) {
    rawSchemes.forEach((value, index) => appendScheme(value?.id, value, index));
  } else if (rawSchemes && typeof rawSchemes === "object") {
    Object.entries(rawSchemes).forEach(([id, value], index) => appendScheme(id, value, index));
  }

  if (!schemes.length) {
    const legacyScheme = buildLegacySchemeDefinition(config);
    if (legacyScheme) {
      schemes.push(legacyScheme);
    }
  }

  return schemes;
}

function resolveSelectedSchemeId(schemes, preferredId = "") {
  const normalizedPreferredId = String(preferredId || "").trim();
  if (normalizedPreferredId && schemes.some((scheme) => scheme.id === normalizedPreferredId)) {
    return normalizedPreferredId;
  }

  return schemes[0]?.id || "";
}

function normalizeModelsPayload(modelsArray, controllerId, secrets) {
  const normalizedModels = {};
  const entries = Array.isArray(modelsArray) ? modelsArray : [];
  if (entries.length < 2) {
    throw new Error("At least two models are required: one controller and at least one worker.");
  }

  for (let index = 0; index < entries.length; index += 1) {
    const source = entries[index] || {};
    const fallbackId = `model_${index + 1}`;
    const modelId = sanitizeModelId(source.id, fallbackId);

    if (normalizedModels[modelId]) {
      throw new Error(`Duplicate model id "${modelId}".`);
    }

    const provider = String(source.provider || "").trim();
    if (!isSupportedProvider(provider)) {
      throw new Error(`Model "${modelId}" has unsupported provider "${provider}".`);
    }

    const model = String(source.model || "").trim();
    const baseUrl = normalizeProviderBaseUrl(provider, source.baseUrl);
    if (!model) {
      throw new Error(`Model "${modelId}" is missing a model name.`);
    }
    if (!baseUrl) {
      throw new Error(`Model "${modelId}" is missing a baseUrl.`);
    }

    const authStyle = String(source.authStyle || "bearer").trim();
    if (!SUPPORTED_AUTH_STYLES.has(authStyle)) {
      throw new Error(`Model "${modelId}" has unsupported authStyle "${authStyle}".`);
    }

    const apiKeyEnv = String(source.apiKeyEnv || "").trim();
    if (authStyle !== "none" && !apiKeyEnv) {
      throw new Error(`Model "${modelId}" must specify apiKeyEnv unless authStyle is "none".`);
    }

    const normalizedModel = {
      provider,
      model,
      baseUrl,
      apiKeyEnv,
      authStyle,
      label: String(source.label || modelId).trim() || modelId,
      role: inferModelRole(source, modelId, controllerId),
      specialties: parseSpecialties(source.specialties)
    };

    const thinkingEnabled = inferThinkingEnabled(source, provider, false);
    if (providerSupportsCapability(provider, "thinking")) {
      normalizedModel.thinkingEnabled = thinkingEnabled;
    }

    const apiKeyHeader = String(source.apiKeyHeader || "").trim();
    if (authStyle === "api-key") {
      normalizedModel.apiKeyHeader = apiKeyHeader || "api-key";
    }

    const reasoningEffort = normalizeReasoningEffort(source.reasoningEffort || source.reasoning?.effort);
    if (providerSupportsCapability(provider, "reasoning") && thinkingEnabled) {
      normalizedModel.reasoning = { effort: reasoningEffort || "medium" };
    }

    if (providerSupportsCapability(provider, "webSearch")) {
      normalizedModel.webSearch = Boolean(source.webSearch);
    }

    const temperatureValue = String(source.temperature ?? "").trim();
    if (providerSupportsCapability(provider, "temperature") && temperatureValue) {
      const temperature = Number(temperatureValue);
      if (!Number.isFinite(temperature)) {
        throw new Error(`Model "${modelId}" has invalid temperature "${temperatureValue}".`);
      }
      normalizedModel.temperature = temperature;
    }

    const apiKeyValue = String(source.apiKeyValue ?? "").trim();
    if (authStyle !== "none" && apiKeyEnv && apiKeyValue) {
      secrets[apiKeyEnv] = apiKeyValue;
    }

    normalizedModels[modelId] = normalizedModel;
  }

  if (!normalizedModels[controllerId]) {
    throw new Error(`Selected controller "${controllerId}" does not exist in the model list.`);
  }

  if (!modelRoleAllowsController(normalizedModels[controllerId].role)) {
    throw new Error(`Selected controller "${controllerId}" is not allowed to act as a controller.`);
  }

  if (
    !Object.values(normalizedModels).some(
      (modelConfig) => modelConfig !== normalizedModels[controllerId] && modelRoleAllowsWorker(modelConfig.role)
    )
  ) {
    throw new Error("At least one worker-capable model is required besides the controller.");
  }

  return normalizedModels;
}

function buildEditableModelsFromScheme(scheme, savedSecrets = {}) {
  const controllerId = String(scheme?.controller || "").trim();
  const modelsInput = scheme?.models && typeof scheme.models === "object" ? scheme.models : {};
  const normalizedModels = {};

  for (const [modelId, modelConfig] of Object.entries(modelsInput)) {
    normalizedModels[modelId] = normalizeModelConfig(modelId, modelConfig, controllerId);
  }

  return Object.values(normalizedModels)
    .sort((left, right) => {
      if (left.id === controllerId) {
        return -1;
      }
      if (right.id === controllerId) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    })
    .map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      role: model.role,
      apiKeyEnv: model.apiKeyEnv || "",
      apiKeyValue: model.apiKeyEnv
        ? String(savedSecrets[model.apiKeyEnv] ?? process.env[model.apiKeyEnv] ?? "")
        : "",
      authStyle: model.authStyle || "bearer",
      apiKeyHeader: model.apiKeyHeader || "",
      thinkingEnabled: inferThinkingEnabled(model, model.provider, false),
      reasoningEffort: model.reasoning?.effort || "",
      webSearch: Boolean(model.webSearch),
      temperature: model.temperature ?? "",
      specialties: model.specialties.join(", ")
    }));
}

function readJsonFileIfExists(filePath, fallback = null) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveBaseConfigPath(projectDir, options = {}) {
  if (options.configPath) {
    return isAbsolute(options.configPath)
      ? options.configPath
      : resolve(projectDir, options.configPath);
  }

  const configuredPath = process.env.AGENT_CLUSTER_CONFIG || "./cluster.config.json";
  return isAbsolute(configuredPath) ? configuredPath : resolve(projectDir, configuredPath);
}

function resolveSettingsPath(projectDir, options = {}) {
  if (options.settingsPath) {
    return isAbsolute(options.settingsPath)
      ? options.settingsPath
      : resolve(projectDir, options.settingsPath);
  }

  const configuredPath = String(process.env.AGENT_CLUSTER_SETTINGS || "").trim();
  if (configuredPath) {
    return isAbsolute(configuredPath) ? configuredPath : resolve(projectDir, configuredPath);
  }

  const defaultSettingsPath = resolve(projectDir, DEFAULT_SETTINGS_PATH);
  if (existsSync(defaultSettingsPath)) {
    return defaultSettingsPath;
  }

  const legacyCandidates = [
    resolve(projectDir, "dist", "runtime.settings.json")
  ];
  for (const candidate of legacyCandidates) {
    if (candidate !== defaultSettingsPath && existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultSettingsPath;
}

function loadBaseConfig(projectDir, options = {}) {
  if (options.baseConfig && typeof options.baseConfig === "object") {
    return {
      configPath: options.configPathLabel || "[embedded default config]",
      parsed: cloneJson(options.baseConfig)
    };
  }

  const configPath = resolveBaseConfigPath(projectDir, options);
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}. Create cluster.config.json or point AGENT_CLUSTER_CONFIG to a valid file.`
    );
  }

  return {
    configPath,
    parsed: JSON.parse(readFileSync(configPath, "utf8"))
  };
}

function mergeBaseConfigWithSettings(baseConfig, savedSettings) {
  const merged = cloneJson(baseConfig || {});

  if (savedSettings?.server && typeof savedSettings.server === "object") {
    merged.server = {
      ...(merged.server || {}),
      ...savedSettings.server
    };
  }

  if (savedSettings?.cluster && typeof savedSettings.cluster === "object") {
    const nextCluster = {
      ...(merged.cluster || {}),
      ...savedSettings.cluster
    };
    nextCluster.phaseParallel = normalizePhaseParallelSettings(
      savedSettings.cluster.phaseParallel,
      merged.cluster?.phaseParallel
    );
    nextCluster.agentBudgetProfiles = normalizeAgentBudgetProfiles(
      savedSettings.cluster.agentBudgetProfiles,
      merged.cluster?.agentBudgetProfiles
    );
    nextCluster.capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
      savedSettings.cluster.capabilityRoutingPolicy,
      merged.cluster?.capabilityRoutingPolicy
    );
    merged.cluster = {
      ...nextCluster
    };
  }

  if (savedSettings?.workspace && typeof savedSettings.workspace === "object") {
    merged.workspace = {
      ...(merged.workspace || {}),
      ...savedSettings.workspace
    };
  }

  if (savedSettings?.bot && typeof savedSettings.bot === "object") {
    merged.bot = {
      ...(merged.bot || {}),
      ...savedSettings.bot
    };
  }

  if (savedSettings?.multiAgent && typeof savedSettings.multiAgent === "object") {
    merged.multiAgent = normalizeMultiAgentSettings(
      savedSettings.multiAgent,
      merged.multiAgent
    );
  }

  if (savedSettings?.schemes && typeof savedSettings.schemes === "object" && Object.keys(savedSettings.schemes).length) {
    merged.schemes = cloneJson(savedSettings.schemes);
  }

  if (savedSettings?.models && typeof savedSettings.models === "object" && Object.keys(savedSettings.models).length) {
    merged.models = cloneJson(savedSettings.models);
  }

  return merged;
}

function normalizeModelConfig(modelId, modelConfig, controllerId) {
  if (!modelConfig || typeof modelConfig !== "object") {
    throw new Error(`Model "${modelId}" must be an object.`);
  }

  const provider = String(modelConfig.provider || "").trim();
  const model = String(modelConfig.model || "").trim();
  const baseUrl = normalizeProviderBaseUrl(provider, modelConfig.baseUrl);

  if (!provider) {
    throw new Error(`Model "${modelId}" is missing "provider".`);
  }
  if (!isSupportedProvider(provider)) {
    throw new Error(`Model "${modelId}" has unsupported provider "${provider}".`);
  }
  if (!model) {
    throw new Error(`Model "${modelId}" is missing "model".`);
  }
  if (!baseUrl) {
    throw new Error(`Model "${modelId}" is missing "baseUrl".`);
  }

  const authStyle = String(modelConfig.authStyle || "bearer").trim();
  if (!SUPPORTED_AUTH_STYLES.has(authStyle)) {
    throw new Error(`Model "${modelId}" has unsupported authStyle "${authStyle}".`);
  }
  const role = inferModelRole(modelConfig, modelId, controllerId);
  const thinkingEnabled = inferThinkingEnabled(modelConfig, provider, false);
  const reasoningEffort = normalizeReasoningEffort(
    modelConfig.reasoning?.effort || modelConfig.reasoningEffort || ""
  );
  const normalizedReasoning =
    providerSupportsCapability(provider, "reasoning") && thinkingEnabled
      ? { effort: reasoningEffort || "medium" }
      : null;

  return {
    ...modelConfig,
    id: modelId,
    provider,
    model,
    baseUrl,
    label: String(modelConfig.label || modelId),
    role,
    authStyle,
    apiKeyEnv: String(modelConfig.apiKeyEnv || "").trim(),
    apiKeyHeader: String(modelConfig.apiKeyHeader || "").trim(),
    thinkingEnabled,
    reasoning: normalizedReasoning,
    webSearch: providerSupportsCapability(provider, "webSearch") ? Boolean(modelConfig.webSearch) : false,
    specialties: parseSpecialties(modelConfig.specialties)
  };
}

function normalizeSavedSettingsPayload(payload, fallbackConfig) {
  const serverPort = normalizePort(payload?.server?.port, normalizePort(fallbackConfig?.server?.port, 4040));
  const maxParallel = normalizeNonNegativeInteger(
    payload?.cluster?.maxParallel,
    normalizeNonNegativeInteger(fallbackConfig?.cluster?.maxParallel, 3)
  );
  const subordinateMaxParallel = maxParallel;
  const groupLeaderMaxDelegates = normalizeNonNegativeInteger(
    payload?.cluster?.groupLeaderMaxDelegates,
    normalizeNonNegativeInteger(
      fallbackConfig?.cluster?.groupLeaderMaxDelegates,
      DEFAULT_GROUP_LEADER_MAX_DELEGATES
    )
  );
  const delegateMaxDepth = normalizeNonNegativeInteger(
    payload?.cluster?.delegateMaxDepth,
    normalizeNonNegativeInteger(
      fallbackConfig?.cluster?.delegateMaxDepth,
      DEFAULT_DELEGATION_MAX_DEPTH
    )
  );
  const phaseParallel = normalizePhaseParallelSettings(
    payload?.cluster?.phaseParallel,
    fallbackConfig?.cluster?.phaseParallel
  );
  const agentBudgetProfiles = normalizeAgentBudgetProfiles(
    normalizeJsonObjectSetting(
      payload?.cluster?.agentBudgetProfiles,
      fallbackConfig?.cluster?.agentBudgetProfiles,
      "cluster.agentBudgetProfiles"
    ),
    fallbackConfig?.cluster?.agentBudgetProfiles
  );
  const capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
    normalizeJsonObjectSetting(
      payload?.cluster?.capabilityRoutingPolicy,
      fallbackConfig?.cluster?.capabilityRoutingPolicy,
      "cluster.capabilityRoutingPolicy"
    ),
    fallbackConfig?.cluster?.capabilityRoutingPolicy
  );
  const workspaceDir = normalizeWorkspaceDir(payload?.workspace?.dir, fallbackConfig?.workspace?.dir);

  const modelsArray = Array.isArray(payload?.models) ? payload.models : [];
  const controllerId = String(payload?.cluster?.controller || "").trim();

  const secrets = {};
  if (Array.isArray(payload?.secrets)) {
    for (const entry of payload.secrets) {
      const name = String(entry?.name || "").trim();
      if (!name) {
        continue;
      }
      secrets[name] = String(entry?.value || "");
    }
  }

  const explicitSchemes = Array.isArray(payload?.schemes) ? payload.schemes : [];
  const schemeInputs =
    explicitSchemes.length
      ? explicitSchemes
      : modelsArray.length
        ? [
            {
              id: payload?.cluster?.activeSchemeId || DEFAULT_SCHEME_ID,
              label: payload?.cluster?.activeSchemeLabel || DEFAULT_SCHEME_LABEL,
              controller: controllerId,
              models: modelsArray
            }
          ]
        : [];

  if (!schemeInputs.length) {
    throw new Error("At least one scheme is required.");
  }

  const schemes = {};
  const normalizedSchemeOrder = [];
  for (let index = 0; index < schemeInputs.length; index += 1) {
    const source = schemeInputs[index] || {};
    const fallbackId = index === 0 ? DEFAULT_SCHEME_ID : `scheme_${index + 1}`;
    const schemeId = sanitizeSchemeId(source.id, fallbackId);
    if (schemes[schemeId]) {
      throw new Error(`Duplicate scheme id "${schemeId}".`);
    }

    const schemeControllerId = String(source?.controller || source?.cluster?.controller || "").trim();
    if (!schemeControllerId) {
      throw new Error(`Scheme "${schemeId}" must specify a controller model.`);
    }

    const normalizedModels = normalizeModelsPayload(source?.models, schemeControllerId, secrets);
    schemes[schemeId] = {
      label: normalizeSchemeLabel(source?.label, schemeId === DEFAULT_SCHEME_ID ? DEFAULT_SCHEME_LABEL : schemeId),
      controller: schemeControllerId,
      models: normalizedModels
    };
    normalizedSchemeOrder.push(schemeId);
  }

  const activeSchemeId = sanitizeSchemeId(
    payload?.cluster?.activeSchemeId,
    normalizedSchemeOrder[0] || DEFAULT_SCHEME_ID
  );
  if (!schemes[activeSchemeId]) {
    throw new Error(`Selected scheme "${activeSchemeId}" does not exist.`);
  }

  const activeScheme = schemes[activeSchemeId];

  return {
    server: {
      port: serverPort
    },
    cluster: {
      activeSchemeId,
      activeSchemeLabel: activeScheme.label,
      controller: activeScheme.controller,
      maxParallel,
      subordinateMaxParallel,
      groupLeaderMaxDelegates,
      delegateMaxDepth,
      phaseParallel,
      agentBudgetProfiles,
      capabilityRoutingPolicy
    },
    workspace: {
      dir: workspaceDir
    },
    bot: normalizeBotConfig(payload?.bot, fallbackConfig?.bot),
    multiAgent: normalizeMultiAgentSettings(payload?.multiAgent, fallbackConfig?.multiAgent),
    secrets,
    models: activeScheme.models,
    schemes
  };
}

function buildEditableSecrets(models, savedSecrets) {
  const names = new Set();

  for (const model of models) {
    if (model.apiKeyEnv) {
      names.add(model.apiKeyEnv);
    }
  }

  for (const name of Object.keys(savedSecrets || {})) {
    if (name) {
      names.add(name);
    }
  }

  return Array.from(names)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      value: String((savedSecrets && savedSecrets[name]) ?? process.env[name] ?? "")
    }));
}

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    const [key, value] = parsed;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadSavedSettings(projectDir, options = {}) {
  const settingsPath = resolveSettingsPath(projectDir, options);
  const rawSettings = readJsonFileIfExists(settingsPath, null);
  return {
    settingsPath,
    settings: materializeSavedSettingsSync(settingsPath, rawSettings)
  };
}

function resolveConfigBundle(projectDir, options = {}) {
  const { configPath, parsed: baseConfig } = loadBaseConfig(projectDir, options);
  const { settingsPath, settings } = loadSavedSettings(projectDir, options);
  const mergedConfig = mergeBaseConfigWithSettings(baseConfig, settings);

  return {
    configPath,
    settingsPath,
    baseConfig,
    settings,
    mergedConfig
  };
}

function applyResolvedSecrets(bundle) {
  applySecretMapToProcessEnv(bundle?.settings?.secrets);
  return bundle;
}

function getEditableSettings(projectDir, options = {}) {
  const envPath = resolve(projectDir, ".env");
  loadEnvFile(envPath);

  const { configPath, settingsPath, settings, mergedConfig } = applyResolvedSecrets(
    resolveConfigBundle(projectDir, options)
  );
  const runtimeConfig = loadRuntimeConfig(projectDir, options);
  const schemes = extractConfiguredSchemes(mergedConfig).map((scheme) => ({
    id: scheme.id,
    label: scheme.label,
    controller: scheme.controller,
    models: buildEditableModelsFromScheme(scheme, settings?.secrets || {})
  }));
  const activeScheme =
    schemes.find((scheme) => scheme.id === runtimeConfig.cluster.activeSchemeId) ||
    schemes[0] || {
      id: DEFAULT_SCHEME_ID,
      label: DEFAULT_SCHEME_LABEL,
      controller: "",
      models: []
    };
  const models = activeScheme.models;

  return {
    configPath,
    settingsPath,
    providerDefinitions: listProviderDefinitions(),
    settings: {
      server: {
        port: normalizePort(mergedConfig?.server?.port, 4040)
      },
      cluster: {
        activeSchemeId: runtimeConfig.cluster.activeSchemeId,
        activeSchemeLabel: runtimeConfig.cluster.activeSchemeLabel,
        controller: runtimeConfig.cluster.controller,
        maxParallel: runtimeConfig.cluster.maxParallel,
        subordinateMaxParallel: runtimeConfig.cluster.subordinateMaxParallel,
        groupLeaderMaxDelegates: runtimeConfig.cluster.groupLeaderMaxDelegates,
        delegateMaxDepth: runtimeConfig.cluster.delegateMaxDepth,
        phaseParallel: normalizePhaseParallelSettings(mergedConfig?.cluster?.phaseParallel),
        agentBudgetProfiles: normalizeAgentBudgetProfiles(mergedConfig?.cluster?.agentBudgetProfiles),
        capabilityRoutingPolicy: normalizeCapabilityRoutingPolicy(
          mergedConfig?.cluster?.capabilityRoutingPolicy
        )
      },
      workspace: {
        dir: normalizeWorkspaceDir(mergedConfig?.workspace?.dir, DEFAULT_WORKSPACE_DIR)
      },
      bot: normalizeBotConfig(mergedConfig?.bot),
      multiAgent: normalizeMultiAgentSettings(mergedConfig?.multiAgent),
      secrets: buildEditableSecrets(schemes.flatMap((scheme) => scheme.models), settings?.secrets || {}),
      schemes,
      models
    }
  };
}

async function saveEditableSettings(projectDir, payload, options = {}) {
  const envPath = resolve(projectDir, ".env");
  loadEnvFile(envPath);

  const { baseConfig } = resolveConfigBundle(projectDir, options);
  const normalized = normalizeSavedSettingsPayload(payload, baseConfig);
  const settingsPath = resolveSettingsPath(projectDir, options);
  const persisted = serializeSavedSettingsSync(settingsPath, normalized);

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  applySecretMapToProcessEnv(normalized.secrets);

  return {
    settingsPath,
    providerDefinitions: listProviderDefinitions(),
    settings: getEditableSettings(projectDir, options).settings
  };
}

function loadRuntimeConfig(projectDir, options = {}) {
  const envPath = resolve(projectDir, ".env");
  loadEnvFile(envPath);

  const { configPath, settingsPath, settings, mergedConfig: parsed } = applyResolvedSecrets(
    resolveConfigBundle(projectDir, options)
  );
  const configuredSchemes = extractConfiguredSchemes(parsed);
  if (!configuredSchemes.length) {
    throw new Error(`Config file ${configPath} must include either a "models" object or a non-empty "schemes" object.`);
  }

  const requestedSchemeId = String(options?.schemeId || "").trim();
  if (requestedSchemeId && !configuredSchemes.some((scheme) => scheme.id === requestedSchemeId)) {
    throw new Error(`Scheme "${requestedSchemeId}" was not found in saved configuration. Save settings before using this scheme.`);
  }
  const preferredSchemeId = requestedSchemeId || String(parsed?.cluster?.activeSchemeId || "").trim();
  const activeSchemeId = resolveSelectedSchemeId(configuredSchemes, preferredSchemeId);
  const activeScheme =
    configuredSchemes.find((scheme) => scheme.id === activeSchemeId) || configuredSchemes[0];
  const controllerId = String(activeScheme?.controller || "").trim();
  const modelsInput = activeScheme?.models;
  if (!controllerId || !modelsInput || typeof modelsInput !== "object" || !modelsInput[controllerId]) {
    throw new Error(`Selected scheme "${activeScheme?.label || activeSchemeId}" must define a valid controller model.`);
  }

  const models = {};
  for (const [modelId, modelConfig] of Object.entries(modelsInput)) {
    models[modelId] = normalizeModelConfig(modelId, modelConfig, controllerId);
  }

  if (!modelRoleAllowsController(models[controllerId].role)) {
    throw new Error(`Selected scheme "${activeScheme?.label || activeSchemeId}" uses a model that cannot act as a controller.`);
  }

  const workerIds = Object.keys(models).filter(
    (modelId) => modelId !== controllerId && modelRoleAllowsWorker(models[modelId].role)
  );
  if (!workerIds.length) {
    throw new Error(`At least one worker-capable model is required besides the controller.`);
  }

  const maxParallel = normalizeNonNegativeInteger(parsed?.cluster?.maxParallel, 3);

  return {
    projectDir,
    configPath,
    settingsPath,
    server: {
      port: normalizePort(parsed?.server?.port, normalizePort(process.env.PORT, 4040))
    },
    cluster: {
      activeSchemeId,
      activeSchemeLabel: activeScheme.label,
      controller: controllerId,
      maxParallel,
      subordinateMaxParallel: maxParallel,
      groupLeaderMaxDelegates: normalizeNonNegativeInteger(
        parsed?.cluster?.groupLeaderMaxDelegates,
        DEFAULT_GROUP_LEADER_MAX_DELEGATES
      ),
      delegateMaxDepth: normalizeNonNegativeInteger(
        parsed?.cluster?.delegateMaxDepth,
        DEFAULT_DELEGATION_MAX_DEPTH
      ),
      phaseParallel: normalizePhaseParallelSettings(parsed?.cluster?.phaseParallel),
      agentBudgetProfiles: normalizeAgentBudgetProfiles(parsed?.cluster?.agentBudgetProfiles),
      capabilityRoutingPolicy: normalizeCapabilityRoutingPolicy(
        parsed?.cluster?.capabilityRoutingPolicy
      ),
      schemes: configuredSchemes.map((scheme) => ({
        id: scheme.id,
        label: scheme.label,
        controller: scheme.controller,
        modelCount: Object.keys(scheme.models || {}).length
      }))
    },
    workspace: {
      dir: normalizeWorkspaceDir(parsed?.workspace?.dir, DEFAULT_WORKSPACE_DIR),
      resolvedDir: resolve(
        projectDir,
        normalizeWorkspaceDir(parsed?.workspace?.dir, DEFAULT_WORKSPACE_DIR)
      )
    },
    bot: normalizeBotConfig(parsed?.bot),
    multiAgent: normalizeMultiAgentSettings(parsed?.multiAgent),
    models
  };
}

function summarizeConfig(config) {
  const controller = config.models[config.cluster.controller];
  const workers = Object.values(config.models).filter((model) => model.id !== controller.id);

  return {
    configPath: config.configPath,
    settingsPath: config.settingsPath,
    controller: {
      id: controller.id,
      label: controller.label,
      model: controller.model,
      provider: controller.provider,
      role: controller.role,
      specialties: controller.specialties
    },
    activeScheme: {
      id: config.cluster.activeSchemeId,
      label: config.cluster.activeSchemeLabel
    },
    schemes: config.cluster.schemes || [],
    workers: workers.map((worker) => ({
      id: worker.id,
      label: worker.label,
      model: worker.model,
      provider: worker.provider,
      role: worker.role,
      specialties: worker.specialties
    })),
    maxParallel: config.cluster.maxParallel,
    subordinateMaxParallel: config.cluster.subordinateMaxParallel,
    groupLeaderMaxDelegates: config.cluster.groupLeaderMaxDelegates,
    delegateMaxDepth: config.cluster.delegateMaxDepth,
    phaseParallel: config.cluster.phaseParallel,
    agentBudgetProfiles: config.cluster.agentBudgetProfiles,
    capabilityRoutingPolicy: config.cluster.capabilityRoutingPolicy,
    workspace: {
      dir: config.workspace.dir,
      resolvedDir: config.workspace.resolvedDir
    },
    bot: {
      installDir: config.bot.installDir,
      enabledPresets: config.bot.enabledPresets
    },
    multiAgent: normalizeMultiAgentSettings(config.multiAgent)
  };
}

module.exports = { saveEditableSettings, loadEnvFile, loadSavedSettings, resolveConfigBundle, applyResolvedSecrets, getEditableSettings, loadRuntimeConfig, summarizeConfig };

},
"/src/operations.mjs": function(module, exports, __require) {
const { createAbortError } = __require("/src/utils/abort.mjs");
const OPERATION_TTL_MS = 5 * 60 * 1000;
const MAX_EVENT_HISTORY = 200;

function now() {
  return Date.now();
}

function createOperationRecord(id, meta = {}) {
  return {
    id,
    meta,
    createdAt: now(),
    updatedAt: now(),
    seq: 0,
    events: [],
    listeners: new Set(),
    finished: false,
    cancellationRequested: false,
    abortController: new AbortController()
  };
}

function writeEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createOperationTracker() {
  const operations = new Map();

  function pruneExpired() {
    const cutoff = now() - OPERATION_TTL_MS;
    for (const [id, operation] of operations.entries()) {
      if (!operation.finished) {
        continue;
      }

      if (operation.updatedAt < cutoff) {
        operations.delete(id);
      }
    }
  }

  function lookupOperation(id) {
    pruneExpired();
    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      return null;
    }
    return operations.get(normalizedId) || null;
  }

  function ensureOperation(id, meta = {}) {
    pruneExpired();

    const normalizedId = String(id || "").trim();
    if (!normalizedId) {
      throw new Error("Operation id is required.");
    }

    let operation = operations.get(normalizedId);
    if (!operation) {
      operation = createOperationRecord(normalizedId, meta);
      operations.set(normalizedId, operation);
    } else if (meta && Object.keys(meta).length) {
      operation.meta = { ...operation.meta, ...meta };
      operation.updatedAt = now();
    }

    return operation;
  }

  function publish(id, payload) {
    const operation = ensureOperation(id);
    const event = {
      seq: ++operation.seq,
      operationId: operation.id,
      timestamp: new Date().toISOString(),
      ...payload
    };

    operation.updatedAt = now();
    operation.events.push(event);
    if (operation.events.length > MAX_EVENT_HISTORY) {
      operation.events.shift();
    }

    if (payload?.type === "complete" || payload?.type === "error") {
      operation.finished = true;
    }

    if (payload?.type === "cancelled") {
      operation.finished = true;
    }

    for (const listener of operation.listeners) {
      writeEvent(listener, event);
    }

    return event;
  }

  function attachStream(id, request, response) {
    const operation = ensureOperation(id);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");

    for (const event of operation.events) {
      writeEvent(response, event);
    }

    operation.listeners.add(response);

    const detach = () => {
      operation.listeners.delete(response);
      if (!response.writableEnded) {
        response.end();
      }
    };

    request.on("close", detach);
    response.on("close", () => {
      operation.listeners.delete(response);
    });
  }

  function getSignal(id) {
    return ensureOperation(id).abortController.signal;
  }

  function getSnapshot(id, options = {}) {
    const operation = lookupOperation(id);
    if (!operation) {
      return null;
    }

    const afterSeq = Math.max(0, Number(options.afterSeq) || 0);
    const events = operation.events.filter((event) => event.seq > afterSeq);
    const lastEvent = operation.events[operation.events.length - 1] || null;

    return {
      id: operation.id,
      meta: { ...operation.meta },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      seq: operation.seq,
      finished: operation.finished,
      cancellationRequested: operation.cancellationRequested,
      lastEvent,
      events
    };
  }

  function cancel(id, options = {}) {
    const operation = lookupOperation(id);
    if (!operation) {
      return {
        ok: false,
        code: "not_found"
      };
    }

    if (operation.finished) {
      return {
        ok: false,
        code: "already_finished"
      };
    }

    if (operation.cancellationRequested) {
      return {
        ok: true,
        alreadyRequested: true
      };
    }

    operation.cancellationRequested = true;
    operation.updatedAt = now();

    publish(operation.id, {
      type: "status",
      stage: "cancel_requested",
      tone: "warning",
      detail: String(options.detail || "Cancellation requested.")
    });

    operation.abortController.abort(
      createAbortError(
        String(options.message || "Operation cancelled by user.")
      )
    );

    return {
      ok: true,
      alreadyRequested: false
    };
  }

  function cancelAll(options = {}) {
    const results = [];

    for (const operation of operations.values()) {
      if (operation.finished) {
        continue;
      }

      results.push(
        cancel(operation.id, {
          detail: options.detail || "Cancellation requested for all active operations.",
          message: options.message || "Operation cancelled because the application is shutting down."
        })
      );
    }

    return {
      ok: true,
      cancelledCount: results.filter((result) => result.ok).length,
      results
    };
  }

  return {
    ensureOperation,
    publish,
    attachStream,
    cancel,
    cancelAll,
    getSignal,
    getSnapshot
  };
}

module.exports = { createOperationTracker };

},
"/src/system/bot-runtime.mjs": function(module, exports, __require) {
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawn } = require("node:child_process");
const { loadRuntimeConfig } = __require("/src/config.mjs");
const MAX_LOG_LENGTH = 12000;
const BOT_STOP_TIMEOUT_MS = 1200;

function compactLog(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > MAX_LOG_LENGTH
    ? normalized.slice(normalized.length - MAX_LOG_LENGTH)
    : normalized;
}

function appendLog(previous, chunk) {
  return compactLog([previous, chunk].filter(Boolean).join("\n"));
}

function parseEnvText(envText) {
  const env = {};
  for (const line of String(envText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    env[match[1]] = match[2];
  }

  return env;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function createBotRuntimeManager({ projectDir, runtimeConfigOptions = {} }) {
  const stateById = new Map();

  function getConfig() {
    return loadRuntimeConfig(projectDir, runtimeConfigOptions);
  }

  function ensureState(botId) {
    const id = String(botId || "").trim();
    if (!id) {
      throw new Error("Bot id is required.");
    }

    const existing = stateById.get(id);
    if (existing) {
      return existing;
    }

    const initial = {
      id,
      status: "stopped",
      pid: null,
      startedAt: 0,
      exitCode: null,
      lastOutput: "",
      lastError: "",
      child: null,
      shutdownPromise: null
    };
    stateById.set(id, initial);
    return initial;
  }

  async function sendKillAndWait(child, signal, timeoutMs = BOT_STOP_TIMEOUT_MS) {
    if (!child || child.exitCode != null || child.signalCode != null) {
      return true;
    }

    const exited = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onClose);
        resolve(value);
      };
      const onExit = () => done(true);
      const onClose = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(50, Number(timeoutMs) || BOT_STOP_TIMEOUT_MS));

      child.once("exit", onExit);
      child.once("close", onClose);

      try {
        child.kill(signal);
      } catch {
        done(child.exitCode != null || child.signalCode != null);
      }
    });

    return exited;
  }

  async function terminateBotProcess(state, options = {}) {
    if (!state?.child) {
      state.status = "stopped";
      state.pid = null;
      return {
        ok: true,
        botId: state?.id || "",
        alreadyStopped: true,
        exited: true
      };
    }

    if (state.shutdownPromise) {
      return state.shutdownPromise;
    }

    const child = state.child;
    const timeoutMs = Math.max(200, Number(options.timeoutMs) || BOT_STOP_TIMEOUT_MS);
    const force = Boolean(options.force);

    state.status = "stopping";
    state.shutdownPromise = (async () => {
      let exited = await sendKillAndWait(child, force ? "SIGKILL" : "SIGTERM", timeoutMs);
      let forced = force;

      if (!exited && !force && state.child === child) {
        forced = true;
        exited = await sendKillAndWait(child, "SIGKILL", Math.max(150, Math.floor(timeoutMs / 2)));
      }

      if (!exited && state.child === child) {
        state.lastError = appendLog(state.lastError, `Bot process did not exit within ${timeoutMs} ms.`);
      }

      return {
        ok: true,
        botId: state.id,
        alreadyStopped: false,
        exited,
        forced
      };
    })();

    try {
      return await state.shutdownPromise;
    } finally {
      if (state.shutdownPromise) {
        state.shutdownPromise = null;
      }
    }
  }

  function connectorScriptPath(config, botId) {
    return join(config.workspace.resolvedDir, config.bot.installDir, botId, "connector-runner.mjs");
  }

  function buildSnapshot(config = null) {
    const runtimeConfig = config || getConfig();
    const knownIds = new Set([
      ...runtimeConfig.bot.enabledPresets,
      ...Object.keys(runtimeConfig.bot.presetConfigs || {}),
      ...Array.from(stateById.keys())
    ]);

    return {
      installDir: runtimeConfig.bot.installDir,
      commandPrefix: runtimeConfig.bot.commandPrefix,
      autoStart: Boolean(runtimeConfig.bot.autoStart),
      progressUpdates: Boolean(runtimeConfig.bot.progressUpdates),
      bots: Array.from(knownIds)
        .sort((left, right) => left.localeCompare(right))
        .map((botId) => {
          const state = ensureState(botId);
          return {
            id: botId,
            enabled: runtimeConfig.bot.enabledPresets.includes(botId),
            configured: Boolean(runtimeConfig.bot.presetConfigs?.[botId]),
            status: state.status,
            pid: state.pid,
            startedAt: state.startedAt,
            exitCode: state.exitCode,
            lastOutput: state.lastOutput,
            lastError: state.lastError
          };
        })
    };
  }

  function stopBot(botId) {
    const state = ensureState(botId);
    if (!state.child) {
      state.status = "stopped";
      state.pid = null;
      return {
        ok: true,
        alreadyStopped: true
      };
    }

    state.status = "stopping";
    void terminateBotProcess(state, {
      force: false,
      timeoutMs: BOT_STOP_TIMEOUT_MS
    });
    return {
      ok: true,
      alreadyStopped: false
    };
  }

  function stopAllBots() {
    for (const botId of Array.from(stateById.keys())) {
      stopBot(botId);
    }
    return {
      ok: true
    };
  }

  async function shutdownAllBots(options = {}) {
    const timeoutMs = Math.max(200, Number(options.timeoutMs) || BOT_STOP_TIMEOUT_MS);
    const force = options.force !== false;
    const activeStates = Array.from(stateById.values()).filter((state) => state.child);
    const results = await Promise.all(
      activeStates.map((state) =>
        terminateBotProcess(state, {
          force,
          timeoutMs
        })
      )
    );

    if (results.some((result) => !result.exited)) {
      await wait(80);
    }

    return {
      ok: true,
      stoppedCount: results.length,
      results,
      runtime: buildSnapshot()
    };
  }

  function startBot(botId, serverUrl) {
    const config = getConfig();
    const state = ensureState(botId);

    if (state.child) {
      return {
        ok: true,
        alreadyRunning: true,
        snapshot: buildSnapshot(config)
      };
    }

    const scriptPath = connectorScriptPath(config, botId);
    if (!existsSync(scriptPath)) {
      throw new Error(`Bot connector script not found: ${scriptPath}. Please install the preset first.`);
    }

    const envText = config.bot.presetConfigs?.[botId]?.envText || "";
    const child = spawn(process.execPath, [scriptPath], {
      cwd: dirname(scriptPath),
      windowsHide: true,
      env: {
        ...process.env,
        ...parseEnvText(envText),
        AGENT_CLUSTER_SERVER_URL: serverUrl,
        AGENT_CLUSTER_BOT_ID: botId,
        AGENT_CLUSTER_COMMAND_PREFIX: config.bot.commandPrefix,
        AGENT_CLUSTER_PROGRESS_UPDATES: config.bot.progressUpdates ? "1" : "0"
      }
    });

    state.child = child;
    state.status = "running";
    state.pid = child.pid || null;
    state.startedAt = Date.now();
    state.exitCode = null;
    state.lastError = "";
    state.lastOutput = "";

    child.stdout?.on("data", (chunk) => {
      state.lastOutput = appendLog(state.lastOutput, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      state.lastError = appendLog(state.lastError, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      state.lastError = appendLog(state.lastError, error.message);
      state.status = "failed";
      state.child = null;
      state.pid = null;
    });
    child.on("exit", (code) => {
      state.exitCode = code;
      state.status = code === 0 || state.status === "stopping" ? "stopped" : "failed";
      state.child = null;
      state.pid = null;
    });

    return {
      ok: true,
      alreadyRunning: false,
      snapshot: buildSnapshot(config)
    };
  }

  function startEnabledBots(serverUrl) {
    const config = getConfig();
    const started = [];
    for (const botId of config.bot.enabledPresets) {
      startBot(botId, serverUrl);
      started.push(botId);
    }

    return {
      ok: true,
      started,
      snapshot: buildSnapshot(config)
    };
  }

  function ensureAutoStart(serverUrl) {
    const config = getConfig();
    if (!config.bot.autoStart) {
      return {
        ok: true,
        started: [],
        snapshot: buildSnapshot(config)
      };
    }

    return startEnabledBots(serverUrl);
  }

  return {
    buildSnapshot,
    ensureAutoStart,
    shutdownAllBots,
    startBot,
    startEnabledBots,
    stopBot,
    stopAllBots
  };
}

module.exports = { createBotRuntimeManager };

},
"/src/http/common.mjs": function(module, exports, __require) {
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function resolveStaticAssetPath(urlPathname) {
  if (!String(urlPathname || "").startsWith("/assets/")) {
    return "";
  }

  const relativePath = decodeURIComponent(String(urlPathname).slice("/assets/".length))
    .replaceAll("\\", "/")
    .trim();
  if (!relativePath || relativePath.startsWith("/")) {
    return "";
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "";
  }

  return relativePath;
}

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

function resolveOperationId(body, fallbackPrefix, randomUuid) {
  const explicit = String(body?.operationId || "").trim();
  return explicit || `${fallbackPrefix}_${randomUuid()}`;
}

function resolveServerUrl(request) {
  const port = request?.socket?.localPort || 0;
  return `http://127.0.0.1:${port}`;
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

module.exports = { readRequestBody, serveStaticFile, resolveStaticAssetPath, delay, sendJson, sendText, resolveOperationId, resolveServerUrl };

},
"/src/http/settings-routes.mjs": function(module, exports, __require) {
const { getEditableSettings, loadRuntimeConfig, saveEditableSettings, summarizeConfig } = __require("/src/config.mjs");
const { readRequestBody, sendJson } = __require("/src/http/common.mjs");
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

module.exports = { handleConfigRequest, handleSettingsRequest, handleSettingsSave };

},
"/src/http/cluster-routes.mjs": function(module, exports, __require) {
const { resolve } = require("node:path");
const { createProviderRegistry } = __require("/src/providers/factory.mjs");
const { testModelConnectivity } = __require("/src/providers/connectivity-test.mjs");
const { runClusterAnalysis } = __require("/src/cluster/orchestrator.mjs");
const { loadRuntimeConfig, summarizeConfig } = __require("/src/config.mjs");
const { writeClusterRunLog } = __require("/src/run-log-store.mjs");
const { isAbortError } = __require("/src/utils/abort.mjs");
const { readRequestBody, resolveOperationId, sendJson } = __require("/src/http/common.mjs");
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

async function executeClusterOperation({
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

async function handleClusterRun(
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

async function handleOperationCancel(
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

async function handleModelTest(request, response, operationTracker, randomUuid) {
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


module.exports = { executeClusterOperation, handleClusterRun, handleOperationCancel, handleModelTest, handleOperationSnapshot };

},
"/src/http/workspace-routes.mjs": function(module, exports, __require) {
const { randomUUID } = require("node:crypto");
const { isAbsolute, resolve } = require("node:path");
const { loadRuntimeConfig } = __require("/src/config.mjs");
const { pickFolderDialog } = __require("/src/system/dialogs.mjs");
const { ensureWorkspaceDirectory, getWorkspaceFilePreview, getWorkspaceTree, writeWorkspaceFiles } = __require("/src/workspace/fs.mjs");
const { clearClusterRunCache } = __require("/src/workspace/cache.mjs");
const { readRequestBody, sendJson } = __require("/src/http/common.mjs");
const FOLDER_PICK_JOB_TTL_MS = 5 * 60 * 1000;

function createFolderPickJobSnapshot(job) {
  if (!job) {
    return null;
  }

  return {
    jobId: job.id,
    status: job.status,
    path: job.path,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function createFolderPickJobStore({
  pickFolder = pickFolderDialog,
  createId = () => randomUUID(),
  now = () => Date.now(),
  ttlMs = FOLDER_PICK_JOB_TTL_MS
} = {}) {
  const jobs = new Map();

  function cleanup(currentTime = now()) {
    for (const [jobId, job] of jobs.entries()) {
      if (job.status === "pending") {
        continue;
      }
      if (job.expiresAt > 0 && job.expiresAt <= currentTime) {
        jobs.delete(jobId);
      }
    }
  }

  function finalize(job, nextState) {
    job.status = nextState.status;
    job.path = nextState.path ?? "";
    job.error = nextState.error ?? "";
    job.updatedAt = now();
    job.expiresAt = job.updatedAt + ttlMs;
    return createFolderPickJobSnapshot(job);
  }

  function start(initialDir = "") {
    cleanup();

    const createdAt = now();
    const job = {
      id: createId(),
      status: "pending",
      path: "",
      error: "",
      createdAt,
      updatedAt: createdAt,
      expiresAt: 0
    };
    jobs.set(job.id, job);

    Promise.resolve()
      .then(() => pickFolder(initialDir))
      .then((selectedPath) => {
        finalize(job, {
          status: selectedPath ? "completed" : "cancelled",
          path: String(selectedPath || "")
        });
      })
      .catch((error) => {
        finalize(job, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error || "Folder picker failed.")
        });
      });

    return createFolderPickJobSnapshot(job);
  }

  function get(jobId) {
    cleanup();
    return createFolderPickJobSnapshot(jobs.get(String(jobId || "").trim()));
  }

  return {
    cleanup,
    get,
    start
  };
}

const folderPickJobStore = createFolderPickJobStore();

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

async function handleWorkspaceCacheClear(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspaceDir = String(body?.workspaceDir || "").trim();
    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const cache = await clearClusterRunCache(workspace.resolvedDir);

    sendJson(response, 200, {
      ok: true,
      workspace,
      cache
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
    sendJson(response, 200, {
      ok: true,
      ...folderPickJobStore.start(workspace.resolvedDir)
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleFolderPickStatus(response, url) {
  try {
    const jobId = String(url.searchParams.get("jobId") || "").trim();
    if (!jobId) {
      sendJson(response, 400, {
        ok: false,
        error: "Folder pick job id is required."
      });
      return;
    }

    const job = folderPickJobStore.get(jobId);
    if (!job) {
      sendJson(response, 404, {
        ok: false,
        error: "Folder pick job was not found or has expired."
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      ...job
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

module.exports = { handleWorkspaceSummary, handleWorkspaceFileRead, handleWorkspaceFileWrite, handleWorkspaceImport, handleWorkspaceCacheClear, handleFolderPick, handleFolderPickStatus, createFolderPickJobStore, resolveWorkspaceRequestContext };

},
"/src/http/bot-routes.mjs": function(module, exports, __require) {
const { loadRuntimeConfig } = __require("/src/config.mjs");
const { installBotCustomCommand, installBotPluginPreset, listBotPluginPresets } = __require("/src/system/bot-plugins.mjs");
const { readRequestBody, resolveOperationId, resolveServerUrl, sendJson } = __require("/src/http/common.mjs");
const { executeClusterOperation } = __require("/src/http/cluster-routes.mjs");
const { resolveWorkspaceRequestContext } = __require("/src/http/workspace-routes.mjs");
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

async function handleBotIncoming(
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
      locale: String(body?.locale || "").trim(),
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

module.exports = { handleBotPresets, handleBotPresetInstall, handleBotCustomInstall, handleBotIncoming, handleBotRuntimeSnapshot, handleBotRuntimeStart, handleBotRuntimeStop, handleBotRuntimeAutoStart };

},
"/src/http/system-routes.mjs": function(module, exports, __require) {
const { sendJson } = __require("/src/http/common.mjs");
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

module.exports = { handleSystemExit };

},
"/src/security/secrets.mjs": function(module, exports, __require) {
const { spawnSync } = require("node:child_process");
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const SETTINGS_ENCRYPTION_VERSION = 1;
const LOCAL_KEY_FILENAME = ".agent-cluster.key";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSecretMap(secrets) {
  const normalized = {};
  if (!secrets || typeof secrets !== "object") {
    return normalized;
  }

  for (const [name, value] of Object.entries(secrets)) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) {
      continue;
    }
    normalized[normalizedName] = String(value ?? "");
  }

  return normalized;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShellSync(script, env = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script)
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env
      }
    }
  );

  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || "PowerShell secret operation failed.").trim()
    );
  }

  return String(result.stdout || "").trim();
}

function protectWindowsDpapiSync(plainText) {
  const payload = Buffer.from(String(plainText || ""), "utf8").toString("base64");
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$plain = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENT_CLUSTER_SECRET_INPUT_B64))
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
ConvertFrom-SecureString $secure
`;

  return {
    provider: "windows-dpapi",
    version: SETTINGS_ENCRYPTION_VERSION,
    payload: runPowerShellSync(script, {
      AGENT_CLUSTER_SECRET_INPUT_B64: payload
    })
  };
}

function unprotectWindowsDpapiSync(blob) {
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
$secure = ConvertTo-SecureString $env:AGENT_CLUSTER_SECRET_INPUT
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($plain))
} finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
`;

  const base64 = runPowerShellSync(script, {
    AGENT_CLUSTER_SECRET_INPUT: String(blob?.payload || "")
  });
  return Buffer.from(base64, "base64").toString("utf8");
}

function resolveLocalKeyPath(settingsPath) {
  return join(dirname(settingsPath), LOCAL_KEY_FILENAME);
}

function loadOrCreateLocalKeySync(settingsPath) {
  const configured = String(process.env.AGENT_CLUSTER_MASTER_KEY || "").trim();
  if (configured) {
    return createHash("sha256").update(configured).digest();
  }

  const keyPath = resolveLocalKeyPath(settingsPath);
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  }

  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${key.toString("base64")}\n`, "utf8");
  return key;
}

function protectLocalAesSync(plainText, settingsPath) {
  const key = loadOrCreateLocalKeySync(settingsPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(String(plainText || ""), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    provider: "local-aes-gcm",
    version: SETTINGS_ENCRYPTION_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    payload: payload.toString("base64")
  };
}

function unprotectLocalAesSync(blob, settingsPath) {
  const key = loadOrCreateLocalKeySync(settingsPath);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(blob?.iv || ""), "base64")
  );
  decipher.setAuthTag(Buffer.from(String(blob?.tag || ""), "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(blob?.payload || ""), "base64")),
    decipher.final()
  ]);
  return plain.toString("utf8");
}

function protectSecretMapSync(secrets, { settingsPath } = {}) {
  const normalizedSecrets = normalizeSecretMap(secrets);
  if (!Object.keys(normalizedSecrets).length) {
    return null;
  }

  const plainText = JSON.stringify(normalizedSecrets);
  if (process.platform === "win32") {
    return protectWindowsDpapiSync(plainText);
  }

  return protectLocalAesSync(plainText, settingsPath);
}

function unprotectSecretMapSync(blob, { settingsPath } = {}) {
  if (!blob || typeof blob !== "object") {
    return {};
  }

  const provider = String(blob.provider || "").trim();
  let plainText = "";

  if (provider === "windows-dpapi") {
    plainText = unprotectWindowsDpapiSync(blob);
  } else if (provider === "local-aes-gcm") {
    plainText = unprotectLocalAesSync(blob, settingsPath);
  } else {
    throw new Error(`Unsupported secret encryption provider "${provider}".`);
  }

  return normalizeSecretMap(JSON.parse(plainText));
}

function materializeSavedSettingsSync(settingsPath, rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object") {
    return rawSettings;
  }

  const settings = cloneJson(rawSettings);
  if (settings.secretsEncrypted && !settings.secrets) {
    settings.secrets = unprotectSecretMapSync(settings.secretsEncrypted, { settingsPath });
    return settings;
  }

  if (settings.secrets && !settings.secretsEncrypted) {
    settings.secrets = normalizeSecretMap(settings.secrets);
    settings.secretsEncrypted = protectSecretMapSync(settings.secrets, { settingsPath });
    const toPersist = cloneJson(settings);
    delete toPersist.secrets;
    writeFileSync(settingsPath, `${JSON.stringify(toPersist, null, 2)}\n`, "utf8");
    return settings;
  }

  settings.secrets = normalizeSecretMap(settings.secrets);
  return settings;
}

function serializeSavedSettingsSync(settingsPath, settings) {
  const normalized = cloneJson(settings || {});
  normalized.secrets = normalizeSecretMap(normalized.secrets);
  normalized.secretsEncrypted = protectSecretMapSync(normalized.secrets, { settingsPath });
  delete normalized.secrets;
  return normalized;
}

module.exports = { protectSecretMapSync, unprotectSecretMapSync, materializeSavedSettingsSync, serializeSavedSettingsSync };

},
"/src/security/process-env.mjs": function(module, exports, __require) {
function applySecretMapToProcessEnv(secrets) {
  if (!secrets || typeof secrets !== "object") {
    return;
  }

  for (const [name, value] of Object.entries(secrets)) {
    if (name && typeof value === "string") {
      process.env[name] = value;
    }
  }
}

module.exports = { applySecretMapToProcessEnv };

},
"/src/static/provider-catalog.js": function(module, exports, __require) {
const RAW_PROVIDER_CATALOG = [
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    group: "Global",
    protocol: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: true,
      thinking: true,
      webSearch: true,
      temperature: false
    },
    exampleModels: ["gpt-5.4", "gpt-5.3-codex"],
    description: "Official OpenAI Responses API and compatible gateways."
  },
  {
    id: "openai-chat",
    label: "OpenAI Chat",
    group: "Global",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["gpt-4.1", "gpt-4.1-mini"],
    description: "Chat Completions API and OpenAI-compatible gateways."
  },
  {
    id: "claude-chat",
    label: "Claude",
    group: "Global",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultAuthStyle: "api-key",
    defaultApiKeyHeader: "x-api-key",
    capabilities: {
      reasoning: false,
      thinking: true,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["claude-sonnet-4-5", "claude-opus-4-1"],
    description: "Official Anthropic Messages API."
  },
  {
    id: "qwen-chat",
    label: "Qwen Chat",
    group: "China",
    protocol: "openai-chat",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["qwen-max", "qwen-plus"],
    description: "DashScope OpenAI-compatible chat endpoint for Qwen."
  },
  {
    id: "qwen-responses",
    label: "Qwen Responses",
    group: "China",
    protocol: "openai-responses",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: false
    },
    exampleModels: ["qwen3-max"],
    description: "DashScope OpenAI-compatible Responses endpoint for Qwen."
  },
  {
    id: "kimi-chat",
    label: "Kimi Chat",
    group: "China",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: true,
      webSearch: true,
      temperature: true
    },
    exampleModels: ["kimi-k2.5", "moonshot-v1-32k"],
    description:
      "Moonshot Kimi OpenAI-compatible chat endpoint. Web search uses the official $web_search built-in tool."
  },
  {
    id: "kimi-coding",
    label: "Kimi Coding",
    group: "China",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.moonshot.cn/anthropic",
    defaultAuthStyle: "api-key",
    defaultApiKeyHeader: "x-api-key",
    capabilities: {
      reasoning: false,
      thinking: true,
      webSearch: true,
      temperature: true
    },
    exampleModels: ["kimi-k2.5"],
    description:
      "Moonshot Kimi Coding Anthropic-compatible endpoint. Use the /anthropic base URL and the Anthropic web search tool."
  },
  {
    id: "doubao-chat",
    label: "Doubao Chat",
    group: "China",
    protocol: "openai-chat",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["doubao-seed-1.6", "doubao-1.5-pro-32k"],
    description: "Volcengine Ark chat endpoint for Doubao-compatible models."
  },
  {
    id: "doubao-responses",
    label: "Doubao Responses",
    group: "China",
    protocol: "openai-responses",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: false
    },
    exampleModels: ["doubao-seed-1.6"],
    description: "Volcengine Ark Responses-compatible endpoint."
  }
];

const DEFAULT_PROVIDER_ID = "openai-chat";

const PROVIDER_CATALOG = Object.freeze(
  RAW_PROVIDER_CATALOG.map((entry) =>
    Object.freeze({
      ...entry,
      exampleModels: Object.freeze([...(entry.exampleModels || [])]),
      capabilities: Object.freeze({
        reasoning: Boolean(entry.capabilities?.reasoning),
        thinking: Boolean(entry.capabilities?.thinking),
        webSearch: Boolean(entry.capabilities?.webSearch),
        temperature: Boolean(entry.capabilities?.temperature)
      })
    })
  )
);

const PROVIDER_BY_ID = new Map(PROVIDER_CATALOG.map((entry) => [entry.id, entry]));

function normalizeProviderId(value) {
  return String(value || "").trim();
}

function getProviderDefinition(providerId) {
  return PROVIDER_BY_ID.get(normalizeProviderId(providerId)) || null;
}

function getSupportedProviderIds() {
  return PROVIDER_CATALOG.map((entry) => entry.id);
}

function isSupportedProvider(providerId) {
  return PROVIDER_BY_ID.has(normalizeProviderId(providerId));
}

function resolveProviderProtocol(providerId) {
  const definition = getProviderDefinition(providerId);
  return definition?.protocol || normalizeProviderId(providerId);
}

function providerSupportsCapability(providerId, capability) {
  const definition = getProviderDefinition(providerId);
  return Boolean(definition?.capabilities?.[capability]);
}

function listProviderDefinitions() {
  return PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    exampleModels: [...entry.exampleModels],
    capabilities: { ...entry.capabilities }
  }));
}

module.exports = { normalizeProviderId, getProviderDefinition, getSupportedProviderIds, isSupportedProvider, resolveProviderProtocol, providerSupportsCapability, listProviderDefinitions, DEFAULT_PROVIDER_ID, PROVIDER_CATALOG };

},
"/src/cluster/policies.mjs": function(module, exports, __require) {
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const AGENT_COUNT_UNIT_PATTERN = String.raw`(?:\u4e2a|\u540d|\u4f4d|\u53f0)`;
const AGENT_COUNT_TERM_PATTERN = String.raw`(?:child\s+agents?|sub-?agents?|agents?|agent|workers?|worker|\u667a\u80fd\u4f53|\u4ee3\u7406|\u5b50\u4ee3\u7406|\u5b50agent)`;
const GLOBAL_AGENT_COUNT_PATTERNS = [
  new RegExp(
    String.raw`(?:\u603b\u5171|\u4e00\u5171|\u603b\u6570|\u603b\u8ba1|\u6574\u4f53|\u5168\u90e8|\u5168\u5c40|overall|total(?:\s+of)?|in\s+total)\s*(?:\u8c03\u7528|\u8c03\u5ea6|\u5b89\u6392|\u4f7f\u7528|\u542f\u7528|use|run|launch|spawn|create|start|deploy|assign|schedule|call)?\s*(\d{1,4})\s*(?:${AGENT_COUNT_UNIT_PATTERN})?\s*(?:${AGENT_COUNT_TERM_PATTERN})`,
    "giu"
  ),
  new RegExp(
    String.raw`(?:${AGENT_COUNT_TERM_PATTERN})\s*(?:\u603b\u6570|\u603b\u5171|overall|total)\s*(?::|=|\u4e3a)?\s*(\d{1,4})`,
    "giu"
  )
];
const DIRECT_AGENT_COUNT_PATTERNS = [
  new RegExp(
    String.raw`(?:\u8c03\u7528|\u8c03\u5ea6|\u5b89\u6392|\u4f7f\u7528|\u542f\u7528|\u751f\u6210|\u521b\u5efa|use|run|launch|spawn|create|start|deploy|assign|schedule|call)\s*(\d{1,4})\s*(?:${AGENT_COUNT_UNIT_PATTERN})?\s*(?:${AGENT_COUNT_TERM_PATTERN})`,
    "giu"
  ),
  new RegExp(
    String.raw`(\d{1,4})\s*(?:${AGENT_COUNT_UNIT_PATTERN})?\s*(?:${AGENT_COUNT_TERM_PATTERN})`,
    "giu"
  )
];

const DEFAULT_AGENT_BUDGET_PROFILES = Object.freeze({
  simple: Object.freeze({
    maxScore: 1,
    maxTopLevelTasks: 1,
    maxChildrenPerLeader: 0,
    maxDelegationDepth: 0,
    maxTotalAgents: 2
  }),
  moderate: Object.freeze({
    maxScore: 4,
    maxTopLevelTasks: 2,
    maxChildrenPerLeader: 2,
    maxDelegationDepth: 1,
    maxTotalAgents: 5
  }),
  complex: Object.freeze({
    maxScore: 7,
    maxTopLevelTasks: 3,
    maxChildrenPerLeader: 3,
    maxDelegationDepth: 2,
    maxTotalAgents: 8
  }),
  veryComplex: Object.freeze({
    maxScore: Number.POSITIVE_INFINITY,
    maxTopLevelTasks: 4,
    maxChildrenPerLeader: 4,
    maxDelegationDepth: 2,
    maxTotalAgents: 12
  })
});

const DEFAULT_CAPABILITY_ROUTING_POLICY = Object.freeze({
  requireWebSearchForFreshFacts: true,
  preferWebSearchForResearch: true,
  requireValidationSpecialistForValidation: true,
  requireCodingManagerForCodeReview: true,
  preferCodexForImplementation: true,
  requirePhaseSpecialistForHandoff: false
});

function safeString(value) {
  return String(value || "").trim();
}

function clampNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return Math.floor(numeric);
}

function collectPositiveMatches(text, patterns) {
  const source = safeString(text);
  if (!source) {
    return [];
  }

  return patterns.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => clampNonNegativeInt(match[1], 0)).filter(
      (value) => value > 0
    )
  );
}

function textBlob(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function normalizeBudgetProfile(profile, fallbackProfile) {
  const fallback = fallbackProfile && typeof fallbackProfile === "object" ? fallbackProfile : {};
  const source = profile && typeof profile === "object" ? profile : {};

  return {
    maxScore: Math.max(0, Number(source.maxScore ?? fallback.maxScore ?? 0) || 0),
    maxTopLevelTasks: Math.max(
      1,
      clampNonNegativeInt(source.maxTopLevelTasks, clampNonNegativeInt(fallback.maxTopLevelTasks, 1))
    ),
    maxChildrenPerLeader: Math.max(
      0,
      clampNonNegativeInt(
        source.maxChildrenPerLeader,
        clampNonNegativeInt(fallback.maxChildrenPerLeader, 0)
      )
    ),
    maxDelegationDepth: Math.max(
      0,
      clampNonNegativeInt(
        source.maxDelegationDepth,
        clampNonNegativeInt(fallback.maxDelegationDepth, 0)
      )
    ),
    maxTotalAgents: Math.max(
      1,
      clampNonNegativeInt(source.maxTotalAgents, clampNonNegativeInt(fallback.maxTotalAgents, 1))
    )
  };
}

function normalizeAgentBudgetProfiles(value, fallback = DEFAULT_AGENT_BUDGET_PROFILES) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_AGENT_BUDGET_PROFILES;

  return {
    simple: normalizeBudgetProfile(source.simple, backup.simple),
    moderate: normalizeBudgetProfile(source.moderate, backup.moderate),
    complex: normalizeBudgetProfile(source.complex, backup.complex),
    veryComplex: normalizeBudgetProfile(source.veryComplex, backup.veryComplex)
  };
}

function normalizeCapabilityRoutingPolicy(value, fallback = DEFAULT_CAPABILITY_ROUTING_POLICY) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_CAPABILITY_ROUTING_POLICY;

  return {
    requireWebSearchForFreshFacts: Boolean(
      source.requireWebSearchForFreshFacts ?? backup.requireWebSearchForFreshFacts
    ),
    preferWebSearchForResearch: Boolean(
      source.preferWebSearchForResearch ?? backup.preferWebSearchForResearch
    ),
    requireValidationSpecialistForValidation: Boolean(
      source.requireValidationSpecialistForValidation ?? backup.requireValidationSpecialistForValidation
    ),
    requireCodingManagerForCodeReview: Boolean(
      source.requireCodingManagerForCodeReview ?? backup.requireCodingManagerForCodeReview
    ),
    preferCodexForImplementation: Boolean(
      source.preferCodexForImplementation ?? backup.preferCodexForImplementation
    ),
    requirePhaseSpecialistForHandoff: Boolean(
      source.requirePhaseSpecialistForHandoff ?? backup.requirePhaseSpecialistForHandoff
    )
  };
}

function getOrderedAgentBudgetProfiles(value) {
  const profiles = normalizeAgentBudgetProfiles(value);
  return [
    { level: "simple", ...profiles.simple },
    { level: "moderate", ...profiles.moderate },
    { level: "complex", ...profiles.complex },
    { level: "very_complex", ...profiles.veryComplex }
  ].sort((left, right) => left.maxScore - right.maxScore);
}

function scoreTextComplexity(text) {
  const normalized = safeString(text).toLowerCase();
  if (!normalized) {
    return {
      score: 0,
      atomic: false
    };
  }

  let score = 0;
  if (normalized.length >= 80) {
    score += 1;
  }
  if (normalized.length >= 180) {
    score += 1;
  }
  if (normalized.length >= 320) {
    score += 1;
  }

  const signalBuckets = [
    /\b(multiple|several|many|parallel|split|batch|compare|survey|collect|across|cross-check|recursive|hierarchical|delegate|coordinate|streams?|tracks?)\b|(?:多个|并行|拆分|批量|对比|调研|收集|跨|递归|层级|委派|分线)/,
    /\b(implementation|implement|refactor|debug|fix(?:es|ing)?|changes?|validate|validation|review|test|build|migrate|integrate|workspace|repository|repo|code|document|report|artifact)\b|(?:实现|重构|调试|修复|变更|验证|测试|构建|工作区|仓库|代码|文档|报告|交付)/,
    /\b(research|evidence|sources?|facts?|current|fresh|web|search|browse|verification)\b|(?:研究|证据|来源|事实|最新|实时|网页|搜索|浏览|核验)/,
    /\b(2|3|4|5|6|7|8|9|two|three|four|five|six|seven|eight|nine|double|triple)\b|(?:两个|三个|四个|五个|六个|七个|八个|九个|两名|三名)/
  ];
  for (const bucket of signalBuckets) {
    if (bucket.test(normalized)) {
      score += 1;
    }
  }

  if (
    /\b(end-to-end|across the codebase|multiple independent|non-overlapping|source clusters?|handoff|pipeline|workflow)\b|(?:端到端|跨代码库|跨文件|多个独立|不重叠|交付|流程)/.test(
      normalized
    )
  ) {
    score += 1;
  }
  if (
    /\b(recursive|hierarchical|nested|tree|grandchild|depth)\b|(?:递归|层级|嵌套|树形|子孙|深度)/.test(
      normalized
    )
  ) {
    score += 1;
  }

  const atomic =
    /(atomic|single(?: file| document| report)?|one file|one document|one report|directly|quick fix|minor|typo|small change|one step)|(?:单个|单文件|单文档|单报告|直接|快速修复|小改动|错字|一步)/.test(
      normalized
    );
  const strongScaleSignal =
    /\b(multiple|parallel|split|compare|survey|collect|recursive|hierarchical|across|delegate)\b|(?:多个|并行|拆分|对比|调研|收集|递归|层级|委派|跨)/.test(
      normalized
    );

  if (atomic && !strongScaleSignal) {
    score = Math.max(0, score - 2);
  }

  return {
    score: Math.max(0, score),
    atomic
  };
}

function normalizeDelegateCount(value, maxDelegates = DEFAULT_GROUP_LEADER_MAX_DELEGATES) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1) {
    return 0;
  }

  if (!Number.isFinite(maxDelegates) || maxDelegates < 0) {
    return Math.min(DEFAULT_GROUP_LEADER_MAX_DELEGATES, Math.floor(count));
  }

  if (Math.floor(maxDelegates) === 0) {
    return 0;
  }

  return Math.min(Math.floor(maxDelegates), Math.floor(count));
}

function scorePlanComplexity(rawPlan) {
  const tasks = Array.isArray(rawPlan?.tasks) ? rawPlan.tasks : [];
  let score = 0;

  if (tasks.length >= 2) {
    score += 2;
  }
  if (tasks.length >= 4) {
    score += 1;
  }

  const uniqueWorkers = new Set(tasks.map((task) => safeString(task?.assignedWorker)).filter(Boolean));
  if (uniqueWorkers.size >= 2) {
    score += 1;
  }

  const uniquePhases = new Set(
    tasks.map((task) => safeString(task?.phase).toLowerCase() || "implementation")
  );
  if (uniquePhases.size >= 2) {
    score += 1;
  }
  if (uniquePhases.size >= 3) {
    score += 1;
  }

  const dependencyCount = tasks.reduce(
    (sum, task) => sum + (Array.isArray(task?.dependsOn) ? task.dependsOn.length : 0),
    0
  );
  if (dependencyCount > 0) {
    score += 1;
  }

  const explicitDelegates = tasks.reduce(
    (sum, task) => sum + normalizeDelegateCount(task?.delegateCount, DEFAULT_GROUP_LEADER_MAX_DELEGATES),
    0
  );
  if (explicitDelegates >= 2) {
    score += 1;
  }
  if (explicitDelegates >= 5) {
    score += 1;
  }

  const planText = textBlob(
    rawPlan?.objective,
    rawPlan?.strategy,
    tasks.flatMap((task) => [task?.title, task?.instructions, task?.expectedOutput])
  );
  score += Math.min(3, scoreTextComplexity(planText).score);

  return score;
}

function selectComplexityBudgetProfile(score, profiles) {
  return (
    profiles.find((profile) => score <= profile.maxScore) ||
    profiles[profiles.length - 1]
  );
}

function buildStructuralAgentCeiling(topLevelLimit, childrenPerLeader, delegationDepth) {
  let total = Math.max(1, topLevelLimit);
  let frontier = Math.max(1, topLevelLimit);

  for (let depth = 0; depth < delegationDepth; depth += 1) {
    frontier *= Math.max(0, childrenPerLeader);
    if (!frontier) {
      break;
    }
    total += frontier;
  }

  return total;
}

function parseExplicitTotalAgentRequest(text) {
  const globalMatches = collectPositiveMatches(text, GLOBAL_AGENT_COUNT_PATTERNS);
  if (globalMatches.length) {
    return Math.max(...globalMatches);
  }

  const directMatches = collectPositiveMatches(text, DIRECT_AGENT_COUNT_PATTERNS);
  if (directMatches.length) {
    return Math.max(...directMatches);
  }

  return null;
}

function resolveTopLevelTaskLimit(maxParallel, workers, complexityBudget = null) {
  const budgetLimit = clampNonNegativeInt(complexityBudget?.maxTopLevelTasks, 0);
  if (budgetLimit > 0) {
    return budgetLimit;
  }

  return Math.max(1, Math.max(workers.length, clampNonNegativeInt(maxParallel, 0)));
}

function resolveEffectiveGroupLeaderMaxDelegates(config, complexityBudget = null) {
  const configured = clampNonNegativeInt(
    config?.cluster?.groupLeaderMaxDelegates,
    DEFAULT_GROUP_LEADER_MAX_DELEGATES
  );
  const budgeted = clampNonNegativeInt(complexityBudget?.maxChildrenPerLeader, configured);
  return Math.min(configured, budgeted);
}

function resolveEffectiveDelegateMaxDepth(config, complexityBudget = null) {
  const configured = clampNonNegativeInt(
    config?.cluster?.delegateMaxDepth,
    DEFAULT_DELEGATION_MAX_DEPTH
  );
  const budgeted = clampNonNegativeInt(complexityBudget?.maxDelegationDepth, configured);
  return Math.min(configured, budgeted);
}

function buildComplexityBudget({ originalTask, rawPlan = null, workers = [], config }) {
  const profiles = getOrderedAgentBudgetProfiles(config?.cluster?.agentBudgetProfiles);
  const workerCount = Math.max(1, workers.length || 0);
  const objectiveComplexity = scoreTextComplexity(originalTask);
  const requestedTotalAgents = parseExplicitTotalAgentRequest(originalTask);
  let score = objectiveComplexity.score;

  if (rawPlan) {
    score += scorePlanComplexity(rawPlan);
  }
  if (objectiveComplexity.atomic) {
    score = Math.min(score, 1);
  }

  const profile = selectComplexityBudgetProfile(score, profiles);
  const configuredTopLevelLimit = (() => {
    const configured = clampNonNegativeInt(config?.cluster?.maxParallel, 0);
    return configured > 0 ? Math.max(1, configured) : workerCount;
  })();
  const profileMaxTopLevelTasks = Math.max(1, Math.min(profile.maxTopLevelTasks, configuredTopLevelLimit));
  const profileMaxDelegationDepth = resolveEffectiveDelegateMaxDepth(config, {
    maxDelegationDepth: profile.maxDelegationDepth
  });
  const profileMaxChildrenPerLeader =
    profileMaxDelegationDepth > 0
      ? resolveEffectiveGroupLeaderMaxDelegates(config, {
        maxChildrenPerLeader: profile.maxChildrenPerLeader
      })
      : 0;
  let maxTopLevelTasks = profileMaxTopLevelTasks;
  let maxDelegationDepth = profileMaxDelegationDepth;
  let maxChildrenPerLeader = profileMaxChildrenPerLeader;
  let structuralAgentCeiling = buildStructuralAgentCeiling(
    maxTopLevelTasks,
    maxChildrenPerLeader,
    maxDelegationDepth
  );
  let maxTotalAgents = Math.max(
    maxTopLevelTasks,
    Math.min(profile.maxTotalAgents, structuralAgentCeiling)
  );
  let budgetSource = "complexity_profile";

  if (requestedTotalAgents) {
    const configuredMaxDelegationDepth = resolveEffectiveDelegateMaxDepth(config, null);
    const configuredMaxChildrenPerLeader =
      configuredMaxDelegationDepth > 0 ? resolveEffectiveGroupLeaderMaxDelegates(config, null) : 0;
    const perLeaderCapacity = buildStructuralAgentCeiling(
      1,
      configuredMaxChildrenPerLeader,
      configuredMaxDelegationDepth
    );
    const minimumTopLevelTasksNeeded = Math.max(
      1,
      Math.ceil(requestedTotalAgents / Math.max(1, perLeaderCapacity))
    );

    maxDelegationDepth = configuredMaxDelegationDepth;
    maxChildrenPerLeader = configuredMaxChildrenPerLeader;
    maxTopLevelTasks = Math.max(
      1,
      Math.min(
        configuredTopLevelLimit,
        Math.max(
          Math.min(profileMaxTopLevelTasks, requestedTotalAgents),
          minimumTopLevelTasksNeeded
        )
      )
    );
    structuralAgentCeiling = buildStructuralAgentCeiling(
      maxTopLevelTasks,
      maxChildrenPerLeader,
      maxDelegationDepth
    );
    maxTotalAgents = Math.max(
      maxTopLevelTasks,
      Math.min(requestedTotalAgents, structuralAgentCeiling)
    );
    budgetSource =
      maxTotalAgents >= requestedTotalAgents ? "user_request" : "user_request_capped_by_runtime";
  }

  return {
    level: profile.level,
    score,
    maxTopLevelTasks,
    maxChildrenPerLeader,
    maxDelegationDepth,
    maxTotalAgents,
    requestedTotalAgents,
    autoBudgetMaxTotalAgents: profile.maxTotalAgents,
    budgetSource
  };
}

function createRunAgentBudget(complexityBudget, topLevelTaskCount) {
  const normalizedTopLevelCount = Math.max(0, clampNonNegativeInt(topLevelTaskCount, 0));
  const initialMaxTotalAgents = Math.max(
    normalizedTopLevelCount || 1,
    clampNonNegativeInt(complexityBudget?.maxTotalAgents, normalizedTopLevelCount || 1)
  );
  const initialChildBudget = Math.max(0, initialMaxTotalAgents - normalizedTopLevelCount);
  const requestedTotalAgents = clampNonNegativeInt(complexityBudget?.requestedTotalAgents, 0) || null;
  const autoBudgetMaxTotalAgents =
    clampNonNegativeInt(complexityBudget?.autoBudgetMaxTotalAgents, 0) || null;
  const budgetSource = safeString(complexityBudget?.budgetSource) || "complexity_profile";
  let remainingChildAgents = initialChildBudget;

  return {
    level: safeString(complexityBudget?.level) || "moderate",
    score: clampNonNegativeInt(complexityBudget?.score, 0),
    maxTopLevelTasks: Math.max(1, clampNonNegativeInt(complexityBudget?.maxTopLevelTasks, 1)),
    maxChildrenPerLeader: Math.max(0, clampNonNegativeInt(complexityBudget?.maxChildrenPerLeader, 0)),
    maxDelegationDepth: Math.max(0, clampNonNegativeInt(complexityBudget?.maxDelegationDepth, 0)),
    maxTotalAgents: initialMaxTotalAgents,
    requestedTotalAgents,
    autoBudgetMaxTotalAgents,
    budgetSource,
    topLevelTaskCount: normalizedTopLevelCount,
    initialChildAgentBudget: initialChildBudget,
    get remainingChildAgents() {
      return remainingChildAgents;
    },
    reserveChildAgents(requested) {
      const normalizedRequest = Math.max(0, clampNonNegativeInt(requested, 0));
      const granted = Math.min(normalizedRequest, remainingChildAgents);
      remainingChildAgents -= granted;
      return granted;
    },
    releaseChildAgents(count) {
      const normalizedRelease = Math.max(0, clampNonNegativeInt(count, 0));
      remainingChildAgents = Math.min(initialChildBudget, remainingChildAgents + normalizedRelease);
    },
    snapshot() {
      return {
        level: this.level,
        score: this.score,
        maxTopLevelTasks: this.maxTopLevelTasks,
        maxChildrenPerLeader: this.maxChildrenPerLeader,
        maxDelegationDepth: this.maxDelegationDepth,
        maxTotalAgents: this.maxTotalAgents,
        requestedTotalAgents: this.requestedTotalAgents,
        autoBudgetMaxTotalAgents: this.autoBudgetMaxTotalAgents,
        budgetSource: this.budgetSource,
        topLevelTaskCount: this.topLevelTaskCount,
        initialChildAgentBudget: this.initialChildAgentBudget,
        remainingChildAgents
      };
    }
  };
}

function summarizeCapabilityRoutingPolicy(policy) {
  const normalized = normalizeCapabilityRoutingPolicy(policy);
  return [
    `require_web_search_for_fresh_facts=${normalized.requireWebSearchForFreshFacts ? "true" : "false"}`,
    `prefer_web_search_for_research=${normalized.preferWebSearchForResearch ? "true" : "false"}`,
    `prefer_codex_for_implementation=${normalized.preferCodexForImplementation ? "true" : "false"}`,
    `require_validation_specialist=${normalized.requireValidationSpecialistForValidation ? "true" : "false"}`,
    `require_coding_manager_for_code_review=${normalized.requireCodingManagerForCodeReview ? "true" : "false"}`,
    `require_handoff_specialist=${normalized.requirePhaseSpecialistForHandoff ? "true" : "false"}`
  ].join("\n");
}

module.exports = { normalizeAgentBudgetProfiles, normalizeCapabilityRoutingPolicy, parseExplicitTotalAgentRequest, resolveTopLevelTaskLimit, resolveEffectiveGroupLeaderMaxDelegates, resolveEffectiveDelegateMaxDepth, buildComplexityBudget, createRunAgentBudget, summarizeCapabilityRoutingPolicy, DEFAULT_AGENT_BUDGET_PROFILES, DEFAULT_CAPABILITY_ROUTING_POLICY };

},
"/src/utils/abort.mjs": function(module, exports, __require) {
const DEFAULT_ABORT_MESSAGE = "Operation cancelled by user.";

function createAbortError(message = DEFAULT_ABORT_MESSAGE, cause = undefined) {
  const error = new Error(String(message || DEFAULT_ABORT_MESSAGE));
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.cancelled = true;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function isAbortError(error) {
  return Boolean(
    error?.cancelled ||
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR"
  );
}

function getAbortMessage(signal, fallback = DEFAULT_ABORT_MESSAGE) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  if (reason && typeof reason.message === "string" && reason.message.trim()) {
    return reason.message.trim();
  }
  return fallback;
}

function throwIfAborted(signal, fallback = DEFAULT_ABORT_MESSAGE) {
  if (signal?.aborted) {
    throw createAbortError(getAbortMessage(signal, fallback), signal.reason);
  }
}

function abortableSleep(ms, signal, fallback = DEFAULT_ABORT_MESSAGE) {
  throwIfAborted(signal, fallback);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));

    const onAbort = () => {
      cleanup();
      reject(createAbortError(getAbortMessage(signal, fallback), signal.reason));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = { createAbortError, isAbortError, getAbortMessage, throwIfAborted, abortableSleep, DEFAULT_ABORT_MESSAGE };

},
"/src/providers/factory.mjs": function(module, exports, __require) {
const { OpenAIResponsesProvider } = __require("/src/providers/openai-responses.mjs");
const { OpenAIChatProvider } = __require("/src/providers/openai-chat.mjs");
const { AnthropicMessagesProvider } = __require("/src/providers/anthropic-messages.mjs");
const { validateModelAccessPolicy } = __require("/src/providers/access-policy.mjs");
const { resolveProviderProtocol } = __require("/src/static/provider-catalog.js");
function createProviderForModel(modelConfig) {
  validateModelAccessPolicy(modelConfig);
  const protocol = resolveProviderProtocol(modelConfig.provider);

  if (protocol === "openai-responses") {
    return new OpenAIResponsesProvider(modelConfig);
  }

  if (protocol === "openai-chat") {
    return new OpenAIChatProvider(modelConfig);
  }

  if (protocol === "anthropic-messages") {
    return new AnthropicMessagesProvider(modelConfig);
  }

  throw new Error(
    `Unsupported provider "${modelConfig.provider}" on model "${modelConfig.id}".`
  );
}

function createProviderRegistry(config) {
  const registry = new Map();

  for (const modelConfig of Object.values(config.models)) {
    registry.set(modelConfig.id, createProviderForModel(modelConfig));
  }

  return registry;
}

module.exports = { createProviderForModel, createProviderRegistry };

},
"/src/providers/connectivity-test.mjs": function(module, exports, __require) {
const { createProviderForModel } = __require("/src/providers/factory.mjs");
const { parseJsonFromText } = __require("/src/utils/json-output.mjs");
const { isSupportedProvider, providerSupportsCapability } = __require("/src/static/provider-catalog.js");
const SUPPORTED_AUTH_STYLES = new Set(["bearer", "api-key", "none"]);
const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const THINKING_PROBE_REPLY = "THINKING_OK";
const WEB_SEARCH_PROBE_QUERY = "OpenAI API";
const WEB_SEARCH_PROBE_OK_PREFIX = "SEARCH_OK";

function mapSecrets(entries) {
  const secrets = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    secrets[name] = String(entry?.value || "");
  }
  return secrets;
}

function normalizeModelInput(payload) {
  const source = payload?.model || {};
  const provider = String(source.provider || "").trim();
  const model = String(source.model || "").trim();
  const baseUrl = String(source.baseUrl || "").trim().replace(/\/+$/, "");
  const authStyle = String(source.authStyle || "bearer").trim();
  const apiKeyEnv = String(source.apiKeyEnv || "").trim();
  const apiKeyValue = String(source.apiKeyValue || "").trim();
  const secrets = mapSecrets(payload?.secrets);

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider "${provider}".`);
  }
  if (!model) {
    throw new Error("Model name is required.");
  }
  if (!baseUrl) {
    throw new Error("Base URL is required.");
  }
  if (!SUPPORTED_AUTH_STYLES.has(authStyle)) {
    throw new Error(`Unsupported authStyle "${authStyle}".`);
  }

  const normalized = {
    id: String(source.id || "connectivity_test_model").trim() || "connectivity_test_model",
    label: String(source.label || source.id || model).trim() || model,
    provider,
    model,
    baseUrl,
    authStyle,
    apiKeyEnv,
    apiKeyHeader: String(source.apiKeyHeader || "").trim(),
    maxOutputTokens: 24,
    timeoutMs: 60000
  };

  const reasoningEffort = normalizeReasoningEffort(source.reasoningEffort || source.reasoning?.effort);
  const thinkingEnabled = inferThinkingEnabled(source, provider);

  if (providerSupportsCapability(provider, "thinking")) {
    normalized.thinkingEnabled = thinkingEnabled;
  }

  if (providerSupportsCapability(provider, "reasoning") && thinkingEnabled) {
    normalized.reasoning = { effort: reasoningEffort || "medium" };
  }

  if (providerSupportsCapability(provider, "webSearch")) {
    normalized.webSearch = Boolean(source.webSearch);
  }

  if (providerSupportsCapability(provider, "temperature")) {
    const temperatureValue = String(source.temperature ?? "").trim();
    if (temperatureValue) {
      const temperature = Number(temperatureValue);
      if (!Number.isFinite(temperature)) {
        throw new Error(`Invalid temperature "${temperatureValue}".`);
      }
      normalized.temperature = temperature;
    }
  }

  if (authStyle !== "none") {
    const resolvedApiKey = apiKeyValue || (apiKeyEnv ? secrets[apiKeyEnv] || process.env[apiKeyEnv] || "" : "");
    if (!resolvedApiKey) {
      throw new Error(
        `No API key found for model "${normalized.id}". Fill API Key in the model card or provide a matching value for ${apiKeyEnv || "the configured key variable"}.`
      );
    }
    normalized.apiKey = resolvedApiKey;
  }

  return normalized;
}

function normalizeReasoningEffort(value, fallback = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return SUPPORTED_REASONING_EFFORTS.has(normalized) ? normalized : fallback;
}

function inferThinkingEnabled(source, provider) {
  if (!providerSupportsCapability(provider, "thinking")) {
    return false;
  }

  if (typeof source?.thinkingEnabled === "boolean") {
    return source.thinkingEnabled;
  }

  if (typeof source?.thinking === "boolean") {
    return source.thinking;
  }

  if (source?.thinking && typeof source.thinking === "object") {
    if (typeof source.thinking.enabled === "boolean") {
      return source.thinking.enabled;
    }

    const thinkingType = String(source.thinking.type || "")
      .trim()
      .toLowerCase();
    if (thinkingType === "enabled") {
      return true;
    }
    if (thinkingType === "disabled") {
      return false;
    }
  }

  if (providerSupportsCapability(provider, "reasoning")) {
    return Boolean(normalizeReasoningEffort(source?.reasoningEffort || source?.reasoning?.effort));
  }

  return false;
}

function createProbeProvider(modelConfig, overrides = {}) {
  return createProviderForModel({
    ...modelConfig,
    ...overrides
  });
}

function summarizeBasicReply(response) {
  const text = String(response?.text || "").trim();
  if (text) {
    return text;
  }

  const statusHint = String(
    response?.raw?.choices?.[0]?.finish_reason ||
      response?.raw?.status ||
      response?.raw?.output?.[0]?.status ||
      ""
  ).trim();
  if (statusHint) {
    return `[empty text response; status=${statusHint}]`;
  }

  return "[empty text response; request completed successfully]";
}

function createThinkingProbePrompt() {
  return {
    instructions: [
      "You are a thinking-mode connectivity probe for an agent cluster.",
      `Do any internal reasoning you need, then reply with exactly ${THINKING_PROBE_REPLY}.`,
      "Do not return JSON. Do not add any other text."
    ].join(" "),
    input: [
      "Quick reasoning task:",
      "1. Confirm whether 1, 1, 2, 3, 5 follows the Fibonacci pattern.",
      "2. Confirm whether reversing that sequence changes its last element.",
      `After reasoning, reply with exactly ${THINKING_PROBE_REPLY}.`
    ].join("\n")
  };
}

function createWebSearchProbePrompt() {
  return {
    instructions: [
      "You are a web-search capability probe.",
      "If web search is available, you must perform exactly one live web search before answering.",
      "Do not rely on prior knowledge.",
      "Reply with exactly one line only."
    ].join(" "),
    input: [
      `Search for "${WEB_SEARCH_PROBE_QUERY}" once, then reply exactly as: ${WEB_SEARCH_PROBE_OK_PREFIX} domain=<hostname>.`,
      "If search is unavailable, reply exactly as: SEARCH_NO."
    ].join(" ")
  };
}

function createWorkflowProbePrompt(modelConfig, mode = "strict") {
  if (mode === "fallback") {
    return {
      instructions: [
        "You are a compact workflow connectivity probe.",
        "Return one compact JSON object only.",
        'Schema: {"status":"ok","usedWebSearch":true|false,"checks":["string"],"query":"string","marker":"string","note":"string"}'
      ].join(" "),
      input: [
        "Reply with valid JSON only.",
        `Set checks to ["fallback:${modelConfig.model}"].`,
        modelConfig.webSearch
          ? `If web search is enabled, use it exactly once for "${WEB_SEARCH_PROBE_QUERY}".`
          : "Do not browse.",
        `Set usedWebSearch to ${modelConfig.webSearch ? "true only if search actually ran, otherwise false" : "false"}.`,
        `Set query to ${modelConfig.webSearch ? `"${WEB_SEARCH_PROBE_QUERY}" when search ran, otherwise ""` : '""'}.`,
        "Set marker to one short hostname or title fragment.",
        "Keep note short."
      ].join("\n")
    };
  }

  return {
    instructions: [
      "You are a compact workflow connectivity probe.",
      "Return JSON only.",
      "Return one valid JSON object that matches the schema exactly.",
      modelConfig.webSearch
        ? `If web search is enabled for this model, use it exactly once for "${WEB_SEARCH_PROBE_QUERY}" before answering.`
        : "Do not browse.",
      'Schema: {"status":"ok","usedWebSearch":true|false,"checks":["string"],"query":"string","marker":"string","note":"string"}'
    ].join(" "),
    input: [
      "Return one compact JSON object only.",
      `Set checks to ["structured:${modelConfig.model}"${modelConfig.webSearch ? ',"web-search"' : ',"no-web-search"'}].`,
      modelConfig.webSearch
        ? `Use web search exactly once for "${WEB_SEARCH_PROBE_QUERY}". Set usedWebSearch to true only if search actually ran.`
        : "Set usedWebSearch to false.",
      `Set query to ${modelConfig.webSearch ? `"${WEB_SEARCH_PROBE_QUERY}" when search ran, otherwise ""` : '""'}.`,
      "Set marker to one short hostname or title fragment.",
      "Keep note under 8 words."
    ].join("\n")
  };
}

function normalizeWorkflowProbePayload(parsed) {
  if (String(parsed?.status || "").trim().toLowerCase() !== "ok") {
    throw new Error('Workflow probe returned JSON, but "status" was not "ok".');
  }
  if (!Array.isArray(parsed?.checks)) {
    throw new Error('Workflow probe returned JSON, but "checks" was not an array.');
  }

  return {
    reportedWebSearch: Boolean(parsed?.usedWebSearch),
    usedWebSearch: Boolean(parsed?.usedWebSearch),
    checks: parsed.checks.map((item) => String(item || "").trim()).filter(Boolean),
    query: String(parsed?.query || "").trim(),
    marker: String(parsed?.marker || "").trim(),
    note: String(parsed?.note || "").trim()
  };
}

function detectChatWebSearch(raw) {
  return Array.isArray(raw?.choices)
    ? raw.choices.some((choice) =>
        Array.isArray(choice?.message?.tool_calls)
          ? choice.message.tool_calls.some(
              (toolCall) =>
                String(toolCall?.function?.name || "")
                  .trim()
                  .toLowerCase() === "$web_search"
            )
          : false
      )
    : false;
}

function detectResponsesWebSearch(raw) {
  if (
    Array.isArray(raw?.output) &&
    raw.output.some((item) =>
      String(item?.type || "")
        .trim()
        .toLowerCase()
        .includes("web_search")
    )
  ) {
    return true;
  }

  return Array.isArray(raw?.output)
    ? raw.output.some((item) =>
        Array.isArray(item?.content)
          ? item.content.some((content) =>
              Array.isArray(content?.annotations)
                ? content.annotations.some((annotation) => {
                    const type = String(annotation?.type || "")
                      .trim()
                      .toLowerCase();
                    return type.includes("web_search") || type.includes("citation");
                  })
                : false
            )
          : false
      )
    : false;
}

function detectAnthropicWebSearch(raw) {
  return Array.isArray(raw?.content)
    ? raw.content.some((item) => {
        const type = String(item?.type || "")
          .trim()
          .toLowerCase();
        const name = String(item?.name || item?.tool_name || "")
          .trim()
          .toLowerCase();
        return (
          type.includes("web_search") ||
          name.includes("web_search") ||
          (type.includes("tool") && name.includes("search"))
        );
      })
    : false;
}

function detectWebSearchEvidence(modelConfig, response) {
  if (response?.meta?.webSearchObserved) {
    return {
      observed: true,
      confirmationMethod: "tool_trace"
    };
  }

  const raw = response?.raw;
  const provider = String(modelConfig?.provider || "").trim();
  let observed = false;
  if (provider === "openai-responses") {
    observed = detectResponsesWebSearch(raw);
  } else if (provider === "claude-chat" || provider === "kimi-coding") {
    observed = detectAnthropicWebSearch(raw);
  } else {
    observed = detectChatWebSearch(raw) || detectResponsesWebSearch(raw) || detectAnthropicWebSearch(raw);
  }

  return {
    observed,
    confirmationMethod: observed ? "response_trace" : ""
  };
}

function detectResponsesThinking(raw) {
  if (Array.isArray(raw?.output) && raw.output.some((item) => String(item?.type || "").toLowerCase() === "reasoning")) {
    return true;
  }

  return false;
}

function detectChatThinking(raw) {
  const choice = raw?.choices?.[0];
  const reasoningContent = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    return true;
  }
  if (Array.isArray(reasoningContent) && reasoningContent.length) {
    return true;
  }

  const content = choice?.message?.content;
  if (
    Array.isArray(content) &&
    content.some(
      (item) =>
        String(item?.type || "").toLowerCase().includes("reasoning") &&
        typeof item?.text === "string" &&
        item.text.trim()
    )
  ) {
    return true;
  }

  return false;
}

function detectAnthropicThinking(raw) {
  return Array.isArray(raw?.content)
    ? raw.content.some((item) =>
        ["thinking", "redacted_thinking"].includes(String(item?.type || "").toLowerCase())
      )
    : false;
}

function detectThinkingEvidence(modelConfig, raw) {
  const provider = String(modelConfig?.provider || "").trim();
  if (provider === "openai-responses") {
    return detectResponsesThinking(raw);
  }
  if (provider === "claude-chat" || provider === "kimi-coding") {
    return detectAnthropicThinking(raw);
  }
  return detectChatThinking(raw) || detectResponsesThinking(raw) || detectAnthropicThinking(raw);
}

function parseWebSearchProbeMarker(reply) {
  const match = String(reply || "").match(/domain=([^\s]+)/i);
  return match ? String(match[1] || "").trim() : "";
}

function assessWorkflowProbe(modelConfig, workflowProbe) {
  const webSearchEnabled = Boolean(modelConfig?.webSearch);
  const dedicatedWebSearchProbe = workflowProbe?.webSearchProbe || null;
  const webSearchUsed = webSearchEnabled
    ? dedicatedWebSearchProbe
      ? Boolean(dedicatedWebSearchProbe.verified)
      : Boolean(workflowProbe?.usedWebSearch)
    : false;
  const webSearchVerified = webSearchEnabled && webSearchUsed;
  const degradedBecauseWebSearch = webSearchEnabled && !webSearchUsed;
  const thinkingEnabled = Boolean(modelConfig?.thinkingEnabled);
  const thinkingVerified = thinkingEnabled && Boolean(workflowProbe?.thinkingProbe?.verified);
  const degradedBecauseThinking = thinkingEnabled && !thinkingVerified;
  const degraded =
    Boolean(workflowProbe?.degraded) || degradedBecauseWebSearch || degradedBecauseThinking;

  let summary = "";
  if (degradedBecauseWebSearch && degradedBecauseThinking) {
    summary =
      "Basic probe passed, but the workflow checks did not confirm that either web search or thinking mode executed successfully on this model.";
  } else if (
    degradedBecauseWebSearch &&
    String(dedicatedWebSearchProbe?.error || "").trim()
  ) {
    summary =
      `Basic probe passed, but the dedicated web-search probe failed: ${String(dedicatedWebSearchProbe.error || "").trim()}`;
  } else if (degradedBecauseWebSearch) {
    summary =
      "Basic probe passed, but the dedicated web-search probe did not confirm that web search executed successfully on this model.";
  } else if (degradedBecauseThinking) {
    summary =
      "Basic probe passed, but the workflow checks did not confirm that thinking mode executed successfully on this model.";
  } else if (workflowProbe?.degraded) {
    summary =
      "Basic probe passed. Workflow probe was downgraded because the model did not return stable structured text to the diagnostic prompt.";
  } else if (webSearchVerified && thinkingVerified) {
    summary =
      "Basic probe + workflow probe passed. Structured JSON, web-search availability, and thinking mode were verified.";
  } else if (webSearchVerified) {
    summary =
      "Basic probe + workflow probe passed. Structured JSON and web-search availability were verified.";
  } else if (thinkingVerified) {
    summary =
      "Basic probe + workflow probe passed. Structured JSON and thinking mode were verified.";
  } else if (workflowProbe?.mode === "fallback") {
    summary = "Basic probe passed. Workflow probe succeeded with a compatibility fallback.";
  } else {
    summary = "Basic probe + workflow probe passed.";
  }

  return {
    degraded,
    summary,
    webSearch: {
      enabled: webSearchEnabled,
      used: webSearchUsed,
      verified: webSearchVerified,
      confirmationMethod:
        String(dedicatedWebSearchProbe?.confirmationMethod || "").trim() ||
        String(workflowProbe?.webSearchEvidence?.confirmationMethod || "").trim() ||
        (workflowProbe?.reportedWebSearch ? "probe_report" : ""),
      query:
        String(dedicatedWebSearchProbe?.query || "").trim() ||
        String(workflowProbe?.query || "").trim(),
      marker:
        String(dedicatedWebSearchProbe?.marker || "").trim() ||
        String(workflowProbe?.marker || "").trim(),
      reply: String(dedicatedWebSearchProbe?.reply || "").trim(),
      error: String(dedicatedWebSearchProbe?.error || "").trim()
    },
    thinking: {
      enabled: thinkingEnabled,
      verified: thinkingVerified,
      error: String(workflowProbe?.thinkingProbe?.error || "").trim()
    }
  };
}

function isRecoverableWorkflowProbeError(error) {
  const message = String(error?.message || error || "").trim().toLowerCase();
  return (
    message.includes("returned no text output") ||
    message.includes("empty text cannot be parsed as json") ||
    message.includes("no json object or array found in model output")
  );
}

async function runBasicProbe(modelConfig, runtimeOptions = {}) {
  const provider = createProbeProvider(modelConfig, {
    maxOutputTokens: 32,
    timeoutMs: Math.max(60000, Number(modelConfig.timeoutMs) || 60000)
  });

  const response = await provider.invoke({
    instructions: "You are a connectivity test endpoint. Reply with exactly OK.",
    input: "Connectivity test. Reply with OK only.",
    purpose: "connectivity_test_basic",
    onRetry: runtimeOptions.onRetry,
    allowEmptyText: true
  });

  return summarizeBasicReply(response);
}

async function runWorkflowProbeVariant(modelConfig, runtimeOptions = {}, mode = "strict") {
  const provider = createProbeProvider(modelConfig, {
    maxOutputTokens: mode === "fallback" ? 80 : 96,
    timeoutMs: Math.max(90000, Number(modelConfig.timeoutMs) || 90000)
  });
  const prompt = createWorkflowProbePrompt(modelConfig, mode);

  const response = await provider.invoke({
    instructions: prompt.instructions,
    input: prompt.input,
    purpose: "connectivity_test_workflow",
    onRetry: runtimeOptions.onRetry
  });

  const parsed = parseJsonFromText(response.text);
  const normalized = normalizeWorkflowProbePayload(parsed);
  const webSearchEvidence = detectWebSearchEvidence(modelConfig, response);

  return {
    ...normalized,
    usedWebSearch: normalized.usedWebSearch || webSearchEvidence.observed,
    webSearchEvidence
  };
}

async function runWorkflowProbe(modelConfig, runtimeOptions = {}) {
  try {
    const strictResult = await runWorkflowProbeVariant(modelConfig, runtimeOptions, "strict");
    return {
      ...strictResult,
      mode: "strict",
      degraded: false
    };
  } catch (error) {
    if (!isRecoverableWorkflowProbeError(error)) {
      throw error;
    }

    try {
      const fallbackResult = await runWorkflowProbeVariant(modelConfig, runtimeOptions, "fallback");
      return {
        ...fallbackResult,
        mode: "fallback",
        degraded: false,
        fallbackReason: error.message
      };
    } catch (fallbackError) {
      if (!isRecoverableWorkflowProbeError(fallbackError)) {
        throw fallbackError;
      }

      return {
        usedWebSearch: false,
        reportedWebSearch: false,
        checks: [`basic:${modelConfig.model}`],
        query: "",
        marker: "",
        note: `Workflow probe degraded: ${fallbackError.message}`,
        webSearchEvidence: {
          observed: false,
          confirmationMethod: ""
        },
        mode: "degraded",
        degraded: true,
        fallbackReason: error.message
      };
    }
  }
}

async function runWebSearchProbe(modelConfig, runtimeOptions = {}) {
  const provider = createProbeProvider(
    {
      ...modelConfig,
      webSearch: true
    },
    {
      maxOutputTokens: 64,
      timeoutMs: Math.max(90000, Number(modelConfig.timeoutMs) || 90000)
    }
  );
  const prompt = createWebSearchProbePrompt();

  try {
    const response = await provider.invoke({
      instructions: prompt.instructions,
      input: prompt.input,
      purpose: "connectivity_test_web_search",
      onRetry: runtimeOptions.onRetry,
      allowEmptyText: true
    });

    const reply = String(response.text || "").trim();
    const webSearchEvidence = detectWebSearchEvidence(modelConfig, response);

    return {
      verified: Boolean(webSearchEvidence.observed),
      confirmationMethod: String(webSearchEvidence.confirmationMethod || "").trim(),
      query: WEB_SEARCH_PROBE_QUERY,
      marker: parseWebSearchProbeMarker(reply),
      reply,
      error: "",
      reportedOk: reply.startsWith(WEB_SEARCH_PROBE_OK_PREFIX)
    };
  } catch (error) {
    return {
      verified: false,
      confirmationMethod: "",
      query: WEB_SEARCH_PROBE_QUERY,
      marker: "",
      reply: "",
      error: error.message,
      reportedOk: false
    };
  }
}

async function runThinkingProbe(modelConfig, runtimeOptions = {}) {
  const provider = createProbeProvider(
    {
      ...modelConfig,
      webSearch: false
    },
    {
      maxOutputTokens: Math.max(512, Number(modelConfig.maxOutputTokens) || 512),
      timeoutMs: Math.max(90000, Number(modelConfig.timeoutMs) || 90000)
    }
  );
  const prompt = createThinkingProbePrompt();

  try {
    const response = await provider.invoke({
      instructions: prompt.instructions,
      input: prompt.input,
      purpose: "connectivity_test_thinking",
      onRetry: runtimeOptions.onRetry
    });

    return {
      verified:
        String(response.text || "").trim() === THINKING_PROBE_REPLY &&
        detectThinkingEvidence(modelConfig, response.raw),
      reply: String(response.text || "").trim(),
      error: ""
    };
  } catch (error) {
    return {
      verified: false,
      reply: "",
      error: error.message
    };
  }
}

async function testModelConnectivity(payload, runtimeOptions = {}) {
  const modelConfig = normalizeModelInput(payload);
  const basicReply = await runBasicProbe(modelConfig, runtimeOptions);
  let workflowProbe;

  try {
    workflowProbe = await runWorkflowProbe(modelConfig, runtimeOptions);
  } catch (error) {
    throw new Error(`Basic probe passed, but workflow probe failed: ${error.message}`);
  }

  const thinkingProbe = modelConfig.thinkingEnabled
    ? await runThinkingProbe(modelConfig, runtimeOptions)
    : null;
  if (thinkingProbe) {
    workflowProbe.thinkingProbe = thinkingProbe;
  }

  const webSearchProbe = modelConfig.webSearch
    ? await runWebSearchProbe(modelConfig, runtimeOptions)
    : null;
  if (webSearchProbe) {
    workflowProbe.webSearchProbe = webSearchProbe;
  }

  const assessment = assessWorkflowProbe(modelConfig, workflowProbe);

  return {
    ok: true,
    degraded: assessment.degraded,
    model: {
      id: modelConfig.id,
      label: modelConfig.label,
      provider: modelConfig.provider,
      endpoint: modelConfig.baseUrl
    },
    reply: basicReply.slice(0, 120),
    summary: assessment.summary,
    diagnostics: {
      workflowProbe,
      webSearch: assessment.webSearch,
      thinking: assessment.thinking
    }
  };
}

module.exports = { testModelConnectivity };

},
"/src/cluster/orchestrator.mjs": function(module, exports, __require) {
const { buildLeaderDelegationRequest, buildLeaderSynthesisRequest, buildPlanningRequest, buildSynthesisRequest, buildWorkerExecutionRequest } = __require("/src/cluster/prompts.mjs");
const { parseJsonFromText } = __require("/src/utils/json-output.mjs");
const { getWorkspaceTree, verifyWorkspaceArtifacts, writeWorkspaceFiles } = __require("/src/workspace/fs.mjs");
const { runWorkspaceToolLoop } = __require("/src/workspace/agent-loop.mjs");
const { isAbortError, throwIfAborted } = __require("/src/utils/abort.mjs");
const { createSessionRuntime } = __require("/src/session/runtime.mjs");
const { buildRetryPayload, invokeProviderWithSession } = __require("/src/cluster/provider-session.mjs");
const { createMultiAgentRuntime, normalizeMultiAgentRuntimeSettings } = __require("/src/cluster/multi-agent-runtime.mjs");
const { buildComplexityBudget, createRunAgentBudget, normalizeCapabilityRoutingPolicy, resolveEffectiveDelegateMaxDepth, resolveEffectiveGroupLeaderMaxDelegates, resolveTopLevelTaskLimit, summarizeCapabilityRoutingPolicy } = __require("/src/cluster/policies.mjs");
const { deriveTaskRequirements } = __require("/src/workspace/task-requirements.mjs");
const { buildDocxFallbackContent, getArtifactTitleFromPath, inferRequestedArtifact } = __require("/src/workspace/artifact-fallback.mjs");
const { normalizeWorkspaceArtifactReferences } = __require("/src/workspace/action-protocol.mjs");
const PHASE_ORDER = ["research", "implementation", "validation", "handoff"];
const DEFAULT_SUBORDINATE_MAX_PARALLEL = 3;
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const PHASE_CONCURRENCY_CAPS = {};
const RETRYABLE_PROVIDER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const DELEGATION_FILE_REFERENCE_PATTERNS = [
  /`([^`\r\n]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))`/gi,
  /"([^"\r\n]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))"/gi,
  /'([^'\r\n]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))'/gi,
  /([A-Za-z0-9_./\\-]+\.(?:json|docx|md|txt|csv|tsv|yaml|yml|xml|html|js|mjs|cjs|ts|tsx|jsx|py|pdf|pptx|xlsx))/gi
];
const DELEGATION_PRODUCER_HINTS = [
  /\b(write|create|generate|save|produce|output|materialize|build|assemble|deliver)\b/i,
  /(写入|生成|创建|保存|产出|输出|落地|交付)/
];
const DELEGATION_CONSUMER_HINTS = [
  /\b(read|use|verify|validate|check|open|load|parse|review|summarize|merge|combine|consume|based on|using)\b/i,
  /(读取|使用|基于|核验|验证|检查|打开|加载|解析|审阅|汇总|合并|依赖)/
];
const AGENT_PREFIX = {
  research: {
    leader: "调研组长",
    subordinate: "调研下属"
  },
  implementation: {
    leader: "编码组长",
    subordinate: "编码下属"
  },
  validation: {
    leader: "验证组长",
    subordinate: "验证下属"
  },
  handoff: {
    leader: "交付组长",
    subordinate: "交付下属"
  },
  general: {
    leader: "分析组长",
    subordinate: "分析下属"
  }
};
const PHASE_HINTS = {
  research: ["long context reading", "web research", "data extraction", "cross-checking", "analysis"],
  implementation: ["coding", "debugging", "implementation critique", "patch suggestions"],
  validation: ["test planning", "code review", "cross-checking", "debugging", "qa"],
  handoff: ["document writing", "chat", "synthesis", "communication"]
};
const ROLE_PHASES = {
  controller: [...PHASE_ORDER],
  research: ["research"],
  implementation: ["implementation"],
  coding_manager: ["validation"],
  validation: ["validation"],
  handoff: ["handoff"],
  general: ["implementation"]
};

function emitEvent(onEvent, payload) {
  if (typeof onEvent === "function") {
    onEvent({
      timestamp: new Date().toISOString(),
      ...payload
    });
  }
}

function workerListFromConfig(config) {
  const candidates = Object.values(config.models).filter(
    (model) => model.id !== config.cluster.controller
  );
  const workerCapableCandidates = candidates.filter((model) => modelCanActAsWorker(model));
  return workerCapableCandidates.length ? workerCapableCandidates : candidates;
}

function modelListFromConfig(config) {
  return Object.values(config?.models || {});
}

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeArtifactEntry(value) {
  if (typeof value === "string") {
    return String(value).trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  return String(
    value.path ??
      value.filePath ??
      value.file_path ??
      value.filename ??
      value.fileName ??
      value.targetPath ??
      value.target_path ??
      ""
  ).trim();
}

function normalizeArtifactArray(value) {
  return Array.isArray(value)
    ? normalizeWorkspaceArtifactReferences(
      value
        .map((item) => normalizeArtifactEntry(item))
        .filter(Boolean)
    )
    : [];
}

function normalizeModelRole(value, fallback = "") {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }

  if (trimmed === "both" || trimmed === "dual" || trimmed === "dual-role" || trimmed === "dual_role") {
    return "hybrid";
  }

  return ["controller", "worker", "hybrid"].includes(trimmed) ? trimmed : fallback;
}

function inferModelRole(worker) {
  const explicitRole = normalizeModelRole(worker?.role);
  if (explicitRole) {
    return explicitRole;
  }

  return workerHasSpecialty(worker, "controller") ? "controller" : "worker";
}

function modelCanActAsController(worker) {
  const role = inferModelRole(worker);
  return role === "controller" || role === "hybrid";
}

function modelCanActAsWorker(worker) {
  const role = inferModelRole(worker);
  return role === "worker" || role === "hybrid";
}

function uniqueArray(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item)).filter(Boolean)));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDelegationFileReference(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`]+|["'`.,;:!?]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function extractDelegationFileReferences(text) {
  const source = String(text || "");
  const matches = [];
  for (const pattern of DELEGATION_FILE_REFERENCE_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const normalized = normalizeDelegationFileReference(match[1]);
      if (normalized) {
        matches.push(normalized);
      }
    }
  }
  return uniqueArray(matches);
}

function matchesDelegationHint(text, patterns) {
  return patterns.some((pattern) => pattern.test(String(text || "")));
}

function inferImplicitDelegationDependencies(subtasks) {
  const metadata = (Array.isArray(subtasks) ? subtasks : []).map((subtask, index) => {
    const combinedText = [subtask?.title, subtask?.instructions, subtask?.expectedOutput]
      .filter(Boolean)
      .join("\n");
    return {
      id: subtask.id,
      ordinal: index + 1,
      combinedText,
      normalizedText: combinedText.toLowerCase(),
      references: extractDelegationFileReferences(combinedText),
      producerHints: matchesDelegationHint(combinedText, DELEGATION_PRODUCER_HINTS),
      consumerHints: matchesDelegationHint(combinedText, DELEGATION_CONSUMER_HINTS)
    };
  });
  const dependencies = new Map();

  metadata.forEach((current, currentIndex) => {
    const inferred = [];
    for (let priorIndex = 0; priorIndex < currentIndex; priorIndex += 1) {
      const prior = metadata[priorIndex];
      const sharedReferences = prior.references.filter((reference) =>
        current.references.includes(reference)
      );
      const referencesPriorId =
        new RegExp(`\\b${escapeRegExp(prior.id)}\\b`, "i").test(current.combinedText) ||
        new RegExp(`\\b(?:subtask|subagent|child(?:\\s+agent)?|sibling)\\s*0*${prior.ordinal}\\b`, "i").test(
          current.combinedText
        ) ||
        new RegExp(`(?:子任务|子代理|下属)\\s*0*${prior.ordinal}`).test(current.combinedText);
      if (referencesPriorId) {
        inferred.push(prior.id);
        continue;
      }

      if (!sharedReferences.length || !prior.producerHints || !current.consumerHints) {
        continue;
      }

      inferred.push(prior.id);
    }
    dependencies.set(current.id, uniqueArray(inferred));
  });

  return dependencies;
}

function normalizePhase(value, fallback = "implementation") {
  const normalized = String(value || "").trim().toLowerCase();
  return PHASE_ORDER.includes(normalized) ? normalized : fallback;
}

function phaseIndex(value) {
  return PHASE_ORDER.indexOf(normalizePhase(value));
}

function normalizeVerificationStatus(value) {
  const normalized = String(value || "").trim();
  return ["not_applicable", "passed", "failed"].includes(normalized)
    ? normalized
    : "not_applicable";
}

function resolveGroupLeaderMaxDelegates(config) {
  const configured = Number(config?.cluster?.groupLeaderMaxDelegates);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_GROUP_LEADER_MAX_DELEGATES;
  }

  return Math.floor(configured);
}

function resolveDelegateMaxDepth(config) {
  const configured = Number(config?.cluster?.delegateMaxDepth);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_DELEGATION_MAX_DEPTH;
  }

  return Math.floor(configured);
}

function resolveSubordinateMaxParallel(config) {
  const configured = Number(config?.cluster?.subordinateMaxParallel);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_SUBORDINATE_MAX_PARALLEL;
  }

  return Math.floor(configured);
}

function resolveSharedResearchGatewayMaxParallel(config) {
  const configured = Number(config?.cluster?.sharedResearchGatewayMaxParallel);
  if (!Number.isFinite(configured) || configured < 0) {
    return 0;
  }

  return Math.floor(configured);
}

function normalizeDelegateCount(value, maxDelegates = DEFAULT_GROUP_LEADER_MAX_DELEGATES) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1) {
    return 0;
  }

  if (!Number.isFinite(maxDelegates) || maxDelegates < 0) {
    return Math.min(DEFAULT_GROUP_LEADER_MAX_DELEGATES, Math.floor(count));
  }

  if (Math.floor(maxDelegates) === 0) {
    return 0;
  }

  return Math.min(Math.floor(maxDelegates), Math.floor(count));
}

function hasExplicitDelegateCount(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed !== "";
}

function taskLooksAtomic(task, phase) {
  const normalizedPhase = normalizePhase(phase, "implementation");
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  const compactText = text.replace(/\s+/g, " ").trim();
  const hasScaleSignal = /(compare|survey|collect|batch|multiple|parallel|delegate|split|across|recursive|non-overlapping|several|\u591a\u4e2a|\u5e76\u884c|\u62c6\u5206|\u6279\u91cf|\u9012\u5f52|\u59d4\u6d3e)/.test(
    text
  );

  if (normalizedPhase === "handoff") {
    return true;
  }

  if (/(atomic|single file|single document|single report|one file|one document|one report|directly|handle directly|\u539f\u5b50|\u5355\u6587\u4ef6|\u5355\u6587\u6863|\u76f4\u63a5\u5904\u7406)/.test(text)) {
    return true;
  }

  return Boolean(compactText) && compactText.length <= 96 && !hasScaleSignal;
}

function shouldPreferDelegation(task, phase, groupLeaderMaxDelegates, delegateMaxDepth) {
  if (Math.floor(Number(groupLeaderMaxDelegates) || 0) <= 0) {
    return false;
  }
  if (Math.floor(Number(delegateMaxDepth) || 0) <= 0) {
    return false;
  }

  const normalizedPhase = normalizePhase(phase, "implementation");
  if (taskLooksAtomic(task, normalizedPhase)) {
    return false;
  }

  return normalizedPhase === "research" || normalizedPhase === "implementation" || normalizedPhase === "validation";
}

function inferPlannedDelegateCount(task, phase, groupLeaderMaxDelegates, delegateMaxDepth) {
  if (!shouldPreferDelegation(task, phase, groupLeaderMaxDelegates, delegateMaxDepth)) {
    return 0;
  }

  const normalizedPhase = normalizePhase(phase, "implementation");
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  let suggested = 1;

  if (normalizedPhase === "research" || normalizedPhase === "implementation") {
    suggested = 2;
  } else if (normalizedPhase === "handoff") {
    suggested = 0;
  }

  if (/(compare|survey|collect|batch|multiple|parallel|delegate|split|analyze directly and return the result)/.test(text)) {
    suggested = Math.max(suggested, 2);
  }
  if (/(small|atomic|single file|single document|one file|directly)/.test(text)) {
    suggested = Math.min(suggested, 1);
  }

  return normalizeDelegateCount(suggested, groupLeaderMaxDelegates);
}

function resolveTaskDelegateCount(task, phase, groupLeaderMaxDelegates, delegateMaxDepth) {
  const inferred = inferPlannedDelegateCount(task, phase, groupLeaderMaxDelegates, delegateMaxDepth);

  if (!hasExplicitDelegateCount(task?.delegateCount)) {
    return inferred;
  }

  const explicit = normalizeDelegateCount(task?.delegateCount, groupLeaderMaxDelegates);
  if (explicit > 0) {
    return explicit;
  }

  return inferred;
}

function safeString(value) {
  return String(value || "").trim();
}

function normalizeRunLocale(value) {
  return safeString(value) === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeRunText(locale, englishText, chineseText) {
  return normalizeRunLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function createRunLanguagePack(locale) {
  const normalizedLocale = normalizeRunLocale(locale);
  return {
    taskTitle(index) {
      return normalizedLocale === "zh-CN" ? `任务 ${index + 1}` : `Task ${index + 1}`;
    },
    subtaskTitle(index) {
      return normalizedLocale === "zh-CN" ? `子任务 ${index + 1}` : `Subtask ${index + 1}`;
    },
    subtaskInstructions(index) {
      return normalizedLocale === "zh-CN"
        ? `处理组长任务中的第 ${index + 1} 部分。`
        : `Handle part ${index + 1} of the assigned leader task.`;
    },
    subtaskExpectedOutput() {
      return normalizedLocale === "zh-CN" ? "输出具体的专业结果。" : "Concrete specialist output.";
    },
    fallbackTaskTitle(worker, phase) {
      return normalizedLocale === "zh-CN"
        ? `${worker.label} 的${phase}任务`
        : `${worker.label} ${phase} task`;
    },
    fallbackTaskInstructions(originalTask) {
      return normalizedLocale === "zh-CN"
        ? `从你最擅长的专业方向处理用户目标“${originalTask}”。`
        : `Handle the user objective "${originalTask}" in your strongest specialty area.`;
    },
    fallbackTaskExpectedOutput() {
      return normalizedLocale === "zh-CN"
        ? "输出结构化结论，并在合适时给出具体产物。"
        : "Structured findings with concrete artifacts where useful.";
    },
    structuredSpecialistAnalysis() {
      return normalizedLocale === "zh-CN" ? "结构化的专业分析结果。" : "Structured specialist analysis.";
    },
    analyzeObjective(originalTask) {
      return normalizedLocale === "zh-CN"
        ? `从你的专业角度分析目标“${originalTask}”，并返回具体建议。`
        : `Analyze the objective "${originalTask}" from your specialty and return concrete recommendations.`;
    },
    validateGeneratedWorkspaceOutputsTitle() {
      return normalizedLocale === "zh-CN" ? "校验生成的工作区产物" : "Validate generated workspace outputs";
    },
    validateGeneratedOutputsTitle() {
      return normalizedLocale === "zh-CN" ? "校验生成结果" : "Validate generated outputs";
    },
    validationGateInstructions() {
      return normalizedLocale === "zh-CN"
        ? "仅审查上游实现任务明确产出的文件和产物；除非依赖结果要求扩大范围，否则忽略无关的既有工作区文件。对这些产物执行最相关且安全的测试或构建命令，并报告该工作流结果是否真正可用。"
        : "Review only the files and artifacts explicitly produced by upstream implementation tasks unless dependency outputs require a broader workspace inspection. Ignore unrelated pre-existing workspace files, run the most relevant safe tests or build commands for the produced outputs, and report whether the workflow result is actually usable.";
    },
    validationGateExpectedOutput() {
      return normalizedLocale === "zh-CN" ? "给出带测试/构建结果的验证结论。" : "Validation verdict with test/build results.";
    },
    finalCodeManagementReviewTitle() {
      return normalizedLocale === "zh-CN" ? "最终代码管理复核" : "Final code management review";
    },
    finalCodeManagementReviewInstructions() {
      return normalizedLocale === "zh-CN"
        ? "对所有实现产物执行最终代码管理复核。优先关注上游实现任务明确产出的文件和产物；除非依赖输出指向其他文件，否则忽略无关的既有工作区内容。针对这些产物运行最相关且安全的测试、构建或 lint 命令，并报告编码结果是否一致、可验收、可交付。"
        : "Perform the final code-management review for all implementation outputs. Focus first on files and artifacts explicitly produced by upstream implementation tasks, ignore unrelated pre-existing workspace files unless a dependency output points to them, run the most relevant safe test, build, or lint commands for those outputs, and report whether the coding results are cohesive and ready for handoff.";
    },
    finalCodeManagementReviewExpectedOutput() {
      return normalizedLocale === "zh-CN"
        ? "给出带验证证据和剩余风险的最终代码复核结论。"
        : "Final code review verdict with verification evidence and remaining risks.";
    },
    prepareHandoffSummaryTitle() {
      return normalizedLocale === "zh-CN" ? "准备交付摘要" : "Prepare handoff summary";
    },
    prepareHandoffSummaryInstructions() {
      return normalizedLocale === "zh-CN"
        ? "整理一份面向用户的精简交付摘要，覆盖产出结果、剩余风险，以及如何使用生成的内容。"
        : "Prepare a concise user-facing handoff summary covering outcomes, remaining risks, and how to use the generated outputs.";
    },
    prepareHandoffSummaryExpectedOutput() {
      return normalizedLocale === "zh-CN" ? "输出可直接阅读的交付说明。" : "Readable handoff notes.";
    },
    planningChildAgents(delegateCount, requestedTotalAgents) {
      if (normalizedLocale === "zh-CN") {
        return Number(requestedTotalAgents) > 0
          ? `计划在本任务内最多分配 ${delegateCount} 个子 agent，对应整轮全局目标 ${requestedTotalAgents} 个 agent。`
          : `计划在本任务内最多分配 ${delegateCount} 个子 agent。`;
      }
      return Number(requestedTotalAgents) > 0
        ? `Planning up to ${delegateCount} child agent(s) for this task within the run-wide total target of ${requestedTotalAgents} agent(s).`
        : `Planning up to ${delegateCount} child agent(s) for this task.`;
    },
    leaderSynthesisContent(childCount) {
      return normalizedLocale === "zh-CN"
        ? `把 ${childCount} 个子任务结果汇总成一份统一结论。`
        : `Merge ${childCount} child result(s) into one consolidated answer.`;
    },
    leaderSynthesisDetail(childCount) {
      return normalizedLocale === "zh-CN"
        ? `正在汇总 ${childCount} 个子任务结果。`
        : `Synthesizing ${childCount} child result(s).`;
    },
    taskCompletedWithoutDelegation() {
      return normalizedLocale === "zh-CN" ? "任务已直接完成，未继续委派。" : "Task completed without delegation.";
    },
    taskCompletedAfterBudgetExhausted() {
      return normalizedLocale === "zh-CN"
        ? "整轮子 agent 预算已用尽，本任务已改为直接完成。"
        : "Task completed after the run-wide child-agent budget was exhausted.";
    },
    delegationDone(delegatedCount, subordinateConcurrency, hasDependencies, globalConcurrencyLabel) {
      if (normalizedLocale === "zh-CN") {
        return delegatedCount < 0
          ? ""
          : `已分派 ${delegatedCount} 个子任务；本地子任务启动上限 ${subordinateConcurrency}，依赖感知调度${hasDependencies ? "已启用" : "无需启用"}，全局执行上限 ${globalConcurrencyLabel}。`;
      }
      return `Delegated ${delegatedCount} child task(s); local child launch cap is ${subordinateConcurrency}, dependency-aware scheduling is ${hasDependencies ? "enabled" : "not needed"}, and the global execution cap is ${globalConcurrencyLabel}.`;
    },
    delegationDoneBudgeted(delegatedCount, subordinateConcurrency, hasDependencies, globalConcurrencyLabel) {
      if (normalizedLocale === "zh-CN") {
        return `应用整轮子 agent 预算后，已分派 ${delegatedCount} 个子任务；本地子任务启动上限 ${subordinateConcurrency}，依赖感知调度${hasDependencies ? "已启用" : "无需启用"}，全局执行上限 ${globalConcurrencyLabel}。`;
      }
      return `Delegated ${delegatedCount} child task(s) after applying the run-wide child-agent budget; local child launch cap is ${subordinateConcurrency}, dependency-aware scheduling is ${hasDependencies ? "enabled" : "not needed"}, and the global execution cap is ${globalConcurrencyLabel}.`;
    },
    delegationDoneSequential(delegatedCount, globalConcurrencyLabel) {
      return normalizedLocale === "zh-CN"
        ? `已分派 ${delegatedCount} 个子任务；本地子任务将顺序启动，全局执行上限 ${globalConcurrencyLabel}。`
        : `Delegated ${delegatedCount} child task(s); local child launch continues sequentially and the global execution cap is ${globalConcurrencyLabel}.`;
    },
    collaborationStarted(mode) {
      return normalizedLocale === "zh-CN"
        ? `协作已启动，当前模式：${mode}。`
        : `Collaboration started in ${mode} mode.`;
    }
  };
}

function isGenericEnglishTaskTitle(value, kind = "task") {
  const normalized = safeString(value).toLowerCase();
  if (!normalized) {
    return false;
  }

  if (kind === "subtask") {
    return /^(subtask|child task|task)\s*#?:?\s*\d+$/.test(normalized);
  }

  return /^task\s*#?:?\s*\d+$/.test(normalized);
}

function resolveLocalizedTaskTitle(rawTitle, fallbackTitle, kind = "task") {
  const normalized = safeString(rawTitle);
  if (!normalized) {
    return fallbackTitle;
  }

  return isGenericEnglishTaskTitle(normalized, kind) ? fallbackTitle : normalized;
}

function joinConversationParts(parts) {
  return parts
    .map((value) => safeString(value))
    .filter(Boolean)
    .join(" ");
}

function resolveQuotedTaskTitle(taskTitle, fallback, locale = "en-US") {
  const normalized = safeString(taskTitle);
  if (normalized) {
    return normalizeRunLocale(locale) === "zh-CN" ? `“${normalized}”` : `"${normalized}"`;
  }
  return fallback;
}

function resolveConversationSnippet(stage, payload = {}) {
  switch (stage) {
    case "leader_delegate_done":
      return safeString(payload.detail || payload.summary || payload.thinkingSummary || payload.content);
    case "worker_done":
    case "subagent_done":
      return safeString(payload.summary || payload.content || payload.thinkingSummary || payload.detail);
    default:
      return safeString(payload.content || payload.summary || payload.thinkingSummary || payload.detail);
  }
}

function extractEventDetailValue(detail, patterns = []) {
  const normalized = safeString(detail);
  if (!normalized) {
    return "";
  }

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return safeString(match[1] || match[0]);
    }
  }

  return normalized;
}

function buildConversationStyleContent(stage, payload = {}, taskTitle = "", locale = "en-US") {
  const normalizedLocale = normalizeRunLocale(locale);
  const snippet = resolveConversationSnippet(stage, payload);
  const taskLabel = resolveQuotedTaskTitle(
    taskTitle,
    normalizedLocale === "zh-CN" ? "该任务" : "this task",
    normalizedLocale
  );
  const childTaskLabel = resolveQuotedTaskTitle(
    taskTitle,
    normalizedLocale === "zh-CN" ? "该子任务" : "this child task",
    normalizedLocale
  );

  switch (stage) {
    case "planning_start":
      return localizeRunText(
        normalizedLocale,
        "I'm planning the overall collaboration.",
        "我正在规划整个协作流程。"
      );
    case "planning_done":
      return localizeRunText(
        normalizedLocale,
        `The top-level plan is ready with ${payload.taskCount ?? 0} task(s).`,
        `顶层计划已完成，共拆分 ${payload.taskCount ?? 0} 个任务。`
      );
    case "phase_start":
      return localizeRunText(
        normalizedLocale,
        `Entering the ${safeString(payload.phase) || "current"} phase.`,
        `进入${safeString(payload.phase) || "当前"}阶段。`
      );
    case "phase_done":
      return localizeRunText(
        normalizedLocale,
        `Completed the ${safeString(payload.phase) || "current"} phase.`,
        `已完成${safeString(payload.phase) || "当前"}阶段。`
      );
    case "leader_delegate_start":
      return joinConversationParts([
        localizeRunText(
          normalizedLocale,
          `I'm splitting ${taskLabel} into child assignments.`,
          `我来把 ${taskLabel} 拆成若干子任务。`
        ),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Focus: ${snippet}`, `重点：${snippet}`)
          : ""
      ]);
    case "leader_delegate_done":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "Delegation plan ready.", "分工计划已确定。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "worker_start":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `I'm taking ${taskLabel}.`, `我来处理 ${taskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Plan: ${snippet}`, `计划：${snippet}`)
          : ""
      ]);
    case "subagent_created":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Please take ${childTaskLabel}.`, `请接手 ${childTaskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Focus: ${snippet}`, `重点：${snippet}`)
          : ""
      ]);
    case "subagent_start":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Acknowledged ${childTaskLabel}.`, `已接单，开始处理 ${childTaskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Plan: ${snippet}`, `计划：${snippet}`)
          : localizeRunText(normalizedLocale, "Starting now.", "马上开始。")
      ]);
    case "leader_synthesis_start":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I'm merging the child outputs into one answer.", "我正在汇总子任务结果。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "worker_done":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Finished ${taskLabel}.`, `已完成 ${taskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Result: ${snippet}`, `结果：${snippet}`)
          : ""
      ]);
    case "subagent_done":
      return joinConversationParts([
        localizeRunText(normalizedLocale, `Completed ${childTaskLabel}.`, `已完成 ${childTaskLabel}。`),
        snippet && snippet !== taskTitle
          ? localizeRunText(normalizedLocale, `Result: ${snippet}`, `结果：${snippet}`)
          : ""
      ]);
    case "workspace_list":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I checked the workspace path.", "我已查看工作区路径。"),
        extractEventDetailValue(snippet) ? localizeRunText(normalizedLocale, `Path: ${extractEventDetailValue(snippet)}`, `路径：${extractEventDetailValue(snippet)}`) : ""
      ]);
    case "workspace_read":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I read the required files.", "我已读取所需文件。"),
        extractEventDetailValue(snippet) ? localizeRunText(normalizedLocale, `Files: ${extractEventDetailValue(snippet)}`, `文件：${extractEventDetailValue(snippet)}`) : ""
      ]);
    case "workspace_write": {
      const artifactPath = extractEventDetailValue(snippet, [
        /^Auto-materialized requested artifact(?: but verification failed)?:\s*(.+)$/i,
        /^已自动生成(?:并校验|但校验失败的)?目标产物[：:]\s*(.+)$/i
      ]);
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I wrote files into the workspace.", "我已向工作区写入文件。"),
        artifactPath
          ? localizeRunText(
              normalizedLocale,
              `Artifact: ${artifactPath}`,
              `产物：${artifactPath}`
            )
          : extractEventDetailValue(snippet)
            ? localizeRunText(
                normalizedLocale,
                `Files: ${extractEventDetailValue(snippet)}`,
                `文件：${extractEventDetailValue(snippet)}`
              )
            : ""
      ]);
    }
    case "workspace_web_search":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I finished a web search.", "我已完成一次网页搜索。"),
        extractEventDetailValue(snippet)
          ? localizeRunText(
              normalizedLocale,
              `Query: ${extractEventDetailValue(snippet)}`,
              `查询：${extractEventDetailValue(snippet)}`
            )
          : ""
      ]);
    case "workspace_json_repair":
      return localizeRunText(
        normalizedLocale,
        "I detected an invalid workspace JSON response and I'm repairing it.",
        "我检测到无效的 workspace JSON 响应，正在修复。"
      );
    case "memory_write": {
      const title = extractEventDetailValue(snippet, [
        /^Stored session memory:\s*(.+)$/i,
        /^已写入会话记忆[：:]\s*(.+)$/i
      ]);
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I stored the latest session memory.", "我已写入最新的会话记忆。"),
        title ? localizeRunText(normalizedLocale, `Title: ${title}`, `标题：${title}`) : ""
      ]);
    }
    case "memory_read": {
      const memoryCount = extractEventDetailValue(snippet, [
        /^Recalled\s+(\d+)\s+session memory item\(s\)\.?$/i,
        /^已召回\s+(\d+)\s+条会话记忆。?$/i
      ]);
      return joinConversationParts([
        localizeRunText(normalizedLocale, "I recalled the relevant session memory.", "我已召回相关会话记忆。"),
        memoryCount
          ? localizeRunText(normalizedLocale, `Items: ${memoryCount}`, `条目：${memoryCount}`)
          : ""
      ]);
    }
    case "worker_fallback":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "Rerouted after a provider failure.", "因 provider 故障已切换执行者。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "controller_fallback":
      return joinConversationParts([
        localizeRunText(normalizedLocale, "Controller fallback engaged.", "主控已切换到备用模型。"),
        snippet && snippet !== taskTitle ? snippet : ""
      ]);
    case "cancel_requested":
      return localizeRunText(
        normalizedLocale,
        "The user requested cancellation and I'm stopping the current run.",
        "用户已请求终止，我正在停止当前运行。"
      );
    default:
      return snippet;
  }
}

function padAgentIndex(value) {
  return String(value).padStart(2, "0");
}

function textBlob(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function workerHasSpecialty(worker, specialty) {
  const normalizedSpecialty = safeString(specialty).toLowerCase();
  if (!normalizedSpecialty) {
    return false;
  }

  return safeArray(worker?.specialties).some(
    (item) => safeString(item).toLowerCase() === normalizedSpecialty
  );
}

function taskLooksCodeRelated(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return /(code|coding|script|patch|implement|fix|write|edit|refactor|repo|repository|workspace|test|build|lint|debug|\u7f16\u7801|\u4ee3\u7801|\u5b9e\u73b0|\u4fee\u590d|\u8865\u4e01|\u811a\u672c|\u91cd\u6784|\u4ed3\u5e93|\u5de5\u7a0b|\u6d4b\u8bd5|\u6784\u5efa|\u8c03\u8bd5|\u5ba1\u67e5|\u8bc4\u5ba1)/.test(
    text
  );
}

function taskLooksCodeReview(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return /(\bcode review\b|\breview generated code\b|\bfinal review\b|\bcoding[- ]manager\b|\bmanager review\b|\breview all generated code\b|\u4ee3\u7801\u590d\u6838|\u4ee3\u7801\u8bc4\u5ba1|\u5ba1\u67e5\u4ee3\u7801|\u6700\u7ec8\u590d\u6838)/.test(
    text
  );
}

function taskRequiresConcreteArtifact(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  const hasExplicitArtifactPath = /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/.test(text);
  const hasNegatedArtifactWrite =
    /(\bdo not\b|\bdon't\b|\bwithout\b|\bavoid\b|\bnever\b).{0,20}\b(write|create|generate|save|export|deliver)\b/.test(text) ||
    /\b(write|create|generate|save|export|deliver)\b.{0,20}\b(no|without)\b.{0,12}\b(file|document|report|artifact|files|documents|reports|artifacts)\b/.test(text) ||
    /(?:不要|勿|禁止|无需|不必).{0,8}(?:写入|生成|创建|导出|保存).{0,8}(?:文件|文档|报告|交付物)/.test(text);

  if (hasExplicitArtifactPath) {
    return true;
  }
  if (hasNegatedArtifactWrite) {
    return false;
  }

  return (
    /(write|create|generate|save|export|deliver).{0,40}(file|document|report|artifact)/.test(text) ||
    /(\u6587\u4ef6|\u6587\u6863|\u62a5\u544a|\u4ea4\u4ed8\u7269|\u751f\u6210doc|\u751f\u6210docx)/.test(text)
  );
}

function taskNeedsFreshFacts(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return /(\blatest\b|\brecent\b|\bcurrent\b|\btoday\b|\byesterday\b|\btomorrow\b|\breal[- ]time\b|\bannouncement\b|\bmarket\b|\bquote\b|\bfact[- ]check\b|\bverify\b|\bverification\b|\bsource\b|\bbrowse\b|\bweb\b|\bsearch\b|\bresearch\b|\bnews\b|\b行情\b|\b公告\b|\b最新\b|\b最近\b|\b实时\b|\b核验\b|\b验证\b|\b来源\b|\b网页\b|\b搜索\b|\b交易日\b|\b市场\b)/.test(
    text
  );
}

function filterWorkersForTask(workers, phase, task, capabilityRoutingPolicy) {
  const policy = normalizeCapabilityRoutingPolicy(capabilityRoutingPolicy);
  let eligibleWorkers = Array.isArray(workers) ? workers.slice() : [];
  if (!eligibleWorkers.length) {
    return [];
  }

  const workersWithWebSearch = eligibleWorkers.filter((worker) => worker?.webSearch);
  if (
    phase === "research" &&
    taskNeedsFreshFacts(task) &&
    policy.requireWebSearchForFreshFacts &&
    workersWithWebSearch.length
  ) {
    eligibleWorkers = workersWithWebSearch;
  }

  if (phase === "validation" && policy.requireValidationSpecialistForValidation) {
    const validationSpecialists = eligibleWorkers.filter((worker) =>
      inferWorkerPhases(worker).includes("validation")
    );
    if (validationSpecialists.length) {
      eligibleWorkers = validationSpecialists;
    }
  }

  if (
    phase === "validation" &&
    taskLooksCodeReview(task) &&
    policy.requireCodingManagerForCodeReview
  ) {
    const codingManagers = eligibleWorkers.filter((worker) =>
      workerHasSpecialty(worker, "coding_manager")
    );
    if (codingManagers.length) {
      eligibleWorkers = codingManagers;
    }
  }

  if (phase === "handoff" && policy.requirePhaseSpecialistForHandoff) {
    const handoffSpecialists = eligibleWorkers.filter((worker) =>
      inferWorkerPhases(worker).includes("handoff")
    );
    if (handoffSpecialists.length) {
      eligibleWorkers = handoffSpecialists;
    }
  }

  return eligibleWorkers;
}

function inferWorkerPhases(worker) {
  const specialties = safeArray(worker?.specialties).map((item) => item.toLowerCase());
  const phases = new Set();

  for (const specialty of specialties) {
    for (const phase of ROLE_PHASES[specialty] || []) {
      phases.add(phase);
    }
  }

  for (const phase of PHASE_ORDER) {
    if (PHASE_HINTS[phase].some((hint) => specialties.some((specialty) => specialty.includes(hint)))) {
      phases.add(phase);
    }
  }

  if (worker?.webSearch) {
    phases.add("research");
  }

  if (String(worker?.model || "").toLowerCase().includes("codex")) {
    phases.add("implementation");
    phases.add("validation");
  }

  if (!phases.size) {
    phases.add("implementation");
  }

  return Array.from(phases);
}

function inferPhase(task, worker) {
  const explicit = normalizePhase(task?.phase || "", "");
  if (explicit) {
    return explicit;
  }

  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput, worker?.specialties);
  if (/(search|research|source|evidence|example|compare|collect|survey|current|fact)/.test(text)) {
    return "research";
  }
  if (/(test|validate|verification|review|check|qa|lint|build)/.test(text)) {
    return "validation";
  }
  if (/(document|handoff|report|summar|explain|presentation|communicat)/.test(text)) {
    return "handoff";
  }
  if (/(code|script|patch|implement|fix|write|edit|refactor)/.test(text)) {
    return "implementation";
  }

  return inferWorkerPhases(worker)[0] || "implementation";
}

function scoreWorkerForTask(worker, phase, task, capabilityRoutingPolicy = null) {
  const policy = normalizeCapabilityRoutingPolicy(capabilityRoutingPolicy);
  const workerPhases = inferWorkerPhases(worker);
  const specialties = safeArray(worker?.specialties).map((item) => item.toLowerCase());
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  let score = workerPhases.includes(phase) ? 10 : 0;

  if (phase === "research" && worker?.webSearch) {
    score += 4;
  }
  if (phase === "research" && policy.preferWebSearchForResearch && worker?.webSearch) {
    score += 4;
  }

  if (phase === "implementation" && String(worker?.model || "").toLowerCase().includes("codex")) {
    score += 4;
  }
  if (
    phase === "implementation" &&
    policy.preferCodexForImplementation &&
    String(worker?.model || "").toLowerCase().includes("codex")
  ) {
    score += 4;
  }

  if (phase === "validation" && workerHasSpecialty(worker, "coding_manager") && taskLooksCodeReview(task)) {
    score += 8;
  }

  for (const hint of PHASE_HINTS[phase] || []) {
    if (specialties.some((specialty) => specialty.includes(hint))) {
      score += 2;
    }
    if (text.includes(hint)) {
      score += 1;
    }
  }

  return score;
}

function normalizeStatusCode(value) {
  const status = Number(value);
  return Number.isFinite(status) && status > 0 ? Math.floor(status) : 0;
}

function isRetryableProviderStatus(status) {
  return RETRYABLE_PROVIDER_STATUSES.has(normalizeStatusCode(status));
}

function looksLikeRetryableProviderMessage(message) {
  const text = safeString(message).toLowerCase();
  if (!text) {
    return false;
  }

  return /timed out|timeout|gateway|bad gateway|service unavailable|temporarily down|upstream|rate limit|429|fetch failed|network|econnreset|econnrefused|socket|enotfound|eai_again|other side closed|circuit breaker/.test(
    text
  );
}

function classifyProviderTaskError(error, worker = null, sessionRuntime = null) {
  const status = normalizeStatusCode(error?.status);
  const errorMessage = safeString(error?.message || error);
  const retryableFromStatus = isRetryableProviderStatus(status);
  const retryableFromFlag = Boolean(error?.retryable);
  const retryableFromMessage = looksLikeRetryableProviderMessage(errorMessage);
  const circuitState = safeString(sessionRuntime?.getCircuitState?.(worker?.id)?.state);
  const retryableFromCircuit = /circuit breaker|circuit for/i.test(errorMessage);
  const retryableProviderFailure =
    retryableFromFlag || retryableFromStatus || retryableFromMessage || retryableFromCircuit;
  const providerFailure =
    retryableProviderFailure ||
    status > 0 ||
    /request to https?:\/\//i.test(errorMessage) ||
    /provider/i.test(errorMessage);

  return {
    failureKind: retryableProviderFailure ? "provider_retryable" : providerFailure ? "provider" : "task",
    retryableProviderFailure,
    providerFailure,
    errorStatus: status || null,
    errorMessage,
    circuitState
  };
}

function normalizeWorkerBaseUrl(worker) {
  return safeString(worker?.baseUrl).toLowerCase();
}

function normalizeWorkerProvider(worker) {
  return safeString(worker?.provider).toLowerCase();
}

function createControllerRuntimeAgent(modelConfig, currentRuntimeAgent = null) {
  return {
    ...modelConfig,
    runtimeId:
      currentRuntimeAgent?.runtimeId ||
      `controller:${currentRuntimeAgent?.id || modelConfig.id}`,
    displayLabel: modelConfig.label || modelConfig.id,
    agentKind: "controller",
    parentAgentId: null,
    parentAgentLabel: "",
    phase: "controller",
    delegationDepth: 0,
    ordinalIndex: 0
  };
}

function rebindControllerRuntimeAgent(agent, modelConfig) {
  return createControllerRuntimeAgent(modelConfig, agent);
}

function scoreControllerCandidateForPurpose(worker, purpose, primaryController) {
  const phases = inferWorkerPhases(worker);
  let score = 0;

  if (modelCanActAsController(worker)) {
    score += 10;
  }

  if (purpose === "planning") {
    if (phases.includes("research")) {
      score += 4;
    }
    if (phases.includes("validation")) {
      score += 2;
    }
    if (phases.includes("handoff")) {
      score += 1;
    }
    if (worker?.webSearch) {
      score += 1;
    }
  } else if (purpose === "synthesis") {
    if (phases.includes("handoff")) {
      score += 6;
    }
    if (phases.includes("validation")) {
      score += 2;
    }
    if (phases.includes("research")) {
      score += 1;
    }
  }

  if (
    normalizeWorkerBaseUrl(worker) &&
    normalizeWorkerBaseUrl(worker) !== normalizeWorkerBaseUrl(primaryController)
  ) {
    score += 6;
  }

  if (
    normalizeWorkerProvider(worker) &&
    normalizeWorkerProvider(worker) !== normalizeWorkerProvider(primaryController)
  ) {
    score += 3;
  }

  return score;
}

function rankFallbackControllers({
  models,
  primaryController,
  purpose,
  providerRegistry
}) {
  const candidates = (Array.isArray(models) ? models : []).filter(
    (modelConfig) =>
      modelConfig?.id &&
      modelConfig.id !== primaryController?.id &&
      providerRegistry?.get(modelConfig.id)
  );
  const controllerSpecialists = candidates.filter((modelConfig) =>
    modelCanActAsController(modelConfig)
  );
  const eligibleCandidates = controllerSpecialists.length ? controllerSpecialists : candidates;

  return eligibleCandidates
    .sort((left, right) => {
      const leftScore = scoreControllerCandidateForPurpose(left, purpose, primaryController);
      const rightScore = scoreControllerCandidateForPurpose(right, purpose, primaryController);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return safeString(left.label || left.id).localeCompare(safeString(right.label || right.id));
    });
}

function rankFallbackWorkersForTask({
  workers,
  primaryWorker,
  phase,
  task,
  capabilityRoutingPolicy,
  providerRegistry
}) {
  const eligibleWorkers = filterWorkersForTask(
    Array.isArray(workers) ? workers : [],
    phase,
    task,
    capabilityRoutingPolicy
  );
  const primaryBaseUrl = normalizeWorkerBaseUrl(primaryWorker);
  const primaryProvider = normalizeWorkerProvider(primaryWorker);

  return eligibleWorkers
    .filter(
      (worker) =>
        worker?.id &&
        worker.id !== primaryWorker?.id &&
        providerRegistry?.get(worker.id)
    )
    .sort((left, right) => {
      const leftScore =
        scoreWorkerForTask(left, phase, task, capabilityRoutingPolicy) +
        (normalizeWorkerBaseUrl(left) && normalizeWorkerBaseUrl(left) !== primaryBaseUrl ? 6 : 0) +
        (normalizeWorkerProvider(left) && normalizeWorkerProvider(left) !== primaryProvider ? 3 : 0);
      const rightScore =
        scoreWorkerForTask(right, phase, task, capabilityRoutingPolicy) +
        (normalizeWorkerBaseUrl(right) && normalizeWorkerBaseUrl(right) !== primaryBaseUrl ? 6 : 0) +
        (normalizeWorkerProvider(right) && normalizeWorkerProvider(right) !== primaryProvider ? 3 : 0);

      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }

      return safeString(left.label).localeCompare(safeString(right.label));
    });
}

function pickBestWorkerForTask(workers, phase, task, capabilityRoutingPolicy = null) {
  const eligibleWorkers = filterWorkersForTask(workers, phase, task, capabilityRoutingPolicy);
  const candidateWorkers = eligibleWorkers.length ? eligibleWorkers : [...workers];
  return [...candidateWorkers]
    .sort(
      (left, right) =>
        scoreWorkerForTask(right, phase, task, capabilityRoutingPolicy) -
        scoreWorkerForTask(left, phase, task, capabilityRoutingPolicy)
    )[0];
}

function normalizeConcurrencyLimit(value, fallback = 1) {
  const configured = Number(value);
  if (!Number.isFinite(configured) || configured < 0) {
    return fallback;
  }

  return Math.floor(configured);
}

function formatConcurrencyLimit(limit) {
  return Number.isFinite(limit) && limit > 0 ? String(limit) : "unlimited";
}

function createExecutionGate(maxParallel) {
  const normalizedLimit = normalizeConcurrencyLimit(maxParallel, 1);
  if (normalizedLimit === 0) {
    return {
      limit: Number.POSITIVE_INFINITY,
      async run(work, { signal } = {}) {
        throwIfAborted(signal);
        return work();
      }
    };
  }

  let active = 0;
  const queue = [];

  function createRelease() {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      active = Math.max(0, active - 1);

      while (queue.length && active < normalizedLimit) {
        const waiter = queue.shift();
        if (!waiter || waiter.cancelled) {
          continue;
        }

        waiter.cleanup?.();
        waiter.cleanup = null;
        active += 1;
        waiter.resolve(createRelease());
        break;
      }
    };
  }

  function acquire(signal) {
    throwIfAborted(signal);

    if (active < normalizedLimit) {
      active += 1;
      return Promise.resolve(createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cancelled: false,
        cleanup: null
      };

      const abortHandler = () => {
        waiter.cancelled = true;
        const index = queue.indexOf(waiter);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        waiter.cleanup?.();
        waiter.cleanup = null;
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", abortHandler);
      }

      queue.push(waiter);
    });
  }

  return {
    limit: normalizedLimit,
    async run(work, { signal } = {}) {
      const release = await acquire(signal);

      try {
        throwIfAborted(signal);
        return await work();
      } finally {
        release();
      }
    }
  };
}

function resolvePhaseConcurrency(phase, maxParallel, config) {
  const configuredCap = Number(config?.cluster?.phaseParallel?.[phase]);
  const hardCap =
    Number.isFinite(configuredCap) && configuredCap >= 0
      ? Math.floor(configuredCap)
      : PHASE_CONCURRENCY_CAPS[phase] ?? 0;
  const clusterCap = normalizeConcurrencyLimit(maxParallel, 1);

  if (hardCap === 0 && clusterCap === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (hardCap === 0) {
    return clusterCap === 0 ? Number.POSITIVE_INFINITY : Math.max(1, clusterCap);
  }
  if (clusterCap === 0) {
    return Math.max(1, hardCap);
  }

  return Math.max(1, Math.min(clusterCap, hardCap));
}

function countRunningResearchTasksForBaseUrl(runningTaskIds, taskById, config, baseUrl) {
  if (!baseUrl) {
    return 0;
  }

  let count = 0;
  for (const taskId of runningTaskIds) {
    const runningTask = taskById.get(taskId);
    if (!runningTask || runningTask.phase !== "research") {
      continue;
    }

    const worker = config.models[runningTask.assignedWorker];
    if (String(worker?.baseUrl || "").trim().toLowerCase() === baseUrl) {
      count += 1;
    }
  }

  return count;
}

function canStartTaskForPhase(task, runningTaskIds, taskById, config) {
  if (task.phase !== "research") {
    return true;
  }

  const worker = config.models[task.assignedWorker];
  if (!worker?.webSearch) {
    return true;
  }

  const baseUrl = String(worker?.baseUrl || "").trim().toLowerCase();
  if (!baseUrl) {
    return true;
  }

  const sharedGatewayCap = resolveSharedResearchGatewayMaxParallel(config);
  if (sharedGatewayCap === 0) {
    return true;
  }

  return (
    countRunningResearchTasksForBaseUrl(runningTaskIds, taskById, config, baseUrl) < sharedGatewayCap
  );
}

function resolveAgentPrefix(phase, kind) {
  const bucket = AGENT_PREFIX[normalizePhase(phase, "general")] || AGENT_PREFIX.general;
  return bucket[kind] || AGENT_PREFIX.general[kind] || "";
}

function buildRuntimeDisplayLabel(worker, phase, kind, ordinalIndex = 0) {
  const prefix = resolveAgentPrefix(phase, kind);
  if (kind === "subordinate") {
    return `${prefix}${padAgentIndex(Math.max(1, Number(ordinalIndex) || 1))} 路 ${worker.label}`;
  }

  return `${prefix} 路 ${worker.label}`;
}

function formatRuntimeDisplayLabel(worker, phase, kind, ordinalIndex = 0) {
  const prefix = resolveAgentPrefix(phase, kind);
  if (kind === "subordinate") {
    return `${prefix}${padAgentIndex(Math.max(1, Number(ordinalIndex) || 1))} · ${worker.label}`;
  }

  return `${prefix} · ${worker.label}`;
}

function createLeaderRuntimeAgent(worker, task) {
  const phase = normalizePhase(task?.phase, inferWorkerPhases(worker)[0] || "implementation");
  return {
    ...worker,
    runtimeId: `leader:${worker.id}`,
    displayLabel: formatRuntimeDisplayLabel(worker, phase, "leader"),
    agentKind: "leader",
    parentAgentId: null,
    phase,
    delegationDepth: 0,
    ordinalIndex: 0
  };
}

function createSubordinateRuntimeAgent(leaderAgent, task, index) {
  const phase = normalizePhase(task?.phase, leaderAgent.phase || "implementation");
  const ordinalIndex = index + 1;
  return {
    ...leaderAgent,
    runtimeId: `${leaderAgent.runtimeId || leaderAgent.id}::${task.id}:${padAgentIndex(ordinalIndex)}`,
    displayLabel: formatRuntimeDisplayLabel(leaderAgent, phase, "subordinate", ordinalIndex),
    agentKind: "subordinate",
    parentAgentId: leaderAgent.runtimeId,
    parentAgentLabel: leaderAgent.displayLabel,
    phase,
    delegationDepth: Math.max(0, Number(leaderAgent.delegationDepth || 0) + 1),
    ordinalIndex
  };
}

function rebindRuntimeAgent(agent, worker) {
  const agentKind = safeString(agent?.agentKind) || "leader";
  const phase = normalizePhase(agent?.phase, inferWorkerPhases(worker)[0] || "implementation");
  return {
    ...worker,
    runtimeId: agent.runtimeId || `${agentKind}:${worker.id}`,
    displayLabel: formatRuntimeDisplayLabel(worker, phase, agentKind, agent.ordinalIndex),
    agentKind,
    parentAgentId: agent.parentAgentId || null,
    parentAgentLabel: agent.parentAgentLabel || "",
    phase,
    delegationDepth: Math.max(0, Number(agent.delegationDepth || 0)),
    ordinalIndex: Math.max(0, Number(agent.ordinalIndex || 0))
  };
}

function buildAgentEventBase(agent, task = null) {
  return {
    agentId: agent.runtimeId || agent.id,
    agentLabel: agent.displayLabel || agent.label || agent.id,
    agentKind: agent.agentKind || "leader",
    parentAgentId: agent.parentAgentId || "",
    parentAgentLabel: agent.parentAgentLabel || "",
    modelId: agent.id,
    modelLabel: agent.label,
    taskId: task?.id || "",
    taskTitle: task?.title || ""
  };
}

function emitAgentEvent(onEvent, agent, payload, task = null) {
  emitEvent(onEvent, {
    ...buildAgentEventBase(agent, task),
    ...payload
  });
}

function normalizeDelegationPlan(parsed, delegateCount, options = {}) {
  const defaultToRequested = options.defaultToRequested !== false;
  const preferDelegation = options.preferDelegation === true;
  const languagePack = createRunLanguagePack(options.outputLocale);
  const subtasks = Array.isArray(parsed?.subtasks) ? parsed.subtasks : [];
  const explicitCount = Number(parsed?.delegateCount);
  const desiredCount =
    Number.isFinite(explicitCount) && explicitCount >= 0 && !(preferDelegation && explicitCount === 0 && !subtasks.length)
      ? Math.min(delegateCount, Math.floor(explicitCount))
      : subtasks.length
        ? Math.min(delegateCount, subtasks.length)
        : defaultToRequested
          ? delegateCount
          : 0;
  const seenIds = new Set();
  const normalizedSubtasks = subtasks
    .slice(0, desiredCount)
    .map((subtask, index) => {
      const preferredId = safeString(subtask?.id).replace(/[^\w-]/g, "_") || `sub_${index + 1}`;
      let subtaskId = preferredId;
      while (seenIds.has(subtaskId)) {
        subtaskId = `${preferredId}_${index + 1}`;
      }
      seenIds.add(subtaskId);
      const fallbackTitle = languagePack.subtaskTitle(index);
      return {
        id: subtaskId,
        title: resolveLocalizedTaskTitle(subtask?.title, fallbackTitle, "subtask"),
        instructions: safeString(subtask?.instructions) || languagePack.subtaskInstructions(index),
        dependsOn: safeArray(subtask?.dependsOn),
        expectedOutput: safeString(subtask?.expectedOutput) || languagePack.subtaskExpectedOutput()
      };
    });

  while (defaultToRequested && normalizedSubtasks.length < desiredCount) {
    const index = normalizedSubtasks.length;
    const subtaskId = `sub_${index + 1}`;
    seenIds.add(subtaskId);
    normalizedSubtasks.push({
      id: subtaskId,
      title: languagePack.subtaskTitle(index),
      instructions: languagePack.subtaskInstructions(index),
      dependsOn: [],
      expectedOutput: languagePack.subtaskExpectedOutput()
    });
  }

  const subtaskIdSet = new Set(normalizedSubtasks.map((subtask) => subtask.id));
  const implicitDependencies = inferImplicitDelegationDependencies(normalizedSubtasks);
  const finalizedSubtasks = normalizedSubtasks.map((subtask) => ({
    ...subtask,
    dependsOn: uniqueArray([
      ...safeArray(subtask.dependsOn).filter(
        (dependencyId) => dependencyId !== subtask.id && subtaskIdSet.has(dependencyId)
      ),
      ...(implicitDependencies.get(subtask.id) || [])
    ])
  }));

  return {
    thinkingSummary: safeString(parsed?.thinkingSummary),
    delegationSummary: safeString(parsed?.delegationSummary),
      subtasks: finalizedSubtasks
  };
}

function summarizeExecutionForDependency(execution) {
  return {
    taskId: execution.taskId,
    title: execution.title,
    workerId: execution.workerId,
    workerLabel: execution.workerLabel,
    phase: execution.phase,
    status: execution.status,
    output: execution.output
  };
}

function summarizeSubordinateExecution(execution) {
  return {
    agentId: execution.agentId || execution.workerId,
    agentLabel: execution.agentLabel || execution.workerLabel || execution.workerId,
    status: execution.status,
    summary: execution.output?.summary || "",
    thinkingSummary: execution.output?.thinkingSummary || "",
    generatedFiles: execution.output?.generatedFiles || [],
    verifiedGeneratedFiles: execution.output?.verifiedGeneratedFiles || [],
    executedCommands: execution.output?.executedCommands || []
  };
}

function buildDefaultFallbackTasks(workers, originalTask, outputLocale = "en-US") {
  const languagePack = createRunLanguagePack(outputLocale);
  return workers.map((worker, index) => {
    const phase = inferWorkerPhases(worker)[0] || "implementation";
    return {
      id: `task_${index + 1}`,
      phase,
      title: languagePack.fallbackTaskTitle(worker, phase),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.fallbackTaskInstructions(originalTask),
      dependsOn: [],
      expectedOutput: languagePack.fallbackTaskExpectedOutput()
    };
  });
}

function injectWorkflowTasks(tasks, workers, originalTask, outputLocale = "en-US") {
  const languagePack = createRunLanguagePack(outputLocale);
  const output = [...tasks];
  const implementationTasks = output.filter((task) => task.phase === "implementation");
  const validationWorkers = workers.filter((worker) => inferWorkerPhases(worker).includes("validation"));
  const codingManagerWorkers = validationWorkers.filter((worker) =>
    workerHasSpecialty(worker, "coding_manager")
  );
  const handoffWorkers = workers.filter((worker) => inferWorkerPhases(worker).includes("handoff"));

  if (
    implementationTasks.length &&
    !output.some((task) => task.phase === "validation") &&
    validationWorkers.length &&
    !codingManagerWorkers.length
  ) {
    const worker = pickBestWorkerForTask(validationWorkers, "validation", {
      title: languagePack.validateGeneratedWorkspaceOutputsTitle(),
      instructions: originalTask
    });
    output.push({
      id: "validation_gate",
      phase: "validation",
      title: languagePack.validateGeneratedOutputsTitle(),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.validationGateInstructions(),
      dependsOn: implementationTasks.map((task) => task.id),
      expectedOutput: languagePack.validationGateExpectedOutput()
    });
  }

  if (
    implementationTasks.length &&
    codingManagerWorkers.length &&
    !output.some((task) => task.id === "coding_management_review")
  ) {
    const worker = pickBestWorkerForTask(codingManagerWorkers, "validation", {
      title: languagePack.finalCodeManagementReviewTitle(),
      instructions: originalTask,
      expectedOutput: languagePack.validationGateExpectedOutput()
    });
    const validationDependencies = output
      .filter((task) => task.phase === "validation" && task.id !== "coding_management_review")
      .map((task) => task.id);

    output.push({
      id: "coding_management_review",
      phase: "validation",
      title: languagePack.finalCodeManagementReviewTitle(),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.finalCodeManagementReviewInstructions(),
      dependsOn: uniqueArray([
        ...implementationTasks.map((task) => task.id),
        ...validationDependencies
      ]),
      expectedOutput: languagePack.finalCodeManagementReviewExpectedOutput()
    });
  }

  if (!output.some((task) => task.phase === "handoff") && handoffWorkers.length) {
    const worker = pickBestWorkerForTask(handoffWorkers, "handoff", {
      title: languagePack.prepareHandoffSummaryTitle(),
      instructions: originalTask
    });
    output.push({
      id: "handoff_summary",
      phase: "handoff",
      title: languagePack.prepareHandoffSummaryTitle(),
      assignedWorker: worker.id,
      delegateCount: 0,
      instructions: languagePack.prepareHandoffSummaryInstructions(),
      dependsOn: output.filter((task) => task.phase !== "handoff").map((task) => task.id),
      expectedOutput: languagePack.prepareHandoffSummaryExpectedOutput()
    });
  }

  return output;
}

function normalizePlan(
  rawPlan,
  workers,
  originalTask,
  topLevelTaskLimit,
  groupLeaderMaxDelegates,
  delegateMaxDepth,
  capabilityRoutingPolicy = null,
  multiAgentConfig = null,
  outputLocale = "en-US"
) {
  const languagePack = createRunLanguagePack(outputLocale);
  const workerIds = new Set(workers.map((worker) => worker.id));
  const fallbackTasks = buildDefaultFallbackTasks(workers, originalTask, outputLocale);

  const taskCandidates = Array.isArray(rawPlan?.tasks) && rawPlan.tasks.length ? rawPlan.tasks : fallbackTasks;
  const seenIds = new Set();
  const preliminaryTasks = taskCandidates
    .slice(0, Math.max(1, Number(topLevelTaskLimit) || 1))
    .map((task, index) => {
    const preferredId = String(task?.id || `task_${index + 1}`).replace(/[^\w-]/g, "_");
    let taskId = preferredId || `task_${index + 1}`;
    while (seenIds.has(taskId)) {
      taskId = `${taskId}_${index + 1}`;
    }

    const requestedWorker = workerIds.has(task?.assignedWorker)
      ? workers.find((worker) => worker.id === String(task.assignedWorker))
      : workers[index % workers.length];
    const phase = inferPhase(task, requestedWorker);
    const assignedWorkerCandidate = requestedWorker || workers[index % workers.length];
    const eligibleWorkers = filterWorkersForTask(
      workers,
      phase,
      task,
      capabilityRoutingPolicy
    );
    const reroutedWorker =
      eligibleWorkers.includes(assignedWorkerCandidate) &&
      scoreWorkerForTask(assignedWorkerCandidate, phase, task, capabilityRoutingPolicy) > 0
        ? assignedWorkerCandidate
        : pickBestWorkerForTask(
            eligibleWorkers.length ? eligibleWorkers : workers,
            phase,
            task,
            capabilityRoutingPolicy
          ) || assignedWorkerCandidate;
    seenIds.add(taskId);

    return {
      id: taskId,
      phase,
      title: resolveLocalizedTaskTitle(task?.title, languagePack.taskTitle(index), "task"),
      assignedWorker: reroutedWorker.id,
      delegateCount: resolveTaskDelegateCount(
        task,
        phase,
        groupLeaderMaxDelegates,
        delegateMaxDepth
      ),
      instructions: String(
        task?.instructions ||
          languagePack.analyzeObjective(originalTask)
      ),
      dependsOn: safeArray(task?.dependsOn),
      expectedOutput: String(task?.expectedOutput || languagePack.structuredSpecialistAnalysis())
    };
  });

  const tasksWithWorkflow = injectWorkflowTasks(preliminaryTasks, workers, originalTask, outputLocale);
  const taskById = new Map(tasksWithWorkflow.map((task) => [task.id, task]));
  const tasks = tasksWithWorkflow
    .map((task) => ({
      ...task,
      dependsOn: safeArray(task.dependsOn).filter((dependencyId) => {
        const dependency = taskById.get(dependencyId);
        return dependency && phaseIndex(dependency.phase) <= phaseIndex(task.phase);
      })
    }))
    .sort((left, right) => {
      const phaseDelta = phaseIndex(left.phase) - phaseIndex(right.phase);
      if (phaseDelta !== 0) {
        return phaseDelta;
      }
      return left.id.localeCompare(right.id);
    });
  const modeAdjustedTasks = applyMultiAgentModeToTasks(tasks, multiAgentConfig).map((task) => ({
    ...task,
    requirements: deriveTaskRequirements(task)
  }));

  return {
    objective: String(rawPlan?.objective || originalTask),
    strategy: String(
      rawPlan?.strategy ||
        "Run the workflow in phases: research, implementation, validation, then handoff before the controller synthesizes the final answer."
    ),
    tasks: modeAdjustedTasks
  };
}

function applyMultiAgentModeToTasks(tasks, multiAgentConfig = null) {
  const settings = normalizeMultiAgentRuntimeSettings(multiAgentConfig);
  const normalizedTasks = Array.isArray(tasks) ? tasks.map((task) => ({ ...task })) : [];
  if (!settings.enabled || !normalizedTasks.length) {
    return normalizedTasks;
  }

  if (settings.mode === "sequential") {
    let previousTaskId = "";
    return normalizedTasks.map((task) => {
      const nextTask = {
        ...task,
        dependsOn: uniqueArray([
          ...safeArray(task.dependsOn),
          ...(previousTaskId ? [previousTaskId] : [])
        ])
      };
      previousTaskId = task.id;
      return nextTask;
    });
  }

  if (settings.mode === "workflow") {
    const completedByPreviousPhases = [];
    let currentPhase = normalizedTasks[0]?.phase || "";

    return normalizedTasks.map((task) => {
      if (task.phase !== currentPhase) {
        currentPhase = task.phase;
        completedByPreviousPhases.push(
          ...normalizedTasks
            .filter((candidate) => phaseIndex(candidate.phase) < phaseIndex(task.phase))
            .map((candidate) => candidate.id)
        );
      }

      return {
        ...task,
        dependsOn: uniqueArray([
          ...safeArray(task.dependsOn),
          ...completedByPreviousPhases
        ])
      };
    });
  }

  return normalizedTasks;
}

function applyTaskOutputGuards(task, output, extras = {}) {
  const guarded = {
    ...output,
    keyFindings: uniqueArray(output?.keyFindings || []),
    risks: uniqueArray(output?.risks || []),
    deliverables: uniqueArray(output?.deliverables || []),
    followUps: uniqueArray(output?.followUps || []),
    generatedFiles: uniqueArray(output?.generatedFiles || []),
    verifiedGeneratedFiles: uniqueArray(output?.verifiedGeneratedFiles || []),
    workspaceActions: uniqueArray(output?.workspaceActions || []),
    executedCommands: uniqueArray(output?.executedCommands || []),
    delegationNotes: uniqueArray(output?.delegationNotes || [])
  };

  const actualGeneratedFiles = uniqueArray(
    Array.isArray(extras.actualGeneratedFiles)
      ? extras.actualGeneratedFiles
      : guarded.verifiedGeneratedFiles
  );

  if (taskRequiresConcreteArtifact(task) && !actualGeneratedFiles.length) {
    guarded.verificationStatus = "failed";
    guarded.risks = uniqueArray([
      ...guarded.risks,
      "Task expected a concrete file artifact, but no generated file was verified in the workspace."
    ]);
    guarded.followUps = uniqueArray([
      ...guarded.followUps,
      "Write the requested artifact into the workspace and include it in generatedFiles."
    ]);
  }

  return guarded;
}

function normalizeWorkerResult(parsed, rawText, extras = {}) {
  return {
    thinkingSummary: String(parsed?.thinkingSummary || extras.thinkingSummary || ""),
    summary: String(parsed?.summary || rawText || "No summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    risks: safeArray(parsed?.risks),
    deliverables: safeArray(parsed?.deliverables),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    followUps: safeArray(parsed?.followUps),
    generatedFiles: uniqueArray([
      ...normalizeArtifactArray(parsed?.generatedFiles),
      ...normalizeArtifactArray(extras.generatedFiles)
    ]),
    verifiedGeneratedFiles: uniqueArray([
      ...normalizeArtifactArray(parsed?.verifiedGeneratedFiles),
      ...normalizeArtifactArray(extras.verifiedGeneratedFiles)
    ]),
    workspaceActions: uniqueArray([...(parsed?.workspaceActions || []), ...(extras.workspaceActions || [])]),
    executedCommands: uniqueArray([...(parsed?.executedCommands || []), ...(extras.executedCommands || [])]),
    toolUsage: uniqueArray([...(parsed?.toolUsage || []), ...(extras.toolUsage || [])]),
    memoryReads: Math.max(0, Number(parsed?.memoryReads ?? extras.memoryReads ?? 0) || 0),
    memoryWrites: Math.max(0, Number(parsed?.memoryWrites ?? extras.memoryWrites ?? 0) || 0),
    verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus || extras.verificationStatus),
    delegationNotes: uniqueArray([...(parsed?.delegationNotes || []), ...(extras.delegationNotes || [])]),
    unstructuredOutput: Boolean(parsed?.unstructuredOutput || extras.unstructuredOutput),
    subordinateCount: Number(extras.subordinateCount || 0),
    subordinateResults: Array.isArray(extras.subordinateResults) ? extras.subordinateResults : []
  };
}

function normalizeSynthesis(parsed, rawText) {
  return {
    finalAnswer: String(parsed?.finalAnswer || rawText || "No final answer returned."),
    executiveSummary: safeArray(parsed?.executiveSummary),
    consensus: safeArray(parsed?.consensus),
    disagreements: safeArray(parsed?.disagreements),
    nextActions: safeArray(parsed?.nextActions)
  };
}

function createStructuredFallback(label, rawText, error) {
  return {
    unstructuredOutput: true,
    thinkingSummary: "",
    summary: `${label} returned unstructured output.`,
    keyFindings: [rawText.slice(0, 2000)],
    risks: [String(error.message || error)],
    deliverables: [],
    confidence: "low",
    followUps: ["Tighten the prompt or use a model with more reliable JSON output."]
  };
}

function parseStructuredJsonOrFallback(label, rawText) {
  try {
    const parsed = parseJsonFromText(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Model output did not parse into a JSON object.");
    }
    return parsed;
  } catch (error) {
    return createStructuredFallback(label, rawText, error);
  }
}

async function invokeProviderWithSessionLegacy({
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
  allowEmptyText = false
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
    spanLabel: `${agent.displayLabel || agent.label || agent.id} · ${purpose}`
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

function resolveSubordinateConcurrency(agent, task, config, requestedCount) {
  const total = Math.max(1, Number(requestedCount) || 1);
  const phaseCap = resolvePhaseConcurrency(task?.phase, config?.cluster?.maxParallel, config);
  const limits = [phaseCap].filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, limits.length ? Math.min(total, ...limits) : total);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(normalizedItems.length);
  let nextIndex = 0;

  async function workerLoop() {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= normalizedItems.length) {
        return;
      }

      results[currentIndex] = await mapper(normalizedItems[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, normalizedItems.length) }, () => workerLoop())
  );

  return results;
}

async function executeSingleTask({
  task,
  originalTask,
  plan,
  completedResults,
  providerRegistry,
  config,
  executionGate,
  runAgentBudget = null,
  sessionRuntime,
  parentSpanId = "",
  onEvent,
  signal,
  outputLocale = "en-US"
}) {
  const runLocale = normalizeRunLocale(outputLocale);
  const languagePack = createRunLanguagePack(runLocale);
  const allWorkers = workerListFromConfig(config);
  const capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
    config?.cluster?.capabilityRoutingPolicy
  );
  const primaryWorker = config.models[task.assignedWorker];
  let attemptChildAgentReservations = 0;

  function buildDependencyOutputs() {
    return task.dependsOn
      .map((dependencyId) => completedResults.get(dependencyId))
      .filter(Boolean)
      .map((result) => ({
        taskId: result.taskId,
        workerId: result.workerId,
        status: result.status,
        output: result.output
      }));
  }

  function resolveLifecycleStages(agent) {
    if (agent.agentKind === "subordinate") {
      return {
        start: "subagent_start",
        done: "subagent_done",
        failed: "subagent_failed",
        retry: "subagent_retry"
      };
    }

    return {
      start: "worker_start",
      done: "worker_done",
      failed: "worker_failed",
      retry: "worker_retry"
    };
  }

  function buildFailureResult(agent, agentTask, error, startedAt) {
    const endedAt = Date.now();
    const failure = classifyProviderTaskError(error, agent, sessionRuntime);
    const output = applyTaskOutputGuards(
      agentTask,
      normalizeWorkerResult(
        {
          thinkingSummary: "",
          summary: `${agent.displayLabel || agent.label} execution failed: ${failure.errorMessage}`,
          risks: [failure.errorMessage],
          confidence: "low",
          followUps: ["Check the provider baseUrl, API key, and model id."]
        },
        "",
        {
          verificationStatus: agentTask.phase === "validation" ? "failed" : "not_applicable"
        }
      )
    );
    return {
      taskId: agentTask.id,
      title: agentTask.title,
      workerId: agent.id,
      workerLabel: agent.label,
      agentId: agent.runtimeId || agent.id,
      agentLabel: agent.displayLabel || agent.label,
      agentKind: agent.agentKind || "leader",
      phase: agentTask.phase,
      status: "failed",
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      rawText: "",
      output,
      failureKind: failure.failureKind,
      providerFailure: failure.providerFailure,
      retryableProviderFailure: failure.retryableProviderFailure,
      errorMessage: failure.errorMessage,
      errorStatus: failure.errorStatus,
      circuitState: failure.circuitState,
      failedWorkerId: agent.id,
      failedWorkerLabel: agent.label
    };
  }

  async function runWithExecutionGate(work) {
    if (!executionGate) {
      throwIfAborted(signal);
      return work();
    }

    return executionGate.run(work, { signal });
  }

  async function executeDirectAgentTask({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    emitLifecycle = true,
    taskSpanId = ""
  }) {
    throwIfAborted(signal);
    const lifecycle = resolveLifecycleStages(agent);
    const startedAt = Date.now();
    const prompt = buildWorkerExecutionRequest({
      originalTask,
      clusterPlan: plan,
      worker: agent,
      task: agentTask,
      dependencyOutputs,
      outputLocale: runLocale
    });

    if (emitLifecycle) {
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: lifecycle.start,
          tone: "neutral",
          content: agentTask.instructions || agentTask.title || ""
        },
        agentTask
      );
    }

    try {
      let parsed;
      let rawText = "";
      await runWithExecutionGate(async () => {
        if (config.workspace?.resolvedDir) {
          parsed = await runWorkspaceToolLoop({
            provider,
            invokeModel(options) {
              return invokeProviderWithSession({
                sessionRuntime,
                provider: options.provider,
                agent: options.worker,
                task: options.task,
                parentSpanId: options.parentSpanId || taskSpanId,
                purpose: options.purpose,
                instructions: options.instructions,
                input: options.input,
                onRetry: options.onRetry,
                signal: options.signal,
                buildAgentEventBase
              });
            },
            worker: agent,
            task: agentTask,
            originalTask,
            clusterPlan: plan,
            dependencyOutputs,
            workspaceRoot: config.workspace.resolvedDir,
            sessionRuntime,
            parentSpanId: taskSpanId,
            onRetry(retry) {
              emitAgentEvent(
                onEvent,
                agent,
                {
                  ...buildRetryPayload({
                    stage: lifecycle.retry,
                    model: agent,
                    retry,
                    taskId: agentTask.id,
                    taskTitle: agentTask.title
                  }),
                  agentKind: agent.agentKind || "leader"
                },
                agentTask
              );
            },
            onEvent,
            signal
          });
          return;
        }

        const response = await invokeProviderWithSession({
          sessionRuntime,
          provider,
          agent,
          task: agentTask,
          parentSpanId: taskSpanId,
          instructions: prompt.instructions,
          input: prompt.input,
          purpose: agent.agentKind === "subordinate" ? "subordinate_execution" : "worker_execution",
          signal,
          buildAgentEventBase,
          onRetry(retry) {
            emitAgentEvent(
              onEvent,
              agent,
              {
                ...buildRetryPayload({
                  stage: lifecycle.retry,
                  model: agent,
                  retry,
                  taskId: agentTask.id,
                  taskTitle: agentTask.title
                }),
                agentKind: agent.agentKind || "leader"
              },
              agentTask
            );
          }
        });

        rawText = response.text;
        parsed = parseStructuredJsonOrFallback(agent.displayLabel || agent.label, response.text);
      });

      const endedAt = Date.now();
      const output = applyTaskOutputGuards(
        agentTask,
        normalizeWorkerResult(parsed, rawText),
        {
          actualGeneratedFiles: Array.isArray(parsed?.workspaceActions) && parsed.workspaceActions.length
            ? parsed?.verifiedGeneratedFiles || []
            : parsed?.verifiedGeneratedFiles || parsed?.generatedFiles || []
        }
      );
      const result = {
        taskId: agentTask.id,
        title: agentTask.title,
        workerId: agent.id,
        workerLabel: agent.label,
        agentId: agent.runtimeId || agent.id,
        agentLabel: agent.displayLabel || agent.label,
        agentKind: agent.agentKind || "leader",
        phase: agentTask.phase,
        status: "completed",
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        rawText,
        output,
        failureKind: "",
        providerFailure: false,
        retryableProviderFailure: false,
        errorMessage: "",
        errorStatus: null,
        circuitState: "",
        failedWorkerId: "",
        failedWorkerLabel: ""
      };

      sessionRuntime?.remember(
        {
          title: `${agent.displayLabel || agent.label} · ${agentTask.title}`,
          content: output.summary || output.thinkingSummary || rawText,
          tags: uniqueArray([agentTask.phase, agent.id, agent.agentKind || "leader"])
        },
        {
          ...buildAgentEventBase(agent, agentTask),
          parentSpanId: taskSpanId
        }
      );

      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "status",
            stage: lifecycle.done,
            tone: "ok",
            thinkingSummary: result.output.thinkingSummary || "",
            summary: result.output.summary || "",
            content: result.output.summary || result.output.thinkingSummary || "",
            targetAgentLabel: agent.parentAgentLabel || ""
          },
          agentTask
        );
      }

      return result;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const result = buildFailureResult(agent, agentTask, error, startedAt);
      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "error",
            stage: lifecycle.failed,
            tone: "error",
            detail: error.message
          },
          agentTask
        );
      }
      return result;
    }
  }

  async function planLeaderDelegation({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    delegateCount,
    depthRemaining,
    defaultToRequested,
    preferDelegation,
    parentSpanId = ""
  }) {
    const delegationSpanId = sessionRuntime?.startSpan({
      ...buildAgentEventBase(agent, agentTask),
      parentSpanId,
      spanKind: "delegation",
      spanLabel: `${agent.displayLabel || agent.label} · delegation`
    });
    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "leader_delegate_start",
        tone: "neutral",
        content: agentTask.instructions || agentTask.title || "",
        detail:
          languagePack.planningChildAgents(
            delegateCount,
            Number(runAgentBudget?.requestedTotalAgents) || 0
          )
      },
      agentTask
    );

    const prompt = buildLeaderDelegationRequest({
      originalTask,
      clusterPlan: plan,
      leader: agent,
      task: agentTask,
      dependencyOutputs,
      delegateCount,
      depthRemaining,
      runAgentBudget,
      outputLocale: runLocale
    });

    try {
      const response = await runWithExecutionGate(() =>
        invokeProviderWithSession({
          sessionRuntime,
          provider,
          agent,
          task: agentTask,
          parentSpanId: delegationSpanId || parentSpanId,
          instructions: prompt.instructions,
          input: prompt.input,
          purpose: "leader_delegation",
          signal,
          buildAgentEventBase,
          onRetry(retry) {
            emitAgentEvent(
              onEvent,
              agent,
              {
                ...buildRetryPayload({
                  stage: "leader_delegate_retry",
                  model: agent,
                  retry,
                  taskId: agentTask.id,
                  taskTitle: agentTask.title
                }),
                agentKind: agent.agentKind || "leader"
              },
              agentTask
            );
          }
        })
      );

      let parsed;
      try {
        parsed = parseJsonFromText(response.text);
      } catch {
        parsed = null;
      }

      const normalized = normalizeDelegationPlan(parsed, delegateCount, {
        defaultToRequested,
        preferDelegation,
        outputLocale: runLocale
      });
      if (delegationSpanId) {
        sessionRuntime.endSpan(delegationSpanId, {
          status: "ok",
          detail: localizeRunText(
            runLocale,
            `Planned ${normalized.subtasks.length} delegated child task(s).`,
            `已规划 ${normalized.subtasks.length} 个子任务。`
          )
        });
      }
      return normalized;
    } catch (error) {
      if (delegationSpanId) {
        sessionRuntime.endSpan(delegationSpanId, {
          status: isAbortError(error) ? "warning" : "error",
          detail: error.message
        });
      }
      throw error;
    }
  }

  async function maybeAutoMaterializeLeaderArtifact({
    agent,
    agentTask,
    output,
    dependencyOutputs,
    subordinateExecutions,
    parentSpanId = ""
  }) {
    const workspaceRoot = config.workspace?.resolvedDir;
    if (!workspaceRoot || !taskRequiresConcreteArtifact(agentTask)) {
      return output;
    }
    if (output?.unstructuredOutput) {
      return output;
    }

    const artifactPath = inferRequestedArtifact(
      agentTask,
      output,
      workspaceRoot,
      originalTask
    );
    const reportedArtifacts = normalizeWorkspaceArtifactReferences([
      ...(output?.verifiedGeneratedFiles || []),
      ...(output?.generatedFiles || [])
    ]);
    const reportedVerification = reportedArtifacts.length
      ? await verifyWorkspaceArtifacts(workspaceRoot, reportedArtifacts, {
        maxFiles: Math.min(12, reportedArtifacts.length)
      })
      : [];
    const verifiedReportedArtifacts = reportedVerification
      .filter((entry) => entry.verified)
      .map((entry) => entry.path);
    const filteredOutput = {
      ...output,
      generatedFiles: uniqueArray(verifiedReportedArtifacts),
      verifiedGeneratedFiles: uniqueArray(verifiedReportedArtifacts)
    };
    const hasVerifiedRequestedArtifact = verifiedReportedArtifacts.includes(artifactPath);
    const failedReportedArtifacts = reportedVerification.filter(
      (entry) => !entry.verified && entry.path !== artifactPath
    );
    filteredOutput.risks = uniqueArray([
      ...(filteredOutput?.risks || []),
      ...failedReportedArtifacts.map(
        (entry) => `Reported artifact "${entry.path}" was not actually present in the workspace: ${entry.error}`
      )
    ]);

    if (hasVerifiedRequestedArtifact) {
      return filteredOutput;
    }
    if (!/\.docx$/i.test(String(artifactPath || ""))) {
      return filteredOutput;
    }

    const content = buildDocxFallbackContent({
      task: agentTask,
      parsed: filteredOutput,
      dependencyOutputs: [
        ...dependencyOutputs,
        ...subordinateExecutions.map(summarizeExecutionForDependency)
      ],
      originalTask
    });
    if (!safeString(content) || safeString(content).length < 24) {
      return filteredOutput;
    }

    const writtenFiles = await writeWorkspaceFiles(workspaceRoot, [
      {
        path: artifactPath,
        title: getArtifactTitleFromPath(artifactPath),
        content,
        encoding: "utf8"
      }
    ]);
    const verification = await verifyWorkspaceArtifacts(workspaceRoot, [artifactPath], {
      maxFiles: 1
    });
    const verifiedGeneratedFiles = verification
      .filter((entry) => entry.verified)
      .map((entry) => entry.path);
    const failedVerification = verification.filter((entry) => !entry.verified);

    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "workspace_write",
        tone: verifiedGeneratedFiles.length ? "ok" : "warning",
        detail: verifiedGeneratedFiles.length
          ? localizeRunText(
              runLocale,
              `Auto-materialized requested artifact: ${artifactPath}`,
              `已自动生成目标产物：${artifactPath}`
            )
          : localizeRunText(
              runLocale,
              `Auto-materialized requested artifact but verification failed: ${artifactPath}`,
              `已自动生成目标产物但校验失败：${artifactPath}`
            )
      },
      agentTask
    );
    sessionRuntime?.remember(
      {
        title: localizeRunText(
          runLocale,
          `${agent.displayLabel || agent.label} artifact materialization`,
          `${agent.displayLabel || agent.label} 产物生成`
        ),
        content: verifiedGeneratedFiles.length
          ? localizeRunText(
              runLocale,
              `Auto-materialized ${artifactPath}`,
              `已自动生成 ${artifactPath}`
            )
          : localizeRunText(
              runLocale,
              `Attempted to auto-materialize ${artifactPath}, but verification failed.`,
              `已尝试自动生成 ${artifactPath}，但校验失败。`
            ),
        tags: uniqueArray([agentTask.phase, agent.id, "artifact_materialization"])
      },
      {
        ...buildAgentEventBase(agent, agentTask),
        parentSpanId
      }
    );

    return {
      ...filteredOutput,
      keyFindings: uniqueArray([
        ...(filteredOutput?.keyFindings || []),
        verifiedGeneratedFiles.length
          ? "The requested workspace artifact was auto-materialized from the leader synthesis output."
          : ""
      ]),
      risks: uniqueArray([
        ...(filteredOutput?.risks || []),
        ...failedVerification.map(
          (entry) => `Auto-materialized artifact "${entry.path}" could not be verified: ${entry.error}`
        )
      ]),
      generatedFiles: uniqueArray([
        ...(filteredOutput?.generatedFiles || []),
        ...writtenFiles.map((entry) => entry.path)
      ]),
      verifiedGeneratedFiles: uniqueArray([
        ...(filteredOutput?.verifiedGeneratedFiles || []),
        ...verifiedGeneratedFiles
      ]),
      workspaceActions: uniqueArray([...(filteredOutput?.workspaceActions || []), "write_docx"]),
      toolUsage: uniqueArray([...(filteredOutput?.toolUsage || []), "write_docx"]),
      verificationStatus: verifiedGeneratedFiles.length
        ? "passed"
        : filteredOutput?.verificationStatus || "not_applicable"
    };
  }

  async function synthesizeLeaderResult({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    subordinateExecutions,
    delegationPlan,
    startedAt,
    parentSpanId = ""
  }) {
    const synthesisSpanId = sessionRuntime?.startSpan({
      ...buildAgentEventBase(agent, agentTask),
      parentSpanId,
      spanKind: "delegation_synthesis",
      spanLabel: `${agent.displayLabel || agent.label} · child synthesis`
    });
    emitAgentEvent(
      onEvent,
      agent,
      {
        type: "status",
        stage: "leader_synthesis_start",
        tone: "neutral",
        content:
          delegationPlan.delegationSummary ||
          languagePack.leaderSynthesisContent(subordinateExecutions.length),
        detail: languagePack.leaderSynthesisDetail(subordinateExecutions.length)
      },
      agentTask
    );

    const prompt = buildLeaderSynthesisRequest({
      originalTask,
      clusterPlan: plan,
      leader: agent,
      task: agentTask,
      dependencyOutputs,
      subordinateResults: subordinateExecutions.map(summarizeExecutionForDependency),
      outputLocale: runLocale
    });

    const response = await runWithExecutionGate(() =>
      invokeProviderWithSession({
        sessionRuntime,
        instructions: prompt.instructions,
        input: prompt.input,
        provider,
        agent,
        task: agentTask,
        parentSpanId: synthesisSpanId || parentSpanId,
        purpose: "leader_synthesis",
        signal,
        buildAgentEventBase,
        onRetry(retry) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              ...buildRetryPayload({
                stage: "leader_synthesis_retry",
                model: agent,
                retry,
                taskId: agentTask.id,
                taskTitle: agentTask.title
              }),
              agentKind: agent.agentKind || "leader"
            },
            agentTask
          );
        }
      })
    );

    let parsed;
    parsed = parseStructuredJsonOrFallback(agent.displayLabel || agent.label, response.text);

    const endedAt = Date.now();
    const mergedGeneratedFiles = subordinateExecutions.flatMap(
      (execution) => execution.output?.generatedFiles || []
    );
    const mergedVerifiedGeneratedFiles = subordinateExecutions.flatMap(
      (execution) => execution.output?.verifiedGeneratedFiles || execution.output?.generatedFiles || []
    );
    const mergedWorkspaceActions = subordinateExecutions.flatMap(
      (execution) => execution.output?.workspaceActions || []
    );
    const mergedCommands = subordinateExecutions.flatMap(
      (execution) => execution.output?.executedCommands || []
    );
    const totalDescendantCount = subordinateExecutions.reduce(
      (sum, execution) => sum + 1 + Number(execution.output?.subordinateCount || 0),
      0
    );
    const derivedVerification =
      agentTask.phase === "validation" &&
      subordinateExecutions.some((execution) => execution.output?.verificationStatus === "failed")
        ? "failed"
        : agentTask.phase === "validation" &&
            subordinateExecutions.length &&
            subordinateExecutions.every((execution) => execution.output?.verificationStatus === "passed")
          ? "passed"
          : "not_applicable";
    let normalizedLeaderOutput = normalizeWorkerResult(parsed, response.text, {
      delegationNotes: [
        delegationPlan.delegationSummary,
        ...subordinateExecutions
          .filter((execution) => execution.status === "failed")
          .map((execution) => `${execution.agentLabel || execution.workerLabel} failed`)
      ],
      generatedFiles: mergedGeneratedFiles,
      verifiedGeneratedFiles: mergedVerifiedGeneratedFiles,
      workspaceActions: mergedWorkspaceActions,
      executedCommands: mergedCommands,
      toolUsage: subordinateExecutions.flatMap((execution) => execution.output?.toolUsage || []),
      memoryReads: subordinateExecutions.reduce(
        (sum, execution) => sum + Number(execution.output?.memoryReads || 0),
        0
      ),
      memoryWrites: subordinateExecutions.reduce(
        (sum, execution) => sum + Number(execution.output?.memoryWrites || 0),
        0
      ),
      subordinateCount: totalDescendantCount,
      subordinateResults: subordinateExecutions.map(summarizeSubordinateExecution),
      verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus || derivedVerification)
    });
    normalizedLeaderOutput = await maybeAutoMaterializeLeaderArtifact({
      agent,
      agentTask,
      output: normalizedLeaderOutput,
      dependencyOutputs,
      subordinateExecutions,
      parentSpanId: synthesisSpanId || parentSpanId
    });
    const realizedArtifacts = uniqueArray(
      normalizedLeaderOutput.verifiedGeneratedFiles.length
        ? normalizedLeaderOutput.verifiedGeneratedFiles
        : normalizedLeaderOutput.generatedFiles
    );
    const output = applyTaskOutputGuards(
      agentTask,
      normalizedLeaderOutput,
      {
        actualGeneratedFiles: realizedArtifacts
      }
    );

    const retryableChildProviderFailure = subordinateExecutions.find(
      (execution) => execution.retryableProviderFailure
    );
    const status = subordinateExecutions.some((execution) => execution.status === "failed")
      ? "failed"
      : "completed";
    sessionRuntime?.remember(
      {
        title: `${agent.displayLabel || agent.label} · ${agentTask.title}`,
        content: output.summary || output.thinkingSummary || response.text,
        tags: uniqueArray([agentTask.phase, agent.id, "leader_synthesis"])
      },
      {
        ...buildAgentEventBase(agent, agentTask),
        parentSpanId: synthesisSpanId || parentSpanId
      }
    );
    if (synthesisSpanId) {
      sessionRuntime.endSpan(synthesisSpanId, {
        status: status === "failed" ? "error" : "ok",
        detail: `Synthesized ${subordinateExecutions.length} child result(s).`
      });
    }

    return {
      taskId: agentTask.id,
      title: agentTask.title,
      workerId: agent.id,
      workerLabel: agent.label,
      agentId: agent.runtimeId || agent.id,
      agentLabel: agent.displayLabel || agent.label,
      agentKind: agent.agentKind || "leader",
      phase: agentTask.phase,
      status,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      rawText: response.text,
      output,
      failureKind: retryableChildProviderFailure?.failureKind || "",
      providerFailure: Boolean(retryableChildProviderFailure?.providerFailure),
      retryableProviderFailure: Boolean(retryableChildProviderFailure),
      errorMessage: retryableChildProviderFailure?.errorMessage || "",
      errorStatus: retryableChildProviderFailure?.errorStatus ?? null,
      circuitState: retryableChildProviderFailure?.circuitState || "",
      failedWorkerId: retryableChildProviderFailure?.failedWorkerId || "",
      failedWorkerLabel: retryableChildProviderFailure?.failedWorkerLabel || ""
    };
  }

  throwIfAborted(signal);
  if (!primaryWorker) {
    throw new Error(`Worker "${task.assignedWorker}" was not found in the active scheme.`);
  }
  const primaryProvider = providerRegistry.get(task.assignedWorker);
  if (!primaryProvider) {
    throw new Error(`No provider found for worker "${task.assignedWorker}".`);
  }

  const dependencyOutputs = buildDependencyOutputs();
  const globalConcurrencyLabel = formatConcurrencyLimit(executionGate?.limit ?? Number.POSITIVE_INFINITY);
  const branchFactor = runAgentBudget
    ? Math.min(
        resolveGroupLeaderMaxDelegates(config),
        Math.max(0, Number(runAgentBudget.maxChildrenPerLeader || 0))
      )
    : resolveGroupLeaderMaxDelegates(config);
  const maxDelegationDepth = runAgentBudget
    ? Math.min(
        resolveDelegateMaxDepth(config),
        Math.max(0, Number(runAgentBudget.maxDelegationDepth || 0))
      )
    : resolveDelegateMaxDepth(config);

  async function executeAgentHierarchy({
    agent,
    provider,
    agentTask,
    dependencyOutputs,
    preferredDelegateCount = 0,
    depthRemaining = 0,
    defaultToRequested = false,
    emitLifecycle = true,
    parentSpanId: inheritedParentSpanId = ""
  }) {
    throwIfAborted(signal);
    const lifecycle = resolveLifecycleStages(agent);
    const startedAt = Date.now();
    const taskSpanId = sessionRuntime?.startSpan({
      ...buildAgentEventBase(agent, agentTask),
      parentSpanId: inheritedParentSpanId || parentSpanId,
      spanKind: agent.agentKind === "subordinate" ? "subtask" : "task",
      spanLabel: `${agent.displayLabel || agent.label} · ${agentTask.title}`
    });

    if (emitLifecycle) {
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: lifecycle.start,
          tone: "neutral",
          content: agentTask.instructions || agentTask.title || "",
          detail:
            preferredDelegateCount > 0 && depthRemaining > 0
              ? `Execution started with delegation budget ${preferredDelegateCount} and remaining depth ${depthRemaining}.`
              : "Execution started."
        },
        agentTask
      );
    }

    try {
      const requestedDelegateCount =
        depthRemaining > 0
          ? normalizeDelegateCount(preferredDelegateCount, branchFactor)
          : 0;
      const remainingChildBudget = Math.max(
        0,
        Number(runAgentBudget?.remainingChildAgents ?? requestedDelegateCount)
      );
      const delegateBudgetCeiling = Math.min(requestedDelegateCount, remainingChildBudget);

      if (!delegateBudgetCeiling) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || "",
              summary: directResult.output.summary || "",
              content: directResult.output.summary || directResult.output.thinkingSummary || "",
              targetAgentLabel: agent.parentAgentLabel || ""
            },
            agentTask
          );
        }
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: directResult.status === "failed" ? "error" : "ok",
            detail:
              directResult.output.summary ||
              directResult.output.thinkingSummary ||
              "Task completed."
          });
        }
        return directResult;
      }

      const delegationPlan = await planLeaderDelegation({
        agent,
        provider,
        agentTask,
        dependencyOutputs,
        delegateCount: delegateBudgetCeiling,
        depthRemaining: Math.max(0, depthRemaining - 1),
        defaultToRequested,
        preferDelegation: shouldPreferDelegation(
          agentTask,
          agentTask.phase,
          branchFactor,
          depthRemaining
        ),
        parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
      });

      if (!delegationPlan.subtasks.length) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || "",
              summary: directResult.output.summary || "",
              content: directResult.output.summary || directResult.output.thinkingSummary || "",
              targetAgentLabel: agent.parentAgentLabel || ""
            },
            agentTask
          );
        }
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: directResult.status === "failed" ? "error" : "ok",
            detail:
              directResult.output.summary ||
              directResult.output.thinkingSummary ||
              languagePack.taskCompletedWithoutDelegation()
          });
        }
        return directResult;
      }

      const grantedChildCount = runAgentBudget
        ? runAgentBudget.reserveChildAgents(delegationPlan.subtasks.length)
        : delegationPlan.subtasks.length;
      attemptChildAgentReservations += grantedChildCount;
      const delegatedSubtasks = delegationPlan.subtasks.slice(0, grantedChildCount);

      if (!delegatedSubtasks.length) {
        const directResult = await executeDirectAgentTask({
          agent,
          provider,
          agentTask,
          dependencyOutputs,
          emitLifecycle: false,
          taskSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
        });

        if (emitLifecycle) {
          emitAgentEvent(
            onEvent,
            agent,
            {
              type: "status",
              stage: lifecycle.done,
              tone: directResult.status === "failed" ? "warning" : "ok",
              thinkingSummary: directResult.output.thinkingSummary || "",
              summary: directResult.output.summary || "",
              content: directResult.output.summary || directResult.output.thinkingSummary || "",
              targetAgentLabel: agent.parentAgentLabel || ""
            },
            agentTask
          );
        }
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: directResult.status === "failed" ? "error" : "ok",
            detail:
              directResult.output.summary ||
              directResult.output.thinkingSummary ||
              languagePack.taskCompletedAfterBudgetExhausted()
          });
        }
        return directResult;
      }

      const subordinateConcurrency = resolveSubordinateConcurrency(
        agent,
        agentTask,
        config,
        delegatedSubtasks.length
      );
      const hasDelegatedDependencies = delegatedSubtasks.some(
        (subtask) => Array.isArray(subtask?.dependsOn) && subtask.dependsOn.length
      );
      emitAgentEvent(
        onEvent,
        agent,
        {
          type: "status",
          stage: "leader_delegate_done",
          tone: "ok",
          detail:
            grantedChildCount < delegationPlan.subtasks.length
              ? languagePack.delegationDoneBudgeted(
                  delegatedSubtasks.length,
                  subordinateConcurrency,
                  hasDelegatedDependencies,
                  globalConcurrencyLabel
                )
              : subordinateConcurrency === 1
                ? languagePack.delegationDoneSequential(
                    delegatedSubtasks.length,
                    globalConcurrencyLabel
                  )
                : languagePack.delegationDone(
                    delegatedSubtasks.length,
                    subordinateConcurrency,
                    hasDelegatedDependencies,
                    globalConcurrencyLabel
                  ),
          thinkingSummary: delegationPlan.thinkingSummary || ""
        },
        agentTask
      );

      const childPreferredDelegateCount = depthRemaining > 1 ? branchFactor : 0;
      const delegatedEntries = delegatedSubtasks.map((subtask, index) => {
        const subordinateTask = {
          id: `${agentTask.id}__${subtask.id}`,
          phase: agentTask.phase,
          title: subtask.title,
          assignedWorker: agentTask.assignedWorker,
          delegateCount: childPreferredDelegateCount,
          instructions: subtask.instructions,
          dependsOn: safeArray(subtask.dependsOn),
          expectedOutput: subtask.expectedOutput
        };
        subordinateTask.requirements = deriveTaskRequirements(subordinateTask, {
          parentRequirements: agentTask.requirements,
          inheritConcreteArtifactRequirement: false
        });
        return {
          index,
          subtask,
          subordinateTask,
          subordinateAgent: createSubordinateRuntimeAgent(agent, subordinateTask, index)
        };
      });
      const completedSubordinateExecutions = new Map();
      const runningSubordinateExecutions = new Map();

      while (completedSubordinateExecutions.size < delegatedEntries.length) {
        for (const entry of delegatedEntries) {
          if (
            runningSubordinateExecutions.size >= subordinateConcurrency ||
            completedSubordinateExecutions.has(entry.subtask.id) ||
            runningSubordinateExecutions.has(entry.subtask.id)
          ) {
            continue;
          }

          const ready = entry.subordinateTask.dependsOn.every((dependencyId) =>
            completedSubordinateExecutions.has(dependencyId)
          );
          if (!ready) {
            continue;
          }

          emitAgentEvent(
            onEvent,
            entry.subordinateAgent,
            {
              type: "status",
              stage: "subagent_created",
              tone: "neutral",
              content: entry.subtask.instructions || entry.subtask.title || "",
              detail: localizeRunText(
                runLocale,
                `Created child agent for: ${entry.subtask.title}`,
                `已为该任务创建子 Agent：${entry.subtask.title}`
              ),
              thinkingSummary: delegationPlan.thinkingSummary || "",
              targetAgentLabel: entry.subordinateAgent.displayLabel || entry.subordinateAgent.label || ""
            },
            entry.subordinateTask
          );

          const childDependencyOutputs = [
            ...dependencyOutputs,
            ...entry.subordinateTask.dependsOn
              .map((dependencyId) => completedSubordinateExecutions.get(dependencyId))
              .filter(Boolean)
              .map(summarizeExecutionForDependency)
          ];
          const executionPromise = executeAgentHierarchy({
            agent: entry.subordinateAgent,
            provider,
            agentTask: entry.subordinateTask,
            dependencyOutputs: childDependencyOutputs,
            preferredDelegateCount: childPreferredDelegateCount,
            depthRemaining: Math.max(0, depthRemaining - 1),
            defaultToRequested: false,
            parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
          }).then((execution) => ({
            subtaskId: entry.subtask.id,
            execution
          }));
          runningSubordinateExecutions.set(entry.subtask.id, executionPromise);
        }

        if (!runningSubordinateExecutions.size) {
          const blocked = delegatedEntries
            .filter((entry) => !completedSubordinateExecutions.has(entry.subtask.id))
            .map((entry) => ({
              subtaskId: entry.subtask.id,
              dependsOn: entry.subordinateTask.dependsOn
            }));
          throw new Error(
            `Delegated child tasks contain unresolved dependencies: ${JSON.stringify(blocked)}`
          );
        }

        const settled = await Promise.race(runningSubordinateExecutions.values());
        runningSubordinateExecutions.delete(settled.subtaskId);
        completedSubordinateExecutions.set(settled.subtaskId, settled.execution);
      }

      const subordinateExecutions = delegatedEntries.map((entry) =>
        completedSubordinateExecutions.get(entry.subtask.id)
      );

      const result = await synthesizeLeaderResult({
        agent,
        provider,
        agentTask,
        dependencyOutputs,
        subordinateExecutions,
        delegationPlan,
        startedAt,
        parentSpanId: taskSpanId || inheritedParentSpanId || parentSpanId
      });

      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "status",
            stage: lifecycle.done,
            tone: result.status === "failed" ? "warning" : "ok",
            thinkingSummary: result.output.thinkingSummary || "",
            summary: result.output.summary || "",
            content: result.output.summary || result.output.thinkingSummary || "",
            targetAgentLabel: agent.parentAgentLabel || ""
          },
          agentTask
        );
      }
      if (taskSpanId) {
        sessionRuntime.endSpan(taskSpanId, {
          status: result.status === "failed" ? "error" : "ok",
          detail:
            result.output.summary ||
            result.output.thinkingSummary ||
            "Delegated task completed."
        });
      }
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        if (taskSpanId) {
          sessionRuntime.endSpan(taskSpanId, {
            status: "warning",
            detail: error.message
          });
        }
        throw error;
      }

      const result = buildFailureResult(agent, agentTask, error, startedAt);
      if (taskSpanId) {
        sessionRuntime.endSpan(taskSpanId, {
          status: "error",
          detail: error.message
        });
      }
      if (emitLifecycle) {
        emitAgentEvent(
          onEvent,
          agent,
          {
            type: "error",
            stage: lifecycle.failed,
            tone: "error",
            detail: error.message
          },
          agentTask
        );
      }
      return result;
    }
  }

  const preferredDelegateCount = normalizeDelegateCount(task.delegateCount, branchFactor);
  const fallbackWorkers = rankFallbackWorkersForTask({
    workers: allWorkers,
    primaryWorker,
    phase: normalizePhase(task.phase, inferPhase(task, primaryWorker)),
    task,
    capabilityRoutingPolicy,
    providerRegistry
  });
  const executionCandidates = [primaryWorker, ...fallbackWorkers];
  let leaderAgent = createLeaderRuntimeAgent(primaryWorker, task);
  let currentTask = task;
  let lastResult = null;

  for (let attemptIndex = 0; attemptIndex < executionCandidates.length; attemptIndex += 1) {
    const currentWorker = executionCandidates[attemptIndex];
    const currentProvider =
      currentWorker.id === primaryWorker.id
        ? primaryProvider
        : providerRegistry.get(currentWorker.id);
    if (!currentProvider) {
      continue;
    }

    attemptChildAgentReservations = 0;
    currentTask =
      attemptIndex === 0
        ? task
        : {
            ...task,
            assignedWorker: currentWorker.id
          };
    leaderAgent =
      attemptIndex === 0
        ? leaderAgent
        : rebindRuntimeAgent(leaderAgent, currentWorker);

    const result = await executeAgentHierarchy({
      agent: leaderAgent,
      provider: currentProvider,
      agentTask: currentTask,
      dependencyOutputs,
      preferredDelegateCount,
      depthRemaining: maxDelegationDepth,
      defaultToRequested: preferredDelegateCount > 0,
      parentSpanId
    });

    lastResult = result;
    const hasMoreCandidates = attemptIndex < executionCandidates.length - 1;
    if (!result.retryableProviderFailure || !hasMoreCandidates) {
      return result;
    }

    if (runAgentBudget && attemptChildAgentReservations > 0) {
      runAgentBudget.releaseChildAgents(attemptChildAgentReservations);
    }

    const nextWorker = executionCandidates[attemptIndex + 1];
    emitAgentEvent(
      onEvent,
      leaderAgent,
      {
        type: "status",
        stage: "worker_fallback",
        tone: "warning",
        detail: localizeRunText(
          runLocale,
          `Retryable provider failure on ${currentWorker.label}; rerouting this task to ${nextWorker.label}.`,
          `${currentWorker.label} 发生可重试的 provider 故障；本任务已切换给 ${nextWorker.label}。`
        ),
        previousWorkerId: currentWorker.id,
        previousWorkerLabel: currentWorker.label,
        fallbackWorkerId: nextWorker.id,
        fallbackWorkerLabel: nextWorker.label,
        attempt: attemptIndex + 1,
        maxAttempts: executionCandidates.length
      },
      currentTask
    );
  }

  return lastResult;
}

async function executePlan(
  plan,
  originalTask,
  config,
  executionGate,
  providerRegistry,
  runAgentBudget,
  sessionRuntime,
  parentSpanId,
  onEvent,
  signal,
  outputLocale = "en-US"
) {
  const pending = new Map(plan.tasks.map((task) => [task.id, task]));
  const running = new Map();
  const completedResults = new Map();
  const maxParallel = config.cluster.maxParallel;
  const taskById = new Map(plan.tasks.map((task) => [task.id, task]));

  for (const phase of PHASE_ORDER) {
    throwIfAborted(signal);
    const phaseTasks = Array.from(pending.values()).filter((task) => task.phase === phase);
    if (!phaseTasks.length) {
      continue;
    }

    const phaseMaxParallel = resolvePhaseConcurrency(phase, maxParallel, config);

    emitEvent(onEvent, {
      type: "status",
      stage: "phase_start",
      tone: "neutral",
      phase,
      detail: localizeRunText(
        outputLocale,
        `Entering ${phase} phase.`,
        `进入${phase}阶段。`
      )
    });

    while (phaseTasks.some((task) => !completedResults.has(task.id))) {
      throwIfAborted(signal);
      for (const task of phaseTasks) {
        if (
          running.size >= phaseMaxParallel ||
          completedResults.has(task.id) ||
          running.has(task.id)
        ) {
          continue;
        }

        const ready = task.dependsOn.every((dependencyId) => completedResults.has(dependencyId));
        if (!ready) {
          continue;
        }

        if (!canStartTaskForPhase(task, running.keys(), taskById, config)) {
          continue;
        }

        pending.delete(task.id);
        const promise = executeSingleTask({
          task,
          originalTask,
          plan,
          completedResults,
          providerRegistry,
          config,
          executionGate,
          runAgentBudget,
          sessionRuntime,
          parentSpanId,
          onEvent,
          signal,
          outputLocale
        }).then((result) => ({ taskId: task.id, result }));
        running.set(task.id, promise);
      }

      if (!running.size) {
        const blocked = phaseTasks
          .filter((task) => !completedResults.has(task.id))
          .map((task) => ({
            taskId: task.id,
            phase: task.phase,
            dependsOn: task.dependsOn
          }));
        throw new Error(
          `Workflow phase "${phase}" contains unresolved dependencies: ${JSON.stringify(blocked)}`
        );
      }

      let settled;
      try {
        settled = await Promise.race(running.values());
      } catch (error) {
        await Promise.allSettled(running.values());
        throw error;
      }
      running.delete(settled.taskId);
      completedResults.set(settled.taskId, settled.result);
    }

    const phaseResults = phaseTasks
      .map((task) => completedResults.get(task.id))
      .filter(Boolean);

    emitEvent(onEvent, {
      type: "status",
      stage: "phase_done",
      tone: "ok",
      phase,
      detail: localizeRunText(
        outputLocale,
        `Completed ${phase} phase with ${phaseResults.length} task(s).`,
        `已完成${phase}阶段，共处理 ${phaseResults.length} 个任务。`
      )
    });

    if (
      phase === "validation" &&
      phaseResults.some((result) => result.output?.verificationStatus === "failed")
    ) {
      emitEvent(onEvent, {
        type: "status",
        stage: "validation_gate_failed",
        tone: "warning",
        detail: localizeRunText(
          outputLocale,
          "Validation phase reported failures. Final synthesis will highlight verification risks.",
          "验证阶段报告了失败项，最终综合会明确标出这些校验风险。"
        )
      });
    }
  }

  return plan.tasks.map((task) => completedResults.get(task.id));
}

async function runClusterAnalysis({
  task,
  config,
  providerRegistry,
  onEvent,
  signal,
  outputLocale = "en-US"
}) {
  const originalTask = String(task || "").trim();
  if (!originalTask) {
    throw new Error("Task input cannot be empty.");
  }

  throwIfAborted(signal);
  const startedAt = Date.now();
  const executionGate = createExecutionGate(config.cluster.maxParallel);
  const controllerId = config.cluster.controller;
  const controllerModel = config.models[controllerId];
  const controller = controllerModel;
  if (!controllerModel) {
    throw new Error(`Controller "${controllerId}" was not found in the active scheme.`);
  }
  const controllerProvider = providerRegistry.get(controllerId);
  if (!controllerProvider) {
    throw new Error(`No provider found for controller "${controllerId}".`);
  }
  const controllerModels = modelListFromConfig(config);
  const runLocale = normalizeRunLocale(outputLocale);
  const languagePack = createRunLanguagePack(runLocale);
  let activeController = createControllerRuntimeAgent(controllerModel);
  let activeControllerProvider = controllerProvider;
  const multiAgentRuntime = createMultiAgentRuntime(config.multiAgent);
  
  function resolveRuntimeAgentFromEvent(payload = {}) {
    const runtimeId = safeString(
      payload.agentId || payload.parentAgentId || activeController?.runtimeId || controllerId
    );
    const displayLabel = safeString(
      payload.agentLabel ||
        payload.parentAgentLabel ||
        activeController?.displayLabel ||
        activeController?.label ||
        controllerModel?.label ||
        controllerId
    );

    return {
      runtimeId,
      displayLabel,
      label: safeString(payload.modelLabel || payload.agentLabel || displayLabel || controllerId),
      id: safeString(payload.modelId || activeController?.id || controllerId),
      agentKind: safeString(payload.agentKind || "leader") || "leader"
    };
  }

  function resolveParentRuntimeAgent(payload = {}) {
    if (!payload.parentAgentId && !payload.parentAgentLabel) {
      return null;
    }

    return {
      runtimeId: safeString(payload.parentAgentId),
      displayLabel: safeString(payload.parentAgentLabel || payload.parentAgentId),
      label: safeString(payload.parentAgentLabel || payload.parentAgentId),
      id: safeString(payload.parentAgentId || payload.parentAgentLabel),
      agentKind: "leader"
    };
  }

  function translateClusterEventToMultiAgentMessage(payload = {}) {
    const stage = safeString(payload.stage);
    const agent = resolveRuntimeAgentFromEvent(payload);
    const parentAgent = resolveParentRuntimeAgent(payload);
    const taskTitle = safeString(payload.taskTitle || payload.taskId);
    const phase = safeString(payload.phase);
    const tone = safeString(payload.tone || "neutral") || "neutral";
    const content = buildConversationStyleContent(stage, payload, taskTitle, runLocale);

    switch (stage) {
      case "planning_start":
        return {
          kind: "system",
          stage,
          tone,
          speaker: agent,
          content:
            content ||
            localizeRunText(
              runLocale,
              `${agent.displayLabel} started planning the collaboration.`,
              `${agent.displayLabel} 已开始规划协作流程。`
            )
        };
      case "planning_done":
        return {
          kind: "summary",
          stage,
          tone: "ok",
          speaker: agent,
          content:
            content ||
            localizeRunText(
              runLocale,
              `${agent.displayLabel} created ${payload.taskCount ?? 0} top-level task(s).`,
              `${agent.displayLabel} 已创建 ${payload.taskCount ?? 0} 个顶层任务。`
            )
        };
      case "phase_start":
      case "phase_done":
        return {
          kind: "system",
          stage,
          tone,
          phase,
          speaker: agent,
          content: content || `${stage === "phase_start" ? "Entering" : "Completed"} ${phase} phase.`
        };
      case "worker_start":
      case "subagent_start":
      case "leader_delegate_start":
      case "leader_delegate_done":
      case "leader_synthesis_start":
      case "workspace_list":
      case "workspace_read":
      case "workspace_write":
      case "workspace_web_search":
      case "workspace_command":
      case "workspace_tool_blocked":
      case "workspace_json_repair":
      case "memory_read":
      case "memory_write":
        return {
          kind: "message",
          stage,
          tone,
          phase,
          speaker: agent,
          content:
            content ||
            (taskTitle
              ? localizeRunText(
                  runLocale,
                  `${agent.displayLabel} is handling ${taskTitle}.`,
                  `${agent.displayLabel} 正在处理 ${taskTitle}。`
                )
              : localizeRunText(
                  runLocale,
                  `${agent.displayLabel} sent an update.`,
                  `${agent.displayLabel} 发送了一条进展更新。`
                ))
        };
      case "subagent_created":
        return {
          kind: "message",
          stage,
          tone,
          phase,
          speaker: parentAgent || agent,
          target: agent,
          content:
            content ||
            localizeRunText(
              runLocale,
              `Created ${agent.displayLabel}${taskTitle ? ` for ${taskTitle}` : ""}.`,
              `已创建 ${agent.displayLabel}${taskTitle ? `，负责 ${taskTitle}` : ""}。`
            )
        };
      case "worker_done":
      case "subagent_done":
      case "worker_fallback":
      case "controller_fallback":
      case "cluster_cancelled":
      case "cluster_failed":
        return {
          kind: "summary",
          stage,
          tone,
          phase,
          speaker: agent,
          target: parentAgent || null,
          content:
            content ||
            (taskTitle
              ? localizeRunText(
                  runLocale,
                  `${agent.displayLabel} completed ${taskTitle}.`,
                  `${agent.displayLabel} 已完成 ${taskTitle}。`
                )
              : localizeRunText(
                  runLocale,
                  `${agent.displayLabel} completed an update.`,
                  `${agent.displayLabel} 已完成一条更新。`
                ))
        };
      case "planning_retry":
      case "worker_retry":
      case "subagent_retry":
      case "leader_delegate_retry":
      case "leader_synthesis_retry":
      case "synthesis_retry":
      case "circuit_opened":
      case "circuit_half_open":
      case "circuit_closed":
      case "circuit_blocked":
      case "validation_gate_failed":
      case "cancel_requested":
      case "synthesis_start":
        return {
          kind: "system",
          stage,
          tone,
          phase,
          speaker: agent,
          content:
            content ||
            safeString(payload.finalAnswer) ||
            localizeRunText(
              runLocale,
              `${agent.displayLabel} reported ${stage.replaceAll("_", " ")}.`,
              `${agent.displayLabel} 已报告 ${stage.replaceAll("_", " ")}。`
            )
        };
      default:
        return null;
    }
  }

  function captureMultiAgentFromEvent(payload = {}) {
    if (!multiAgentRuntime.isEnabled()) {
      return;
    }

    const message = translateClusterEventToMultiAgentMessage(payload);
    if (!message) {
      return;
    }

    if (message.kind === "summary") {
      multiAgentRuntime.recordSummary(message);
      return;
    }

    if (message.kind === "system") {
      multiAgentRuntime.recordSystem(message);
      return;
    }

    multiAgentRuntime.recordMessage(message);
  }

  function forwardClusterEvent(payload) {
    captureMultiAgentFromEvent(payload);
    emitEvent(onEvent, payload);
  }

  const sessionRuntime = createSessionRuntime({
    locale: runLocale,
    emitEvent(payload) {
      forwardClusterEvent(payload);
    }
  });
  const operationSpanId = sessionRuntime.startSpan({
    ...buildAgentEventBase(activeController, null),
    spanKind: "operation",
    spanLabel: `Cluster run · ${originalTask.slice(0, 72) || "task"}`
  });

  try {
    const workers = workerListFromConfig(config);
    const capabilityRoutingPolicy = normalizeCapabilityRoutingPolicy(
      config?.cluster?.capabilityRoutingPolicy
    );
    multiAgentRuntime.start({
      task: originalTask,
      controller: activeController,
      detail: languagePack.collaborationStarted(multiAgentRuntime.settings.mode)
    });

    async function invokeControllerStageWithFallback({
      purpose,
      prompt,
      startStage,
      retryStage
    }) {
      const primaryController = activeController;
      const primaryProvider = activeControllerProvider;
      const fallbackControllers = rankFallbackControllers({
        models: controllerModels,
        primaryController,
        purpose,
        providerRegistry
      }).map((modelConfig) => rebindControllerRuntimeAgent(primaryController, modelConfig));
      const stageCandidates = [primaryController, ...fallbackControllers];
      let lastError = null;

      for (let attemptIndex = 0; attemptIndex < stageCandidates.length; attemptIndex += 1) {
        const stageController = stageCandidates[attemptIndex];
        const stageProvider =
          attemptIndex === 0 ? primaryProvider : providerRegistry.get(stageController.id);
        if (!stageProvider) {
          continue;
        }

        const stageSpanId = sessionRuntime.startSpan({
          ...buildAgentEventBase(stageController, null),
          parentSpanId: operationSpanId,
          spanKind: purpose,
          spanLabel: `${stageController.displayLabel || stageController.label} 路 ${purpose}`
        });

        forwardClusterEvent({
          ...buildAgentEventBase(stageController, null),
          type: "status",
          stage: startStage,
          tone: "neutral"
        });

        try {
          const response = await executionGate.run(
            () =>
              invokeProviderWithSession({
                sessionRuntime,
                provider: stageProvider,
                agent: stageController,
                parentSpanId: stageSpanId,
                instructions: prompt.instructions,
                input: prompt.input,
                purpose,
                signal,
                buildAgentEventBase,
                onRetry(retry) {
                  forwardClusterEvent({
                    ...buildAgentEventBase(stageController, null),
                    ...buildRetryPayload({
                      stage: retryStage,
                      model: stageController,
                      retry
                    })
                  });
                }
              }),
            { signal }
          );

          sessionRuntime.endSpan(stageSpanId, {
            status: "ok",
            detail: `Controller ${purpose} completed.`
          });
          activeController = stageController;
          activeControllerProvider = stageProvider;
          return {
            response,
            controller: stageController,
            provider: stageProvider,
            spanId: stageSpanId
          };
        } catch (error) {
          sessionRuntime.endSpan(stageSpanId, {
            status: isAbortError(error) ? "warning" : "error",
            detail: error.message
          });

          if (isAbortError(error)) {
            throw error;
          }

          lastError = error;
          const failure = classifyProviderTaskError(error, stageController, sessionRuntime);
          const hasMoreCandidates = attemptIndex < stageCandidates.length - 1;
          if (!failure.retryableProviderFailure || !hasMoreCandidates) {
            throw error;
          }

          const nextController = stageCandidates[attemptIndex + 1];
          forwardClusterEvent({
            ...buildAgentEventBase(nextController, null),
            type: "status",
            stage: "controller_fallback",
            tone: "warning",
            detail: localizeRunText(
              runLocale,
              `Retryable provider failure on ${stageController.label}; rerouting ${purpose} to ${nextController.label}.`,
              `${stageController.label} 发生可重试的 provider 故障；${purpose} 已切换到 ${nextController.label}。`
            ),
            previousControllerId: stageController.id,
            previousControllerLabel: stageController.label,
            fallbackControllerId: nextController.id,
            fallbackControllerLabel: nextController.label,
            purpose,
            attempt: attemptIndex + 1,
            maxAttempts: stageCandidates.length
          });
        }
      }

      throw lastError || new Error(`No controller provider was available for ${purpose}.`);
    }

    const prePlanningBudget = buildComplexityBudget({
      originalTask,
      workers,
      config
    });
    const workspaceSummary = config.workspace?.resolvedDir
      ? await getWorkspaceTree(config.workspace.resolvedDir)
      : null;
    const planningPrompt = buildPlanningRequest({
      task: originalTask,
      workers,
      maxParallel: resolveTopLevelTaskLimit(
        config.cluster.maxParallel,
        workers,
        prePlanningBudget
      ),
      workspaceSummary,
      delegateMaxDepth: resolveEffectiveDelegateMaxDepth(config, prePlanningBudget),
      delegateBranchFactor: resolveEffectiveGroupLeaderMaxDelegates(config, prePlanningBudget),
      complexityBudget: prePlanningBudget,
      capabilityRoutingPolicySummary: summarizeCapabilityRoutingPolicy(capabilityRoutingPolicy),
      outputLocale: runLocale
    });
    const planningStage = await invokeControllerStageWithFallback({
      purpose: "planning",
      prompt: planningPrompt,
      startStage: "planning_start",
      retryStage: "planning_retry",
      spanLabel: `${controller.label} · planning`
    });

    const planningResponse = planningStage.response;

    let rawPlan;
    try {
      rawPlan = parseJsonFromText(planningResponse.text);
    } catch {
      rawPlan = null;
    }

    const complexityBudget = buildComplexityBudget({
      originalTask,
      rawPlan,
      workers,
      config
    });
    const topLevelTaskLimit = resolveTopLevelTaskLimit(
      config.cluster.maxParallel,
      workers,
      complexityBudget
    );
    const groupLeaderMaxDelegates = resolveEffectiveGroupLeaderMaxDelegates(
      config,
      complexityBudget
    );
    const delegateMaxDepth = resolveEffectiveDelegateMaxDepth(config, complexityBudget);
    const plan = normalizePlan(
      rawPlan,
      workers,
      originalTask,
      topLevelTaskLimit,
      groupLeaderMaxDelegates,
      delegateMaxDepth,
      capabilityRoutingPolicy,
      config.multiAgent,
      runLocale
    );
    const runAgentBudget = createRunAgentBudget(complexityBudget, plan.tasks.length);
    sessionRuntime.remember(
      {
        title: localizeRunText(runLocale, "Cluster planning", "集群规划"),
        content: plan.strategy,
        tags: ["planning", activeController.id]
      },
      {
        ...buildAgentEventBase(activeController, null),
        parentSpanId: planningStage.spanId
      }
    );

    forwardClusterEvent({
      ...buildAgentEventBase(activeController, null),
      type: "status",
      stage: "planning_done",
      tone: "ok",
      taskCount: plan.tasks.length,
      detail: plan.strategy,
      budget: runAgentBudget.snapshot(),
      planStrategy: plan.strategy,
      planTasks: plan.tasks.map((taskItem) => ({
        id: taskItem.id,
        title: taskItem.title,
        phase: taskItem.phase,
        assignedWorker: taskItem.assignedWorker,
        delegateCount: taskItem.delegateCount
      }))
    });

    const executions = await executePlan(
      plan,
      originalTask,
      config,
      executionGate,
      providerRegistry,
      runAgentBudget,
      sessionRuntime,
      operationSpanId,
      forwardClusterEvent,
      signal,
      runLocale
    );

    const synthesisPrompt = buildSynthesisRequest({
      task: originalTask,
      plan,
      executions,
      outputLocale: runLocale
    });
    const synthesisStage = await invokeControllerStageWithFallback({
      purpose: "synthesis",
      prompt: synthesisPrompt,
      startStage: "synthesis_start",
      retryStage: "synthesis_retry",
      spanLabel: `${controller.label} · synthesis`
    });

    const synthesisResponse = synthesisStage.response;

    let synthesisParsed;
    try {
      synthesisParsed = parseJsonFromText(synthesisResponse.text);
    } catch {
      synthesisParsed = null;
    }

    const normalizedSynthesis = normalizeSynthesis(synthesisParsed, synthesisResponse.text);
    sessionRuntime.remember(
      {
        title: localizeRunText(runLocale, "Cluster synthesis", "集群综合"),
        content: normalizedSynthesis.finalAnswer,
        tags: ["synthesis", activeController.id]
      },
      {
        ...buildAgentEventBase(activeController, null),
        parentSpanId: synthesisStage.spanId
      }
    );

    const totalMs = Date.now() - startedAt;
    sessionRuntime.endSpan(operationSpanId, {
      status: "ok",
      detail:
        normalizedSynthesis.finalAnswer ||
        localizeRunText(runLocale, "Cluster run completed.", "集群运行已完成。")
    });
    sessionRuntime.publishSessionUpdate(
      localizeRunText(runLocale, "Cluster run completed.", "集群运行已完成。")
    );
    multiAgentRuntime.complete({
      content:
        normalizedSynthesis.finalAnswer ||
        localizeRunText(runLocale, "Cluster run completed.", "集群运行已完成。"),
      tone: "ok"
    });
    forwardClusterEvent({
      ...buildAgentEventBase(activeController, null),
      type: "complete",
      stage: "cluster_done",
      tone: "ok",
      totalMs,
      finalAnswer: normalizedSynthesis.finalAnswer,
      executiveSummary: normalizedSynthesis.executiveSummary,
      session: sessionRuntime.buildSnapshot(),
      multiAgentSession: multiAgentRuntime.buildSnapshot()
    });

    return {
      plan,
      executions,
      synthesis: normalizedSynthesis,
      controller: {
        id: activeController.id,
        label: activeController.label,
        model: activeController.model
      },
      budget: runAgentBudget.snapshot(),
      timings: {
        totalMs
      },
      session: sessionRuntime.buildSnapshot(),
      multiAgentSession: multiAgentRuntime.buildSnapshot()
    };
  } catch (error) {
    sessionRuntime.endSpan(operationSpanId, {
      status: isAbortError(error) ? "warning" : "error",
      detail: error.message
    });
    sessionRuntime.publishSessionUpdate(
      isAbortError(error) ? "Cluster run cancelled." : "Cluster run failed."
    );
    multiAgentRuntime.complete({
      content: error.message,
      tone: isAbortError(error) ? "warning" : "error"
    });
    throw error;
  }
}

module.exports = { runClusterAnalysis };

},
"/src/run-log-store.mjs": function(module, exports, __require) {
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, resolve } = require("node:path");
const { createOperationEventTranslator, describeOperationEvent } = __require("/src/static/operation-events.js");
const RUN_LOG_DIR = "task-logs";

function sanitizeRunId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");

  return normalized || `run_${Date.now()}`;
}

function formatLogValue(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeLogLocale(value) {
  return String(value || "").trim() === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeLogText(locale, englishText, chineseText) {
  return normalizeLogLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function formatEventLine(event, locale = "en-US") {
  const timestamp = formatLogValue(event?.timestamp, "unknown-time");
  const stage = formatLogValue(event?.stage, "unknown-stage");
  const tone = formatLogValue(event?.tone);
  const actor = formatLogValue(event?.agentLabel || event?.modelLabel || event?.modelId);
  const translate = createOperationEventTranslator(locale);
  const detail = formatLogValue(
    describeOperationEvent(event, {
      locale,
      translate,
      formatDelay(value) {
        const amount = Number(value);
        return Number.isFinite(amount) ? `${amount} ms` : "n/a";
      }
    }),
    formatLogValue(event?.detail || event?.message)
  );
  return [
    `[${timestamp}]`,
    stage,
    tone ? `tone=${tone}` : "",
    actor ? `actor=${actor}` : "",
    detail ? `detail=${detail}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function renderClusterRunLogText(payload) {
  const locale = normalizeLogLocale(payload?.locale || payload?.operation?.meta?.locale);
  const summary = payload?.result?.synthesis || {};
  const timings = payload?.result?.timings || {};
  const eventLines = Array.isArray(payload?.operation?.events)
    ? payload.operation.events
        .filter((event) => {
          const stage = String(event?.stage || "").trim();
          return stage !== "session_update" && !stage.startsWith("trace_span_");
        })
        .map((event) => formatEventLine(event, locale))
    : [];

  return [
    localizeLogText(locale, "# Agent Cluster Task Log", "# Agent 集群任务日志"),
    `Operation ID: ${formatLogValue(payload?.operationId, "unknown")}`,
    `Status: ${formatLogValue(payload?.status, "unknown")}`,
    `Saved At: ${formatLogValue(payload?.savedAt, "unknown")}`,
    `Task: ${formatLogValue(payload?.task, "unknown")}`,
    `Scheme: ${formatLogValue(payload?.schemeId, "default")}`,
    `Workspace: ${formatLogValue(payload?.workspace?.resolvedDir, "unknown")}`,
    "",
    localizeLogText(locale, "## Summary", "## 摘要"),
    `${localizeLogText(locale, "Final Answer", "最终答复")}: ${formatLogValue(summary?.finalAnswer, formatLogValue(payload?.error?.message, "n/a"))}`,
    `${localizeLogText(locale, "Total Time (ms)", "总耗时（ms）")}: ${formatLogValue(timings?.totalMs, "n/a")}`,
    `${localizeLogText(locale, "Task Count", "任务数量")}: ${formatLogValue(payload?.result?.plan?.tasks?.length, "0")}`,
    `${localizeLogText(locale, "Execution Count", "执行数量")}: ${formatLogValue(payload?.result?.executions?.length, "0")}`,
    "",
    localizeLogText(locale, "## Status Timeline", "## 状态时间线"),
    ...(eventLines.length ? eventLines : [localizeLogText(locale, "(no events captured)", "（未捕获到事件）")]),
    "",
    localizeLogText(
      locale,
      "Detailed low-level traces remain in the JSON log.",
      "更详细的底层追踪已保存在 JSON 日志中。"
    ),
    ""
  ].join("\n");
}

async function writeClusterRunLog(projectDir, runId, payload) {
  const safeRunId = sanitizeRunId(runId);
  const jsonPath = `${RUN_LOG_DIR}/${safeRunId}.json`;
  const textPath = `${RUN_LOG_DIR}/${safeRunId}.log`;
  const jsonAbsolutePath = resolve(projectDir, jsonPath);
  const textAbsolutePath = resolve(projectDir, textPath);
  const jsonContent = `${JSON.stringify(payload, null, 2)}\n`;
  const textContent = `${renderClusterRunLogText(payload)}\n`;

  await mkdir(dirname(jsonAbsolutePath), { recursive: true });
  await mkdir(dirname(textAbsolutePath), { recursive: true });
  await writeFile(jsonAbsolutePath, jsonContent, "utf8");
  await writeFile(textAbsolutePath, textContent, "utf8");

  return {
    jsonPath,
    jsonBytes: Buffer.byteLength(jsonContent, "utf8"),
    textPath,
    textBytes: Buffer.byteLength(textContent, "utf8")
  };
}

module.exports = { writeClusterRunLog, RUN_LOG_DIR };

},
"/src/system/dialogs.mjs": function(module, exports, __require) {
const { spawn } = require("node:child_process");
function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Sta",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(script)
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          ...env
        }
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function pickFolderDialog(initialDir = "") {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select Agent Cluster workspace folder"
$dialog.ShowNewFolderButton = $true
$initialDir = $env:AGENT_CLUSTER_INITIAL_DIR
if (-not [string]::IsNullOrWhiteSpace($initialDir) -and (Test-Path -LiteralPath $initialDir -PathType Container)) {
  $dialog.SelectedPath = (Resolve-Path -LiteralPath $initialDir).Path
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

  return runPowerShell(script, {
    AGENT_CLUSTER_INITIAL_DIR: String(initialDir || "")
  });
}

module.exports = { pickFolderDialog };

},
"/src/workspace/fs.mjs": function(module, exports, __require) {
const { existsSync } = require("node:fs");
const { mkdir, readdir, readFile, stat, writeFile } = require("node:fs/promises");
const { dirname, extname, isAbsolute, relative, resolve, sep } = require("node:path");
const { isSupportedReadableDocument, readDocumentText } = __require("/src/workspace/document-reader.mjs");
const { createDocxBuffer } = __require("/src/workspace/docx.mjs");
const DEFAULT_MAX_TREE_ENTRIES = 200;
const DEFAULT_MAX_TREE_DEPTH = 4;
const DEFAULT_MAX_READ_FILES = 6;
const DEFAULT_MAX_WRITE_FILES = 6;
const DEFAULT_MAX_FILE_BYTES = 120000;

function normalizeRelativePath(filePath) {
  return String(filePath || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
}

function resolveWorkspaceRoot(workspaceDir) {
  return resolve(String(workspaceDir || "."));
}

async function ensureWorkspaceDirectory(workspaceDir) {
  const rootDir = resolveWorkspaceRoot(workspaceDir);
  await mkdir(rootDir, { recursive: true });
  return rootDir;
}

function assertPathWithinWorkspace(workspaceDir, filePath) {
  const rootDir = resolveWorkspaceRoot(workspaceDir);
  const normalized = normalizeRelativePath(filePath);
  const absolutePath = resolve(rootDir, normalized);
  const rel = relative(rootDir, absolutePath);

  if (!normalized) {
    return {
      rootDir,
      relativePath: ".",
      absolutePath: rootDir
    };
  }

  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`Path "${filePath}" is outside the configured workspace.`);
  }

  return {
    rootDir,
    relativePath: normalized,
    absolutePath
  };
}

function resolveWorkspacePath(workspaceDir, filePath = ".") {
  return assertPathWithinWorkspace(workspaceDir, filePath);
}

async function walkTree(rootDir, currentDir, depth, maxDepth, lines, state) {
  if (state.count >= state.maxEntries || depth > maxDepth) {
    return;
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() && !right.isDirectory()) {
      return -1;
    }
    if (!left.isDirectory() && right.isDirectory()) {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const entry of entries) {
    if (state.count >= state.maxEntries) {
      lines.push("... (workspace tree truncated)");
      return;
    }

    const absolutePath = resolve(currentDir, entry.name);
    const displayPath = normalizeRelativePath(relative(rootDir, absolutePath)) || entry.name;
    lines.push(`${"  ".repeat(depth)}- ${displayPath}${entry.isDirectory() ? "/" : ""}`);
    state.count += 1;

    if (entry.isDirectory()) {
      await walkTree(rootDir, absolutePath, depth + 1, maxDepth, lines, state);
    }
  }
}

async function getWorkspaceTree(workspaceDir, options = {}) {
  const rootDir = await ensureWorkspaceDirectory(workspaceDir);
  const lines = [];
  const state = {
    count: 0,
    maxEntries: Math.max(1, Number(options.maxEntries || DEFAULT_MAX_TREE_ENTRIES))
  };

  await walkTree(
    rootDir,
    rootDir,
    0,
    Math.max(0, Number(options.maxDepth || DEFAULT_MAX_TREE_DEPTH)),
    lines,
    state
  );

  return {
    rootDir,
    lines,
    truncated: state.count >= state.maxEntries
  };
}

async function readWorkspaceFiles(workspaceDir, filePaths, options = {}) {
  const normalizedPaths = Array.isArray(filePaths) ? filePaths : [];
  const targetPaths = normalizedPaths.slice(0, Math.max(1, Number(options.maxFiles || DEFAULT_MAX_READ_FILES)));
  const maxBytes = Math.max(1024, Number(options.maxBytes || DEFAULT_MAX_FILE_BYTES));
  const results = [];

  for (const filePath of targetPaths) {
    const resolved = assertPathWithinWorkspace(workspaceDir, filePath);
    const fileStat = await stat(resolved.absolutePath);
    if (!fileStat.isFile()) {
      throw new Error(`Path "${resolved.relativePath}" is not a file.`);
    }

    const content = await readDocumentText(resolved.absolutePath);
    const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
    results.push({
      path: resolved.relativePath,
      size: fileStat.size,
      truncated,
      content: truncated ? content.slice(0, maxBytes) : content
    });
  }

  return results;
}

async function listWorkspacePath(workspaceDir, filePath = ".", options = {}) {
  const resolved = assertPathWithinWorkspace(workspaceDir, filePath);
  const directoryPath = resolved.absolutePath;
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Path "${resolved.relativePath}" is not a directory.`);
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const limitedEntries = entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, Math.max(1, Number(options.maxEntries || DEFAULT_MAX_TREE_ENTRIES)));

  return limitedEntries.map((entry) => ({
    path: normalizeRelativePath(relative(resolveWorkspaceRoot(workspaceDir), resolve(directoryPath, entry.name))),
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file"
  }));
}

async function writeWorkspaceFiles(workspaceDir, files, options = {}) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const maxFiles = Math.max(1, Number(options.maxFiles || DEFAULT_MAX_WRITE_FILES));
  const writtenFiles = [];

  for (const file of normalizedFiles.slice(0, maxFiles)) {
    const resolved = assertPathWithinWorkspace(workspaceDir, file?.path);
    const encoding = String(file?.encoding || "utf8").trim().toLowerCase() || "utf8";
    const extension = extname(resolved.relativePath).toLowerCase();
    const content =
      extension === ".docx" && encoding !== "base64"
        ? createDocxBuffer({
          title: String(file?.title || ""),
          content: String(file?.content ?? "")
        })
        : encoding === "base64"
          ? Buffer.from(String(file?.content ?? ""), "base64")
          : Buffer.from(String(file?.content ?? ""), "utf8");
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    await writeFile(resolved.absolutePath, content);
    writtenFiles.push({
      path: resolved.relativePath,
      bytes: content.byteLength,
      materializedAs: extension === ".docx" && encoding !== "base64" ? "docx" : "raw"
    });
  }

  return writtenFiles;
}

async function verifyWorkspaceArtifacts(workspaceDir, filePaths, options = {}) {
  const normalizedPaths = Array.isArray(filePaths) ? filePaths : [];
  const maxFiles = Math.max(1, Number(options.maxFiles || DEFAULT_MAX_WRITE_FILES));
  const results = [];

  for (const filePath of normalizedPaths.slice(0, maxFiles)) {
    const resolved = assertPathWithinWorkspace(workspaceDir, filePath);

    try {
      const fileStat = await stat(resolved.absolutePath);
      if (!fileStat.isFile()) {
        throw new Error(`Path "${resolved.relativePath}" is not a file.`);
      }

      if (isSupportedReadableDocument(resolved.absolutePath)) {
        await readDocumentText(resolved.absolutePath);
      }

      results.push({
        path: resolved.relativePath,
        verified: true,
        bytes: fileStat.size
      });
    } catch (error) {
      results.push({
        path: resolved.relativePath,
        verified: false,
        error: error.message
      });
    }
  }

  return results;
}

async function getWorkspaceFilePreview(workspaceDir, filePath, options = {}) {
  const [result] = await readWorkspaceFiles(workspaceDir, [filePath], options);
  return result;
}

function workspaceExists(workspaceDir) {
  return existsSync(resolveWorkspaceRoot(workspaceDir));
}

module.exports = { ensureWorkspaceDirectory, getWorkspaceTree, readWorkspaceFiles, listWorkspacePath, writeWorkspaceFiles, verifyWorkspaceArtifacts, getWorkspaceFilePreview, resolveWorkspaceRoot, resolveWorkspacePath, workspaceExists };

},
"/src/workspace/cache.mjs": function(module, exports, __require) {
const { existsSync } = require("node:fs");
const { mkdir, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");
const { ensureWorkspaceDirectory, resolveWorkspacePath } = __require("/src/workspace/fs.mjs");
const CLUSTER_CACHE_DIR = ".agent-cluster-cache";

function sanitizeCacheRunId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");

  return normalized || `run_${Date.now()}`;
}

async function countDirectoryEntries(dirPath) {
  let files = 0;
  let directories = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = resolveWorkspacePath(dirPath, entry.name).absolutePath;
    if (entry.isDirectory()) {
      directories += 1;
      const child = await countDirectoryEntries(absolutePath);
      files += child.files;
      directories += child.directories;
      continue;
    }

    if (entry.isFile()) {
      files += 1;
    }
  }

  return { files, directories };
}

function resolveCacheContext(workspaceDir) {
  const resolved = resolveWorkspacePath(workspaceDir, CLUSTER_CACHE_DIR);
  return {
    cacheDir: resolved.absolutePath,
    cachePath: resolved.relativePath
  };
}

async function writeClusterRunCache(workspaceDir, runId, payload) {
  await ensureWorkspaceDirectory(workspaceDir);
  const safeRunId = sanitizeCacheRunId(runId);
  const fileResolved = resolveWorkspacePath(
    workspaceDir,
    `${CLUSTER_CACHE_DIR}/runs/${safeRunId}.json`
  );
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  await mkdir(dirname(fileResolved.absolutePath), { recursive: true });
  await writeFile(fileResolved.absolutePath, content, "utf8");

  return {
    path: fileResolved.relativePath,
    bytes: Buffer.byteLength(content, "utf8")
  };
}

async function clearClusterRunCache(workspaceDir) {
  await ensureWorkspaceDirectory(workspaceDir);
  const { cacheDir, cachePath } = resolveCacheContext(workspaceDir);

  if (!existsSync(cacheDir)) {
    return {
      existed: false,
      cachePath,
      removedFiles: 0,
      removedDirectories: 0
    };
  }

  const cacheStat = await stat(cacheDir);
  if (!cacheStat.isDirectory()) {
    await rm(cacheDir, { force: true });
    return {
      existed: true,
      cachePath,
      removedFiles: 1,
      removedDirectories: 0
    };
  }

  const counts = await countDirectoryEntries(cacheDir);
  await rm(cacheDir, { recursive: true, force: true });

  return {
    existed: true,
    cachePath,
    removedFiles: counts.files,
    removedDirectories: counts.directories + 1
  };
}

module.exports = { writeClusterRunCache, clearClusterRunCache, CLUSTER_CACHE_DIR };

},
"/src/system/bot-plugins.mjs": function(module, exports, __require) {
const { existsSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const { ensureWorkspaceDirectory, resolveWorkspacePath } = __require("/src/workspace/fs.mjs");
const DEFAULT_INSTALL_DIR = "bot-connectors";
const DEFAULT_INSTALL_TIMEOUT_MS = 420000;
const OUTPUT_CHAR_LIMIT = 24000;

const BOT_PLUGIN_PRESETS = Object.freeze([
  {
    id: "qq_guild",
    label: "QQ 频道 Bot",
    channel: "QQ",
    source: "社区 SDK",
    ecosystem: "npm",
    description: "QQ 官方频道消息桥接预设。安装后会生成可直接转发到 Agent 集群的连接器脚本。",
    docsUrl: "https://github.com/zhinjs/qq-official-bot",
    installCommand: "npm install qq-official-bot",
    tags: ["QQ", "频道", "Gateway"],
    fields: [
      {
        envName: "QQ_BOT_APP_ID",
        label: "App ID",
        type: "text",
        required: true,
        placeholder: "填写 QQ 官方机器人 App ID",
        description: "QQ 开放平台里创建机器人后获得的 App ID。"
      },
      {
        envName: "QQ_BOT_SECRET",
        label: "App Secret",
        type: "password",
        required: true,
        placeholder: "填写 QQ 官方机器人 Secret",
        description: "用于连接 QQ 官方 Bot Gateway 的密钥。"
      },
      {
        envName: "QQ_BOT_SANDBOX",
        label: "沙箱模式",
        type: "toggle",
        defaultValue: "0",
        trueValue: "1",
        falseValue: "0",
        description: "调试阶段建议开启，正式运行时通常关闭。"
      }
    ],
    envHints: [
      "QQ_BOT_APP_ID=你的机器人 AppId",
      "QQ_BOT_SECRET=你的机器人 Secret",
      "QQ_BOT_SANDBOX=0"
    ]
  },
  {
    id: "wechaty",
    label: "微信 Bot",
    channel: "微信",
    source: "官方文档",
    ecosystem: "npm",
    description: "Wechaty 连接器预设。收到消息后会把任务转发给 Agent 集群，并把进度与结果回复到原会话。",
    docsUrl: "https://wechaty.js.org/docs/howto/installation/",
    installCommand: "npm install wechaty",
    tags: ["微信", "Wechaty", "Message"],
    fields: [
      {
        envName: "WECHATY_PUPPET",
        label: "Puppet 类型",
        type: "text",
        placeholder: "例如 wechaty-puppet-service",
        description: "留空则使用 Wechaty 默认 Puppet。"
      },
      {
        envName: "WECHATY_PUPPET_SERVICE_TOKEN",
        label: "Puppet Token",
        type: "password",
        placeholder: "填写对应 Puppet Service Token",
        description: "仅在使用 wechaty-puppet-service 等远程 Puppet 时需要。"
      },
      {
        envName: "WECHATY_BOT_NAME",
        label: "Bot 名称",
        type: "text",
        defaultValue: "agent-cluster-wechaty",
        placeholder: "agent-cluster-wechaty",
        description: "用于本地运行时区分实例名称。"
      }
    ],
    envHints: [
      "WECHATY_PUPPET=可选，例如 wechaty-puppet-service",
      "WECHATY_PUPPET_SERVICE_TOKEN=对应 Puppet Token",
      "WECHATY_BOT_NAME=agent-cluster-wechaty"
    ]
  },
  {
    id: "dingtalk",
    label: "钉钉 Bot",
    channel: "钉钉",
    source: "官方文档",
    ecosystem: "npm",
    description: "钉钉 Stream Bot 预设。连接器会监听钉钉消息事件，并把执行过程回推到当前会话。",
    docsUrl: "https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/nodejs/build-bot/",
    installCommand: "npm install dingtalk-stream",
    tags: ["钉钉", "Stream", "Event"],
    fields: [
      {
        envName: "DINGTALK_CLIENT_ID",
        label: "Client ID",
        type: "text",
        required: true,
        placeholder: "填写钉钉应用的 Client ID",
        description: "钉钉 Stream Bot 应用凭证中的 Client ID。"
      },
      {
        envName: "DINGTALK_CLIENT_SECRET",
        label: "Client Secret",
        type: "password",
        required: true,
        placeholder: "填写钉钉应用的 Client Secret",
        description: "钉钉 Stream Bot 应用凭证中的 Client Secret。"
      }
    ],
    envHints: [
      "DINGTALK_CLIENT_ID=你的 Client ID",
      "DINGTALK_CLIENT_SECRET=你的 Client Secret"
    ]
  },
  {
    id: "feishu",
    label: "飞书 Bot",
    channel: "飞书",
    source: "官方仓库",
    ecosystem: "npm",
    description: "飞书长连接 Bot 预设。连接器会接收飞书 IM 消息，并把任务结果回复到对应聊天。",
    docsUrl: "https://github.com/larksuite/oapi-sdk-nodejs",
    installCommand: "npm install @larksuiteoapi/node-sdk",
    tags: ["飞书", "LongConn", "IM"],
    fields: [
      {
        envName: "FEISHU_APP_ID",
        label: "App ID",
        type: "text",
        required: true,
        placeholder: "填写飞书应用的 App ID",
        description: "飞书开放平台应用凭证中的 App ID。"
      },
      {
        envName: "FEISHU_APP_SECRET",
        label: "App Secret",
        type: "password",
        required: true,
        placeholder: "填写飞书应用的 App Secret",
        description: "飞书开放平台应用凭证中的 App Secret。"
      }
    ],
    envHints: [
      "FEISHU_APP_ID=你的 App ID",
      "FEISHU_APP_SECRET=你的 App Secret"
    ]
  }
]);

function normalizeInstallDir(value, fallback = DEFAULT_INSTALL_DIR) {
  const normalized = String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || fallback;
}

function trimCommandOutput(stdout, stderr) {
  const joined = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (!joined) {
    return "";
  }

  return joined.length > OUTPUT_CHAR_LIMIT ? `${joined.slice(0, OUTPUT_CHAR_LIMIT)}\n... [output truncated]` : joined;
}

function sanitizePackageName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "") || "agent-cluster-bot";
}

function getPresetById(presetId) {
  return BOT_PLUGIN_PRESETS.find((preset) => preset.id === String(presetId || "").trim()) || null;
}

function buildShellCommand(commandText) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandText]
    };
  }

  return {
    command: "sh",
    args: ["-lc", commandText]
  };
}

function buildManifestPayload({ preset, installDir, targetRelativeDir, commandText, commandOutput }) {
  return {
    id: preset.id,
    label: preset.label,
    channel: preset.channel,
    source: preset.source,
    ecosystem: preset.ecosystem,
    description: preset.description,
    docsUrl: preset.docsUrl,
    installDir,
    targetRelativeDir,
    installCommand: commandText,
    installedAt: new Date().toISOString(),
    outputPreview: commandOutput,
    envHints: preset.envHints || []
  };
}

async function ensureNodePackage(targetDir, packageName, label) {
  const packageJsonPath = join(targetDir, "package.json");
  if (existsSync(packageJsonPath)) {
    return packageJsonPath;
  }

  const packageJson = {
    name: sanitizePackageName(packageName),
    version: "0.1.0",
    private: true,
    description: `${label} connector scaffold generated by Agent Cluster Workbench`,
    type: "module"
  };

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return packageJsonPath;
}

function renderSharedBridgeHelpers() {
  return [
    `const SERVER_URL = String(process.env.AGENT_CLUSTER_SERVER_URL || "").replace(/\\/+$/, "");`,
    `const BOT_ID = String(process.env.AGENT_CLUSTER_BOT_ID || "bot").trim() || "bot";`,
    `const COMMAND_PREFIX = String(process.env.AGENT_CLUSTER_COMMAND_PREFIX || "/agent").trim();`,
    `const PROGRESS_UPDATES = process.env.AGENT_CLUSTER_PROGRESS_UPDATES !== "0";`,
    `const POLL_INTERVAL_MS = Math.max(1200, Number(process.env.AGENT_CLUSTER_POLL_INTERVAL_MS || 2500));`,
    ``,
    `function ensureServerUrl() {`,
    `  if (!SERVER_URL) {`,
    `    throw new Error("AGENT_CLUSTER_SERVER_URL is required.");`,
    `  }`,
    `}`,
    ``,
    `function sleep(ms) {`,
    `  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));`,
    `}`,
    ``,
    `function trimReply(text, maxLength = 1200) {`,
    `  const normalized = String(text || "").trim();`,
    `  return normalized.length > maxLength ? \`\${normalized.slice(0, maxLength)}…\` : normalized;`,
    `}`,
    ``,
    `function normalizeText(value) {`,
    `  return String(value || "").replace(/\\r/g, "").trim();`,
    `}`,
    ``,
    `function extractTaskText(rawText) {`,
    `  const normalized = normalizeText(rawText);`,
    `  if (!normalized) {`,
    `    return "";`,
    `  }`,
    `  if (!COMMAND_PREFIX) {`,
    `    return normalized;`,
    `  }`,
    `  if (!normalized.toLowerCase().startsWith(COMMAND_PREFIX.toLowerCase())) {`,
    `    return "";`,
    `  }`,
    `  return normalizeText(normalized.slice(COMMAND_PREFIX.length));`,
    `}`,
    ``,
    `async function postJson(path, body) {`,
    `  ensureServerUrl();`,
    `  const response = await fetch(\`\${SERVER_URL}\${path}\`, {`,
    `    method: "POST",`,
    `    headers: { "Content-Type": "application/json" },`,
    `    body: JSON.stringify(body || {})`,
    `  });`,
    `  const payload = await response.json();`,
    `  if (!response.ok || payload.ok === false) {`,
    `    throw new Error(payload.error || \`HTTP \${response.status}\`);`,
    `  }`,
    `  return payload;`,
    `}`,
    ``,
    `async function getJson(path) {`,
    `  ensureServerUrl();`,
    `  const response = await fetch(\`\${SERVER_URL}\${path}\`);`,
    `  const payload = await response.json();`,
    `  if (!response.ok || payload.ok === false) {`,
    `    throw new Error(payload.error || \`HTTP \${response.status}\`);`,
    `  }`,
    `  return payload;`,
    `}`,
    ``,
    `async function submitClusterTask(payload) {`,
    `  return postJson("/api/bot/incoming", {`,
    `    botId: BOT_ID,`,
    `    ...payload`,
    `  });`,
    `}`,
    ``,
    `async function fetchOperationSnapshot(operationId, afterSeq = 0) {`,
    `  const query = new URLSearchParams();`,
    `  if (afterSeq > 0) {`,
    `    query.set("afterSeq", String(afterSeq));`,
    `  }`,
    `  return getJson(\`/api/operations/\${encodeURIComponent(operationId)}/snapshot?\${query.toString()}\`);`,
    `}`,
    ``,
    `function shouldForwardProgressEvent(event) {`,
    `  return [`,
    `    "planning_start",`,
    `    "planning_done",`,
    `    "planning_retry",`,
    `    "worker_retry",`,
    `    "leader_delegate_start",`,
    `    "leader_delegate_done",`,
    `    "leader_synthesis_start",`,
    `    "leader_synthesis_retry",`,
    `    "subagent_retry",`,
    `    "synthesis_start",`,
    `    "synthesis_retry"`,
    `  ].includes(event.stage);`,
    `}`,
    ``,
    `function describeProgressEvent(event) {`,
    `  switch (event.stage) {`,
    `    case "planning_start":`,
    `      return "主控开始规划任务。";`,
    `    case "planning_done":`,
    `      return \`主控完成规划，已拆分 \${event.taskCount || 0} 个任务。\`;`,
    `    case "planning_retry":`,
    `      return \`\${event.modelLabel || "主控"} 正在重试规划，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "worker_retry":`,
    `      return \`\${event.agentLabel || event.modelLabel || "工作模型"} 正在重试，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "leader_delegate_start":`,
    `      return \`\${event.agentLabel || "组长"} 正在分配下属任务。\`;`,
    `    case "leader_delegate_done":`,
    `      return event.detail || \`\${event.agentLabel || "组长"} 已完成任务分配。\`;`,
    `    case "leader_synthesis_start":`,
    `      return \`\${event.agentLabel || "组长"} 正在汇总下属结果。\`;`,
    `    case "leader_synthesis_retry":`,
    `      return \`\${event.agentLabel || "组长"} 正在重试汇总，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "subagent_retry":`,
    `      return \`\${event.agentLabel || "下属 Agent"} 正在重试，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    case "synthesis_start":`,
    `      return "主控开始汇总各组结果。";`,
    `    case "synthesis_retry":`,
    `      return \`\${event.modelLabel || "主控"} 正在重试最终汇总，第 \${event.attempt || "?"}/\${event.maxRetries || "?"} 次。\`;`,
    `    default:`,
    `      return "";`,
    `  }`,
    `}`,
    ``,
    `async function followOperation(operationId, sendReply) {`,
    `  let afterSeq = 0;`,
    `  let lastProgressMessage = "";`,
    `  for (;;) {`,
    `    const snapshot = await fetchOperationSnapshot(operationId, afterSeq);`,
    `    const events = Array.isArray(snapshot.events) ? snapshot.events : [];`,
    `    for (const event of events) {`,
    `      afterSeq = Math.max(afterSeq, Number(event.seq) || 0);`,
    `      if (event.stage === "cluster_done") {`,
    `        const finalAnswer = trimReply(event.finalAnswer || event.detail || "任务已完成。", 1800);`,
    `        await sendReply(\`任务完成。\\n\\n\${finalAnswer}\`);`,
    `        return;`,
    `      }`,
    `      if (event.stage === "cluster_failed") {`,
    `        await sendReply(trimReply(\`任务执行失败：\${event.detail || "未知错误"}\`, 1800));`,
    `        return;`,
    `      }`,
    `      if (event.stage === "cluster_cancelled") {`,
    `        await sendReply(trimReply(\`任务已终止：\${event.detail || "已取消"}\`, 1800));`,
    `        return;`,
    `      }`,
    `      if (PROGRESS_UPDATES && shouldForwardProgressEvent(event)) {`,
    `        const progressMessage = describeProgressEvent(event);`,
    `        if (progressMessage && progressMessage !== lastProgressMessage) {`,
    `          lastProgressMessage = progressMessage;`,
    `          await sendReply(trimReply(progressMessage, 700));`,
    `        }`,
    `      }`,
    `    }`,
    `    if (snapshot.finished) {`,
    `      return;`,
    `    }`,
    `    await sleep(POLL_INTERVAL_MS);`,
    `  }`,
    `}`,
    ``,
    `async function dispatchClusterTask(payload, sendReply) {`,
    `  const taskText = extractTaskText(payload.text);`,
    `  if (!taskText) {`,
    `    return false;`,
    `  }`,
    `  await sendReply(trimReply(\`已接收任务，开始转发给 Agent 集群：\${taskText}\`, 500));`,
    `  const submission = await submitClusterTask({`,
    `    ...payload,`,
    `    text: taskText`,
    `  });`,
    `  await sendReply(\`任务已受理，编号：\${submission.operationId}\`);`,
    `  await followOperation(submission.operationId, sendReply);`,
    `  return true;`,
    `}`
  ].join("\n");
}

function renderWechatyRunner() {
  return [
    `import { WechatyBuilder } from "wechaty";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `const bot = WechatyBuilder.build({`,
    `  name: process.env.WECHATY_BOT_NAME || "agent-cluster-wechaty",`,
    `  puppet: process.env.WECHATY_PUPPET || undefined,`,
    `  puppetToken: process.env.WECHATY_PUPPET_SERVICE_TOKEN || process.env.WECHATY_PUPPET_TOKEN || undefined`,
    `});`,
    ``,
    `bot.on("scan", (qrcode) => {`,
    `  console.log("Wechaty QRCode:", qrcode);`,
    `});`,
    ``,
    `bot.on("login", (user) => {`,
    `  console.log("Wechaty logged in:", user?.name?.() || user?.id || "unknown");`,
    `});`,
    ``,
    `bot.on("message", async (message) => {`,
    `  try {`,
    `    if (message.self()) {`,
    `      return;`,
    `    }`,
    `    const text = await message.text();`,
    `    if (!extractTaskText(text)) {`,
    `      return;`,
    `    }`,
    `    const talker = message.talker();`,
    `    const room = message.room();`,
    `    await dispatchClusterTask({`,
    `      text,`,
    `      senderId: talker?.id || "",`,
    `      senderName: talker?.name?.() || "",`,
    `      chatId: room?.id || talker?.id || "",`,
    `      channelId: room?.id || "",`,
    `      raw: {`,
    `        type: message.type?.() || ""`,
    `      }`,
    `    }, async (replyText) => {`,
    `      await message.say(replyText);`,
    `    });`,
    `  } catch (error) {`,
    `    console.error("Wechaty bridge failed:", error);`,
    `    await message.say(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `  }`,
    `});`,
    ``,
    `await bot.start();`,
    `console.log("Wechaty bridge started.");`
  ].join("\n");
}

function renderFeishuRunner() {
  return [
    `import * as lark from "@larksuiteoapi/node-sdk";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `function requiredEnv(name) {`,
    `  const value = String(process.env[name] || "").trim();`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is required.\`);`,
    `  }`,
    `  return value;`,
    `}`,
    ``,
    `function extractFeishuText(content) {`,
    `  try {`,
    `    const parsed = JSON.parse(content || "{}");`,
    `    return normalizeText(parsed.text || parsed.content || "");`,
    `  } catch {`,
    `    return normalizeText(content);`,
    `  }`,
    `}`,
    ``,
    `const appId = requiredEnv("FEISHU_APP_ID");`,
    `const appSecret = requiredEnv("FEISHU_APP_SECRET");`,
    `const client = new lark.Client({ appId, appSecret });`,
    `const eventDispatcher = new lark.EventDispatcher({}).register({`,
    `  "im.message.receive_v1": async (data) => {`,
    `    const event = data?.event || data || {};`,
    `    const message = event.message || {};`,
    `    const sender = event.sender || {};`,
    `    const text = extractFeishuText(message.content);`,
    `    if (!extractTaskText(text)) {`,
    `      return;`,
    `    }`,
    `    const sendReply = async (replyText) => {`,
    `      await client.im.message.create({`,
    `        params: { receive_id_type: "chat_id" },`,
    `        data: {`,
    `          receive_id: message.chat_id,`,
    `          msg_type: "text",`,
    `          content: JSON.stringify({ text: replyText })`,
    `        }`,
    `      });`,
    `    };`,
    `    try {`,
    `      await dispatchClusterTask({`,
    `        text,`,
    `        senderId: sender.sender_id?.open_id || "",`,
    `        senderName: "",`,
    `        chatId: message.chat_id || "",`,
    `        channelId: message.chat_id || "",`,
    `        raw: event`,
    `      }, sendReply);`,
    `    } catch (error) {`,
    `      console.error("Feishu bridge failed:", error);`,
    `      await sendReply(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `    }`,
    `  }`,
    `});`,
    ``,
    `const wsClient = new lark.ws.Client({`,
    `  appId,`,
    `  appSecret,`,
    `  eventDispatcher`,
    `});`,
    ``,
    `wsClient.start();`,
    `console.log("Feishu bridge started.");`
  ].join("\n");
}

function renderDingtalkRunner() {
  return [
    `import * as dingtalk from "dingtalk-stream";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `function requiredEnv(name) {`,
    `  const value = String(process.env[name] || "").trim();`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is required.\`);`,
    `  }`,
    `  return value;`,
    `}`,
    ``,
    `function extractDingtalkText(message) {`,
    `  return normalizeText(message?.text?.content || message?.content?.text || message?.content || "");`,
    `}`,
    ``,
    `async function sendDingtalkReply(sessionWebhook, accessToken, text) {`,
    `  await fetch(sessionWebhook, {`,
    `    method: "POST",`,
    `    headers: {`,
    `      "Content-Type": "application/json",`,
    `      "x-acs-dingtalk-access-token": accessToken`,
    `    },`,
    `    body: JSON.stringify({`,
    `      msgtype: "text",`,
    `      text: { content: text }`,
    `    })`,
    `  });`,
    `}`,
    ``,
    `const credential = new dingtalk.Credential(requiredEnv("DINGTALK_CLIENT_ID"), requiredEnv("DINGTALK_CLIENT_SECRET"));`,
    `const client = new dingtalk.StreamClient(credential);`,
    ``,
    `client.registerCallbackHandler("chatbot.message", async (event) => {`,
    `  const message = event?.data || event || {};`,
    `  const text = extractDingtalkText(message);`,
    `  if (!extractTaskText(text)) {`,
    `    return dingtalk.AckMessage.OK;`,
    `  }`,
    `  const accessToken = await client.getAccessToken();`,
    `  const sessionWebhook = message.sessionWebhook || message.conversation?.sessionWebhook;`,
    `  const sendReply = async (replyText) => {`,
    `    if (!sessionWebhook) {`,
    `      return;`,
    `    }`,
    `    await sendDingtalkReply(sessionWebhook, accessToken, replyText);`,
    `  };`,
    `  try {`,
    `    await dispatchClusterTask({`,
    `      text,`,
    `      senderId: message.senderStaffId || "",`,
    `      senderName: message.senderNick || "",`,
    `      chatId: message.conversationId || "",`,
    `      channelId: message.conversationId || "",`,
    `      raw: message`,
    `    }, sendReply);`,
    `  } catch (error) {`,
    `    console.error("Dingtalk bridge failed:", error);`,
    `    await sendReply(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `  }`,
    `  return dingtalk.AckMessage.OK;`,
    `});`,
    ``,
    `await client.start();`,
    `console.log("Dingtalk bridge started.");`
  ].join("\n");
}

function renderQqRunner() {
  return [
    `import { createClient } from "qq-official-bot";`,
    ``,
    renderSharedBridgeHelpers(),
    ``,
    `function requiredEnv(name) {`,
    `  const value = String(process.env[name] || "").trim();`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is required.\`);`,
    `  }`,
    `  return value;`,
    `}`,
    ``,
    `const client = createClient({`,
    `  appid: requiredEnv("QQ_BOT_APP_ID"),`,
    `  secret: requiredEnv("QQ_BOT_SECRET"),`,
    `  sandbox: String(process.env.QQ_BOT_SANDBOX || "0") === "1"`,
    `});`,
    ``,
    `async function handleQqMessage(message) {`,
    `  const text = normalizeText(message?.content || "");`,
    `  if (!extractTaskText(text)) {`,
    `    return;`,
    `  }`,
    `  const sendReply = async (replyText) => {`,
    `    if (typeof message.reply === "function") {`,
    `      await message.reply(replyText);`,
    `      return;`,
    `    }`,
    `    if (client.api?.postMessage && message.channel_id) {`,
    `      await client.api.postMessage(message.channel_id, { content: replyText });`,
    `    }`,
    `  };`,
    `  try {`,
    `    await dispatchClusterTask({`,
    `      text,`,
    `      senderId: message.author?.id || "",`,
    `      senderName: message.author?.username || "",`,
    `      chatId: message.channel_id || "",`,
    `      channelId: message.channel_id || "",`,
    `      raw: message`,
    `    }, sendReply);`,
    `  } catch (error) {`,
    `    console.error("QQ bridge failed:", error);`,
    `    await sendReply(trimReply(\`转发失败：\${error.message}\`, 700));`,
    `  }`,
    `}`,
    ``,
    `client.on("ready", () => {`,
    `  console.log("QQ bridge started.");`,
    `});`,
    `client.on("message", handleQqMessage);`,
    `client.on("atMessage", handleQqMessage);`,
    `await client.start();`
  ].join("\n");
}

function renderConnectorRunner(preset) {
  switch (preset.id) {
    case "wechaty":
      return renderWechatyRunner();
    case "feishu":
      return renderFeishuRunner();
    case "dingtalk":
      return renderDingtalkRunner();
    case "qq_guild":
      return renderQqRunner();
    default:
      throw new Error(`Unsupported connector preset "${preset.id}".`);
  }
}

async function writeConnectorScaffold(targetDir, preset) {
  const connectorPath = join(targetDir, "connector-runner.mjs");
  const envExamplePath = join(targetDir, ".env.example");
  const envText = (preset.envHints || []).join("\n");

  await writeFile(connectorPath, `${renderConnectorRunner(preset)}\n`, "utf8");
  await writeFile(envExamplePath, `${envText}\n`, "utf8");

  return {
    connectorPath,
    envExamplePath
  };
}

async function writeInstallArtifacts(targetDir, manifestPayload) {
  const manifestPath = join(targetDir, ".agent-cluster-bot-plugin.json");
  const readmePath = join(targetDir, "AGENT_CLUSTER_BOT_README.md");

  const readme = [
    `# ${manifestPayload.label}`,
    "",
    `- 渠道：${manifestPayload.channel}`,
    `- 来源：${manifestPayload.source}`,
    `- 文档：${manifestPayload.docsUrl}`,
    `- 安装时间：${manifestPayload.installedAt}`,
    "",
    "## 安装命令",
    "",
    "```bash",
    manifestPayload.installCommand,
    "```",
    "",
    "## 连接器说明",
    "",
    "已自动生成：",
    "- `connector-runner.mjs`：实际连接聊天平台并转发到 Agent 集群的脚本",
    "- `.env.example`：该平台需要填写的环境变量模板",
    "- `.agent-cluster-bot-plugin.json`：安装清单",
    "",
    "## 运行方式",
    "",
    "1. 在图形界面的 Bot 配置里安装并保存该预设。",
    "2. 把 `.env.example` 里的变量填到对应预设的“环境变量”输入框。",
    "3. 在界面里点击“启动全部 Bot”或启动单个预设。",
    "4. 在聊天里用命令前缀触发，例如 `/agent 请分析当前代码仓库`。",
    "",
    "## 环境变量模板",
    "",
    "```env",
    ...(manifestPayload.envHints || []),
    "```",
    "",
    "## 说明",
    "",
    manifestPayload.description,
    ""
  ].join("\n");

  await writeFile(manifestPath, `${JSON.stringify(manifestPayload, null, 2)}\n`, "utf8");
  await writeFile(readmePath, `${readme}\n`, "utf8");

  return {
    manifestPath,
    readmePath
  };
}

async function runShellCommand(commandText, { cwd, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS } = {}) {
  const { command, args } = buildShellCommand(commandText);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false"
      }
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const normalizedTimeout = Math.max(1000, Number(timeoutMs) || DEFAULT_INSTALL_TIMEOUT_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1200).unref();
    }, normalizedTimeout);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = trimCommandOutput(stdout, stderr);

      if (timedOut) {
        reject(new Error(`Command timed out after ${normalizedTimeout} ms: ${commandText}${output ? `\n${output}` : ""}`));
        return;
      }

      if (code !== 0) {
        reject(
          new Error(
            `Command failed${code != null ? ` with exit code ${code}` : signal ? ` with signal ${signal}` : ""}: ${commandText}${output ? `\n${output}` : ""}`
          )
        );
        return;
      }

      resolve({
        code,
        signal,
        output
      });
    });
  });
}

async function prepareInstallTarget(workspaceDir, installDir, leafDir) {
  const workspaceRoot = await ensureWorkspaceDirectory(workspaceDir);
  const normalizedInstallDir = normalizeInstallDir(installDir);
  const target = resolveWorkspacePath(workspaceRoot, `${normalizedInstallDir}/${leafDir}`);
  await mkdir(target.absolutePath, { recursive: true });

  return {
    workspaceRoot,
    installDir: normalizedInstallDir,
    targetDir: target.absolutePath,
    targetRelativeDir: target.relativePath
  };
}

function listBotPluginPresets() {
  return BOT_PLUGIN_PRESETS.map((preset) => ({
    ...preset,
    defaultInstallDir: DEFAULT_INSTALL_DIR
  }));
}

async function installBotPluginPreset({
  workspaceDir,
  installDir = DEFAULT_INSTALL_DIR,
  presetId,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS
}) {
  const preset = getPresetById(presetId);
  if (!preset) {
    throw new Error(`Unknown bot preset "${presetId}".`);
  }

  const target = await prepareInstallTarget(workspaceDir, installDir, preset.id);
  if (preset.ecosystem === "npm") {
    await ensureNodePackage(target.targetDir, `${preset.id}-connector`, preset.label);
  }

  const commandText = preset.installCommand;
  const result = await runShellCommand(commandText, {
    cwd: target.targetDir,
    timeoutMs
  });

  const manifestPayload = buildManifestPayload({
    preset,
    installDir: target.installDir,
    targetRelativeDir: target.targetRelativeDir,
    commandText,
    commandOutput: result.output
  });
  const scaffold = await writeConnectorScaffold(target.targetDir, preset);
  const artifacts = await writeInstallArtifacts(target.targetDir, manifestPayload);

  return {
    preset: {
      id: preset.id,
      label: preset.label,
      docsUrl: preset.docsUrl
    },
    command: commandText,
    output: result.output,
    installDir: target.installDir,
    targetDir: target.targetDir,
    targetRelativeDir: target.targetRelativeDir,
    manifestPath: artifacts.manifestPath,
    readmePath: artifacts.readmePath,
    connectorPath: scaffold.connectorPath,
    envExamplePath: scaffold.envExamplePath
  };
}

async function installBotCustomCommand({
  workspaceDir,
  installDir = DEFAULT_INSTALL_DIR,
  commandText,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS
}) {
  const normalizedCommand = String(commandText || "").trim();
  if (!normalizedCommand) {
    throw new Error("Custom bot install command is required.");
  }

  const preset = {
    id: "custom",
    label: "自定义 Bot 命令",
    channel: "Custom",
    source: "用户自定义",
    ecosystem: "shell",
    description: "通过图形界面的自定义命令执行安装。此目录不会自动生成平台连接器脚本。",
    docsUrl: "",
    installCommand: normalizedCommand,
    envHints: []
  };

  const target = await prepareInstallTarget(workspaceDir, installDir, "custom");
  if (/^(npm|pnpm|yarn)(\s|$)/i.test(normalizedCommand)) {
    await ensureNodePackage(target.targetDir, "custom-bot-connector", preset.label);
  }

  const result = await runShellCommand(normalizedCommand, {
    cwd: target.targetDir,
    timeoutMs
  });

  const manifestPayload = buildManifestPayload({
    preset,
    installDir: target.installDir,
    targetRelativeDir: target.targetRelativeDir,
    commandText: normalizedCommand,
    commandOutput: result.output
  });
  const artifacts = await writeInstallArtifacts(target.targetDir, manifestPayload);

  return {
    command: normalizedCommand,
    output: result.output,
    installDir: target.installDir,
    targetDir: target.targetDir,
    targetRelativeDir: target.targetRelativeDir,
    manifestPath: artifacts.manifestPath,
    readmePath: artifacts.readmePath
  };
}

module.exports = { installBotPluginPreset, installBotCustomCommand, listBotPluginPresets };

},
"/src/providers/openai-responses.mjs": function(module, exports, __require) {
const { postJson } = __require("/src/providers/http-client.mjs");
function buildInputItems({ instructions, input }) {
  const items = [];

  if (typeof instructions === "string" && instructions.trim()) {
    items.push({
      role: "system",
      content: [
        {
          type: "input_text",
          text: instructions
        }
      ]
    });
  }

  if (Array.isArray(input)) {
    return items.concat(input);
  }

  items.push({
    role: "user",
    content: [
      {
        type: "input_text",
        text: String(input || "")
      }
    ]
  });

  return items;
}

function extractTextFromResponse(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item.content || []) {
      if (typeof content?.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function hasStructuredResponsesOutput(response) {
  if (Array.isArray(response?.output) && response.output.length > 0) {
    return true;
  }

  return typeof response?.status === "string" || typeof response?.id === "string";
}

function responseMentionsWebSearch(response) {
  if (
    Array.isArray(response?.output) &&
    response.output.some((item) =>
      String(item?.type || "")
        .trim()
        .toLowerCase()
        .includes("web_search")
    )
  ) {
    return true;
  }

  return Array.isArray(response?.output)
    ? response.output.some((item) =>
        Array.isArray(item?.content)
          ? item.content.some((content) =>
              Array.isArray(content?.annotations)
                ? content.annotations.some((annotation) => {
                    const type = String(annotation?.type || "")
                      .trim()
                      .toLowerCase();
                    return type.includes("web_search") || type.includes("citation");
                  })
                : false
            )
          : false
      )
    : false;
}

function buildResponseTools(modelConfig) {
  const tools = [];
  if (modelConfig.webSearch) {
    tools.push({ type: "web_search" });
  }
  return tools;
}

function buildReasoningConfig(modelConfig) {
  if (modelConfig?.thinkingEnabled === false) {
    return null;
  }

  const explicitEffort = String(modelConfig?.reasoning?.effort || "")
    .trim()
    .toLowerCase();
  if (explicitEffort) {
    return {
      ...modelConfig.reasoning,
      effort: explicitEffort
    };
  }

  if (modelConfig?.thinkingEnabled) {
    return { effort: "medium" };
  }

  return null;
}

class OpenAIResponsesProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/responses`;
    const body = {
      model: this.modelConfig.model,
      input: buildInputItems({ instructions, input })
    };

    const reasoning = buildReasoningConfig(this.modelConfig);
    if (reasoning) {
      body.reasoning = reasoning;
    }

    const tools = buildResponseTools(this.modelConfig);
    if (tools.length) {
      body.tools = tools;
    }

    if (this.modelConfig.maxOutputTokens) {
      body.max_output_tokens = this.modelConfig.maxOutputTokens;
    }

    const raw = await postJson(endpoint, body, this.modelConfig, {
      purpose,
      onRetry,
      signal
    });
    const text = extractTextFromResponse(raw);
    if (!text) {
      if (allowEmptyText && hasStructuredResponsesOutput(raw)) {
        return {
          text: "",
          raw,
          meta: {
            webSearchObserved: responseMentionsWebSearch(raw)
          }
        };
      }
      throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
    }

    return {
      text,
      raw,
      meta: {
        webSearchObserved: responseMentionsWebSearch(raw)
      }
    };
  }
}

module.exports = { OpenAIResponsesProvider };

},
"/src/providers/openai-chat.mjs": function(module, exports, __require) {
const { postJson } = __require("/src/providers/http-client.mjs");
const { providerSupportsCapability } = __require("/src/static/provider-catalog.js");
const MAX_BUILTIN_TOOL_TURNS = 6;

function extractMessageContent(choice) {
  if (typeof choice?.text === "string") {
    return choice.text.trim();
  }

  const content = choice?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function buildBuiltinToolConfig(modelConfig) {
  if (!modelConfig?.webSearch) {
    return null;
  }

  return [
    {
      type: "builtin_function",
      function: {
        name: "$web_search"
      }
    }
  ];
}

function cloneAssistantMessage(message) {
  return {
    role: "assistant",
    content:
      typeof message?.content === "string" || Array.isArray(message?.content)
        ? message.content
        : "",
    ...(Array.isArray(message?.tool_calls) && message.tool_calls.length
      ? {
          tool_calls: message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: toolCall?.function ? { ...toolCall.function } : toolCall?.function
          }))
        }
      : {})
  };
}

function parseFunctionArguments(rawArguments) {
  if (typeof rawArguments !== "string") {
    return rawArguments ?? {};
  }

  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return rawArguments;
  }
}

function buildToolResultContent(toolCall) {
  const parsedArguments = parseFunctionArguments(toolCall?.function?.arguments);
  if (typeof parsedArguments === "string") {
    return parsedArguments;
  }
  return JSON.stringify(parsedArguments);
}

function hasStructuredChatResponse(raw) {
  return Array.isArray(raw?.choices) && raw.choices.length > 0;
}

function buildThinkingConfig(modelConfig, { builtinToolsEnabled = false } = {}) {
  if (!providerSupportsCapability(modelConfig?.provider, "thinking")) {
    return null;
  }

  if (builtinToolsEnabled) {
    return { type: "disabled" };
  }

  return {
    type: modelConfig?.thinkingEnabled ? "enabled" : "disabled"
  };
}

class OpenAIChatProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/chat/completions`;
    const messages = [
      { role: "system", content: instructions },
      { role: "user", content: input }
    ];
    const builtinTools = buildBuiltinToolConfig(this.modelConfig);
    let lastRaw = null;
    let builtinToolTurns = 0;
    let webSearchToolCalls = 0;

    for (let turn = 0; turn < MAX_BUILTIN_TOOL_TURNS; turn += 1) {
      const body = {
        model: this.modelConfig.model,
        messages,
        user: `agent-cluster:${purpose}`
      };

      if (typeof this.modelConfig.temperature === "number") {
        body.temperature = this.modelConfig.temperature;
      }

      if (this.modelConfig.maxOutputTokens) {
        body.max_tokens = this.modelConfig.maxOutputTokens;
      }

      const thinking = buildThinkingConfig(this.modelConfig, {
        builtinToolsEnabled: Boolean(builtinTools)
      });
      if (thinking) {
        body.thinking = thinking;
      }

      if (builtinTools) {
        body.tools = builtinTools;
      }

      lastRaw = await postJson(endpoint, body, this.modelConfig, {
        purpose,
        onRetry,
        signal
      });

      const choice = lastRaw?.choices?.[0];
      const toolCalls = Array.isArray(choice?.message?.tool_calls)
        ? choice.message.tool_calls
        : [];
      if (builtinTools && toolCalls.length) {
        builtinToolTurns += 1;
        webSearchToolCalls += toolCalls.filter(
          (toolCall) => String(toolCall?.function?.name || "").trim() === "$web_search"
        ).length;
        messages.push(cloneAssistantMessage(choice.message));
        for (const toolCall of toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: String(toolCall?.id || ""),
            name: String(toolCall?.function?.name || ""),
            content: buildToolResultContent(toolCall)
          });
        }
        continue;
      }

      const text = extractMessageContent(choice);
      if (!text) {
        if (allowEmptyText && hasStructuredChatResponse(lastRaw)) {
          return {
            text: "",
            raw: lastRaw,
            meta: {
              builtinToolTurns,
              webSearchToolCalls,
              webSearchObserved: webSearchToolCalls > 0
            }
          };
        }
        throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
      }

      return {
        text,
        raw: lastRaw,
        meta: {
          builtinToolTurns,
          webSearchToolCalls,
          webSearchObserved: webSearchToolCalls > 0
        }
      };
    }

    throw new Error(
      `Model "${this.modelConfig.id}" exceeded the maximum built-in tool turns.`
    );
  }
}

module.exports = { OpenAIChatProvider };

},
"/src/providers/anthropic-messages.mjs": function(module, exports, __require) {
const { postJson } = __require("/src/providers/http-client.mjs");
const { providerSupportsCapability } = __require("/src/static/provider-catalog.js");
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const MAX_SERVER_TOOL_TURNS = 6;
const THINKING_BUDGET_BY_EFFORT = Object.freeze({
  low: 1024,
  medium: 2048,
  high: 3072,
  xhigh: 4096
});

function buildMessageContent(input) {
  if (Array.isArray(input)) {
    return [
      {
        type: "text",
        text: JSON.stringify(input)
      }
    ];
  }

  return [
    {
      type: "text",
      text: String(input || "")
    }
  ];
}

function extractTextFromAnthropicResponse(response) {
  const parts = [];

  for (const item of response?.content || []) {
    if (item?.type === "text" && typeof item?.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.join("\n").trim();
}

function hasStructuredAnthropicResponse(response) {
  return Array.isArray(response?.content) || typeof response?.id === "string";
}

function responseMentionsAnthropicWebSearch(response) {
  return Array.isArray(response?.content)
    ? response.content.some((item) => {
        const type = String(item?.type || "")
          .trim()
          .toLowerCase();
        const name = String(item?.name || item?.tool_name || "")
          .trim()
          .toLowerCase();
        return (
          type.includes("web_search") ||
          name.includes("web_search") ||
          (type.includes("tool") && name.includes("search"))
        );
      })
    : false;
}

function buildAnthropicWebSearchTools(modelConfig) {
  if (!modelConfig?.webSearch) {
    return null;
  }

  return [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3
    }
  ];
}

function resolveThinkingEffort(modelConfig) {
  return String(modelConfig?.reasoning?.effort || modelConfig?.reasoningEffort || "")
    .trim()
    .toLowerCase();
}

function buildAnthropicThinkingConfig(modelConfig) {
  if (!providerSupportsCapability(modelConfig?.provider, "thinking") || !modelConfig?.thinkingEnabled) {
    return null;
  }

  const effort = resolveThinkingEffort(modelConfig) || "medium";
  const requestedBudget =
    THINKING_BUDGET_BY_EFFORT[effort] || THINKING_BUDGET_BY_EFFORT.medium;

  return {
    type: "enabled",
    budget_tokens: requestedBudget
  };
}

class AnthropicMessagesProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/messages`;
    const messages = [
      {
        role: "user",
        content: buildMessageContent(input)
      }
    ];
    const tools = buildAnthropicWebSearchTools(this.modelConfig);
    let lastRaw = null;
    let serverToolTurns = 0;
    let webSearchObserved = false;

    for (let turn = 0; turn < MAX_SERVER_TOOL_TURNS; turn += 1) {
      const requestedMaxTokens = Math.max(
        64,
        Number(this.modelConfig.maxOutputTokens || DEFAULT_MAX_TOKENS)
      );
      const thinking = buildAnthropicThinkingConfig(this.modelConfig);
      const body = {
        model: this.modelConfig.model,
        max_tokens: thinking
          ? Math.max(requestedMaxTokens, Number(thinking.budget_tokens || 0) + 512)
          : requestedMaxTokens,
        messages
      };

      if (typeof instructions === "string" && instructions.trim()) {
        body.system = instructions.trim();
      }

      if (typeof this.modelConfig.temperature === "number") {
        body.temperature = this.modelConfig.temperature;
      }

      if (tools) {
        body.tools = tools;
      }

      if (thinking) {
        body.thinking = thinking;
      }

      lastRaw = await postJson(
        endpoint,
        body,
        {
          ...this.modelConfig,
          authStyle: this.modelConfig.authStyle || "api-key",
          apiKeyHeader: this.modelConfig.apiKeyHeader || "x-api-key",
          extraHeaders: {
            "anthropic-version":
              this.modelConfig.anthropicVersion || DEFAULT_ANTHROPIC_VERSION,
            ...(this.modelConfig.extraHeaders || {})
          }
        },
        {
          purpose,
          onRetry,
          signal
        }
      );
      webSearchObserved =
        webSearchObserved ||
        responseMentionsAnthropicWebSearch(lastRaw) ||
        (Boolean(tools) &&
          String(lastRaw?.stop_reason || "").trim().toLowerCase() === "pause_turn");

      if (
        String(lastRaw?.stop_reason || "").trim().toLowerCase() === "pause_turn" &&
        Array.isArray(lastRaw?.content) &&
        lastRaw.content.length
      ) {
        serverToolTurns += 1;
        messages.push({
          role: "assistant",
          content: lastRaw.content
        });
        continue;
      }

      const text = extractTextFromAnthropicResponse(lastRaw);
      if (!text) {
        if (allowEmptyText && hasStructuredAnthropicResponse(lastRaw)) {
          return {
            text: "",
            raw: lastRaw,
            meta: {
              serverToolTurns,
              webSearchObserved
            }
          };
        }
        throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
      }

      return {
        text,
        raw: lastRaw,
        meta: {
          serverToolTurns,
          webSearchObserved
        }
      };
    }

    throw new Error(
      `Model "${this.modelConfig.id}" exceeded the maximum server-tool continuation turns.`
    );
  }
}

module.exports = { AnthropicMessagesProvider };

},
"/src/providers/access-policy.mjs": function(module, exports, __require) {
function validateModelAccessPolicy(modelConfig) {
  void modelConfig;
}

module.exports = { validateModelAccessPolicy };

},
"/src/utils/json-output.mjs": function(module, exports, __require) {
function findBalancedJson(text) {
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[") {
      starts.push(index);
    }
  }

  for (const startIndex of starts) {
    const stack = [];
    let inString = false;
    let escaping = false;

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = char === "}" ? "{" : "[";
        if (stack[stack.length - 1] !== expected) {
          break;
        }

        stack.pop();
        if (!stack.length) {
          return text.slice(startIndex, index + 1);
        }
      }
    }
  }

  return null;
}

function normalizeSmartQuotes(text) {
  return String(text || "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function removeJsonLikeComments(text) {
  let result = "";
  let quote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        index += 1;
      }
      index -= 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length - 1 && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function normalizeJsonLikeStrings(text) {
  let result = "";
  let quote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaping) {
        result += char;
        escaping = false;
        continue;
      }

      if (char === "\\") {
        result += "\\";
        escaping = true;
        continue;
      }

      if (char === quote) {
        result += '"';
        quote = "";
        continue;
      }

      if (char === "\r") {
        if (text[index + 1] === "\n") {
          index += 1;
        }
        result += "\\n";
        continue;
      }

      if (char === "\n") {
        result += "\\n";
        continue;
      }

      if (quote === "'" && char === '"') {
        result += '\\"';
        continue;
      }

      result += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += '"';
      continue;
    }

    result += char;
  }

  return result;
}

function isBareJsonKeyStart(char) {
  return /[A-Za-z_\u00C0-\uFFFF$]/.test(String(char || ""));
}

function isBareJsonKeyChar(char) {
  return /[A-Za-z0-9_\u00C0-\uFFFF$-]/.test(String(char || ""));
}

function quoteBareJsonKeys(text) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "{" || char === ",") {
      result += char;
      let cursor = index + 1;
      let whitespace = "";
      while (cursor < text.length && /\s/.test(text[cursor])) {
        whitespace += text[cursor];
        cursor += 1;
      }

      if (text[cursor] === '"' || !isBareJsonKeyStart(text[cursor])) {
        result += whitespace;
        index = cursor - 1;
        continue;
      }

      let keyEnd = cursor + 1;
      while (keyEnd < text.length && isBareJsonKeyChar(text[keyEnd])) {
        keyEnd += 1;
      }
      const key = text.slice(cursor, keyEnd);
      let postKeyWhitespace = "";
      let colonIndex = keyEnd;
      while (colonIndex < text.length && /\s/.test(text[colonIndex])) {
        postKeyWhitespace += text[colonIndex];
        colonIndex += 1;
      }

      if (text[colonIndex] === ":") {
        result += `${whitespace}"${key}"${postKeyWhitespace}`;
        index = colonIndex - 1;
        continue;
      }

      result += whitespace;
      index = cursor - 1;
      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingJsonCommas(text) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/.test(text[cursor])) {
        cursor += 1;
      }
      if (text[cursor] === "}" || text[cursor] === "]") {
        continue;
      }
    }

    result += char;
  }

  return result;
}

function repairJsonLikeText(text) {
  return stripTrailingJsonCommas(
    quoteBareJsonKeys(
      normalizeJsonLikeStrings(
        removeJsonLikeComments(
          normalizeSmartQuotes(String(text || "").replace(/^\uFEFF/, "").trim())
        )
      )
    )
  );
}

function extractOuterFencedBlock(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("```")) {
    return null;
  }

  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) {
    return null;
  }

  const closingFenceIndex = trimmed.lastIndexOf("```");
  if (closingFenceIndex <= firstLineEnd) {
    return null;
  }

  const trailing = trimmed.slice(closingFenceIndex + 3).trim();
  if (trailing) {
    return null;
  }

  return trimmed.slice(firstLineEnd + 1, closingFenceIndex).trim();
}

function extractJsonCandidate(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Empty text cannot be parsed as JSON.");
  }

  const outerFenced = extractOuterFencedBlock(trimmed);
  if (outerFenced) {
    return outerFenced;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const balanced = findBalancedJson(trimmed);
  if (balanced) {
    return balanced;
  }

  throw new Error("No JSON object or array found in model output.");
}

function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Empty text cannot be parsed as JSON.");
  }

  const candidates = [trimmed];
  try {
    const extracted = extractJsonCandidate(trimmed);
    if (extracted && extracted !== trimmed) {
      candidates.push(extracted);
    }
  } catch {
    // Ignore and continue with the raw candidate.
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
      const repairedCandidate = repairJsonLikeText(candidate);
      if (!repairedCandidate || repairedCandidate === candidate) {
        continue;
      }
      try {
        return JSON.parse(repairedCandidate);
      } catch (repairError) {
        lastError = repairError;
      }
    }
  }

  throw lastError || new Error("No JSON object or array found in model output.");
}

module.exports = { extractJsonCandidate, parseJsonFromText };

},
"/src/cluster/prompts.mjs": function(module, exports, __require) {
const { renderRuntimeCalendarNote } = __require("/src/utils/runtime-context.mjs");
function normalizeOutputLocale(value) {
  return String(value || "").trim() === "zh-CN" ? "zh-CN" : "en-US";
}

function describeOutputLanguage(locale) {
  return normalizeOutputLocale(locale) === "zh-CN" ? "Simplified Chinese" : "English";
}

function buildOutputLanguageInstruction(locale) {
  return normalizeOutputLocale(locale) === "zh-CN"
    ? "Output language policy: always respond in Simplified Chinese. Keep the JSON keys exactly as specified in English, but write all natural-language values, summaries, findings, titles, and final answers in Simplified Chinese unless the user explicitly requests another language."
    : "Output language policy: always respond in English. Keep the JSON keys exactly as specified in English, and write all natural-language values, summaries, findings, titles, and final answers in English unless the user explicitly requests another language.";
}

function buildOutputLanguageInput(locale) {
  return `Requested response language:\n${describeOutputLanguage(locale)}`;
}

function formatWorkers(workers) {
  return workers
    .map(
      (worker) =>
        `- ${worker.id}: ${worker.label} | model=${worker.model} | provider=${worker.provider} | web_search=${worker.webSearch ? "enabled" : "disabled"} | delegate_capacity=dynamic | specialties=${worker.specialties.join(", ") || "generalist"}`
    )
    .join("\n");
}

function formatWorkspaceSummary(workspaceSummary) {
  if (!workspaceSummary?.rootDir) {
    return "Workspace not configured.";
  }

  const tree =
    Array.isArray(workspaceSummary.lines) && workspaceSummary.lines.length
      ? workspaceSummary.lines.join("\n")
      : "(workspace is empty)";
  return `Workspace root: ${workspaceSummary.rootDir}\nWorkspace tree:\n${tree}`;
}

function uniqueStrings(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function extractIdentityTokens(task) {
  const source = String(task || "");
  const repoMatches = Array.from(source.matchAll(/\b[\w.-]+\/[\w.-]+\b/g), (match) => match[0]);
  const quotedMatches = Array.from(source.matchAll(/`([^`]+)`/g), (match) => match[1]);
  const properNounMatches = Array.from(
    source.matchAll(/\b[A-Z][A-Za-z0-9._-]{3,}\b/g),
    (match) => match[0]
  );

  return uniqueStrings([...repoMatches, ...quotedMatches, ...properNounMatches]).slice(0, 8);
}

function buildIdentityLock(task) {
  const tokens = extractIdentityTokens(task);
  if (!tokens.length) {
    return [
      "Identity lock:",
      "preserve exact product, repository, file, and proper-noun names from the user objective.",
      "If a similarly spelled entity appears, treat it as a different target until verified."
    ].join(" ");
  }

  return [
    "Identity lock:",
    `preserve and verify these exact target names before collecting evidence: ${tokens.join(", ")}.`,
    "If a source differs by repository owner, one character, or product family, treat it as out of scope unless verified."
  ].join(" ");
}

function buildArtifactGuard() {
  return [
    "Artifact guard:",
    "if a task expects a concrete file, report, or document, do not claim it was delivered unless the file was actually written and can be named precisely."
  ].join(" ");
}

function buildDateGuard() {
  return renderRuntimeCalendarNote();
}

function formatAgentBudgetSummary(complexityBudget) {
  if (!complexityBudget || typeof complexityBudget !== "object") {
    return "{}";
  }

  const requestedTotalAgents = Number(complexityBudget?.requestedTotalAgents);
  const effectiveTotalAgents = Number(complexityBudget?.maxTotalAgents);
  const automaticTotalAgents = Number(complexityBudget?.autoBudgetMaxTotalAgents);
  const lines = [];

  if (requestedTotalAgents > 0) {
    lines.push(
      `User explicitly requested ${requestedTotalAgents} total agent(s) for the whole cluster run.`
    );
    lines.push(
      "Interpret that as one run-wide total across all top-level leaders and child agents combined, not as a per-leader quota."
    );
    if (automaticTotalAgents > 0 && automaticTotalAgents !== effectiveTotalAgents) {
      lines.push(
        `Automatic complexity budgeting would have suggested ${automaticTotalAgents}, but the explicit user request overrides that automatic cap.`
      );
    }
    if (effectiveTotalAgents > 0 && effectiveTotalAgents < requestedTotalAgents) {
      lines.push(
        `Current runtime settings can effectively schedule up to ${effectiveTotalAgents} total agent(s) under the present topology and concurrency limits.`
      );
    }
  }

  lines.push(JSON.stringify(complexityBudget, null, 2));
  return lines.join("\n");
}

function formatDelegationBudgetSummary(delegateCount, runAgentBudget) {
  const summary = {
    localChildAgentAllocation: Math.max(0, Number(delegateCount) || 0),
    requestedTotalAgents:
      Number(runAgentBudget?.requestedTotalAgents) > 0
        ? Number(runAgentBudget.requestedTotalAgents)
        : null,
    effectiveTotalAgents:
      Number(runAgentBudget?.maxTotalAgents) > 0 ? Number(runAgentBudget.maxTotalAgents) : null,
    remainingRunWideChildBudget:
      Number(runAgentBudget?.remainingChildAgents) >= 0
        ? Number(runAgentBudget.remainingChildAgents)
        : null,
    budgetSource: String(runAgentBudget?.budgetSource || "complexity_profile")
  };

  return JSON.stringify(summary, null, 2);
}

function buildPlanningRequest({
  task,
  workers,
  maxParallel,
  workspaceSummary = null,
  delegateMaxDepth = 1,
  delegateBranchFactor = 0,
  complexityBudget = null,
  capabilityRoutingPolicySummary = "",
  outputLocale = "en-US"
}) {
  return {
    instructions: [
      "You are the controller of a multi-model agent cluster.",
      buildDateGuard(),
      buildOutputLanguageInstruction(outputLocale),
      "Break the user objective into concrete subtasks that can be executed by the listed group leaders.",
      "Never infer a different 'actual current date' from background knowledge. Use only the authoritative runtime clock provided below.",
      "Use staged workflow phases when helpful: research -> implementation -> validation -> handoff.",
      "Favor parallel execution unless a dependency is truly necessary.",
      Number(complexityBudget?.requestedTotalAgents) > 0
        ? `The user explicitly requested ${complexityBudget.requestedTotalAgents} total agents for the whole run. Treat that as one global cluster-wide total, not as a per-task or per-leader quota.`
        : "Apply the agent budget as a run-wide limit, not a per-task quota.",
      "Treat the listed specialties as the primary routing hints when assigning tasks to group leaders.",
      "Use only the worker ids provided to you.",
      "Prefer workers with web_search=enabled for tasks that require fresh facts, case collection, public-source verification, or browsing.",
      "Do not assign web-search-dependent work to workers whose web_search capability is disabled when a web-search-enabled worker is available.",
      "If the task depends on current facts, real-world examples, or source verification, use web search when your model supports it.",
      "For search-heavy research, split the work into smaller batches. Prefer roughly 4-8 verified examples, cases, or evidence items per research subtask instead of large quotas in one task.",
      "If several workers share the same provider or base URL, avoid overloading that gateway with too many simultaneous search tasks.",
      "Do not invent sources, cases, URLs, or evidence that you did not actually verify.",
      "If a coding or file-producing task is involved, assign at least one worker to inspect and modify the workspace.",
      buildIdentityLock(task),
      buildArtifactGuard(),
      "When the user asks for a concrete document or file, make that expected artifact explicit in expectedOutput.",
      "Return JSON only.",
      'Schema: {"objective":"string","strategy":"string","tasks":[{"id":"task_1","phase":"research|implementation|validation|handoff","title":"string","assignedWorker":"worker_id","delegateCount":0,"instructions":"string","dependsOn":["task_0"],"expectedOutput":"string"}]}'
    ].join(" "),
    input: [
      `User objective:\n${task}`,
      `Current local date context:\n${buildDateGuard()}`,
      buildOutputLanguageInput(outputLocale),
      `Available workers:\n${formatWorkers(workers)}`,
      `Workspace context:\n${formatWorkspaceSummary(workspaceSummary)}`,
      `Delegation limits:\nmax_depth=${Math.max(0, Number(delegateMaxDepth) || 0)}\nmax_children_per_parent=${Math.max(0, Number(delegateBranchFactor) || 0)}`,
      `Hard limit: no more than ${Math.max(1, Number(maxParallel) || 0)} top-level subtasks unless absolutely necessary.`,
      complexityBudget
        ? `Agent budget:\n${formatAgentBudgetSummary(complexityBudget)}`
        : "Agent budget:\n{}",
      capabilityRoutingPolicySummary
        ? `Capability routing policy:\n${capabilityRoutingPolicySummary}`
        : "Capability routing policy:\ndefault"
    ].join("\n\n")
  };
}

function buildWorkerExecutionRequest({
  originalTask,
  clusterPlan,
  worker,
  task,
  dependencyOutputs,
  outputLocale = "en-US"
}) {
  return {
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      buildDateGuard(),
      buildOutputLanguageInstruction(outputLocale),
      "Complete only the assigned subtask and stay scoped.",
      "Never state that the actual current date is different from the authoritative runtime clock below.",
      "Be explicit about uncertainty and concrete about recommendations.",
      "Respect the assigned workflow phase.",
      "If the subtask requires current facts, public examples, or source verification, use web search when your model supports it.",
      "For search-heavy research, prefer a smaller fully verified batch over a larger unverified list.",
      "Never fabricate examples, URLs, citations, or case studies.",
      buildIdentityLock(originalTask),
      buildArtifactGuard(),
      "If the task expects a file or document and you cannot point to the exact artifact, report that gap as a risk and do not mark verificationStatus as passed.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought; keep it concise and safe for display.",
      "Return JSON only.",
      'Schema: {"thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"generatedFiles":["string"],"confidence":"low|medium|high","followUps":["string"],"verificationStatus":"not_applicable|passed|failed"}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Current local date context:\n${buildDateGuard()}`,
      buildOutputLanguageInput(outputLocale),
      `Worker capabilities:\nweb_search=${worker.webSearch ? "enabled" : "disabled"}`,
      `Assigned workflow phase:\n${task.phase || "implementation"}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]"
    ].join("\n\n")
  };
}

function buildLeaderDelegationRequest({
  originalTask,
  clusterPlan,
  leader,
  task,
  dependencyOutputs,
  delegateCount,
  depthRemaining,
  runAgentBudget = null,
  outputLocale = "en-US"
}) {
  return {
    instructions: [
      `You are ${leader.label}, an agent inside a multi-model cluster.`,
      buildDateGuard(),
      buildOutputLanguageInstruction(outputLocale),
      `You may create up to ${delegateCount} child agents for this assignment.`,
      Number(runAgentBudget?.requestedTotalAgents) > 0
        ? `The user explicitly requested ${runAgentBudget.requestedTotalAgents} total agents for the whole cluster run. That number applies to the entire run across all top-level leaders and child agents combined, not to this single parent task.`
        : "Any child-agent budget you see is a local branch allocation inside a larger run-wide budget.",
      "Do not complain that your local child-agent allocation is smaller than the user's global request; use your local allocation as this branch's assigned share of the overall run.",
      `Recursive delegation depth remaining after this decision: ${Math.max(0, Number(depthRemaining) || 0)}.`,
      "Never reinterpret the current date from background knowledge. Use only the authoritative runtime clock below when judging whether a date is historical or future.",
      "You may also choose 0 child agents if the task is already atomic and should be executed directly.",
      "When child-agent budget is available and the task is not obviously atomic, prefer delegating to child agents instead of executing everything yourself.",
      "If you delegate, child tasks must be narrower, non-overlapping, and independently executable whenever possible.",
      "If one child really must consume another child's artifact or findings, declare that explicitly with dependsOn. Do not leave that dependency implicit.",
      "For coding or workspace tasks, avoid assigning overlapping file edits to different child agents.",
      "For research tasks, split by source bucket, case batch, or question cluster to reduce duplicated browsing.",
      "Do not make sibling child agents depend on another sibling's not-yet-written workspace file. Have siblings return findings to you, and let the parent synthesize any shared artifact.",
      "Only assign a child agent to write a workspace artifact when that child owns a unique file path that is not shared with sibling subtasks.",
      `Child agents inherit this model capability set: web_search=${leader.webSearch ? "enabled" : "disabled"}. Do not design child subtasks that require web search when web_search is disabled.`,
      buildIdentityLock(originalTask),
      buildArtifactGuard(),
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      'Schema: {"thinkingSummary":"string","delegationSummary":"string","delegateCount":0,"subtasks":[{"id":"sub_1","title":"string","instructions":"string","dependsOn":["sub_0"],"expectedOutput":"string"}]}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Current local date context:\n${buildDateGuard()}`,
      buildOutputLanguageInput(outputLocale),
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned agent task:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Delegation budget:\n${formatDelegationBudgetSummary(delegateCount, runAgentBudget)}`
    ].join("\n\n")
  };
}

function buildLeaderSynthesisRequest({
  originalTask,
  clusterPlan,
  leader,
  task,
  dependencyOutputs,
  subordinateResults,
  outputLocale = "en-US"
}) {
  return {
    instructions: [
      `You are ${leader.label}, an agent synthesizing child-agent results.`,
      buildDateGuard(),
      buildOutputLanguageInstruction(outputLocale),
      "Merge the child outputs into one coherent result for the assigned task.",
      "Never state that the actual current date differs from the authoritative runtime clock below.",
      "Resolve overlaps, highlight conflicts, and preserve concrete evidence or file outputs.",
      buildIdentityLock(originalTask),
      buildArtifactGuard(),
      "Do not claim verification passed if child results failed verification or could not prove the requested artifact exists.",
      "If the assigned task expects a concrete file artifact and child agents only produced source material, still return the final structured content, deliverable filename, and any artifact path hints needed for runtime materialization.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      'Schema: {"thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"generatedFiles":["string"],"confidence":"low|medium|high","followUps":["string"],"delegationNotes":["string"],"verificationStatus":"not_applicable|passed|failed"}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Current local date context:\n${buildDateGuard()}`,
      buildOutputLanguageInput(outputLocale),
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned agent task:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Child-agent outputs:\n${JSON.stringify(subordinateResults, null, 2)}`
    ].join("\n\n")
  };
}

function buildSynthesisRequest({ task, plan, executions, outputLocale = "en-US" }) {
  return {
    instructions: [
      "You are the controller synthesizing outputs from a multi-model cluster.",
      buildDateGuard(),
      buildOutputLanguageInstruction(outputLocale),
      "Never override the authoritative runtime clock with model priors or background assumptions.",
      "Produce a final answer for the user that resolves overlaps and highlights disagreements.",
      "If source-backed verification is required and your model supports web search, use it before finalizing claims.",
      "Do not upgrade uncertain or unverified claims into facts.",
      buildIdentityLock(task),
      buildArtifactGuard(),
      "Return JSON only.",
      'Schema: {"finalAnswer":"string","executiveSummary":["string"],"consensus":["string"],"disagreements":["string"],"nextActions":["string"]}'
    ].join(" "),
    input: [
      `Original user objective:\n${task}`,
      `Current local date context:\n${buildDateGuard()}`,
      buildOutputLanguageInput(outputLocale),
      `Plan:\n${JSON.stringify(plan, null, 2)}`,
      `Worker outputs:\n${JSON.stringify(executions, null, 2)}`
    ].join("\n\n")
  };
}

module.exports = { buildPlanningRequest, buildWorkerExecutionRequest, buildLeaderDelegationRequest, buildLeaderSynthesisRequest, buildSynthesisRequest };

},
"/src/workspace/agent-loop.mjs": function(module, exports, __require) {
const { getWorkspaceTree, listWorkspacePath, readWorkspaceFiles, verifyWorkspaceArtifacts, writeWorkspaceFiles } = __require("/src/workspace/fs.mjs");
const { buildDocxFallbackContent, getArtifactTitleFromPath, inferRequestedArtifact } = __require("/src/workspace/artifact-fallback.mjs");
const { runWorkspaceCommand } = __require("/src/workspace/commands.mjs");
const { WORKSPACE_ACTIONS, buildWorkspaceToolSchemaLines, canonicalizeWorkspaceActionPayload, normalizeWorkspaceArtifactReferences, normalizeToolAction, normalizeWorkspaceFinalResult, validateWorkspaceActionPayload } = __require("/src/workspace/action-protocol.mjs");
const { deriveTaskRequirements } = __require("/src/workspace/task-requirements.mjs");
const { WorkspaceCommandScopeError, assertWorkspaceCommandAllowedForScope } = __require("/src/workspace/command-policy.mjs");
const { parseJsonFromText } = __require("/src/utils/json-output.mjs");
const { throwIfAborted } = __require("/src/utils/abort.mjs");
const { renderRuntimeCalendarNote } = __require("/src/utils/runtime-context.mjs");
const DEFAULT_MAX_TOOL_TURNS = 8;
const MAX_TOOL_TURNS_BY_PHASE = Object.freeze({
  research: 6,
  implementation: 8,
  validation: 6,
  handoff: 4
});
const MAX_WEB_SEARCH_CALLS_BY_PHASE = Object.freeze({
  research: 6,
  implementation: 2,
  validation: 4,
  handoff: 1
});
const MAX_BLOCKED_TOOL_ATTEMPTS = 2;

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean).map((item) => String(item))));
}

function renderWorkspaceTree(lines) {
  return lines.length ? lines.join("\n") : "(workspace is empty)";
}

function renderToolHistory(history) {
  if (!history.length) {
    return "[]";
  }

  return JSON.stringify(history, null, 2);
}

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function resolveMaxToolTurns(phase) {
  const normalized = String(phase || "").trim().toLowerCase();
  return MAX_TOOL_TURNS_BY_PHASE[normalized] ?? DEFAULT_MAX_TOOL_TURNS;
}

function resolveMaxWebSearchCalls(phase) {
  const normalized = String(phase || "").trim().toLowerCase();
  return MAX_WEB_SEARCH_CALLS_BY_PHASE[normalized] ?? 0;
}

function buildRuntimeWorkerIdentity(worker) {
  return {
    agentId: worker.runtimeId || worker.id,
    agentLabel: worker.displayLabel || worker.label || worker.id,
    agentKind: worker.agentKind || "leader",
    parentAgentId: worker.parentAgentId || "",
    parentAgentLabel: worker.parentAgentLabel || "",
    modelId: worker.id,
    modelLabel: worker.label || worker.id
  };
}

function renderSessionMemorySnapshot(entries) {
  const normalized = Array.isArray(entries) ? entries.slice(0, 6) : [];
  if (!normalized.length) {
    return "[]";
  }

  return JSON.stringify(
    normalized.map((entry) => ({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      createdAt: entry.createdAt,
      agentLabel: entry.agentLabel,
      taskTitle: entry.taskTitle
    })),
    null,
    2
  );
}

function collectDependencyArtifactFocus(dependencyOutputs, workspaceRoot) {
  if (!Array.isArray(dependencyOutputs) || !dependencyOutputs.length) {
    return [];
  }

  return Array.from(
    new Set(
      dependencyOutputs.flatMap((item) => {
        const output = item?.output && typeof item.output === "object" ? item.output : {};
        const artifactTask = {
          title: item?.title || "",
          instructions: "",
          expectedOutput: Array.isArray(output?.deliverables) ? output.deliverables.join("\n") : ""
        };
        const inferredArtifact = deriveTaskRequirements(artifactTask).requiresConcreteArtifact
          ? inferRequestedArtifact(
            artifactTask,
            output,
            workspaceRoot || ".",
            output?.summary || ""
          )
          : "";
        return [
          ...(Array.isArray(output.verifiedGeneratedFiles) ? output.verifiedGeneratedFiles : []),
          ...(Array.isArray(output.generatedFiles) ? output.generatedFiles : []),
          inferredArtifact
        ]
          .map((path) => String(path || "").trim())
          .filter(Boolean);
      })
    )
  );
}

function buildWorkspaceWorkerPrompt({
  originalTask,
  clusterPlan,
  worker,
  task,
  taskRequirements,
  dependencyOutputs,
  workspaceRoot,
  workspaceTreeLines,
  toolHistory,
  sessionMemory
}) {
  const toolSchemaLines = buildWorkspaceToolSchemaLines({
    webSearchAvailable: worker.webSearch,
    workspaceWriteAvailable: taskRequirements.allowsWorkspaceWrite,
    workspaceCommandAvailable: taskRequirements.allowsWorkspaceCommand,
    workspaceCommandScopeDescription: taskRequirements.workspaceCommandScopeDescription
  });
  const dateContext = renderRuntimeCalendarNote();
  const dependencyArtifacts = collectDependencyArtifactFocus(dependencyOutputs, workspaceRoot);

  return {
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      "You can directly inspect and modify files inside the configured workspace root, and you can read/write session memory for the current run.",
      `Web search is ${worker.webSearch ? "available" : "not available"} for this model.`,
      `Workspace writes are ${taskRequirements.allowsWorkspaceWrite ? "available" : "not available"} for this task.`,
      `Workspace commands are ${taskRequirements.allowsWorkspaceCommand ? `available with scope: ${taskRequirements.workspaceCommandScopeDescription}` : "not available"} for this task.`,
      dateContext,
      "The runtime clock above is authoritative. Never claim the current actual date is anything else.",
      "Stay scoped to the assigned task, and read files before editing existing code when needed.",
      "If current public facts or source verification are required and web search is available, use it before finalizing claims.",
      "If web search is not available for this model, do not attempt web_search and do not claim live verification.",
      "If workspace writes are not available for this task, do not attempt write_files or write_docx.",
      "If workspace commands are not available for this task, do not attempt run_command.",
      "If workspace commands are available, stay within the allowed command scope and prefer the least-privileged command that solves the task.",
      "For search-heavy research, prefer a smaller fully verified batch over a larger unverified list.",
      "If a tool call is blocked by policy, adapt immediately with the remaining allowed tools or finalize with the limitation; do not repeat the same blocked tool request.",
      "Keep validation tasks tightly bounded. Once you have enough evidence to pass/fail the task, stop calling tools and return final.",
      "If the task expects a concrete file artifact, do not return final before the artifact has actually been written into the workspace.",
      "If the task expects a .docx report, prefer write_docx. The runtime will materialize a real Word document instead of raw text bytes.",
      "If the task expects another concrete binary artifact such as .pptx, .xlsx, or .pdf, you may either write base64 content with write_files or generate the file through safe workspace commands.",
      "Return exactly one workspace action object per response. Do not return an array of actions, a batched action list, or prose plus multiple actions.",
      "Never invent sources, URLs, examples, or case studies.",
      "Never reference or request paths outside the workspace root.",
      "When dependency outputs already list generated or verified files, focus implementation, validation, and review work on those files first.",
      "When dependency artifact focus is non-empty and the expected artifact is missing, do not inspect unrelated pre-existing workspace files just to fill the gap. Report the missing artifact directly.",
      "Ignore unrelated pre-existing workspace files unless the assigned task explicitly requires a broader repository or workspace audit.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      ...toolSchemaLines
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Current local date context:\n${dateContext}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      `Task execution policy:\n${JSON.stringify(taskRequirements, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      dependencyArtifacts.length
        ? `Dependency artifact focus:\n${JSON.stringify(dependencyArtifacts, null, 2)}`
        : "Dependency artifact focus:\n[]",
      `Session memory snapshot:\n${renderSessionMemorySnapshot(sessionMemory)}`,
      `Workspace root:\n${workspaceRoot}`,
      `Workspace tree snapshot:\n${renderWorkspaceTree(workspaceTreeLines)}`,
      `Tool history:\n${renderToolHistory(toolHistory)}`
    ].join("\n\n")
  };
}

function createToolError(message, rawText) {
  return {
    thinkingSummary: "",
    summary: `Workspace tool loop failed: ${message}`,
    keyFindings: rawText ? [rawText.slice(0, 2000)] : [],
    risks: [message],
    deliverables: [],
    confidence: "low",
    followUps: ["Adjust the task or simplify the requested file changes."],
    generatedFiles: [],
    verifiedGeneratedFiles: [],
    workspaceActions: [],
    toolUsage: [],
    memoryReads: 0,
    memoryWrites: 0,
    verificationStatus: "failed",
    executedCommands: []
  };
}

async function requestWorkspaceJsonRepair({
  provider,
  invokeModel,
  worker,
  task,
  taskRequirements,
  rawText,
  onRetry,
  onEvent,
  signal
}) {
  const toolSchemaLines = buildWorkspaceToolSchemaLines({
    webSearchAvailable: worker.webSearch,
    workspaceWriteAvailable: taskRequirements?.allowsWorkspaceWrite,
    workspaceCommandAvailable: taskRequirements?.allowsWorkspaceCommand,
    workspaceCommandScopeDescription: taskRequirements?.workspaceCommandScopeDescription
  });

  const response = await invokeModel({
    provider,
    worker,
    task,
    purpose: "worker_json_repair",
    instructions: [
      "You repair invalid JSON emitted by a workspace agent.",
      "Return valid JSON only.",
      "Preserve the original intent, action, paths, command arguments, and final result content whenever recoverable.",
      "Do not invent new files, commands, sources, or claims.",
      `Workspace writes are ${taskRequirements?.allowsWorkspaceWrite ? "available" : "not available"} for this task.`,
      `Workspace commands are ${taskRequirements?.allowsWorkspaceCommand ? `available with scope: ${taskRequirements.workspaceCommandScopeDescription}` : "not available"} for this task.`,
      "Do not repair the payload into a tool action that is unavailable for this task.",
      "If the payload cannot be safely recovered, return a final action with verificationStatus set to failed and explain the issue briefly.",
      ...toolSchemaLines
    ].join(" "),
    input: [
      "Repair the following invalid workspace-agent output into valid JSON.",
      `Original output:\n${rawText}`
    ].join("\n\n"),
    onRetry,
    signal
  });

  const repaired = parseJsonFromText(response.text);

  if (typeof onEvent === "function") {
    onEvent({
      type: "status",
      stage: "workspace_json_repair",
      tone: "neutral",
      ...buildRuntimeWorkerIdentity(worker),
      taskId: task.id,
      taskTitle: task.title,
      detail: "Detected an invalid workspace JSON response and repaired it automatically."
    });
  }

  return repaired;
}

function normalizeWorkspaceSearchResult(parsed, rawText) {
  return {
    summary: String(parsed?.summary || rawText || "No search summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    sources: uniqueStrings(safeArray(parsed?.sources)),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    rawText: String(rawText || "")
  };
}

async function executeWorkspaceWebSearch({
  provider,
  invokeModel,
  worker,
  task,
  originalTask,
  query,
  domains,
  recencyDays,
  reason,
  onRetry,
  signal,
  parentSpanId = ""
}) {
  const dateContext = renderRuntimeCalendarNote();
  const response = await invokeModel({
    provider,
    worker,
    task,
    parentSpanId,
    purpose: "worker_web_search",
    instructions: [
      `You are ${worker.label}, a web-search-enabled research assistant inside a multi-model cluster.`,
      dateContext,
      "The runtime clock above is authoritative. Do not claim the current actual date is anything else.",
      "Use native web search for this request.",
      "Return JSON only.",
      "Ground the answer in searched public sources and do not invent URLs, dates, or verification claims.",
      'Schema: {"summary":"string","keyFindings":["string"],"sources":["string"],"confidence":"low|medium|high"}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Assigned task:\n${JSON.stringify(task, null, 2)}`,
      `Search query:\n${query}`,
      `Search reason:\n${reason || "The workspace worker requested live web verification."}`,
      domains.length ? `Preferred domains:\n${domains.join(", ")}` : "Preferred domains:\n[]",
      recencyDays > 0 ? `Preferred recency window (days):\n${recencyDays}` : "Preferred recency window (days):\nnone"
    ].join("\n\n"),
    onRetry,
    signal
  });

  let parsed;
  try {
    parsed = parseJsonFromText(response.text);
  } catch {
    parsed = {
      summary: response.text,
      keyFindings: [],
      sources: []
    };
  }

  return normalizeWorkspaceSearchResult(parsed, response.text);
}

function createForcedFinalPayload(reason) {
  const summary = String(reason || "Workspace tool execution stopped before the worker returned a final result.");
  return {
    action: WORKSPACE_ACTIONS.FINAL,
    thinkingSummary: "",
    summary,
    keyFindings: [],
    risks: [summary],
    deliverables: [],
    confidence: "low",
    followUps: ["Use the available tool results to conclude with a narrower or better-bounded task."],
    generatedFiles: [],
    verificationStatus: "failed",
    toolUsage: [],
    memoryReads: 0,
    memoryWrites: 0
  };
}

async function requestForcedWorkspaceFinalResult({
  provider,
  invokeModel,
  worker,
  task,
  originalTask,
  clusterPlan,
  dependencyOutputs,
  workspaceRoot,
  toolHistory,
  sessionRuntime,
  reason,
  lastRawText,
  onRetry,
  signal
}) {
  const workspaceTree = await getWorkspaceTree(workspaceRoot);
  const response = await invokeModel({
    provider,
    worker,
    task,
    purpose: "worker_forced_final",
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      renderRuntimeCalendarNote(),
      "The runtime clock above is authoritative. Never claim the current actual date is anything else.",
      "Tool execution has been stopped for this task. No further tool calls are allowed.",
      "Return exactly one final workspace action object.",
      "Base the conclusion only on dependency outputs, current workspace state, tool history, and session memory already available.",
      "If evidence is incomplete, say so plainly and set verificationStatus to failed.",
      "Do not invent sources, files, URLs, commands, or verification claims.",
      "Return JSON only.",
      'Final schema: {"action":"final","thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"confidence":"low|medium|high","followUps":["string"],"generatedFiles":["relative/path"],"verificationStatus":"not_applicable|passed|failed","toolUsage":["string"],"memoryReads":0,"memoryWrites":0}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Session memory snapshot:\n${renderSessionMemorySnapshot(sessionRuntime?.buildSnapshot?.().memory?.recent || [])}`,
      `Workspace root:\n${workspaceRoot}`,
      `Workspace tree snapshot:\n${renderWorkspaceTree(workspaceTree.lines)}`,
      `Tool history:\n${renderToolHistory(toolHistory)}`,
      `Forced-final reason:\n${reason}`,
      lastRawText ? `Last raw worker output:\n${lastRawText}` : "Last raw worker output:\n(none)"
    ].join("\n\n"),
    onRetry,
    signal
  });

  let parsed = null;
  try {
    parsed = parseJsonFromText(response.text);
  } catch {
    parsed = null;
  }

  if (normalizeToolAction(parsed) !== WORKSPACE_ACTIONS.FINAL) {
    return {
      parsed: createForcedFinalPayload(reason),
      rawText: response.text
    };
  }

  return {
    parsed,
    rawText: response.text
  };
}

async function parseWorkspaceActionPayload({
  provider,
  invokeModel,
  worker,
  task,
  taskRequirements,
  rawText,
  onRetry,
  onEvent,
  signal
}) {
  let parsed;
  let parseError = null;
  try {
    parsed = parseJsonFromText(rawText);
  } catch (error) {
    parseError = error;
    try {
      parsed = await requestWorkspaceJsonRepair({
        provider,
        invokeModel,
        worker,
        task,
        taskRequirements,
        rawText,
        onRetry,
        onEvent,
        signal
      });
    } catch {
      throw error;
    }
  }

  const tryValidate = (candidate) => {
    const canonicalCandidate = canonicalizeWorkspaceActionPayload(candidate);
    const candidateAction = normalizeToolAction(canonicalCandidate);
    if (!candidateAction) {
      const rawAction =
        candidate?.action ??
        candidate?.toolAction ??
        candidate?.tool ??
        candidate?.name ??
        candidate?.type ??
        "";
      throw new Error(
        `Worker returned an unsupported workspace action${rawAction ? ` "${rawAction}"` : ""}.`
      );
    }
    validateWorkspaceActionPayload(canonicalCandidate, candidateAction);
    return {
      parsed: canonicalCandidate,
      action: candidateAction
    };
  };

  try {
    return tryValidate(parsed);
  } catch (error) {
    if (parseError && !parsed) {
      throw parseError;
    }
  }

  parsed = await requestWorkspaceJsonRepair({
    provider,
    invokeModel,
    worker,
    task,
    taskRequirements,
    rawText,
    onRetry,
    onEvent,
    signal
  });

  return tryValidate(parsed);
}

async function runWorkspaceToolLoop({
  provider,
  invokeModel,
  worker,
  task,
  originalTask,
  clusterPlan,
  dependencyOutputs,
  workspaceRoot,
  sessionRuntime = null,
  parentSpanId = "",
  onRetry,
  onEvent,
  signal
}) {
  const taskRequirements = deriveTaskRequirements(task);
  throwIfAborted(signal);
  const workspaceTree = await getWorkspaceTree(workspaceRoot);
  const toolHistory = [];
  const generatedFiles = [];
  const toolCounters = {
    memoryReads: 0,
    memoryWrites: 0
  };
  let lastRawText = "";
  let blockedToolAttempts = 0;
  let webSearchCount = 0;
  let forcedFinalReason = "";
  const maxToolTurns = resolveMaxToolTurns(taskRequirements.phase);
  const maxWebSearchCalls = resolveMaxWebSearchCalls(taskRequirements.phase);
  const invokeWorkerModel =
    typeof invokeModel === "function"
      ? invokeModel
      : async ({ provider: activeProvider, instructions, input, purpose, onRetry: activeOnRetry, signal: activeSignal }) =>
          activeProvider.invoke({
            instructions,
            input,
            purpose,
            onRetry: activeOnRetry,
            signal: activeSignal
          });

  async function maybeAutoMaterializeDocxArtifact(parsed) {
    if (!taskRequirements.requiresConcreteArtifact || !taskRequirements.allowsWorkspaceWrite) {
      return [];
    }

    const artifactPath = inferRequestedArtifact(task, parsed, workspaceRoot, originalTask);
    if (!/\.docx$/i.test(String(artifactPath || ""))) {
      return [];
    }

    const content = buildDocxFallbackContent({
      task,
      parsed,
      dependencyOutputs,
      originalTask
    });
    if (String(content || "").trim().length < 24) {
      return [];
    }

    const result = await writeWorkspaceFiles(workspaceRoot, [
      {
        path: artifactPath,
        title: getArtifactTitleFromPath(artifactPath),
        content,
        encoding: "utf8"
      }
    ]);
    generatedFiles.push(...result.map((entry) => entry.path));
    toolHistory.push({
      action: WORKSPACE_ACTIONS.WRITE_DOCX,
      autoMaterialized: true,
      request: {
        path: artifactPath,
        reason: "Runtime auto-materialized the requested .docx artifact from structured task outputs."
      },
      result
    });
    if (typeof onEvent === "function") {
      onEvent({
        type: "status",
        stage: "workspace_write",
        tone: "ok",
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        generatedFiles: result.map((entry) => entry.path),
        detail: `Auto-materialized Word document: ${artifactPath}`
      });
    }
    return result.map((entry) => entry.path);
  }

  async function finalizeWorkspaceResult(parsed, rawText) {
    if (!generatedFiles.length) {
      await maybeAutoMaterializeDocxArtifact(parsed);
    }
    const reportedGeneratedFiles = normalizeWorkspaceArtifactReferences([
      ...generatedFiles,
      ...safeArray(parsed?.generatedFiles)
    ]);
    const verification = await verifyWorkspaceArtifacts(workspaceRoot, reportedGeneratedFiles, {
      maxFiles: 12
    });
    const verifiedGeneratedFiles = verification
      .filter((entry) => entry.verified)
      .map((entry) => entry.path);
    const failedVerification = verification.filter((entry) => !entry.verified);
    const normalizedResult = normalizeWorkspaceFinalResult(
      parsed,
      rawText,
      reportedGeneratedFiles,
      verifiedGeneratedFiles,
      toolHistory,
      toolCounters
    );

    if (failedVerification.length) {
      normalizedResult.risks = uniqueStrings([
        ...normalizedResult.risks,
        ...failedVerification.map(
          (entry) => `Generated artifact "${entry.path}" could not be verified: ${entry.error}`
        )
      ]);
      if (normalizedResult.verificationStatus === "passed") {
        normalizedResult.verificationStatus = "failed";
      }
    }

    if (normalizedResult.verifiedGeneratedFiles.length && taskRequirements.requiresConcreteArtifact) {
      normalizedResult.keyFindings = uniqueStrings([
        ...normalizedResult.keyFindings,
        "The requested workspace artifact was materialized and verified."
      ]);
      normalizedResult.verificationStatus = "passed";
    }

    return normalizedResult;
  }

  function registerBlockedTool(action, request, message, extras = {}) {
    toolHistory.push({
      action,
      blocked: true,
      request,
      result: {
        blocked: true,
        message,
        ...extras
      }
    });
    if (typeof onEvent === "function") {
      onEvent({
        type: "status",
        stage: "workspace_tool_blocked",
        tone: "warning",
        toolAction: action,
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        detail: message,
        ...extras
      });
    }
    blockedToolAttempts += 1;
    return blockedToolAttempts >= MAX_BLOCKED_TOOL_ATTEMPTS;
  }

  for (let turn = 0; turn < maxToolTurns; turn += 1) {
    throwIfAborted(signal);
    const prompt = buildWorkspaceWorkerPrompt({
      originalTask,
      clusterPlan,
      worker,
      task,
      taskRequirements,
      dependencyOutputs,
      workspaceRoot,
      workspaceTreeLines: workspaceTree.lines,
      toolHistory,
      sessionMemory: sessionRuntime?.buildSnapshot?.().memory?.recent || []
    });

    const response = await invokeWorkerModel({
      provider,
      worker,
      task,
      purpose: "worker_execution",
      instructions: prompt.instructions,
      input: prompt.input,
      onRetry,
      signal,
      parentSpanId
    });

    lastRawText = response.text;
    let parsed;
    let action = "";
    try {
      const result = await parseWorkspaceActionPayload({
        provider,
        invokeModel: invokeWorkerModel,
        worker,
        task,
        taskRequirements,
        rawText: response.text,
        onRetry,
        onEvent,
        signal
      });
      parsed = result.parsed;
      action = result.action;
    } catch (error) {
      return createToolError(error.message, response.text);
    }

    if (!action) {
      return createToolError("Worker returned an unsupported workspace action.", response.text);
    }

    if (action === WORKSPACE_ACTIONS.FINAL) {
      return finalizeWorkspaceResult(parsed, response.text);
    }

    if (action === WORKSPACE_ACTIONS.LIST_FILES) {
      throwIfAborted(signal);
      const targetPath = String(parsed?.path || ".").trim() || ".";
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "list_files",
        spanLabel: `list_files · ${targetPath}`
      });
      const result = await listWorkspacePath(workspaceRoot, targetPath);
      toolHistory.push({
        action,
        request: {
          path: targetPath,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Listed workspace path: ${targetPath}`,
          resultCount: Array.isArray(result) ? result.length : 0
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_list",
          tone: "neutral",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: `Listed workspace path: ${targetPath}`
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.READ_FILES) {
      throwIfAborted(signal);
      const paths = safeArray(parsed?.paths).slice(0, 6);
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "read_files",
        spanLabel: `read_files · ${paths.length} file(s)`
      });
      const result = await readWorkspaceFiles(workspaceRoot, paths);
      toolHistory.push({
        action,
        request: {
          paths,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Read ${paths.length} workspace file(s).`,
          resultCount: result.length
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_read",
          tone: "neutral",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: `Read ${paths.length} workspace file(s).`
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.WRITE_FILES) {
      throwIfAborted(signal);
      const files = Array.isArray(parsed?.files) ? parsed.files : [];
      if (!taskRequirements.allowsWorkspaceWrite) {
        if (
          registerBlockedTool(
            action,
            {
              files: files.map((file) => ({ path: String(file?.path || "") })),
              reason: String(parsed?.reason || "")
            },
            "Blocked write_files because workspace writes are out of scope for this task."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace write attempts were blocked repeatedly for this task.";
          break;
        }
        continue;
      }
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "write_files",
        spanLabel: `write_files · ${files.length} file(s)`
      });
      const result = await writeWorkspaceFiles(workspaceRoot, files);
      generatedFiles.push(...result.map((entry) => entry.path));
      toolHistory.push({
        action,
        request: {
          files: files.map((file) => ({
            path: String(file?.path || ""),
            encoding: String(file?.encoding || "utf8").trim().toLowerCase() || "utf8"
          })),
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Wrote ${result.length} workspace file(s).`,
          resultCount: result.length
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_write",
          tone: "ok",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          generatedFiles: result.map((entry) => entry.path),
          detail: `Wrote ${result.length} workspace file(s).`
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.WRITE_DOCX) {
      throwIfAborted(signal);
      if (!taskRequirements.allowsWorkspaceWrite) {
        if (
          registerBlockedTool(
            action,
            {
              path: String(parsed?.path || ""),
              reason: String(parsed?.reason || "")
            },
            "Blocked write_docx because workspace writes are out of scope for this task."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace document writes were blocked repeatedly for this task.";
          break;
        }
        continue;
      }

      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "write_docx",
        spanLabel: `write_docx 路 ${String(parsed?.path || "")}`
      });
      const result = await writeWorkspaceFiles(workspaceRoot, [
        {
          path: String(parsed?.path || ""),
          title: String(parsed?.title || ""),
          content: String(parsed?.content || ""),
          encoding: "utf8"
        }
      ]);
      generatedFiles.push(...result.map((entry) => entry.path));
      toolHistory.push({
        action,
        request: {
          path: String(parsed?.path || ""),
          title: String(parsed?.title || ""),
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Wrote Word document: ${String(parsed?.path || "")}`,
          resultCount: result.length
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_write",
          tone: "ok",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          generatedFiles: result.map((entry) => entry.path),
          detail: `Wrote Word document: ${String(parsed?.path || "")}`
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.WEB_SEARCH) {
      throwIfAborted(signal);
      const query = String(parsed?.query || "").trim();
      const domains = safeArray(parsed?.domains).slice(0, 6);
      const recencyDays = normalizeInteger(parsed?.recencyDays, 0);
      if (!worker.webSearch) {
        if (
          registerBlockedTool(
            action,
            {
              query,
              domains,
              recencyDays,
              reason: String(parsed?.reason || "")
            },
            "Blocked web_search because web search is not enabled for this model."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Web search was requested repeatedly on a model without web-search support.";
          break;
        }
        continue;
      }
      if (maxWebSearchCalls > 0 && webSearchCount >= maxWebSearchCalls) {
        registerBlockedTool(
          action,
          {
            query,
            domains,
            recencyDays,
            reason: String(parsed?.reason || "")
          },
          `Blocked web_search because this ${taskRequirements.phase} task already used its ${maxWebSearchCalls}-search budget.`,
          {
            searchBudget: maxWebSearchCalls
          }
        );
        forcedFinalReason =
          forcedFinalReason ||
          `Reached the ${maxWebSearchCalls}-search budget for this ${taskRequirements.phase} task; finalize with the evidence already collected.`;
        break;
      }
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: WORKSPACE_ACTIONS.WEB_SEARCH,
        spanLabel: `web_search - ${query.slice(0, 80)}`
      });
      const result = await executeWorkspaceWebSearch({
        provider,
        invokeModel: invokeWorkerModel,
        worker,
        task,
        originalTask,
        query,
        domains,
        recencyDays,
        reason: String(parsed?.reason || ""),
        onRetry,
        signal,
        parentSpanId: toolSpanId || parentSpanId
      });
      webSearchCount += 1;
      toolHistory.push({
        action,
        request: {
          query,
          domains,
          recencyDays,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `Web searched: ${query}`,
          resultCount: result.sources.length
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_web_search",
          tone: "ok",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: query,
          sourceCount: result.sources.length
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.RUN_COMMAND) {
      throwIfAborted(signal);
      const command = String(parsed?.command || "");
      const args = Array.isArray(parsed?.args) ? parsed.args : [];
      const cwd = String(parsed?.cwd || ".").trim() || ".";
      if (!taskRequirements.allowsWorkspaceCommand) {
        if (
          registerBlockedTool(
            action,
            {
              command,
              args: args.map((item) => String(item)),
              cwd,
              reason: String(parsed?.reason || "")
            },
            "Blocked run_command because workspace commands are out of scope for this task."
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace command attempts were blocked repeatedly for this task.";
          break;
        }
        continue;
      }
      try {
        assertWorkspaceCommandAllowedForScope(
          command,
          args,
          taskRequirements.workspaceCommandScope
        );
      } catch (error) {
        if (!(error instanceof WorkspaceCommandScopeError)) {
          throw error;
        }
        if (
          registerBlockedTool(
            action,
            {
              command,
              args: args.map((item) => String(item)),
              cwd,
              reason: String(parsed?.reason || "")
            },
            error.message,
            {
              allowedScope: error.allowedScope,
              requiredScope: error.requiredScope
            }
          )
        ) {
          forcedFinalReason =
            forcedFinalReason || "Workspace command scope mismatches kept recurring; finalize with the available inspection evidence.";
          break;
        }
        continue;
      }
      const toolSpanId = sessionRuntime?.beginToolCall?.({
        ...buildRuntimeWorkerIdentity(worker),
        taskId: task.id,
        taskTitle: task.title,
        parentSpanId,
        spanKind: "tool",
        toolAction: "run_command",
        spanLabel: `run_command · ${command}`
      });
      let result;
      try {
        result = await runWorkspaceCommand(workspaceRoot, command, args, {
          cwd,
          signal
        });
      } catch (error) {
        const message = String(error?.message || error || "Workspace command failed.");
        const blockedByPolicy =
          /not allowed inside the workspace command tool|contains blocked arguments|Only read-only git commands are allowed|node eval arguments are blocked|must use -File|Only workspace script files can be executed|Only \.cmd or \.bat workspace scripts can be executed/i.test(
            message
          );
        toolHistory.push({
          action,
          blocked: blockedByPolicy,
          request: {
            command,
            args: args.map((item) => String(item)),
            cwd,
            reason: String(parsed?.reason || "")
          },
          result: {
            blocked: blockedByPolicy,
            message
          }
        });
        if (toolSpanId) {
          sessionRuntime.completeToolCall(toolSpanId, {
            detail: message,
            exitCode: -1
          });
        }
        if (typeof onEvent === "function") {
          onEvent({
            type: "status",
            stage: blockedByPolicy ? "workspace_tool_blocked" : "workspace_command",
            tone: "warning",
            toolAction: WORKSPACE_ACTIONS.RUN_COMMAND,
            ...buildRuntimeWorkerIdentity(worker),
            taskId: task.id,
            taskTitle: task.title,
            detail: message,
            exitCode: -1
          });
        }
        if (blockedByPolicy) {
          blockedToolAttempts += 1;
          if (blockedToolAttempts >= MAX_BLOCKED_TOOL_ATTEMPTS) {
            forcedFinalReason =
              forcedFinalReason || `Workspace command attempts were blocked repeatedly. ${message}`;
            break;
          }
        }
        continue;
      }
      toolHistory.push({
        action,
        request: {
          command,
          args: args.map((item) => String(item)),
          cwd,
          reason: String(parsed?.reason || "")
        },
        result
      });
      if (toolSpanId) {
        sessionRuntime.completeToolCall(toolSpanId, {
          detail: `${result.command} ${(result.args || []).join(" ").trim()}`.trim(),
          exitCode: result.exitCode
        });
      }
      if (typeof onEvent === "function") {
        onEvent({
          type: "status",
          stage: "workspace_command",
          tone: result.success ? "ok" : "warning",
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          detail: `${result.command} ${(result.args || []).join(" ").trim()}`.trim(),
          exitCode: result.exitCode
        });
      }
      continue;
    }

    if (action === WORKSPACE_ACTIONS.RECALL_MEMORY) {
      throwIfAborted(signal);
      const query = String(parsed?.query || "").trim();
      const tags = safeArray(parsed?.tags);
      const limit = normalizeInteger(parsed?.limit, 3) || 3;
      const result = sessionRuntime?.recall?.(
        {
          query,
          tags,
          limit
        },
        {
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          parentSpanId
        }
      ) || [];
      toolCounters.memoryReads += 1;
      toolHistory.push({
        action,
        request: {
          query,
          tags,
          limit,
          reason: String(parsed?.reason || "")
        },
        result
      });
      continue;
    }

    if (action === WORKSPACE_ACTIONS.REMEMBER) {
      throwIfAborted(signal);
      const title = String(parsed?.title || "").trim() || task.title;
      const content = String(parsed?.content || "").trim();
      const tags = safeArray(parsed?.tags);
      const result = sessionRuntime?.remember?.(
        {
          title,
          content,
          tags
        },
        {
          ...buildRuntimeWorkerIdentity(worker),
          taskId: task.id,
          taskTitle: task.title,
          parentSpanId
        }
      );
      toolCounters.memoryWrites += 1;
      toolHistory.push({
        action,
        request: {
          title,
          tags,
          reason: String(parsed?.reason || "")
        },
        result
      });
      continue;
    }
  }

  try {
    const reason =
      forcedFinalReason ||
      `Worker reached the ${maxToolTurns}-turn workspace tool budget without returning a final result.`;
    const forcedFinal = await requestForcedWorkspaceFinalResult({
      provider,
      invokeModel: invokeWorkerModel,
      worker,
      task,
      originalTask,
      clusterPlan,
      dependencyOutputs,
      workspaceRoot,
      toolHistory,
      sessionRuntime,
      reason,
      lastRawText,
      onRetry,
      signal
    });
    return finalizeWorkspaceResult(forcedFinal.parsed, forcedFinal.rawText);
  } catch (error) {
    return createToolError(
      forcedFinalReason || "Worker exceeded the maximum workspace tool turns.",
      lastRawText || String(error?.message || "")
    );
  }
}

module.exports = { runWorkspaceToolLoop };

},
"/src/session/runtime.mjs": function(module, exports, __require) {
const DEFAULT_MAX_MEMORY_ENTRIES = 96;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

function safeString(value) {
  return String(value || "").trim();
}

function normalizeRuntimeLocale(value) {
  return safeString(value) === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeRuntimeText(locale, englishText, chineseText) {
  return normalizeRuntimeLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function uniqueStrings(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function compactText(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildModelLabel(modelConfig) {
  return safeString(modelConfig?.label || modelConfig?.id || "model");
}

function normalizeUsage(raw) {
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {};
  const inputTokens = normalizeInteger(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens
  );
  const outputTokens = normalizeInteger(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens
  );
  const explicitTotalTokens = normalizeInteger(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = explicitTotalTokens || inputTokens + outputTokens;
  const hasUsage =
    Object.keys(usage).length > 0 || inputTokens > 0 || outputTokens > 0 || totalTokens > 0;

  if (!hasUsage) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function normalizePricing(modelConfig) {
  const pricing = modelConfig?.pricing;
  if (!pricing || typeof pricing !== "object") {
    return null;
  }

  let inputPer1kUsd = normalizeNumber(
    pricing.inputPer1kUsd ?? pricing.promptPer1kUsd
  );
  let outputPer1kUsd = normalizeNumber(
    pricing.outputPer1kUsd ?? pricing.completionPer1kUsd
  );

  if (!inputPer1kUsd) {
    inputPer1kUsd = normalizeNumber(pricing.inputPer1mUsd ?? pricing.promptPer1mUsd) / 1000;
  }
  if (!outputPer1kUsd) {
    outputPer1kUsd =
      normalizeNumber(pricing.outputPer1mUsd ?? pricing.completionPer1mUsd) / 1000;
  }

  if (inputPer1kUsd <= 0 && outputPer1kUsd <= 0) {
    return null;
  }

  return {
    inputPer1kUsd,
    outputPer1kUsd
  };
}

function estimateCostUsd(usage, pricing) {
  if (!usage || !pricing) {
    return null;
  }

  const inputCost = (usage.inputTokens / 1000) * normalizeNumber(pricing.inputPer1kUsd);
  const outputCost = (usage.outputTokens / 1000) * normalizeNumber(pricing.outputPer1kUsd);
  return roundNumber(inputCost + outputCost, 6);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatCircuitDetail(state) {
  if (state.state === "open" && state.openUntil) {
    return `Circuit open until ${new Date(state.openUntil).toISOString()}.`;
  }
  if (state.state === "half_open") {
    return "Circuit is probing in half-open mode.";
  }
  return "Circuit is closed.";
}

function createSessionRuntime({ emitEvent, locale = "en-US" } = {}) {
  const runLocale = normalizeRuntimeLocale(locale);
  const memoryEntries = [];
  const modelStatsById = new Map();
  const circuitByModelId = new Map();
  const spans = new Map();
  let spanSequence = 0;
  let memorySequence = 0;

  const totals = {
    providerCalls: 0,
    providerFailures: 0,
    retries: 0,
    toolCalls: 0,
    memoryReads: 0,
    memoryWrites: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    pricedCallCount: 0,
    unpricedCallCount: 0
  };

  function publish(payload) {
    if (typeof emitEvent === "function") {
      emitEvent(payload);
    }
  }

  function ensureModelStats(modelConfig) {
    const modelId = safeString(modelConfig?.id);
    if (!modelId) {
      throw new Error("Model config must include an id for session tracking.");
    }

    if (!modelStatsById.has(modelId)) {
      modelStatsById.set(modelId, {
        modelId,
        modelLabel: buildModelLabel(modelConfig),
        provider: safeString(modelConfig?.provider),
        model: safeString(modelConfig?.model),
        providerCalls: 0,
        providerFailures: 0,
        retries: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        pricedCallCount: 0,
        unpricedCallCount: 0
      });
    }

    return modelStatsById.get(modelId);
  }

  function ensureCircuitState(modelConfig) {
    const modelId = safeString(modelConfig?.id);
    if (!modelId) {
      throw new Error("Model config must include an id for circuit tracking.");
    }

    if (!circuitByModelId.has(modelId)) {
      circuitByModelId.set(modelId, {
        modelId,
        modelLabel: buildModelLabel(modelConfig),
        state: "closed",
        consecutiveFailures: 0,
        openUntil: 0,
        lastError: "",
        threshold: Math.max(
          1,
          normalizeInteger(modelConfig?.circuitBreakerThreshold) ||
            DEFAULT_CIRCUIT_FAILURE_THRESHOLD
        ),
        cooldownMs: Math.max(
          1_000,
          normalizeInteger(modelConfig?.circuitBreakerCooldownMs) ||
            DEFAULT_CIRCUIT_COOLDOWN_MS
        )
      });
    }

    return circuitByModelId.get(modelId);
  }

  function buildSnapshot() {
    return {
      totals: {
        ...totals,
        estimatedCostUsd: roundNumber(totals.estimatedCostUsd, 6)
      },
      models: Array.from(modelStatsById.values()).map((entry) => ({
        ...entry,
        estimatedCostUsd: roundNumber(entry.estimatedCostUsd, 6)
      })),
      memory: {
        count: memoryEntries.length,
        recent: memoryEntries.slice(0, 8).map((entry) => ({
          id: entry.id,
          title: entry.title,
          content: entry.content,
          tags: entry.tags,
          createdAt: entry.createdAt,
          agentId: entry.agentId,
          agentLabel: entry.agentLabel,
          taskId: entry.taskId,
          taskTitle: entry.taskTitle
        }))
      },
      circuits: Array.from(circuitByModelId.values()).map((entry) => ({
        modelId: entry.modelId,
        modelLabel: entry.modelLabel,
        state: entry.state,
        consecutiveFailures: entry.consecutiveFailures,
        openUntil: entry.openUntil || 0,
        lastError: entry.lastError || ""
      }))
    };
  }

  function publishSessionUpdate(detail = "") {
    publish({
      type: "session",
      stage: "session_update",
      tone: "neutral",
      detail: safeString(detail),
      session: buildSnapshot()
    });
  }

  function startSpan(meta = {}) {
    const spanId = `trace_${String(++spanSequence).padStart(4, "0")}`;
    const span = {
      spanId,
      parentSpanId: safeString(meta.parentSpanId),
      spanKind: safeString(meta.spanKind || "span") || "span",
      spanLabel: safeString(meta.spanLabel || meta.label || meta.spanKind || "Span") || "Span",
      startedAt: Date.now(),
      agentId: safeString(meta.agentId),
      agentLabel: safeString(meta.agentLabel),
      agentKind: safeString(meta.agentKind),
      taskId: safeString(meta.taskId),
      taskTitle: safeString(meta.taskTitle),
      modelId: safeString(meta.modelId),
      modelLabel: safeString(meta.modelLabel),
      purpose: safeString(meta.purpose),
      toolAction: safeString(meta.toolAction),
      detail: safeString(meta.detail)
    };
    spans.set(spanId, span);

    publish({
      type: "trace",
      stage: "trace_span_start",
      tone: "neutral",
      ...span
    });

    return spanId;
  }

  function endSpan(spanId, payload = {}) {
    const existing = spans.get(spanId) || {
      spanId,
      parentSpanId: safeString(payload.parentSpanId),
      spanKind: safeString(payload.spanKind || "span") || "span",
      spanLabel: safeString(payload.spanLabel || payload.label || "Span") || "Span",
      startedAt: Date.now(),
      agentId: safeString(payload.agentId),
      agentLabel: safeString(payload.agentLabel),
      agentKind: safeString(payload.agentKind),
      taskId: safeString(payload.taskId),
      taskTitle: safeString(payload.taskTitle),
      modelId: safeString(payload.modelId),
      modelLabel: safeString(payload.modelLabel),
      purpose: safeString(payload.purpose),
      toolAction: safeString(payload.toolAction)
    };

    const endedAt = Date.now();
    const durationMs = Math.max(0, endedAt - Number(existing.startedAt || endedAt));
    const event = {
      ...existing,
      stage: "trace_span_end",
      type: "trace",
      tone:
        payload.status === "error"
          ? "error"
          : payload.status === "warning"
            ? "warning"
            : "ok",
      status: safeString(payload.status || "ok") || "ok",
      detail: safeString(payload.detail || existing.detail),
      durationMs,
      usage: payload.usage || null,
      estimatedCostUsd:
        Number.isFinite(Number(payload.estimatedCostUsd))
          ? roundNumber(Number(payload.estimatedCostUsd), 6)
          : null,
      memoryCount: normalizeInteger(payload.memoryCount),
      resultCount: normalizeInteger(payload.resultCount),
      exitCode:
        payload.exitCode === null || payload.exitCode === undefined
          ? null
          : Number(payload.exitCode),
      circuitState: safeString(payload.circuitState)
    };

    spans.set(spanId, {
      ...existing,
      ...event,
      endedAt
    });
    publish(event);
    return event;
  }

  function ensureCircuitClosed(modelConfig, meta = {}) {
    const state = ensureCircuitState(modelConfig);
    const now = Date.now();

    if (state.state === "open" && state.openUntil > now) {
      publish({
        type: "status",
        stage: "circuit_blocked",
        tone: "warning",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        detail: `Circuit for ${buildModelLabel(modelConfig)} is open. Retry after ${new Date(state.openUntil).toLocaleTimeString("zh-CN", { hour12: false })}.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker blocked a provider call.");
      throw new Error(
        `Model "${buildModelLabel(modelConfig)}" is temporarily blocked by the circuit breaker after repeated failures.`
      );
    }

    if (state.state === "open" && state.openUntil <= now) {
      state.state = "half_open";
      publish({
        type: "status",
        stage: "circuit_half_open",
        tone: "warning",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        detail: `Circuit for ${buildModelLabel(modelConfig)} entered half-open probe mode.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker moved to half-open mode.");
    }

    return state;
  }

  function markCircuitSuccess(modelConfig, meta = {}) {
    const state = ensureCircuitState(modelConfig);
    const shouldAnnounce =
      state.state !== "closed" || state.consecutiveFailures > 0 || state.lastError;
    state.state = "closed";
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.lastError = "";

    if (shouldAnnounce) {
      publish({
        type: "status",
        stage: "circuit_closed",
        tone: "ok",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        detail: `Circuit for ${buildModelLabel(modelConfig)} has closed and recovered.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker recovered.");
    }

    return state;
  }

  function markCircuitFailure(modelConfig, error, meta = {}) {
    const state = ensureCircuitState(modelConfig);
    state.lastError = String(error?.message || error || "Unknown failure");
    if (state.state === "half_open") {
      state.consecutiveFailures = state.threshold;
    } else {
      state.consecutiveFailures += 1;
    }

    if (state.consecutiveFailures >= state.threshold) {
      state.state = "open";
      state.openUntil = Date.now() + state.cooldownMs;
      publish({
        type: "status",
        stage: "circuit_opened",
        tone: "error",
        modelId: modelConfig.id,
        modelLabel: buildModelLabel(modelConfig),
        consecutiveFailures: state.consecutiveFailures,
        cooldownMs: state.cooldownMs,
        detail: `Circuit for ${buildModelLabel(modelConfig)} opened after ${state.consecutiveFailures} consecutive failures.`,
        ...meta
      });
      publishSessionUpdate("Circuit breaker opened.");
      return state;
    }

    publishSessionUpdate("Provider failure recorded.");
    return state;
  }

  function beginProviderCall(modelConfig, meta = {}) {
    ensureCircuitClosed(modelConfig, meta);
    const modelStats = ensureModelStats(modelConfig);
    totals.providerCalls += 1;
    modelStats.providerCalls += 1;

    const spanId = startSpan({
      spanKind: "provider_call",
      spanLabel:
        safeString(meta.spanLabel) ||
        `${buildModelLabel(modelConfig)} · ${safeString(meta.purpose || "invoke")}`,
      modelId: modelConfig.id,
      modelLabel: buildModelLabel(modelConfig),
      ...meta
    });
    publishSessionUpdate("Provider call started.");
    return { spanId };
  }

  function completeProviderCall(modelConfig, spanId, raw, meta = {}) {
    const usage = normalizeUsage(raw);
    const pricing = normalizePricing(modelConfig);
    const estimatedCostUsd = estimateCostUsd(usage, pricing);
    const modelStats = ensureModelStats(modelConfig);

    if (usage) {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.totalTokens += usage.totalTokens;
      modelStats.inputTokens += usage.inputTokens;
      modelStats.outputTokens += usage.outputTokens;
      modelStats.totalTokens += usage.totalTokens;
    }

    if (estimatedCostUsd !== null) {
      totals.estimatedCostUsd += estimatedCostUsd;
      totals.pricedCallCount += 1;
      modelStats.estimatedCostUsd += estimatedCostUsd;
      modelStats.pricedCallCount += 1;
    } else {
      totals.unpricedCallCount += 1;
      modelStats.unpricedCallCount += 1;
    }

    const circuitState = markCircuitSuccess(modelConfig, meta).state;
    const event = endSpan(spanId, {
      status: "ok",
      detail:
        safeString(meta.detail) ||
        `Provider call completed for ${buildModelLabel(modelConfig)}.`,
      usage,
      estimatedCostUsd,
      circuitState
    });
    publishSessionUpdate("Provider call completed.");
    return {
      usage,
      estimatedCostUsd,
      event
    };
  }

  function failProviderCall(modelConfig, spanId, error, meta = {}) {
    totals.providerFailures += 1;
    const modelStats = ensureModelStats(modelConfig);
    modelStats.providerFailures += 1;
    const circuitState = markCircuitFailure(modelConfig, error, meta).state;
    const event = endSpan(spanId, {
      status: "error",
      detail:
        safeString(meta.detail) ||
        String(error?.message || error || "Provider call failed."),
      circuitState
    });
    return {
      circuitState,
      event
    };
  }

  function recordRetry(modelConfig, retry, meta = {}) {
    totals.retries += 1;
    const modelStats = ensureModelStats(modelConfig);
    modelStats.retries += 1;
    publish({
      type: "trace",
      stage: "trace_retry",
      tone: "warning",
      modelId: modelConfig.id,
      modelLabel: buildModelLabel(modelConfig),
      attempt: retry.attempt,
      maxRetries: retry.maxRetries,
      nextDelayMs: retry.nextDelayMs,
      status: retry.status,
      detail: retry.message,
      ...meta
    });
    publishSessionUpdate("Retry scheduled.");
  }

  function beginToolCall(meta = {}) {
    totals.toolCalls += 1;
    return startSpan({
      spanKind: safeString(meta.spanKind || "tool") || "tool",
      spanLabel: safeString(meta.spanLabel || meta.toolAction || "Tool call") || "Tool call",
      toolAction: safeString(meta.toolAction),
      ...meta
    });
  }

  function completeToolCall(spanId, meta = {}) {
    endSpan(spanId, {
      status: safeString(meta.status || "ok") || "ok",
      detail: meta.detail,
      resultCount: meta.resultCount,
      exitCode: meta.exitCode
    });
    publishSessionUpdate("Tool call completed.");
  }

  function failToolCall(spanId, error, meta = {}) {
    endSpan(spanId, {
      status: "error",
      detail: safeString(meta.detail || error?.message || error || "Tool call failed."),
      exitCode: meta.exitCode
    });
    publishSessionUpdate("Tool call failed.");
  }

  function remember(entry = {}, meta = {}) {
    totals.memoryWrites += 1;
    const memoryTitle =
      safeString(entry.title || entry.taskTitle || "") ||
      localizeRuntimeText(runLocale, "Session memory", "会话记忆");
    const spanId = beginToolCall({
      ...meta,
      spanKind: "memory_write",
      toolAction: "remember",
      spanLabel: safeString(meta.spanLabel || `Remember · ${entry.title || "note"}`) || "Remember"
    });

    const memoryEntry = {
      id: `mem_${String(++memorySequence).padStart(4, "0")}`,
      title: memoryTitle,
      content: compactText(entry.content, 500),
      tags: uniqueStrings(entry.tags),
      createdAt: new Date().toISOString(),
      agentId: safeString(meta.agentId),
      agentLabel: safeString(meta.agentLabel),
      taskId: safeString(meta.taskId),
      taskTitle: safeString(meta.taskTitle)
    };

    if (!memoryEntry.content) {
      completeToolCall(spanId, {
        detail: localizeRuntimeText(
          runLocale,
          "Skipped empty session memory write.",
          "已跳过空白会话记忆写入。"
        ),
        resultCount: memoryEntries.length
      });
      return null;
    }

    memoryEntries.unshift(memoryEntry);
    if (memoryEntries.length > DEFAULT_MAX_MEMORY_ENTRIES) {
      memoryEntries.length = DEFAULT_MAX_MEMORY_ENTRIES;
    }

    publish({
      type: "status",
      stage: "memory_write",
      tone: "ok",
      detail: localizeRuntimeText(
        runLocale,
        `Stored session memory: ${memoryEntry.title}`,
        `已写入会话记忆：${memoryEntry.title}`
      ),
      memoryEntry: cloneJson(memoryEntry),
      ...meta
    });

    endSpan(spanId, {
      status: "ok",
      detail: localizeRuntimeText(
        runLocale,
        `Stored session memory: ${memoryEntry.title}`,
        `已写入会话记忆：${memoryEntry.title}`
      ),
      memoryCount: memoryEntries.length
    });
    publishSessionUpdate("Session memory updated.");
    return memoryEntry;
  }

  function recall(queryInput = {}, meta = {}) {
    totals.memoryReads += 1;
    const queryText = safeString(queryInput.query);
    const requestedTags = uniqueStrings(queryInput.tags).map((item) => item.toLowerCase());
    const limit = Math.max(1, Math.min(12, normalizeInteger(queryInput.limit) || 3));
    const spanId = beginToolCall({
      ...meta,
      spanKind: "memory_read",
      toolAction: "recall_memory",
      spanLabel: safeString(meta.spanLabel || `Recall · ${queryText || "recent"}`) || "Recall"
    });

    const tokens = queryText
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const ranked = memoryEntries
      .map((entry, index) => {
        const haystack = [entry.title, entry.content, ...(entry.tags || [])]
          .join(" ")
          .toLowerCase();
        let score = 0;

        for (const token of tokens) {
          if (haystack.includes(token)) {
            score += 3;
          }
        }

        for (const tag of requestedTags) {
          if ((entry.tags || []).some((item) => item.toLowerCase() === tag)) {
            score += 4;
          }
        }

        score += Math.max(0, 40 - index);
        return {
          entry,
          score
        };
      })
      .filter((item) => item.score > 0 || (!tokens.length && !requestedTags.length))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((item) => item.entry);

    publish({
      type: "status",
      stage: "memory_read",
      tone: "neutral",
      detail: localizeRuntimeText(
        runLocale,
        `Recalled ${ranked.length} session memory item(s).`,
        `已召回 ${ranked.length} 条会话记忆。`
      ),
      memoryCount: ranked.length,
      ...meta
    });

    endSpan(spanId, {
      status: "ok",
      detail: localizeRuntimeText(
        runLocale,
        `Recalled ${ranked.length} session memory item(s).`,
        `已召回 ${ranked.length} 条会话记忆。`
      ),
      resultCount: ranked.length,
      memoryCount: memoryEntries.length
    });
    publishSessionUpdate("Session memory recalled.");
    return ranked.map((entry) => cloneJson(entry));
  }

  return {
    startSpan,
    endSpan,
    beginProviderCall,
    completeProviderCall,
    failProviderCall,
    recordRetry,
    beginToolCall,
    completeToolCall,
    failToolCall,
    remember,
    recall,
    buildSnapshot,
    publishSessionUpdate,
    getCircuitState(modelId) {
      return circuitByModelId.get(String(modelId || "").trim()) || null;
    },
    getMemoryEntries() {
      return memoryEntries.map((entry) => cloneJson(entry));
    },
    describeCircuitState(modelId) {
      const state = this.getCircuitState(modelId);
      return state ? formatCircuitDetail(state) : "Circuit state unavailable.";
    }
  };
}

module.exports = { createSessionRuntime };

},
"/src/cluster/provider-session.mjs": function(module, exports, __require) {
function buildRetryPayload({ stage, model, retry, taskId = "", taskTitle = "" }) {
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

async function invokeProviderWithSession({
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

module.exports = { invokeProviderWithSession, buildRetryPayload };

},
"/src/cluster/multi-agent-runtime.mjs": function(module, exports, __require) {
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  mode: "group_chat",
  speakerStrategy: "phase_priority",
  maxRounds: 16,
  terminationKeyword: "TERMINATE",
  messageWindow: 28,
  summarizeLongMessages: true,
  includeSystemMessages: true
});

const SUPPORTED_MODES = new Set(["group_chat", "sequential", "workflow"]);
const SUPPORTED_SPEAKER_STRATEGIES = new Set(["round_robin", "phase_priority", "random"]);

function safeString(value) {
  return String(value || "").trim();
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeMultiAgentRuntimeSettings(value, fallback = DEFAULT_SETTINGS) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_SETTINGS;
  const normalizedMode = safeString(source.mode || backup.mode).toLowerCase();
  const normalizedSpeakerStrategy = safeString(
    source.speakerStrategy || backup.speakerStrategy
  ).toLowerCase();

  return {
    enabled: Boolean(source.enabled ?? backup.enabled ?? DEFAULT_SETTINGS.enabled),
    mode: SUPPORTED_MODES.has(normalizedMode)
      ? normalizedMode
      : backup.mode || DEFAULT_SETTINGS.mode,
    speakerStrategy: SUPPORTED_SPEAKER_STRATEGIES.has(normalizedSpeakerStrategy)
      ? normalizedSpeakerStrategy
      : backup.speakerStrategy || DEFAULT_SETTINGS.speakerStrategy,
    maxRounds: normalizePositiveInteger(
      source.maxRounds,
      normalizePositiveInteger(backup.maxRounds, DEFAULT_SETTINGS.maxRounds)
    ),
    terminationKeyword:
      safeString(source.terminationKeyword || backup.terminationKeyword) ||
      DEFAULT_SETTINGS.terminationKeyword,
    messageWindow: normalizePositiveInteger(
      source.messageWindow,
      normalizePositiveInteger(backup.messageWindow, DEFAULT_SETTINGS.messageWindow)
    ),
    summarizeLongMessages:
      source.summarizeLongMessages ?? backup.summarizeLongMessages ?? true,
    includeSystemMessages:
      source.includeSystemMessages ?? backup.includeSystemMessages ?? true
  };
}

function truncateContent(content, summarizeLongMessages) {
  const normalized = safeString(content).replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (!summarizeLongMessages || normalized.length <= 320) {
    return normalized;
  }

  return `${normalized.slice(0, 317)}...`;
}

function matchesTerminationKeyword(content, terminationKeyword) {
  const keyword = safeString(terminationKeyword);
  if (!keyword) {
    return false;
  }
  return String(content || "").toLowerCase().includes(keyword.toLowerCase());
}

function createMultiAgentRuntime(rawSettings = {}) {
  const settings = normalizeMultiAgentRuntimeSettings(rawSettings);
  const messages = [];
  const participants = new Map();
  const phaseCounts = new Map();
  let nextMessageId = 0;
  let turnCount = 0;
  let totalMessageCount = 0;
  let foldedMessageCount = 0;
  let terminatedByKeyword = false;
  let summaryText = "";
  let objective = "";
  let status = settings.enabled ? "idle" : "disabled";
  let startedAt = "";
  let endedAt = "";

  function registerParticipant(agent, kind = "agent") {
    const agentId = safeString(agent?.runtimeId || agent?.agentId || agent?.id);
    if (!agentId) {
      return null;
    }

    const current = participants.get(agentId) || {
      id: agentId,
      label: safeString(agent?.displayLabel || agent?.agentLabel || agent?.label || agentId),
      kind: safeString(agent?.agentKind || kind || "agent") || "agent",
      messageCount: 0
    };
    current.label = safeString(agent?.displayLabel || agent?.agentLabel || agent?.label || current.label);
    current.kind = safeString(agent?.agentKind || kind || current.kind) || current.kind;
    current.messageCount += 1;
    participants.set(agentId, current);
    return current;
  }

  function pushMessage({
    kind = "message",
    stage = "",
    tone = "neutral",
    phase = "",
    speaker = null,
    target = null,
    content = "",
    summaryType = ""
  }) {
    if (!settings.enabled) {
      return null;
    }

    const normalizedContent = truncateContent(content, settings.summarizeLongMessages);
    if (!normalizedContent && kind !== "summary") {
      return null;
    }

    const shouldCountAsTurn = kind === "message";
    if (kind === "system" && !settings.includeSystemMessages) {
      return null;
    }

    if (shouldCountAsTurn && turnCount >= settings.maxRounds) {
      foldedMessageCount += 1;
      const lastFoldedSummary = messages.findLast(
        (entry) => entry.kind === "summary" && entry.summaryType === "folded"
      );
      if (lastFoldedSummary) {
        lastFoldedSummary.foldedCount = foldedMessageCount;
        lastFoldedSummary.content = `Folded ${foldedMessageCount} additional collaboration message(s) after reaching the round cap.`;
        return null;
      }

      const foldedSummary = {
        id: `ma_${String(++nextMessageId).padStart(4, "0")}`,
        kind: "summary",
        summaryType: "folded",
        stage: stage || "multi_agent_session_summary",
        tone: "warning",
        phase: safeString(phase),
        round: turnCount,
        timestamp: new Date().toISOString(),
        speakerId: "",
        speakerLabel: "",
        targetId: "",
        targetLabel: "",
        content: "Folded 1 additional collaboration message after reaching the round cap.",
        foldedCount: 1
      };
      messages.push(foldedSummary);
      totalMessageCount += 1;
      return foldedSummary;
    }

    if (shouldCountAsTurn) {
      turnCount += 1;
    }

    const speakerEntry = registerParticipant(speaker, kind);
    const targetEntry = target ? registerParticipant(target, "agent") : null;
    const normalizedPhase = safeString(phase);
    if (normalizedPhase) {
      phaseCounts.set(normalizedPhase, (phaseCounts.get(normalizedPhase) || 0) + 1);
    }

    const entry = {
      id: `ma_${String(++nextMessageId).padStart(4, "0")}`,
      kind,
      summaryType: safeString(summaryType),
      stage: safeString(stage),
      tone: safeString(tone) || "neutral",
      phase: normalizedPhase,
      round: turnCount,
      timestamp: new Date().toISOString(),
      speakerId: speakerEntry?.id || "",
      speakerLabel: speakerEntry?.label || "",
      targetId: targetEntry?.id || "",
      targetLabel: targetEntry?.label || "",
      content: normalizedContent
    };

    totalMessageCount += 1;
    terminatedByKeyword =
      terminatedByKeyword || matchesTerminationKeyword(normalizedContent, settings.terminationKeyword);
    messages.push(entry);
    return entry;
  }

  function start({ task = "", controller = null, detail = "" } = {}) {
    if (!settings.enabled) {
      return null;
    }

    objective = safeString(task);
    startedAt = new Date().toISOString();
    status = "running";

    return pushMessage({
      kind: "system",
      stage: "multi_agent_session_start",
      tone: "neutral",
      phase: "",
      speaker: controller,
      content:
        safeString(detail) ||
        `Multi-agent collaboration started in ${settings.mode} mode with ${settings.speakerStrategy} speaker strategy.`
    });
  }

  function recordSystem(payload = {}) {
    return pushMessage({
      kind: "system",
      stage: payload.stage || "multi_agent_message",
      tone: payload.tone || "neutral",
      phase: payload.phase || "",
      speaker: payload.speaker || null,
      target: payload.target || null,
      content: payload.content || payload.detail || "",
      summaryType: payload.summaryType || ""
    });
  }

  function recordMessage(payload = {}) {
    return pushMessage({
      kind: payload.kind || "message",
      stage: payload.stage || "multi_agent_message",
      tone: payload.tone || "neutral",
      phase: payload.phase || "",
      speaker: payload.speaker || null,
      target: payload.target || null,
      content: payload.content || payload.detail || "",
      summaryType: payload.summaryType || ""
    });
  }

  function recordSummary(payload = {}) {
    const nextSummary = safeString(payload.content || payload.detail);
    if (nextSummary) {
      summaryText = nextSummary;
    }

    return pushMessage({
      kind: "summary",
      stage: payload.stage || "multi_agent_session_summary",
      tone: payload.tone || "ok",
      phase: payload.phase || "",
      speaker: payload.speaker || null,
      target: payload.target || null,
      content: nextSummary,
      summaryType: payload.summaryType || "summary"
    });
  }

  function complete({ content = "", tone = "ok" } = {}) {
    if (!settings.enabled) {
      return null;
    }

    endedAt = new Date().toISOString();
    status = terminatedByKeyword ? "terminated" : "completed";
    const finalSummary =
      safeString(content) ||
      summaryText ||
      `Multi-agent collaboration completed with ${turnCount} visible turn(s).`;
    summaryText = finalSummary;

    return recordSummary({
      stage: "multi_agent_session_summary",
      tone,
      content: finalSummary,
      summaryType: "final"
    });
  }

  function buildSnapshot() {
    const visibleMessages = messages.slice(-Math.max(1, settings.messageWindow));
    return {
      enabled: settings.enabled,
      settings,
      status,
      objective,
      startedAt,
      endedAt,
      rounds: turnCount,
      totalMessageCount,
      foldedMessageCount,
      terminatedByKeyword,
      summary: summaryText,
      participantCount: participants.size,
      participants: Array.from(participants.values()).sort((left, right) =>
        left.label.localeCompare(right.label)
      ),
      phaseCounts: Object.fromEntries(phaseCounts.entries()),
      messages: visibleMessages
    };
  }

  return {
    settings,
    isEnabled() {
      return settings.enabled;
    },
    start,
    recordMessage,
    recordSummary,
    recordSystem,
    complete,
    buildSnapshot
  };
}

module.exports = { normalizeMultiAgentRuntimeSettings, createMultiAgentRuntime };

},
"/src/workspace/task-requirements.mjs": function(module, exports, __require) {
const { WORKSPACE_COMMAND_SCOPES, clampWorkspaceCommandScope, describeWorkspaceCommandScope, normalizeWorkspaceCommandScope } = __require("/src/workspace/command-policy.mjs");
const WORKSPACE_INSPECTION_PATTERN =
  /\b(workspace|repo|repository|codebase|git|commit|branch|diff|status|history|tree|file tree|changed files|patch|review)\b|(?:\u5de5\u4f5c\u533a|\u4ed3\u5e93|\u4ee3\u7801\u5e93|git|\u63d0\u4ea4|\u5206\u652f|\u5dee\u5f02|\u53d8\u66f4|\u72b6\u6001|\u6587\u4ef6\u6811|\u8865\u4e01|\u8bc4\u5ba1)/i;

function safeString(value) {
  return String(value || "").trim();
}

function textBlob(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => safeString(value).toLowerCase())
    .join(" ");
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizePhase(value) {
  const normalized = safeString(value).toLowerCase();
  return normalized || "implementation";
}

function taskRequiresConcreteArtifact(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  const hasExplicitArtifactPath = /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/.test(text);
  const hasNegatedArtifactWrite =
    /(\bdo not\b|\bdon't\b|\bwithout\b|\bavoid\b|\bnever\b).{0,20}\b(write|create|generate|save|export|deliver)\b/.test(text) ||
    /\b(write|create|generate|save|export|deliver)\b.{0,20}\b(no|without)\b.{0,12}\b(file|document|report|artifact|files|documents|reports|artifacts)\b/.test(text) ||
    /(?:不要|勿|禁止|无需|不必).{0,8}(?:写入|生成|创建|导出|保存).{0,8}(?:文件|文档|报告|交付物)/.test(text);

  if (hasExplicitArtifactPath) {
    return true;
  }
  if (hasNegatedArtifactWrite) {
    return false;
  }

  return (
    /(write|create|generate|save|export|deliver).{0,40}(file|document|report|artifact)/.test(text) ||
    /(\u6587\u4ef6|\u6587\u6863|\u62a5\u544a|\u4ea4\u4ed8\u7269|\u751f\u6210doc|\u751f\u6210docx)/.test(text)
  );
}

function taskNeedsWorkspaceInspection(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return WORKSPACE_INSPECTION_PATTERN.test(text);
}

function defaultCommandScopeForTask(task, phase) {
  const needsConcreteArtifact = taskRequiresConcreteArtifact(task);

  switch (phase) {
    case "implementation":
      return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
    case "validation":
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    case "handoff":
      if (needsConcreteArtifact) {
        return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
      }
      return taskNeedsWorkspaceInspection(task)
        ? WORKSPACE_COMMAND_SCOPES.READ_ONLY
        : WORKSPACE_COMMAND_SCOPES.NONE;
    case "research":
      return taskNeedsWorkspaceInspection(task)
        ? WORKSPACE_COMMAND_SCOPES.READ_ONLY
        : WORKSPACE_COMMAND_SCOPES.NONE;
    default:
      return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }
}

function defaultWriteAllowanceForTask(task, phase) {
  return phase === "implementation" || taskRequiresConcreteArtifact(task);
}

function normalizeBooleanOverride(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function deriveTaskRequirements(task = {}, options = {}) {
  const sourceRequirements =
    task?.requirements && typeof task.requirements === "object" ? task.requirements : {};
  const parentRequirements =
    options.parentRequirements && typeof options.parentRequirements === "object"
      ? options.parentRequirements
      : null;
  const inheritConcreteArtifactRequirement = options.inheritConcreteArtifactRequirement !== false;
  const phase = normalizePhase(task?.phase || sourceRequirements.phase || parentRequirements?.phase);
  const inferredConcreteArtifact = taskRequiresConcreteArtifact(task);
  const defaultCommandScope = defaultCommandScopeForTask(task, phase);
  const explicitCommandScope = hasOwn(sourceRequirements, "workspaceCommandScope")
    ? normalizeWorkspaceCommandScope(
      sourceRequirements.workspaceCommandScope,
      defaultCommandScope
    )
    : defaultCommandScope;
  let allowsWorkspaceWrite = normalizeBooleanOverride(
    sourceRequirements.allowsWorkspaceWrite,
    defaultWriteAllowanceForTask(task, phase)
  );
  let allowsWorkspaceCommand = normalizeBooleanOverride(
    sourceRequirements.allowsWorkspaceCommand,
    explicitCommandScope !== WORKSPACE_COMMAND_SCOPES.NONE
  );
  let workspaceCommandScope = allowsWorkspaceCommand
    ? explicitCommandScope
    : WORKSPACE_COMMAND_SCOPES.NONE;

  if (parentRequirements) {
    const parentAllowsWrite = Boolean(parentRequirements.allowsWorkspaceWrite);
    const parentAllowsCommand = Boolean(parentRequirements.allowsWorkspaceCommand);
    if (!parentAllowsWrite) {
      allowsWorkspaceWrite = false;
    }
    if (!parentAllowsCommand) {
      allowsWorkspaceCommand = false;
      workspaceCommandScope = WORKSPACE_COMMAND_SCOPES.NONE;
    } else {
      workspaceCommandScope = clampWorkspaceCommandScope(
        workspaceCommandScope,
        parentRequirements.workspaceCommandScope || WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
      );
      allowsWorkspaceCommand =
        allowsWorkspaceCommand && workspaceCommandScope !== WORKSPACE_COMMAND_SCOPES.NONE;
    }
  }

  return {
    phase,
    requiresWorkspaceWrite: Boolean(
      sourceRequirements.requiresWorkspaceWrite ?? allowsWorkspaceWrite
    ),
    requiresWorkspaceCommand: Boolean(
      sourceRequirements.requiresWorkspaceCommand ?? allowsWorkspaceCommand
    ),
    requiresConcreteArtifact: Boolean(
      sourceRequirements.requiresConcreteArtifact ??
        (inheritConcreteArtifactRequirement ? parentRequirements?.requiresConcreteArtifact : undefined) ??
        inferredConcreteArtifact
    ),
    allowsWorkspaceWrite,
    allowsWorkspaceCommand,
    workspaceCommandScope,
    workspaceCommandScopeDescription: describeWorkspaceCommandScope(workspaceCommandScope)
  };
}

module.exports = { deriveTaskRequirements };

},
"/src/workspace/artifact-fallback.mjs": function(module, exports, __require) {
const { basename, extname, relative, resolve } = require("node:path");
const ARTIFACT_EXTENSION_PATTERN = /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/i;
const WINDOWS_INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;
const QUOTED_ARTIFACT_PATTERN = /[`"'“”]([^`"'“”\r\n]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json))[`"'“”]/gi;
const ABSOLUTE_WINDOWS_ARTIFACT_PATTERN = /[a-z]:\\[^\r\n]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/gi;
const BARE_FILENAME_PATTERN =
  /(?:^|[\s(（:：])([^\s"'“”`<>|?*\r\n\\/:]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json))\b/gi;

function safeString(value) {
  return String(value || "").trim();
}

function uniqueStrings(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => safeString(item))
        .filter(Boolean)
    )
  );
}

function normalizeArtifactCandidateValue(value) {
  if (typeof value === "string") {
    return safeString(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  return safeString(
    value.path ??
      value.filePath ??
      value.file_path ??
      value.filename ??
      value.fileName ??
      value.targetPath ??
      value.target_path
  );
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").trim().replaceAll("\\", "/");
}

function normalizeCandidatePath(candidatePath, workspaceRoot) {
  const normalized = normalizeRelativePath(candidatePath);
  if (!normalized) {
    return "";
  }

  const normalizedWorkspaceRoot = normalizeRelativePath(resolve(workspaceRoot));
  const lowerWorkspaceRoot = normalizedWorkspaceRoot.toLowerCase();
  const lowerCandidate = normalized.toLowerCase();

  if (lowerCandidate.startsWith(lowerWorkspaceRoot)) {
    const absoluteCandidate = resolve(candidatePath);
    const relativePath = normalizeRelativePath(relative(resolve(workspaceRoot), absoluteCandidate));
    if (relativePath && !relativePath.startsWith("../")) {
      return relativePath;
    }
  }

  if (/^[a-z]:\//i.test(normalized)) {
    return basename(normalized);
  }

  return normalized.replace(/^\/+/, "");
}

function collectQuotedArtifactCandidates(text) {
  const value = safeString(text);
  if (!value) {
    return [];
  }

  const matches = [];
  for (const match of value.matchAll(QUOTED_ARTIFACT_PATTERN)) {
    matches.push(match[1]);
  }
  for (const match of value.matchAll(ABSOLUTE_WINDOWS_ARTIFACT_PATTERN)) {
    matches.push(match[0]);
  }
  for (const match of value.matchAll(BARE_FILENAME_PATTERN)) {
    matches.push(match[1]);
  }

  return matches;
}

function sanitizeFilename(value) {
  const normalized = safeString(value)
    .replace(WINDOWS_INVALID_FILENAME, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();

  return normalized || "generated-artifact";
}

function deriveFallbackFilename(task) {
  const source = safeString(task?.title || task?.expectedOutput || task?.instructions);
  if (!source) {
    return "generated-report";
  }

  return sanitizeFilename(source).slice(0, 80);
}

function appendBulletSection(lines, heading, items) {
  const normalizedItems = uniqueStrings(items);
  if (!normalizedItems.length) {
    return;
  }

  lines.push(`## ${heading}`);
  lines.push(...normalizedItems.map((item) => `- ${item}`));
}

function renderOutputSection(result) {
  const output = result?.output && typeof result.output === "object" ? result.output : {};
  const lines = [];

  if (safeString(output.summary)) {
    lines.push(output.summary);
  }

  appendBulletSection(lines, "关键要点", output.keyFindings || []);
  appendBulletSection(lines, "相关交付", output.deliverables || []);
  appendBulletSection(lines, "风险与注意事项", output.risks || []);
  appendBulletSection(lines, "后续建议", output.followUps || []);

  return lines.join("\n");
}

function collectExplicitArtifactCandidates(parsed) {
  return uniqueStrings([
    ...(Array.isArray(parsed?.generatedFiles) ? parsed.generatedFiles : []),
    ...(Array.isArray(parsed?.verifiedGeneratedFiles) ? parsed.verifiedGeneratedFiles : []),
    ...(Array.isArray(parsed?.deliverables) ? parsed.deliverables : [])
  ].map((item) => normalizeArtifactCandidateValue(item)).filter(Boolean));
}

function collectArtifactPathHints(parsed) {
  return uniqueStrings([
    ...(Array.isArray(parsed?.generatedFiles) ? parsed.generatedFiles : []),
    ...(Array.isArray(parsed?.verifiedGeneratedFiles) ? parsed.verifiedGeneratedFiles : [])
  ].map((item) => normalizeArtifactCandidateValue(item)).filter(Boolean));
}

function collectDeliverableTexts(parsed) {
  return uniqueStrings([
    ...(Array.isArray(parsed?.deliverables) ? parsed.deliverables : [])
  ]);
}

function collectArtifactHintTexts(task, parsed, originalTask) {
  return [
    task?.title,
    task?.instructions,
    task?.expectedOutput,
    originalTask,
    parsed?.summary,
    ...(Array.isArray(parsed?.followUps) ? parsed.followUps : []),
    ...collectDeliverableTexts(parsed),
    ...collectArtifactPathHints(parsed),
    ...(Array.isArray(parsed?.keyFindings) ? parsed.keyFindings : [])
  ]
    .map((value) => safeString(value))
    .filter(Boolean);
}

function inferRequestedArtifact(task, parsed, workspaceRoot, originalTask = "") {
  for (const candidate of collectExplicitArtifactCandidates(parsed)) {
    const normalized = normalizeCandidatePath(candidate, workspaceRoot);
    if (ARTIFACT_EXTENSION_PATTERN.test(normalized)) {
      return normalized;
    }
  }

  for (const source of collectArtifactHintTexts(task, parsed, originalTask)) {
    for (const candidate of collectQuotedArtifactCandidates(source)) {
      const normalized = normalizeCandidatePath(candidate, workspaceRoot);
      if (ARTIFACT_EXTENSION_PATTERN.test(normalized)) {
        return normalized;
      }
    }
  }

  const extensionMatch = collectArtifactHintTexts(task, parsed, originalTask)
    .map((source) => source.match(ARTIFACT_EXTENSION_PATTERN))
    .find(Boolean);
  const extension = extensionMatch ? extensionMatch[0].toLowerCase() : ".docx";

  return `${deriveFallbackFilename(task)}${extension.startsWith(".") ? extension : `.${extension}`}`;
}

function buildDocxFallbackContent({
  task,
  parsed,
  dependencyOutputs,
  originalTask
}) {
  const sections = [];
  const title = safeString(task?.title) || "交付文档";
  sections.push(`# ${title}`);

  if (safeString(originalTask)) {
    sections.push("## 原始目标");
    sections.push(originalTask);
  }

  if (safeString(parsed?.summary)) {
    sections.push("## 当前任务总结");
    sections.push(parsed.summary);
  }

  appendBulletSection(sections, "当前任务要点", parsed?.keyFindings || []);
  appendBulletSection(sections, "当前任务交付", parsed?.deliverables || []);
  appendBulletSection(sections, "风险与限制", parsed?.risks || []);
  appendBulletSection(sections, "后续建议", parsed?.followUps || []);

  const outputs = Array.isArray(dependencyOutputs) ? dependencyOutputs : [];
  for (const dependency of outputs) {
    const body = renderOutputSection(dependency);
    if (!safeString(body)) {
      continue;
    }

    const heading =
      safeString(dependency?.title) ||
      safeString(dependency?.taskId) ||
      "依赖输出";
    sections.push(`## 依赖输出：${heading}`);
    sections.push(body);
  }

  return sections.join("\n\n").trim();
}

function shouldAutoMaterializeDocx(task, parsed, dependencyOutputs) {
  const explicitPath = inferRequestedArtifact(task, parsed, ".", "");
  if (!/\.docx$/i.test(explicitPath)) {
    return false;
  }

  const content = buildDocxFallbackContent({
    task,
    parsed,
    dependencyOutputs,
    originalTask: ""
  });

  return safeString(content).length >= 24;
}

function getArtifactTitleFromPath(artifactPath) {
  const fileName = basename(String(artifactPath || ""));
  const extension = extname(fileName);
  return fileName.slice(0, extension ? -extension.length : undefined) || "Generated Report";
}

module.exports = { inferRequestedArtifact, buildDocxFallbackContent, shouldAutoMaterializeDocx, getArtifactTitleFromPath };

},
"/src/workspace/action-protocol.mjs": function(module, exports, __require) {
const WORKSPACE_ACTIONS = Object.freeze({
  LIST_FILES: "list_files",
  READ_FILES: "read_files",
  WRITE_FILES: "write_files",
  WRITE_DOCX: "write_docx",
  WEB_SEARCH: "web_search",
  RUN_COMMAND: "run_command",
  RECALL_MEMORY: "recall_memory",
  REMEMBER: "remember",
  FINAL: "final"
});

function buildWorkspaceToolSchemaLines(options = {}) {
  const webSearchAvailable = Boolean(options.webSearchAvailable);
  const workspaceWriteAvailable = options.workspaceWriteAvailable !== false;
  const workspaceCommandAvailable = options.workspaceCommandAvailable !== false;
  const workspaceCommandScopeDescription = String(
    options.workspaceCommandScopeDescription || ""
  ).trim();
  const schemas = [
    '{"action":"list_files","path":"relative/path","reason":"string"}',
    '{"action":"read_files","paths":["relative/path"],"reason":"string"}'
  ];

  if (workspaceWriteAvailable) {
    schemas.push(
      '{"action":"write_files","files":[{"path":"relative/path","content":"string","encoding":"utf8|base64"}],"reason":"string"}',
      '{"action":"write_docx","path":"relative/path.docx","content":"string","title":"string","reason":"string"}'
    );
  }

  if (webSearchAvailable) {
    schemas.push(
      '{"action":"web_search","query":"string","domains":["example.com"],"recencyDays":30,"reason":"string"}'
    );
  }

  if (workspaceCommandAvailable) {
    schemas.push(
      '{"action":"run_command","command":"string","args":["string"],"cwd":"relative/path","reason":"string"}'
    );
  }

  schemas.push(
    '{"action":"recall_memory","query":"string","limit":3,"tags":["string"],"reason":"string"}',
    '{"action":"remember","title":"string","content":"string","tags":["string"],"reason":"string"}'
  );

  const lines = schemas.map(
    (schema, index) => `Tool schema ${index + 1}: ${schema}`
  );

  if (!workspaceWriteAvailable) {
    lines.push("Unavailable tool: write_files/write_docx. Do not attempt workspace writes for this task.");
  }
  if (!webSearchAvailable) {
    lines.push("Unavailable tool: web_search. Do not claim live web verification for this task.");
  }
  if (!workspaceCommandAvailable) {
    lines.push("Unavailable tool: run_command. Do not attempt workspace commands for this task.");
  } else if (workspaceCommandScopeDescription) {
    lines.push(`run_command scope: ${workspaceCommandScopeDescription}.`);
  }

  lines.push(
    'Final schema: {"action":"final","thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"confidence":"low|medium|high","followUps":["string"],"generatedFiles":["relative/path"],"verificationStatus":"not_applicable|passed|failed","toolUsage":["string"],"memoryReads":0,"memoryWrites":0}'
  );

  return lines;
}

const WORKSPACE_TOOL_SCHEMA_LINES = buildWorkspaceToolSchemaLines({
  webSearchAvailable: true
});

const ACTION_BATCH_KEYS = Object.freeze([
  "actions",
  "steps",
  "toolCalls",
  "tool_calls",
  "operations",
  "calls",
  "requests"
]);

const ACTION_NAME_KEYS = Object.freeze([
  "action",
  "toolAction",
  "tool_action",
  "tool",
  "toolName",
  "tool_name",
  "name",
  "type",
  "method",
  "operation",
  "op",
  "intent",
  "functionName",
  "function_name",
  "call"
]);

const ACTION_WRAPPER_KEYS = Object.freeze([
  "workspaceAction",
  "workspace_action",
  "toolCall",
  "tool_call",
  "functionCall",
  "function_call",
  "request",
  "toolRequest",
  "tool_request",
  "operation",
  "step"
]);

const ACTION_PAYLOAD_KEYS = Object.freeze([
  "payload",
  "params",
  "parameters",
  "arguments",
  "input",
  "toolInput",
  "tool_input",
  "data",
  "body"
]);

const ACTION_ALIASES = new Map([
  ["list", WORKSPACE_ACTIONS.LIST_FILES],
  ["ls", WORKSPACE_ACTIONS.LIST_FILES],
  ["list_files", WORKSPACE_ACTIONS.LIST_FILES],
  ["listfiles", WORKSPACE_ACTIONS.LIST_FILES],
  ["list_file", WORKSPACE_ACTIONS.LIST_FILES],
  ["list_workspace", WORKSPACE_ACTIONS.LIST_FILES],
  ["read", WORKSPACE_ACTIONS.READ_FILES],
  ["read_file", WORKSPACE_ACTIONS.READ_FILES],
  ["read_files", WORKSPACE_ACTIONS.READ_FILES],
  ["readfiles", WORKSPACE_ACTIONS.READ_FILES],
  ["open_file", WORKSPACE_ACTIONS.READ_FILES],
  ["write", WORKSPACE_ACTIONS.WRITE_FILES],
  ["write_file", WORKSPACE_ACTIONS.WRITE_FILES],
  ["write_files", WORKSPACE_ACTIONS.WRITE_FILES],
  ["writefiles", WORKSPACE_ACTIONS.WRITE_FILES],
  ["save_file", WORKSPACE_ACTIONS.WRITE_FILES],
  ["save_files", WORKSPACE_ACTIONS.WRITE_FILES],
  ["create_file", WORKSPACE_ACTIONS.WRITE_FILES],
  ["write_docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["writedocx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["write-docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["create_docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["createdocx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["generate_docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["generatedocx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["word_document", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["write_word_document", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["web_search", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["websearch", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_search_tool", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_searches", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["search_web", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_search_query", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_search_request", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web-search", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["run_command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["runcommand", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["run-command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["shell", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["execute_command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["recall", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["recall_memory", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["recallmemory", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["memory_search", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["remember", WORKSPACE_ACTIONS.REMEMBER],
  ["remember_memory", WORKSPACE_ACTIONS.REMEMBER],
  ["store_memory", WORKSPACE_ACTIONS.REMEMBER],
  ["write_memory", WORKSPACE_ACTIONS.REMEMBER],
  ["final", WORKSPACE_ACTIONS.FINAL],
  ["done", WORKSPACE_ACTIONS.FINAL],
  ["finish", WORKSPACE_ACTIONS.FINAL],
  ["complete", WORKSPACE_ACTIONS.FINAL],
  ["result", WORKSPACE_ACTIONS.FINAL],
  ["final_result", WORKSPACE_ACTIONS.FINAL],
  ["finalresult", WORKSPACE_ACTIONS.FINAL]
]);

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean).map((item) => String(item))));
}

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function toSnakeCase(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function parseMaybeJsonValue(value) {
  if (value && typeof value === "object") {
    return value;
  }

  const normalized = String(value || "").trim();
  if (!normalized || !/^[\[{]/.test(normalized)) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function parseMaybeJsonObject(value) {
  const parsed = parseMaybeJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function normalizeActionName(value) {
  const normalized = toSnakeCase(value);
  if (!normalized) {
    return "";
  }

  if (Object.values(WORKSPACE_ACTIONS).includes(normalized)) {
    return normalized;
  }

  return ACTION_ALIASES.get(normalized) || "";
}

function getFirstObjectValue(candidate, keys) {
  for (const key of keys) {
    const value = candidate?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }

    const parsed = parseMaybeJsonObject(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function getFirstDefinedValue(candidate, keys) {
  for (const key of keys) {
    if (candidate?.[key] != null) {
      return candidate[key];
    }
  }

  return undefined;
}

function resolveRawActionName(candidate) {
  return getFirstDefinedValue(candidate, ACTION_NAME_KEYS);
}

function maybeUnwrapFunctionCall(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }

  if (candidate.function && typeof candidate.function === "object" && !Array.isArray(candidate.function)) {
    const functionArgs = parseMaybeJsonObject(candidate.function.arguments) || {};
    return {
      ...functionArgs,
      ...candidate,
      action:
        candidate.action ??
        candidate.function.name ??
        functionArgs.action
    };
  }

  const nestedArguments = parseMaybeJsonObject(candidate.arguments);
  if (nestedArguments) {
    return {
      ...nestedArguments,
      ...candidate
    };
  }

  return candidate;
}

function maybeUnwrapWorkspaceAction(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }

  let current = maybeUnwrapFunctionCall(candidate);

  for (let depth = 0; depth < 4; depth += 1) {
    let changed = false;

    const wrappedAction = getFirstObjectValue(current, ACTION_WRAPPER_KEYS);
    if (wrappedAction) {
      const rawActionName = resolveRawActionName(current);
      current = {
        ...wrappedAction,
        ...current,
        action:
          rawActionName ??
          resolveRawActionName(wrappedAction)
      };
      current = maybeUnwrapFunctionCall(current);
      changed = true;
    }

    const wrappedPayload = getFirstObjectValue(current, ACTION_PAYLOAD_KEYS);
    if (wrappedPayload) {
      const rawActionName = resolveRawActionName(current);
      current = {
        ...wrappedPayload,
        ...current,
        action:
          rawActionName ??
          resolveRawActionName(wrappedPayload)
      };
      current = maybeUnwrapFunctionCall(current);
      changed = true;
    }

    if (!changed) {
      break;
    }
  }

  return current;
}

function extractFirstActionCandidate(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) || parsed[0];
  }

  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  for (const key of ACTION_BATCH_KEYS) {
    const directEntries = Array.isArray(parsed[key]) ? parsed[key] : null;
    const parsedEntries = directEntries || parseMaybeJsonValue(parsed[key]);
    if (!Array.isArray(parsedEntries) || !parsedEntries.length) {
      continue;
    }

    const firstEntry = extractFirstActionCandidate(parsedEntries);
    if (!firstEntry || typeof firstEntry !== "object" || Array.isArray(firstEntry)) {
      continue;
    }

    return {
      ...firstEntry,
      reason: firstEntry.reason ?? parsed.reason,
      action:
        resolveRawActionName(firstEntry) ??
        resolveRawActionName(parsed)
    };
  }

  return parsed;
}

function getPathAlias(candidate) {
  return getFirstDefinedValue(candidate, [
    "path",
    "filePath",
    "file_path",
    "filename",
    "fileName",
    "targetPath",
    "target_path",
    "artifactPath",
    "artifact_path"
  ]);
}

function getContentAlias(candidate) {
  return getFirstDefinedValue(candidate, [
    "content",
    "text",
    "body",
    "markdown",
    "document",
    "doc",
    "contents",
    "data"
  ]);
}

function normalizeFileLikeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const path = getPathAlias(entry);
  const content = getContentAlias(entry);
  if (!hasNonEmptyString(path) || typeof content !== "string") {
    return null;
  }

  const normalized = {
    path: String(path),
    content: String(content)
  };

  if (entry.encoding != null) {
    normalized.encoding = String(entry.encoding).trim().toLowerCase() || "utf8";
  }
  if (entry.title != null) {
    normalized.title = String(entry.title);
  }

  return normalized;
}

function canonicalizeWorkspaceActionPayload(parsed) {
  const firstCandidate = extractFirstActionCandidate(parsed);
  if (!firstCandidate || typeof firstCandidate !== "object" || Array.isArray(firstCandidate)) {
    return parsed;
  }

  const candidate = maybeUnwrapWorkspaceAction(firstCandidate);
  const action = normalizeActionName(resolveRawActionName(candidate));

  const normalized = {
    ...candidate
  };

  if (!Array.isArray(normalized.files)) {
    const parsedFiles = parseMaybeJsonValue(normalized.files);
    if (Array.isArray(parsedFiles)) {
      normalized.files = parsedFiles;
    }
  }

  if (Array.isArray(normalized.files)) {
    normalized.files = normalized.files
      .map((entry) => normalizeFileLikeEntry(entry))
      .filter(Boolean);
  }

  if (!hasNonEmptyString(normalized.path)) {
    const pathAlias = getPathAlias(normalized);
    if (hasNonEmptyString(pathAlias)) {
      normalized.path = String(pathAlias);
    }
  }

  if (typeof normalized.content !== "string") {
    const contentAlias = getContentAlias(normalized);
    if (typeof contentAlias === "string") {
      normalized.content = String(contentAlias);
    }
  }

  if (!hasNonEmptyString(normalized.command)) {
    const commandAlias = getFirstDefinedValue(normalized, ["command", "cmd", "shellCommand", "shell_command"]);
    if (hasNonEmptyString(commandAlias)) {
      normalized.command = String(commandAlias);
    }
  }

  if (!hasNonEmptyString(normalized.query)) {
    const queryAlias = getFirstDefinedValue(normalized, ["query", "searchQuery", "search_query", "prompt"]);
    if (hasNonEmptyString(queryAlias)) {
      normalized.query = String(queryAlias);
    }
  }

  if (!Array.isArray(normalized.paths)) {
    const parsedPaths = parseMaybeJsonValue(normalized.paths);
    if (Array.isArray(parsedPaths)) {
      normalized.paths = parsedPaths;
    }
  }

  if (!normalized.action && action) {
    normalized.action = action;
  }

  if (!normalized.action) {
    if (
      hasNonEmptyString(normalized.path) &&
      /\.docx$/i.test(String(normalized.path || "")) &&
      typeof normalized.content === "string"
    ) {
      normalized.action = WORKSPACE_ACTIONS.WRITE_DOCX;
    } else if (
      Array.isArray(normalized.files) ||
      (hasNonEmptyString(normalized.path) && typeof normalized.content === "string")
    ) {
      normalized.action = WORKSPACE_ACTIONS.WRITE_FILES;
    } else if (Array.isArray(normalized.paths)) {
      normalized.action = WORKSPACE_ACTIONS.READ_FILES;
    } else if (hasNonEmptyString(normalized.command)) {
      normalized.action = WORKSPACE_ACTIONS.RUN_COMMAND;
    } else if (hasNonEmptyString(normalized.title) && hasNonEmptyString(normalized.content)) {
      normalized.action = WORKSPACE_ACTIONS.REMEMBER;
    } else if (parsed?.summary || parsed?.keyFindings || parsed?.followUps) {
      normalized.action = WORKSPACE_ACTIONS.FINAL;
    }
  }

  normalized.action = normalizeActionName(normalized.action) || normalized.action || "";

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_FILES &&
    !Array.isArray(normalized.files) &&
    hasNonEmptyString(normalized.path) &&
    typeof normalized.content === "string"
  ) {
    normalized.files = [
      {
        path: String(normalized.path),
        content: normalized.content,
        encoding: String(normalized.encoding || "utf8").trim().toLowerCase() || "utf8"
      }
    ];
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_FILES &&
    (!Array.isArray(normalized.files) || !normalized.files.length)
  ) {
    const singleFileEntry =
      normalizeFileLikeEntry(getFirstObjectValue(normalized, ["file", "artifact", "document"])) ||
      normalizeFileLikeEntry(normalized);
    if (singleFileEntry) {
      normalized.files = [
        {
          ...singleFileEntry,
          encoding: String(singleFileEntry.encoding || normalized.encoding || "utf8").trim().toLowerCase() || "utf8"
        }
      ];
    }
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_DOCX &&
    !hasNonEmptyString(normalized.path)
  ) {
    const docxEntry =
      normalizeFileLikeEntry(getFirstObjectValue(normalized, ["file", "artifact", "document"])) ||
      normalizeFileLikeEntry(normalized);
    if (docxEntry) {
      normalized.path = docxEntry.path;
      normalized.content = docxEntry.content;
      if (docxEntry.title != null && normalized.title == null) {
        normalized.title = docxEntry.title;
      }
    }
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_DOCX &&
    hasNonEmptyString(normalized.path) &&
    typeof normalized.content === "string"
  ) {
    normalized.path = String(normalized.path);
    normalized.content = String(normalized.content);
    if (normalized.title != null) {
      normalized.title = String(normalized.title);
    }
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.READ_FILES &&
    !Array.isArray(normalized.paths) &&
    hasNonEmptyString(normalized.path)
  ) {
    normalized.paths = [String(normalized.path)];
  }

  if (normalized.action === WORKSPACE_ACTIONS.RUN_COMMAND) {
    if (Array.isArray(normalized.arguments) && !Array.isArray(normalized.args)) {
      normalized.args = normalized.arguments;
    } else if (typeof normalized.arguments === "string" && !Array.isArray(normalized.args)) {
      const parsedArguments = parseMaybeJsonValue(normalized.arguments);
      if (Array.isArray(parsedArguments)) {
        normalized.args = parsedArguments;
      }
    }

    if (typeof normalized.args === "string") {
      normalized.args = [normalized.args];
    }
  }

  if (normalized.action === WORKSPACE_ACTIONS.WEB_SEARCH) {
    if (typeof normalized.domains === "string") {
      normalized.domains = [normalized.domains];
    }
    if (normalized.recencyDays == null && normalized.recency != null) {
      normalized.recencyDays = normalized.recency;
    }
  }

  if (normalized.action === WORKSPACE_ACTIONS.FINAL) {
    if (!Array.isArray(normalized.generatedFiles) && hasNonEmptyString(normalized.generatedFile)) {
      normalized.generatedFiles = [String(normalized.generatedFile)];
    }
    if (
      !Array.isArray(normalized.verifiedGeneratedFiles) &&
      hasNonEmptyString(normalized.verifiedGeneratedFile)
    ) {
      normalized.verifiedGeneratedFiles = [String(normalized.verifiedGeneratedFile)];
    }
  }

  return normalized;
}

function normalizeVerificationStatus(value, fallback = "not_applicable") {
  const normalized = String(value || "").trim();
  if (["not_applicable", "passed", "failed"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeToolAction(parsed) {
  const normalized = canonicalizeWorkspaceActionPayload(parsed);
  const action = normalizeActionName(resolveRawActionName(normalized));
  if (action) {
    return action;
  }

  if (normalized?.summary || normalized?.keyFindings || normalized?.followUps) {
    return WORKSPACE_ACTIONS.FINAL;
  }

  return "";
}

function hasNonEmptyString(value) {
  return String(value || "").trim().length > 0;
}

const ARTIFACT_EXTENSIONS = [
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".pdf",
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".ps1",
  ".cmd",
  ".bat",
  ".sh",
  ".log"
];

function normalizeArtifactReference(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const lowerText = text.toLowerCase();
  let bestEnd = -1;
  for (const extension of ARTIFACT_EXTENSIONS) {
    const index = lowerText.indexOf(extension);
    if (index === -1) {
      continue;
    }
    const end = index + extension.length;
    if (end > bestEnd) {
      bestEnd = end;
    }
  }

  if (bestEnd > 0) {
    return text.slice(0, bestEnd).trim();
  }

  return text;
}

function normalizeWorkspaceArtifactReferences(values) {
  return uniqueStrings(safeArray(values).map(normalizeArtifactReference).filter(Boolean));
}

function validateWorkspaceActionPayload(parsed, action) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workspace action payload must be a JSON object.");
  }

  switch (action) {
    case WORKSPACE_ACTIONS.LIST_FILES:
      if (!hasNonEmptyString(parsed.path || ".")) {
        throw new Error("list_files requires a workspace-relative path.");
      }
      return;
    case WORKSPACE_ACTIONS.READ_FILES: {
      const paths = safeArray(parsed.paths).filter(Boolean);
      if (!paths.length) {
        throw new Error("read_files requires at least one workspace-relative path.");
      }
      return;
    }
    case WORKSPACE_ACTIONS.WRITE_FILES: {
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      if (!files.length) {
        throw new Error("write_files requires at least one file payload.");
      }
      for (const file of files) {
        if (!hasNonEmptyString(file?.path)) {
          throw new Error("write_files requires every file entry to include a relative path.");
        }
        if (typeof file?.content !== "string") {
          throw new Error("write_files requires every file entry to include string content.");
        }
        if (
          file?.encoding != null &&
          !["utf8", "base64"].includes(String(file.encoding).trim().toLowerCase())
        ) {
          throw new Error('write_files encoding must be either "utf8" or "base64".');
        }
      }
      return;
    }
    case WORKSPACE_ACTIONS.WRITE_DOCX:
      if (!hasNonEmptyString(parsed.path) || !/\.docx$/i.test(String(parsed.path))) {
        throw new Error("write_docx requires a workspace-relative .docx path.");
      }
      if (typeof parsed.content !== "string") {
        throw new Error("write_docx requires string content.");
      }
      return;
    case WORKSPACE_ACTIONS.WEB_SEARCH:
      if (!hasNonEmptyString(parsed.query)) {
        throw new Error("web_search requires a query.");
      }
      if (parsed.domains != null && !Array.isArray(parsed.domains)) {
        throw new Error("web_search domains must be an array of strings.");
      }
      if (parsed.recencyDays != null) {
        const recencyDays = Number(parsed.recencyDays);
        if (!Number.isFinite(recencyDays) || recencyDays < 0) {
          throw new Error("web_search recencyDays must be a non-negative number.");
        }
      }
      return;
    case WORKSPACE_ACTIONS.RUN_COMMAND:
      if (!hasNonEmptyString(parsed.command)) {
        throw new Error("run_command requires a command.");
      }
      if (parsed.args != null && !Array.isArray(parsed.args)) {
        throw new Error("run_command args must be an array of strings.");
      }
      return;
    case WORKSPACE_ACTIONS.RECALL_MEMORY:
      if (!hasNonEmptyString(parsed.query)) {
        throw new Error("recall_memory requires a query.");
      }
      return;
    case WORKSPACE_ACTIONS.REMEMBER:
      if (!hasNonEmptyString(parsed.content)) {
        throw new Error("remember requires content.");
      }
      return;
    case WORKSPACE_ACTIONS.FINAL:
      if (
        !hasNonEmptyString(parsed.summary) &&
        !safeArray(parsed.keyFindings).length &&
        !safeArray(parsed.risks).length &&
        !safeArray(parsed.deliverables).length
      ) {
        throw new Error("final requires a summary or at least one structured result field.");
      }
      return;
    default:
      throw new Error(`Unsupported workspace action "${action || "unknown"}".`);
  }
}

function normalizeWorkspaceFinalResult(
  parsed,
  rawText,
  generatedFiles,
  verifiedGeneratedFiles,
  history,
  counters = {}
) {
  const commandHistory = history.filter(
    (entry) => entry.action === WORKSPACE_ACTIONS.RUN_COMMAND && !entry.blocked
  );
  return {
    thinkingSummary: String(parsed?.thinkingSummary || ""),
    summary: String(parsed?.summary || rawText || "No summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    risks: safeArray(parsed?.risks),
    deliverables: safeArray(parsed?.deliverables),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    followUps: safeArray(parsed?.followUps),
    generatedFiles: normalizeWorkspaceArtifactReferences([
      ...(parsed?.generatedFiles || []),
      ...(generatedFiles || [])
    ]),
    verifiedGeneratedFiles: normalizeWorkspaceArtifactReferences(verifiedGeneratedFiles || []),
    workspaceActions: history.map((entry) => entry.action),
    toolUsage: uniqueStrings([...(parsed?.toolUsage || []), ...history.map((entry) => entry.action)]),
    memoryReads: normalizeInteger(parsed?.memoryReads, normalizeInteger(counters.memoryReads)),
    memoryWrites: normalizeInteger(parsed?.memoryWrites, normalizeInteger(counters.memoryWrites)),
    verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus),
    executedCommands: commandHistory.map((entry) =>
      [entry.request.command, ...(entry.request.args || [])].join(" ").trim()
    )
  };
}

module.exports = { buildWorkspaceToolSchemaLines, canonicalizeWorkspaceActionPayload, normalizeVerificationStatus, normalizeToolAction, normalizeWorkspaceArtifactReferences, validateWorkspaceActionPayload, normalizeWorkspaceFinalResult, WORKSPACE_ACTIONS, WORKSPACE_TOOL_SCHEMA_LINES };

},
"/src/static/operation-events.js": function(module, exports, __require) {
const { createCatalogTranslator } = __require("/src/static/i18n-core.js");
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
    "event.workspaceJsonRepair": "{actor} 正在修复无效的 workspace JSON 响应。",
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
    "event.workspaceJsonRepair": "{actor} is repairing an invalid workspace JSON response.",
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

function createOperationEventTranslator(locale = "") {
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

function describeOperationEvent(
  event,
  {
    formatDelay = (value) => `${value ?? 0} ms`,
    translate = translateOperationEvent,
    locale = ""
  } = {}
) {
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
        detail: event.detail || labels.memoryWrite
      });
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

module.exports = { createOperationEventTranslator, describeOperationEvent };

},
"/src/workspace/document-reader.mjs": function(module, exports, __require) {
const { readFile } = require("node:fs/promises");
const { extname } = require("node:path");
const { spawn } = require("node:child_process");
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".csv",
  ".tsv",
  ".log",
  ".ini",
  ".toml",
  ".conf",
  ".config",
  ".env",
  ".properties",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".kts",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
  ".dockerfile",
  ".gradle",
  ".makefile"
]);

const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"]);

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(script)
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          ...env
        }
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
        return;
      }

      resolve(stdout);
    });
  });
}

function buildOfficeExtractionScript() {
  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression.FileSystem
$path = $env:AGENT_CLUSTER_DOC_PATH
$ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()

function Decode-XmlText([string]$value) {
  return [System.Net.WebUtility]::HtmlDecode(($value -replace '<[^>]+>', ' ' -replace '\\s+', ' ').Trim())
}

function Get-ZipEntryText([string]$archivePath, [string]$entryName) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entry = $archive.Entries | Where-Object { $_.FullName -eq $entryName } | Select-Object -First 1
    if (-not $entry) { return "" }
    $stream = $entry.Open()
    try {
      $reader = New-Object System.IO.StreamReader($stream)
      return $reader.ReadToEnd()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $archive.Dispose()
  }
}

function Get-ZipEntries([string]$archivePath, [string]$prefix) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    return $archive.Entries |
      Where-Object { $_.FullName.StartsWith($prefix) -and -not $_.FullName.EndsWith('/') } |
      Sort-Object FullName |
      ForEach-Object {
        $stream = $_.Open()
        try {
          $reader = New-Object System.IO.StreamReader($stream)
          [PSCustomObject]@{
            Name = $_.FullName
            Content = $reader.ReadToEnd()
          }
        } finally {
          $stream.Dispose()
        }
      }
  } finally {
    $archive.Dispose()
  }
}

function Extract-Docx([string]$filePath) {
  $parts = @()
  foreach ($entry in Get-ZipEntries $filePath 'word/') {
    if ($entry.Name -like '*.xml') {
      $parts += [regex]::Matches($entry.Content, '<w:t[^>]*>(.*?)</w:t>') | ForEach-Object { Decode-XmlText($_.Groups[1].Value) }
    }
  }
  return ($parts | Where-Object { $_ }) -join [Environment]::NewLine
}

function Extract-Pptx([string]$filePath) {
  $slides = @()
  foreach ($entry in Get-ZipEntries $filePath 'ppt/slides/') {
    if ($entry.Name -like '*.xml') {
      $texts = [regex]::Matches($entry.Content, '<a:t[^>]*>(.*?)</a:t>') | ForEach-Object { Decode-XmlText($_.Groups[1].Value) }
      if ($texts.Count -gt 0) {
        $slides += ('[' + $entry.Name + ']')
        $slides += $texts
      }
    }
  }
  return ($slides | Where-Object { $_ }) -join [Environment]::NewLine
}

function Extract-Xlsx([string]$filePath) {
  $sharedStrings = @()
  $sharedXml = Get-ZipEntryText $filePath 'xl/sharedStrings.xml'
  if ($sharedXml) {
    $sharedStrings = [regex]::Matches($sharedXml, '<t[^>]*>(.*?)</t>') | ForEach-Object { Decode-XmlText($_.Groups[1].Value) }
  }

  $lines = @()
  foreach ($entry in Get-ZipEntries $filePath 'xl/worksheets/') {
    if ($entry.Name -like '*.xml') {
      $sheetValues = @()
      foreach ($cell in [regex]::Matches($entry.Content, '<c[^>]*?(?: t="(?<type>[^"]+)")?[^>]*>(?<inner>.*?)</c>')) {
        $type = $cell.Groups['type'].Value
        $inner = $cell.Groups['inner'].Value
        $valueMatch = [regex]::Match($inner, '<v>(.*?)</v>')
        $inlineMatch = [regex]::Match($inner, '<t[^>]*>(.*?)</t>')
        if ($inlineMatch.Success) {
          $sheetValues += Decode-XmlText($inlineMatch.Groups[1].Value)
          continue
        }
        if ($valueMatch.Success) {
          if ($type -eq 's') {
            $index = 0
            if ([int]::TryParse($valueMatch.Groups[1].Value, [ref]$index) -and $index -lt $sharedStrings.Count) {
              $sheetValues += $sharedStrings[$index]
            }
          } else {
            $sheetValues += Decode-XmlText($valueMatch.Groups[1].Value)
          }
        }
      }
      if ($sheetValues.Count -gt 0) {
        $lines += ('[' + $entry.Name + ']')
        $lines += $sheetValues
      }
    }
  }
  return ($lines | Where-Object { $_ }) -join [Environment]::NewLine
}

function Extract-WordLegacy([string]$filePath) {
  $word = $null
  $doc = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $doc = $word.Documents.Open($filePath, $false, $true)
    return $doc.Content.Text
  } finally {
    if ($doc) { $doc.Close() | Out-Null }
    if ($word) { $word.Quit() | Out-Null }
  }
}

function Extract-ExcelLegacy([string]$filePath) {
  $excel = $null
  $workbook = $null
  try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $workbook = $excel.Workbooks.Open($filePath, 0, $true)
    $lines = @()
    foreach ($sheet in $workbook.Worksheets) {
      $lines += ('[' + $sheet.Name + ']')
      $range = $sheet.UsedRange
      $values = $range.Value2
      if ($values -is [System.Array]) {
        foreach ($row in $values) {
          $lines += (($row | ForEach-Object { if ($_ -ne $null) { $_.ToString() } else { "" } }) -join "\`t")
        }
      } elseif ($values -ne $null) {
        $lines += $values.ToString()
      }
    }
    return ($lines | Where-Object { $_ }) -join [Environment]::NewLine
  } finally {
    if ($workbook) { $workbook.Close($false) | Out-Null }
    if ($excel) { $excel.Quit() | Out-Null }
  }
}

function Extract-PowerPointLegacy([string]$filePath) {
  $powerPoint = $null
  $presentation = $null
  try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $presentation = $powerPoint.Presentations.Open($filePath, $true, $false, $false)
    $lines = @()
    foreach ($slide in $presentation.Slides) {
      $lines += ('[Slide ' + $slide.SlideIndex + ']')
      foreach ($shape in $slide.Shapes) {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
          $lines += $shape.TextFrame.TextRange.Text
        }
      }
    }
    return ($lines | Where-Object { $_ }) -join [Environment]::NewLine
  } finally {
    if ($presentation) { $presentation.Close() }
    if ($powerPoint) { $powerPoint.Quit() }
  }
}

switch ($ext) {
  '.docx' { Write-Output (Extract-Docx $path); break }
  '.pptx' { Write-Output (Extract-Pptx $path); break }
  '.xlsx' { Write-Output (Extract-Xlsx $path); break }
  '.doc' { Write-Output (Extract-WordLegacy $path); break }
  '.xls' { Write-Output (Extract-ExcelLegacy $path); break }
  '.ppt' { Write-Output (Extract-PowerPointLegacy $path); break }
  default { throw "Unsupported office extension: $ext" }
}
`;
}

async function extractOfficeDocumentText(filePath) {
  const output = await runPowerShell(buildOfficeExtractionScript(), {
    AGENT_CLUSTER_DOC_PATH: filePath
  });
  return output.trim();
}

async function readDocumentText(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension) || extension === "") {
    return readFile(filePath, "utf8");
  }

  if (OFFICE_EXTENSIONS.has(extension)) {
    return extractOfficeDocumentText(filePath);
  }

  const binary = await readFile(filePath);
  return binary.toString("utf8");
}

function isSupportedReadableDocument(filePath) {
  const extension = extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension) || extension === "";
}

module.exports = { readDocumentText, isSupportedReadableDocument };

},
"/src/workspace/docx.mjs": function(module, exports, __require) {
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const XML_MIME = "application/xml";
const RELS_MIME =
  "application/vnd.openxmlformats-package.relationships+xml";

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function slugifyTitle(value) {
  return String(value || "")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^[\u2022*-]\s+/, "")
    .replace(/\s+/g, " ");
}

function inferTitle(title, content) {
  const explicitTitle = slugifyTitle(title);
  if (explicitTitle) {
    return explicitTitle;
  }

  const firstNonEmptyLine = normalizeText(content)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  return slugifyTitle(firstNonEmptyLine || "Generated Report");
}

function splitParagraphs(content) {
  return normalizeText(content)
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function parseContentBlocks(content, title = "") {
  const blocks = [];
  const normalizedTitle = inferTitle(title, content);
  if (normalizedTitle) {
    blocks.push({
      style: "Title",
      text: normalizedTitle
    });
  }

  for (const paragraph of splitParagraphs(content)) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        blocks.push({
          style: `Heading${headingMatch[1].length}`,
          text: slugifyTitle(headingMatch[2])
        });
        continue;
      }

      const bulletMatch = line.match(/^[\u2022*-]\s+(.+)$/);
      if (bulletMatch) {
        blocks.push({
          style: "Normal",
          text: `• ${bulletMatch[1].trim()}`
        });
        continue;
      }

      blocks.push({
        style: "Normal",
        text: line
      });
    }
  }

  if (blocks.length === 1) {
    blocks.push({
      style: "Normal",
      text: normalizedTitle
    });
  }

  return blocks;
}

function buildRunXml(text) {
  return [
    "<w:r>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/>',
    "</w:rPr>",
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`,
    "</w:r>"
  ].join("");
}

function buildParagraphXml(block) {
  return [
    "<w:p>",
    "<w:pPr>",
    `<w:pStyle w:val="${escapeXml(block.style || "Normal")}"/>`,
    "</w:pPr>",
    buildRunXml(block.text),
    "</w:p>"
  ].join("");
}

function buildDocumentXml(blocks) {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    ' xmlns:o="urn:schemas-microsoft-com:office:office"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
    ' xmlns:v="urn:schemas-microsoft-com:vml"',
    ' xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    ' xmlns:w10="urn:schemas-microsoft-com:office:word"',
    ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    ' xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
    ' xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
    ' xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"',
    ' xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"',
    ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
    ' mc:Ignorable="w14 wp14">',
    "<w:body>",
    ...blocks.map((block) => buildParagraphXml(block)),
    "<w:sectPr>",
    '<w:pgSz w:w="11906" w:h="16838"/>',
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>',
    '<w:cols w:space="720"/>',
    '<w:docGrid w:linePitch="360"/>',
    "</w:sectPr>",
    "</w:body>",
    "</w:document>"
  ].join("");
}

function buildStylesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:docDefaults>",
    "<w:rPrDefault>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/>',
    '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>',
    '<w:sz w:val="22"/>',
    '<w:szCs w:val="22"/>',
    "</w:rPr>",
    "</w:rPrDefault>",
    "<w:pPrDefault>",
    '<w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr>',
    "</w:pPrDefault>",
    "</w:docDefaults>",
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">',
    "<w:name w:val=\"Normal\"/>",
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Title">',
    '<w:name w:val="Title"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="32"/><w:szCs w:val="32"/>',
    "</w:rPr>",
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="280"/></w:pPr>',
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Heading1">',
    '<w:name w:val="heading 1"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="28"/><w:szCs w:val="28"/>',
    "</w:rPr>",
    '<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>',
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Heading2">',
    '<w:name w:val="heading 2"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="24"/><w:szCs w:val="24"/>',
    "</w:rPr>",
    '<w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr>',
    "</w:style>",
    '<w:style w:type="paragraph" w:styleId="Heading3">',
    '<w:name w:val="heading 3"/>',
    "<w:qFormat/>",
    "<w:rPr>",
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimHei"/>',
    "<w:b/><w:bCs/>",
    '<w:sz w:val="22"/><w:szCs w:val="22"/>',
    "</w:rPr>",
    '<w:pPr><w:spacing w:before="120" w:after="80"/></w:pPr>',
    "</w:style>",
    "</w:styles>"
  ].join("");
}

function buildRootRelationshipsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>"
  ].join("");
}

function buildDocumentRelationshipsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>"
  ].join("");
}

function buildContentTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    `<Default Extension="rels" ContentType="${RELS_MIME}"/>`,
    `<Default Extension="xml" ContentType="${XML_MIME}"/>`,
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}"/>`,
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    "</Types>"
  ].join("");
}

function buildCoreXml(title, createdAtIso) {
  const escapedTitle = escapeXml(title);
  const escapedTimestamp = escapeXml(createdAtIso);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapedTitle}</dc:title>`,
    "<dc:creator>Agent Cluster Workbench</dc:creator>",
    "<cp:lastModifiedBy>Agent Cluster Workbench</cp:lastModifiedBy>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${escapedTimestamp}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${escapedTimestamp}</dcterms:modified>`,
    "</cp:coreProperties>"
  ].join("");
}

function buildAppXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>Agent Cluster Workbench</Application>",
    "</Properties>"
  ].join("");
}

function getDosDateTime(date = new Date()) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds
  };
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const dataBuffer = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(String(entry.content ?? ""), "utf8");
    const checksum = crc32(dataBuffer);
    const { date, time } = getDosDateTime(entry.modifiedAt);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectoryBuffer = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectoryBuffer.length, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectoryBuffer, endRecord]);
}

function createDocxBuffer({ title = "", content = "" } = {}) {
  const blocks = parseContentBlocks(content, title);
  const createdAt = new Date();
  const resolvedTitle = inferTitle(title, content);

  return createZipBuffer([
    {
      name: "[Content_Types].xml",
      content: buildContentTypesXml(),
      modifiedAt: createdAt
    },
    {
      name: "_rels/.rels",
      content: buildRootRelationshipsXml(),
      modifiedAt: createdAt
    },
    {
      name: "docProps/core.xml",
      content: buildCoreXml(resolvedTitle, createdAt.toISOString()),
      modifiedAt: createdAt
    },
    {
      name: "docProps/app.xml",
      content: buildAppXml(),
      modifiedAt: createdAt
    },
    {
      name: "word/document.xml",
      content: buildDocumentXml(blocks),
      modifiedAt: createdAt
    },
    {
      name: "word/styles.xml",
      content: buildStylesXml(),
      modifiedAt: createdAt
    },
    {
      name: "word/_rels/document.xml.rels",
      content: buildDocumentRelationshipsXml(),
      modifiedAt: createdAt
    }
  ]);
}

module.exports = { createDocxBuffer };

},
"/src/providers/http-client.mjs": function(module, exports, __require) {
const { abortableSleep, createAbortError, getAbortMessage, isAbortError, throwIfAborted } = __require("/src/utils/abort.mjs");
function resolveApiKey(modelConfig) {
  if (modelConfig.apiKey) {
    return modelConfig.apiKey;
  }

  if (modelConfig.apiKeyEnv && process.env[modelConfig.apiKeyEnv]) {
    return process.env[modelConfig.apiKeyEnv];
  }

  if (modelConfig.authStyle === "none") {
    return "";
  }

  throw new Error(
    `Model "${modelConfig.id}" requires an API key. Set ${modelConfig.apiKeyEnv || "apiKey"} first.`
  );
}

function buildHeaders(modelConfig) {
  const headers = {
    "Content-Type": "application/json",
    ...(modelConfig.extraHeaders || {})
  };

  const authStyle = modelConfig.authStyle || "bearer";
  if (authStyle === "none" && modelConfig.apiKeyEnv) {
    throw new Error(
      `Model "${modelConfig.id}" is configured with authStyle "none", so no API key will be sent to ${modelConfig.baseUrl}. Change authStyle to "bearer" or "api-key", or clear apiKeyEnv if the endpoint is intentionally unauthenticated.`
    );
  }

  const apiKey = resolveApiKey(modelConfig);

  if (authStyle === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (authStyle === "api-key") {
    headers[modelConfig.apiKeyHeader || "api-key"] = apiKey;
  } else if (authStyle !== "none") {
    throw new Error(`Unsupported authStyle "${authStyle}" on model "${modelConfig.id}".`);
  }

  return headers;
}

function isCodexLikeModel(modelConfig) {
  return /codex/i.test(String(modelConfig?.model || modelConfig?.id || ""));
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(status);
}

function isRetryableNetworkError(error) {
  if (!error) {
    return false;
  }

  if (isAbortError(error)) {
    return false;
  }

  if (error.timeout) {
    return true;
  }

  const detail = `${error.message || ""} ${error.cause?.code || ""} ${error.cause?.message || ""}`.toLowerCase();
  return /fetch failed|network|timed out|timeout|econnreset|econnrefused|socket|enotfound|eai_again|other side closed/.test(
    detail
  );
}

function resolveRetryAttempts(modelConfig) {
  const explicit = Number(modelConfig.retryAttempts);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }

  return 10;
}

function resolveRetryBaseMs(modelConfig) {
  const explicit = Number(modelConfig.retryBaseMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  return isCodexLikeModel(modelConfig) ? 1500 : 800;
}

function resolveRetryMaxMs(modelConfig) {
  const explicit = Number(modelConfig.retryMaxMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  return isCodexLikeModel(modelConfig) ? 15000 : 10000;
}

function parseRetryAfterMs(headerValue) {
  const value = String(headerValue || "").trim();
  if (!value) {
    return 0;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return 0;
}

function computeRetryDelayMs(modelConfig, attempt, error) {
  const baseMs = resolveRetryBaseMs(modelConfig);
  const maxMs = resolveRetryMaxMs(modelConfig);
  const exponentialMs = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitterMs = Math.round(exponentialMs * 0.2 * Math.random());
  const retryAfterMs = Math.min(maxMs, Math.max(0, Number(error?.retryAfterMs || 0)));
  return Math.max(exponentialMs + jitterMs, retryAfterMs);
}

function isHtmlPayload(response, responseText) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const trimmed = String(responseText || "").trim().toLowerCase();
  return contentType.includes("text/html") || trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function summarizeHtmlGatewayError(response, url, responseText) {
  const titleMatch = String(responseText || "").match(/<title>([^<]+)<\/title>/i);
  const title = compactWhitespace(titleMatch?.[1] || "");
  const status = response.status;
  const summary = title || `HTTP ${status}`;
  return `Request to ${url} failed: upstream gateway returned ${status}${summary ? ` (${summary})` : ""}. This usually means the provider base URL is temporarily down or its upstream model service failed.`;
}

function summarizeHtmlNonApiError(response, url, responseText) {
  const titleMatch = String(responseText || "").match(/<title>([^<]+)<\/title>/i);
  const title = compactWhitespace(titleMatch?.[1] || "");
  const status = Number(response?.status) || 0;
  const prefix = status > 0 ? `HTTP ${status}` : "HTML page";
  const summary = title ? ` (${title})` : "";
  return `Request to ${url} failed: the provider returned an HTML page instead of API JSON${summary || ` (${prefix})`}. This usually means the base URL is behind browser protection, points to a website page instead of the API endpoint, or the reverse proxy gateway is misconfigured.`;
}

function isMoonshotResponsesRoute(urlOrBaseUrl) {
  return /^https:\/\/api\.moonshot\.cn\/v1(?:\/responses)?$/i.test(String(urlOrBaseUrl || "").replace(/\/+$/, ""));
}

function isMoonshotAnthropicMisroute(urlOrBaseUrl) {
  return /^https:\/\/api\.moonshot\.cn\/v1(?:\/messages)?$/i.test(
    String(urlOrBaseUrl || "").replace(/\/+$/, "")
  );
}

function buildMoonshotResponsesHint(modelConfig, url, response, parsedBody, responseText) {
  if (!isMoonshotResponsesRoute(url) && !isMoonshotResponsesRoute(modelConfig?.baseUrl)) {
    return "";
  }

  const status = Number(response?.status) || 0;
  const detail = `${parsedBody?.error?.message || ""} ${parsedBody?.message || ""} ${responseText || ""}`.trim();
  if (status !== 404 && !/没找到对象|not found|404/i.test(detail)) {
    return "";
  }

  return ' Moonshot 的公开 API 通常走 "/chat/completions"。如果你当前 baseUrl 是 "https://api.moonshot.cn/v1"，请把 provider 改成 "openai-chat"，不要选 "openai-responses"。';
}

function buildMoonshotAnthropicHint(modelConfig, url, response, parsedBody, responseText) {
  const provider = String(modelConfig?.provider || "").trim().toLowerCase();
  if (
    provider !== "kimi-coding" &&
    !isMoonshotAnthropicMisroute(url) &&
    !isMoonshotAnthropicMisroute(modelConfig?.baseUrl)
  ) {
    return "";
  }

  const status = Number(response?.status) || 0;
  const detail = `${parsedBody?.error?.message || ""} ${parsedBody?.message || ""} ${responseText || ""}`.trim();
  if (status !== 404 && !/没找到对象|not found|404/i.test(detail)) {
    return "";
  }

  return ' Moonshot 的 Anthropic 兼容接口通常走 "https://api.moonshot.cn/anthropic/messages"。如果你在使用 Kimi Coding / Claude Code 兼容路由，请把 baseUrl 改成 "https://api.moonshot.cn/anthropic"。';
}

function buildErrorMessage(response, url, responseText, parsedBody, modelConfig) {
  if (isHtmlPayload(response, responseText) && isRetryableStatus(response.status)) {
    return summarizeHtmlGatewayError(response, url, responseText);
  }

  if (isHtmlPayload(response, responseText)) {
    return summarizeHtmlNonApiError(response, url, responseText);
  }

  const detail =
    parsedBody?.error?.message ||
    parsedBody?.message ||
    compactWhitespace(responseText).slice(0, 300) ||
    `HTTP ${response.status}`;

  return `Request to ${url} failed: ${detail}${buildMoonshotResponsesHint(modelConfig, url, response, parsedBody, responseText)}${buildMoonshotAnthropicHint(modelConfig, url, response, parsedBody, responseText)}`;
}

function createTimeoutError(url, timeoutMs, cause = undefined) {
  const error = new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
  error.name = "TimeoutError";
  error.timeout = true;
  error.status = 408;
  error.retryable = true;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

async function postJsonOnce(url, body, modelConfig, hooks = {}) {
  const externalSignal = hooks.signal;
  throwIfAborted(externalSignal);

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(modelConfig.timeoutMs || 210000));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError(url, timeoutMs));
  }, timeoutMs);

  const forwardAbort = () => {
    controller.abort(externalSignal?.reason || createAbortError(getAbortMessage(externalSignal)));
  };

  externalSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(modelConfig),
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (externalSignal?.aborted && !timedOut) {
        throw createAbortError(getAbortMessage(externalSignal), error);
      }

      if (timedOut) {
        throw createTimeoutError(url, timeoutMs, error);
      }

      const wrapped = new Error(
        `Request to ${url} failed: ${error.message}`
      );
      wrapped.retryable = isRetryableNetworkError(error);
      wrapped.cause = error;
      throw wrapped;
    }

    const responseText = await response.text();
    if (isHtmlPayload(response, responseText)) {
      const error = new Error(
        isRetryableStatus(response.status)
          ? summarizeHtmlGatewayError(response, url, responseText)
          : summarizeHtmlNonApiError(response, url, responseText)
      );
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      error.retryable = response.ok ? true : undefined;
      throw error;
    }

    let parsedBody = null;
    try {
      parsedBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      parsedBody = { raw: responseText };
    }

    if (!response.ok) {
      const error = new Error(buildErrorMessage(response, url, responseText, parsedBody, modelConfig));
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw error;
    }

    return parsedBody;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

async function postJson(url, body, modelConfig, hooks = {}) {
  throwIfAborted(hooks.signal);
  const retries = resolveRetryAttempts(modelConfig);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postJsonOnce(url, body, modelConfig, hooks);
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) {
        throw error;
      }
      const retryable = Boolean(error.retryable) || isRetryableStatus(error.status);
      if (!retryable || attempt === retries) {
        if (attempt > 0) {
          error.message = `${error.message} Retried ${attempt} time${attempt === 1 ? "" : "s"}.`;
        }
        throw error;
      }

      const backoffMs = computeRetryDelayMs(modelConfig, attempt, error);
      if (typeof hooks.onRetry === "function") {
        hooks.onRetry({
          attempt: attempt + 1,
          maxRetries: retries,
          nextDelayMs: backoffMs,
          status: error.status || null,
          message: error.message,
          modelId: modelConfig.id,
          model: modelConfig.model,
          baseUrl: modelConfig.baseUrl,
          purpose: hooks.purpose || null
        });
      }
      await abortableSleep(backoffMs, hooks.signal);
    }
  }

  throw lastError;
}

module.exports = { postJson };

},
"/src/utils/runtime-context.mjs": function(module, exports, __require) {
function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeDateString(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function normalizeTimeString(value) {
  const normalized = String(value || "").trim();
  return /^\d{2}:\d{2}(:\d{2})?$/.test(normalized)
    ? (normalized.length === 5 ? `${normalized}:00` : normalized)
    : "";
}

function resolveRuntimeNow(options = {}) {
  if (options.now instanceof Date) {
    return options.now;
  }

  const overrideDate = normalizeDateString(
    options.currentDate ||
      process.env.AGENT_CLUSTER_CURRENT_DATE ||
      process.env.CODEX_CURRENT_DATE
  );
  const overrideTime = normalizeTimeString(
    options.currentTime ||
      process.env.AGENT_CLUSTER_CURRENT_TIME
  );

  if (overrideDate) {
    const candidate = new Date(`${overrideDate}T${overrideTime || "12:00:00"}`);
    if (!Number.isNaN(candidate.valueOf())) {
      return candidate;
    }
  }

  return new Date();
}

function extractDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: parts.year || "0000",
    month: parts.month || "01",
    day: parts.day || "01",
    hour: parts.hour || "00",
    minute: parts.minute || "00",
    second: parts.second || "00"
  };
}

function getRuntimeCalendarContext(options = {}) {
  const now = resolveRuntimeNow(options);
  const timeZone =
    String(options.timeZone || process.env.AGENT_CLUSTER_TIMEZONE || "").trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const parts = extractDateParts(now, timeZone);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;

  return {
    now,
    timeZone,
    localDate,
    localTime,
    localDateTime: `${localDate} ${localTime}`,
    isoTimestamp: now.toISOString()
  };
}

function renderRuntimeCalendarNote(options = {}) {
  const context = getRuntimeCalendarContext(options);
  return [
    `Authoritative runtime clock: ${context.localDateTime} (${context.timeZone}).`,
    `This runtime clock overrides any background assumption about today's date. Do not claim the current date is anything else.`,
    `Treat any explicit date on or before ${context.localDate} as historical, not future.`,
    "Anchor relative terms such as today, yesterday, and tomorrow only to the authoritative runtime clock above."
  ].join(" ");
}

module.exports = { getRuntimeCalendarContext, renderRuntimeCalendarNote };

},
"/src/workspace/commands.mjs": function(module, exports, __require) {
const { spawn } = require("node:child_process");
const { extname } = require("node:path");
const { ensureWorkspaceDirectory, resolveWorkspacePath } = __require("/src/workspace/fs.mjs");
const { createAbortError, getAbortMessage, throwIfAborted } = __require("/src/utils/abort.mjs");
const MAX_OUTPUT_BYTES = 200000;
const DEFAULT_TIMEOUT_MS = 90000;
const MAX_TIMEOUT_MS = 180000;
const ALLOWED_EXECUTABLES = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "rg",
  "rg.exe",
  "python",
  "py",
  "pytest",
  "dotnet",
  "cargo",
  "go",
  "java",
  "javac",
  "mvn",
  "gradle",
  "gradlew",
  "git",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe"
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(["status", "diff", "show", "log", "rev-parse", "ls-files"]);
const SAFE_SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".py", ".ps1", ".cmd", ".bat", ".sh"]);
const BLOCKED_ARGUMENT_SNIPPETS = [
  "rm -rf",
  "remove-item",
  "del /f",
  "format",
  "mkfs",
  "shutdown",
  "reboot",
  "git reset --hard",
  "git clean -fd",
  "git clean -xdf",
  "powershell -command",
  "powershell -encodedcommand",
  "pwsh -command",
  "pwsh -encodedcommand",
  "cmd /c del",
  "cmd /c rd"
];

function normalizeExecutable(command) {
  return String(command || "").trim().toLowerCase();
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((item) => String(item ?? "")) : [];
}

function truncateOutput(value) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return {
      text,
      truncated: false
    };
  }

  return {
    text: text.slice(0, MAX_OUTPUT_BYTES),
    truncated: true
  };
}

function validateCommandPolicy(workspaceDir, command, args) {
  const executable = normalizeExecutable(command);
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`Command "${command}" is not allowed inside the workspace command tool.`);
  }

  const combined = [executable, ...args].join(" ").toLowerCase();
  if (BLOCKED_ARGUMENT_SNIPPETS.some((snippet) => combined.includes(snippet))) {
    throw new Error(`Command "${command}" contains blocked arguments for safety reasons.`);
  }

  if (executable === "git" && !ALLOWED_GIT_SUBCOMMANDS.has(String(args[0] || "").trim())) {
    throw new Error("Only read-only git commands are allowed inside the workspace command tool.");
  }

  if (executable === "node" && ["-e", "--eval"].includes(String(args[0] || "").trim())) {
    throw new Error("node eval arguments are blocked. Run a script file from the workspace instead.");
  }

  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) {
    const mode = String(args[0] || "").trim().toLowerCase();
    if (!["-file", "-f"].includes(mode)) {
      throw new Error("PowerShell commands must use -File with a script inside the workspace.");
    }

    const scriptPath = String(args[1] || "").trim();
    const resolved = resolveWorkspacePath(workspaceDir, scriptPath);
    if (!SAFE_SCRIPT_EXTENSIONS.has(extname(resolved.relativePath).toLowerCase())) {
      throw new Error("Only workspace script files can be executed with PowerShell.");
    }
  }

  if (["cmd", "cmd.exe"].includes(executable)) {
    const mode = String(args[0] || "").trim().toLowerCase();
    if (mode !== "/c") {
      throw new Error("cmd commands must use /c with a batch script inside the workspace.");
    }

    const scriptPath = String(args[1] || "").trim();
    const resolved = resolveWorkspacePath(workspaceDir, scriptPath);
    if (![".cmd", ".bat"].includes(extname(resolved.relativePath).toLowerCase())) {
      throw new Error("Only .cmd or .bat workspace scripts can be executed with cmd.");
    }
  }
}

async function runWorkspaceCommand(workspaceDir, command, args = [], options = {}) {
  await ensureWorkspaceDirectory(workspaceDir);
  throwIfAborted(options.signal);
  const normalizedCommand = String(command || "").trim();
  const normalizedArgs = normalizeArgs(args);
  validateCommandPolicy(workspaceDir, normalizedCommand, normalizedArgs);

  const cwd = String(options.cwd || ".").trim() || ".";
  const cwdPath = resolveWorkspacePath(workspaceDir, cwd);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))
  );

  return new Promise((resolve, reject) => {
    const child = spawn(normalizedCommand, normalizedArgs, {
      cwd: cwdPath.absolutePath,
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill();
    };

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      cleanup();
      if (aborted || options.signal?.aborted) {
        reject(createAbortError(getAbortMessage(options.signal), error));
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      if (aborted || options.signal?.aborted) {
        reject(createAbortError(getAbortMessage(options.signal)));
        return;
      }
      const normalizedStdout = truncateOutput(stdout);
      const normalizedStderr = truncateOutput(stderr);
      resolve({
        command: normalizedCommand,
        args: normalizedArgs,
        cwd: cwdPath.relativePath,
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
        signal: signal || "",
        timedOut,
        success: !timedOut && Number(exitCode) === 0,
        stdout: normalizedStdout.text,
        stderr: normalizedStderr.text,
        stdoutTruncated: normalizedStdout.truncated,
        stderrTruncated: normalizedStderr.truncated
      });
    });
  });
}

module.exports = { runWorkspaceCommand };

},
"/src/workspace/command-policy.mjs": function(module, exports, __require) {
const WORKSPACE_COMMAND_SCOPES = Object.freeze({
  NONE: "none",
  READ_ONLY: "read_only",
  VERIFY: "verify",
  SAFE_EXECUTION: "safe_execution"
});

const SCOPE_RANK = Object.freeze({
  [WORKSPACE_COMMAND_SCOPES.NONE]: 0,
  [WORKSPACE_COMMAND_SCOPES.READ_ONLY]: 1,
  [WORKSPACE_COMMAND_SCOPES.VERIFY]: 2,
  [WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION]: 3
});

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "show",
  "log",
  "rev-parse",
  "ls-files"
]);
const READ_ONLY_EXECUTABLES = new Set(["rg", "rg.exe"]);

const VERIFY_KEYWORD_PATTERN =
  /\b(test|tests|spec|verify|verification|check|lint|build|validate|validation|smoke|typecheck|compile|coverage|vet|clippy|assemble|audit|ci)\b/i;
const VERIFY_TOOL_PATTERN =
  /^(vitest|jest|mocha|ava|tap|eslint|tsc|tsx|vite|webpack|rollup|tsup|playwright|cypress|ruff|mypy|pytest|coverage|nyc|turbo|prettier)$/i;

function safeString(value) {
  return String(value || "").trim();
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((item) => String(item ?? "")) : [];
}

function findFirstNonFlag(args, startIndex = 0) {
  for (let index = Math.max(0, startIndex); index < args.length; index += 1) {
    const value = safeString(args[index]);
    if (!value || value.startsWith("-")) {
      continue;
    }
    return value;
  }

  return "";
}

function looksLikeVerificationToken(value) {
  const normalized = safeString(value);
  if (!normalized) {
    return false;
  }

  const tail = normalized.split(/[\\/]/).pop() || normalized;
  return VERIFY_KEYWORD_PATTERN.test(normalized) || VERIFY_TOOL_PATTERN.test(tail);
}

function normalizeScope(value) {
  const normalized = safeString(value).toLowerCase();
  return Object.values(WORKSPACE_COMMAND_SCOPES).includes(normalized)
    ? normalized
    : WORKSPACE_COMMAND_SCOPES.NONE;
}

function isKnownScope(value) {
  return Object.values(WORKSPACE_COMMAND_SCOPES).includes(safeString(value).toLowerCase());
}

function resolveScriptTarget(executable, args) {
  if (["node", "java", "javac"].includes(executable)) {
    return findFirstNonFlag(args);
  }

  if (["python", "py"].includes(executable)) {
    if (safeString(args[0]).toLowerCase() === "-m") {
      return safeString(args[1]);
    }
    return findFirstNonFlag(args);
  }

  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) {
    return safeString(args[1]);
  }

  if (["cmd", "cmd.exe"].includes(executable)) {
    return safeString(args[1]);
  }

  return "";
}

function classifyPackageManagerScope(executable, args) {
  const primary = safeString(args[0]).toLowerCase();
  const secondary = safeString(args[1]).toLowerCase();

  if (["npm", "pnpm"].includes(executable)) {
    if (["test", "lint", "build"].includes(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (["run", "exec"].includes(primary) && looksLikeVerificationToken(secondary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "dlx" && looksLikeVerificationToken(secondary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "yarn") {
    if (["test", "lint", "build"].includes(primary) || looksLikeVerificationToken(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "run" && looksLikeVerificationToken(secondary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "npx") {
    const tool = findFirstNonFlag(args);
    return looksLikeVerificationToken(tool)
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

function classifyScriptExecutionScope(executable, args) {
  if (["python", "py"].includes(executable) && safeString(args[0]).toLowerCase() === "-m") {
    return looksLikeVerificationToken(args[1])
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  const target = resolveScriptTarget(executable, args);
  return looksLikeVerificationToken(target)
    ? WORKSPACE_COMMAND_SCOPES.VERIFY
    : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

function classifyJvmOrBuildScope(executable, args) {
  const primary = safeString(args[0]).toLowerCase();
  const remaining = args.map((item) => safeString(item).toLowerCase());

  if (executable === "dotnet") {
    if (["test", "build", "restore"].includes(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "format" && remaining.includes("--verify-no-changes")) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "cargo") {
    if (["test", "check", "build", "clippy"].includes(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "fmt" && remaining.includes("--check")) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "go") {
    return ["test", "build", "vet"].includes(primary)
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "mvn") {
    return remaining.some((item) => looksLikeVerificationToken(item))
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (["gradle", "gradlew"].includes(executable)) {
    return remaining.some((item) => looksLikeVerificationToken(item))
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "pytest" || executable === "javac") {
    return WORKSPACE_COMMAND_SCOPES.VERIFY;
  }

  return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

function normalizeWorkspaceCommandScope(value, fallback = WORKSPACE_COMMAND_SCOPES.NONE) {
  if (isKnownScope(value)) {
    return normalizeScope(value);
  }
  return normalizeScope(fallback);
}

function getWorkspaceCommandScopeRank(value) {
  return SCOPE_RANK[normalizeWorkspaceCommandScope(value)] ?? 0;
}

function clampWorkspaceCommandScope(value, ceiling = WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION) {
  const normalizedValue = normalizeWorkspaceCommandScope(value);
  const normalizedCeiling = normalizeWorkspaceCommandScope(
    ceiling,
    WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
  );
  return getWorkspaceCommandScopeRank(normalizedValue) <= getWorkspaceCommandScopeRank(normalizedCeiling)
    ? normalizedValue
    : normalizedCeiling;
}

function describeWorkspaceCommandScope(value) {
  switch (normalizeWorkspaceCommandScope(value)) {
    case WORKSPACE_COMMAND_SCOPES.READ_ONLY:
      return "read-only workspace inspection commands";
    case WORKSPACE_COMMAND_SCOPES.VERIFY:
      return "read-only inspection plus verification, test, lint, and build commands";
    case WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION:
      return "the full safe workspace command set";
    default:
      return "no workspace commands";
  }
}

function formatWorkspaceCommand(command, args = []) {
  return [safeString(command), ...normalizeArgs(args)].filter(Boolean).join(" ").trim();
}

function resolveRequiredWorkspaceCommandScope(command, args = []) {
  const executable = safeString(command).toLowerCase();
  const normalizedArgs = normalizeArgs(args);

  if (!executable) {
    return WORKSPACE_COMMAND_SCOPES.NONE;
  }

  if (executable === "git" && READ_ONLY_GIT_SUBCOMMANDS.has(safeString(normalizedArgs[0]).toLowerCase())) {
    return WORKSPACE_COMMAND_SCOPES.READ_ONLY;
  }

  if (READ_ONLY_EXECUTABLES.has(executable)) {
    return WORKSPACE_COMMAND_SCOPES.READ_ONLY;
  }

  if (["npm", "npx", "pnpm", "yarn"].includes(executable)) {
    return classifyPackageManagerScope(executable, normalizedArgs);
  }

  if (
    ["node", "python", "py", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe"].includes(
      executable
    )
  ) {
    return classifyScriptExecutionScope(executable, normalizedArgs);
  }

  if (["pytest", "dotnet", "cargo", "go", "javac", "mvn", "gradle", "gradlew"].includes(executable)) {
    return classifyJvmOrBuildScope(executable, normalizedArgs);
  }

  return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

class WorkspaceCommandScopeError extends Error {
  constructor(command, args, allowedScope, requiredScope) {
    const commandText = formatWorkspaceCommand(command, args) || safeString(command) || "(empty command)";
    const normalizedAllowedScope = normalizeWorkspaceCommandScope(allowedScope);
    const normalizedRequiredScope = normalizeWorkspaceCommandScope(requiredScope);
    super(
      `Blocked run_command "${commandText}" because this task only allows ${describeWorkspaceCommandScope(
        normalizedAllowedScope
      )}.`
    );
    this.name = "WorkspaceCommandScopeError";
    this.code = "WORKSPACE_COMMAND_SCOPE_BLOCKED";
    this.command = safeString(command);
    this.args = normalizeArgs(args);
    this.commandText = commandText;
    this.allowedScope = normalizedAllowedScope;
    this.requiredScope = normalizedRequiredScope;
  }
}

function assertWorkspaceCommandAllowedForScope(command, args = [], allowedScope) {
  const normalizedAllowedScope = normalizeWorkspaceCommandScope(allowedScope);
  const requiredScope = resolveRequiredWorkspaceCommandScope(command, args);
  if (getWorkspaceCommandScopeRank(requiredScope) > getWorkspaceCommandScopeRank(normalizedAllowedScope)) {
    throw new WorkspaceCommandScopeError(command, args, normalizedAllowedScope, requiredScope);
  }

  return {
    allowedScope: normalizedAllowedScope,
    requiredScope
  };
}

module.exports = { normalizeWorkspaceCommandScope, getWorkspaceCommandScopeRank, clampWorkspaceCommandScope, describeWorkspaceCommandScope, formatWorkspaceCommand, resolveRequiredWorkspaceCommandScope, assertWorkspaceCommandAllowedForScope, WorkspaceCommandScopeError, WORKSPACE_COMMAND_SCOPES };

},
"/src/static/i18n-core.js": function(module, exports, __require) {
function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function resolveRuntimeLocale(root = typeof document !== "undefined" ? document : null) {
  const lang = String(root?.documentElement?.lang || "").toLowerCase();
  return lang.startsWith("en") ? "en-US" : "zh-CN";
}

function createCatalogTranslator(catalog, options = {}) {
  const fallbackLocale = options.fallbackLocale || "zh-CN";
  const resolveLocale =
    typeof options.resolveLocale === "function"
      ? options.resolveLocale
      : () => resolveRuntimeLocale();

  return (key, values = {}) => {
    const locale = resolveLocale();
    return interpolate(catalog?.[locale]?.[key] ?? catalog?.[fallbackLocale]?.[key] ?? key, values);
  };
}

module.exports = { interpolate, resolveRuntimeLocale, createCatalogTranslator };

}
};
const __cache = Object.create(null);
function __require(moduleId) {
  if (!moduleId.startsWith("/")) return require(moduleId);
  if (__cache[moduleId]) return __cache[moduleId].exports;
  const module = { exports: {} };
  __cache[moduleId] = module;
  __modules[moduleId](module, module.exports, __require);
  return module.exports;
}
__require("/src/sea-main.mjs");

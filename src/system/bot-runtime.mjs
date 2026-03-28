import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { loadRuntimeConfig } from "../config.mjs";

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

export function createBotRuntimeManager({ projectDir, runtimeConfigOptions = {} }) {
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

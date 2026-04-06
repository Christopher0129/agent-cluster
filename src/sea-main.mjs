import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { getAsset } from "node:sea";
import { dirname, join } from "node:path";
import process, { argv, execPath } from "node:process";
import { createAppServer, resolveRuntimePort } from "./app.mjs";

const HIDDEN_LAUNCH_ARG = "--sea-hidden-launch";
const SHOW_CONSOLE_ARG = "--show-console";
const NO_OPEN_ARG = "--no-open";
const BROWSER_LAUNCH_TIMEOUT_MS = 400;
const APP_STARTUP_LOG_FILE = "app-startup.log";
const APP_STARTUP_STATUS_FILE = "app-startup-status.json";

function getProjectDir() {
  return dirname(execPath);
}

function getAssetBuffer(assetPath) {
  return Buffer.from(getAsset(assetPath));
}

function getNormalizedLaunchArgs() {
  return argv.slice(1).filter((value) => String(value || "").trim() && value !== execPath);
}

function getStartupLogDir() {
  return join(getProjectDir(), "task-logs");
}

function getStartupLogPath() {
  return join(getStartupLogDir(), APP_STARTUP_LOG_FILE);
}

function getStartupStatusPath() {
  return join(getStartupLogDir(), APP_STARTUP_STATUS_FILE);
}

function ensureStartupLogDir() {
  mkdirSync(getStartupLogDir(), { recursive: true });
}

function serializeStartupError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "Unknown startup error");
}

const startupState = {
  sessionId: `startup_${Date.now()}_${process.pid}`,
  pid: process.pid,
  executablePath: execPath,
  projectDir: getProjectDir(),
  rawArgv: [...argv],
  launchArgs: getNormalizedLaunchArgs(),
  platform: process.platform,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  stage: "boot",
  status: "starting",
  port: 0,
  url: "",
  hiddenLaunchRequested: argv.includes(HIDDEN_LAUNCH_ARG),
  showConsoleRequested: argv.includes(SHOW_CONSOLE_ARG),
  browserLaunch: {
    enabled: !argv.includes(NO_OPEN_ARG),
    completed: false,
    success: false,
    launcher: "",
    lastError: "",
    attempts: []
  },
  error: ""
};

function mergeStartupState(extras = {}) {
  if (!extras || typeof extras !== "object") {
    return;
  }

  const next = { ...extras };
  if (next.browserLaunch && typeof next.browserLaunch === "object") {
    startupState.browserLaunch = {
      ...startupState.browserLaunch,
      ...next.browserLaunch
    };
    delete next.browserLaunch;
  }

  Object.assign(startupState, next);
}

function writeStartupStatus() {
  try {
    ensureStartupLogDir();
    startupState.updatedAt = new Date().toISOString();
    writeFileSync(getStartupStatusPath(), JSON.stringify(startupState, null, 2), "utf8");
  } catch {
    // Swallow secondary status-write failures.
  }
}

function appendStartupLog(message) {
  try {
    ensureStartupLogDir();
    appendFileSync(
      getStartupLogPath(),
      `[${new Date().toISOString()}] [${startupState.stage}] ${String(message || "").trim()}\n`,
      "utf8"
    );
  } catch {
    // Swallow secondary log-write failures.
  }
}

function recordStartupStage(stage, message = "", extras = {}) {
  startupState.stage = String(stage || "").trim() || startupState.stage;
  mergeStartupState(extras);
  writeStartupStatus();
  if (message) {
    appendStartupLog(message);
  }
}

function shouldRelaunchHiddenOnWindows() {
  return (
    process.platform === "win32" &&
    !argv.includes(HIDDEN_LAUNCH_ARG) &&
    !argv.includes(SHOW_CONSOLE_ARG)
  );
}

function relaunchHiddenOnWindows() {
  recordStartupStage("relaunch_hidden_parent", "Relaunching packaged app in hidden mode.", {
    status: "relaunching_hidden"
  });
  const child = spawn(execPath, [...argv.slice(1), HIDDEN_LAUNCH_ARG], {
    cwd: getProjectDir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  recordStartupStage(
    "relaunch_hidden_parent_done",
    `Spawned hidden child process ${child.pid || "unknown"}.`,
    {
      status: "relaunching_hidden",
      hiddenChildPid: child.pid || 0
    }
  );
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...options
  });
  child.unref();
  return child;
}

function waitForDetachedLaunch(command, args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnDetached(command, args, options);
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    child.once("error", () => settle(false));
    setTimeout(() => settle(true), BROWSER_LAUNCH_TIMEOUT_MS);
  });
}

async function openBrowser(url) {
  const attempts = [];
  const launchers =
    process.platform === "win32"
      ? [
          ["explorer.exe", [url]],
          ["cmd", ["/c", "start", "", url]],
          ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        ]
      : process.platform === "darwin"
        ? [["open", [url]]]
        : [["xdg-open", [url]]];

  for (const [command, args] of launchers) {
    const launched = await waitForDetachedLaunch(command, args);
    const attempt = {
      command,
      args,
      launched,
      timestamp: new Date().toISOString()
    };
    attempts.push(attempt);
    if (launched) {
      recordStartupStage("browser_launch_succeeded", `Browser launch accepted via ${command}.`, {
        status: "running",
        browserLaunch: {
          completed: true,
          success: true,
          launcher: command,
          lastError: "",
          attempts
        }
      });
      return true;
    }
  }

  const error = new Error(`Failed to open the default browser for ${url}`);
  recordStartupStage("browser_launch_failed", error.message, {
    status: "running_browser_launch_failed",
    browserLaunch: {
      completed: true,
      success: false,
      launcher: "",
      lastError: error.message,
      attempts
    }
  });
  logStartupFailure(error);
  return false;
}

function logStartupFailure(error) {
  try {
    const detail = serializeStartupError(error);
    mergeStartupState({
      status: "failed",
      error: detail
    });
    writeStartupStatus();
    appendStartupLog(detail);
  } catch {
    // Swallow secondary logging failures.
  }
}

recordStartupStage(
  startupState.hiddenLaunchRequested ? "hidden_child_boot" : "boot",
  startupState.hiddenLaunchRequested
    ? "Hidden child process booted."
    : "Startup sequence initialized."
);

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
recordStartupStage("config_ready", "Embedded base config loaded.", {
  status: "config_loaded"
});

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
recordStartupStage("port_resolved", `Resolved runtime port ${port}.`, {
  port,
  status: "binding_server"
});

server.on("error", (error) => {
  recordStartupStage("server_error", `Server failed before listen: ${serializeStartupError(error)}`, {
    status: "failed"
  });
  logStartupFailure(error);
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Cluster Workbench listening at ${url}`);
  recordStartupStage("server_listening", `Server listening at ${url}.`, {
    status: "running",
    port,
    url
  });
  if (!argv.includes(NO_OPEN_ARG)) {
    void openBrowser(url);
  } else {
    recordStartupStage("server_listening_no_open", "Server listening without auto-opening the browser.", {
      status: "running",
      browserLaunch: {
        completed: true,
        success: false,
        launcher: "",
        lastError: "Browser auto-open skipped by --no-open."
      }
    });
  }
});

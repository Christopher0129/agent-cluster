import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { getAsset } from "node:sea";
import { dirname, join } from "node:path";
import process, { argv, execPath } from "node:process";
import { createAppServer, resolveRuntimePort } from "./app.mjs";

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

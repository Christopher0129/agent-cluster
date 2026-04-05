import { spawn } from "node:child_process";
import { getAsset } from "node:sea";
import { dirname, join } from "node:path";
import process, { argv, execPath } from "node:process";
import { createAppServer, resolveRuntimePort } from "./app.mjs";

const HIDDEN_LAUNCH_ARG = "--sea-hidden-launch";
const SHOW_CONSOLE_ARG = "--show-console";

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
    cwd: dirname(execPath),
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

if (shouldRelaunchHiddenOnWindows()) {
  relaunchHiddenOnWindows();
  process.exit(0);
}

const projectDir = dirname(execPath);
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

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Cluster Workbench listening at ${url}`);
  if (!argv.includes("--no-open")) {
    openBrowser(url);
  }
});

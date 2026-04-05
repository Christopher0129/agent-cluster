import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

const nodeCheckFiles = [
  "src/server.mjs",
  "src/app.mjs",
  "src/cluster/orchestrator.mjs",
  "scripts/build-win-exe.mjs",
  "src/workspace/cache.mjs"
];

const importCheckFiles = [
  "src/static/app-bootstrap.js",
  "src/static/app-elements.js",
  "src/static/app-shell-ui.js",
  "src/static/app-state.js",
  "src/static/locale-ui.js",
  "src/static/models-schemes-ui.js",
  "src/static/agent-viz-ui.js",
  "src/static/cluster-run-ui.js",
  "src/static/model-connectivity-service.js",
  "src/static/model-status-ui.js",
  "src/static/secrets-ui.js",
  "src/static/settings-ui.js",
  "src/static/ui-core.js",
  "src/static/workspace-ui.js",
  "src/static/connectivity-ui.js",
  "src/static/run-console-ui.js",
  "src/static/bot-ui.js",
  "src/static/agent-graph-layout.js",
  "src/static/cluster-event-protocol.js",
  "src/static/operation-events.js",
  "src/static/provider-catalog.js"
];

for (const relativePath of nodeCheckFiles) {
  const result = spawnSync(process.execPath, ["--check", relativePath], {
    cwd: projectDir,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const relativePath of importCheckFiles) {
  const moduleUrl = `${pathToFileURL(resolve(projectDir, relativePath)).href}?check=${Date.now()}`;

  try {
    await import(moduleUrl);
  } catch (error) {
    console.error(`Failed to import ${relativePath}`);
    console.error(error);
    process.exit(1);
  }
}

console.log("Syntax checks passed.");

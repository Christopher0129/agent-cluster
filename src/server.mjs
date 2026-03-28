import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppServer, resolveRuntimePort } from "./app.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, "..");
const staticDir = resolve(projectDir, "src", "static");

async function staticAssetLoader(assetPath) {
  return readFile(resolve(staticDir, assetPath));
}

export function createServer() {
  return createAppServer({
    projectDir,
    staticAssetLoader
  });
}

export function startServer() {
  const port = resolveRuntimePort({ projectDir });
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Agent Cluster listening at http://127.0.0.1:${port}`);
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}

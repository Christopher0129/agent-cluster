import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".html",
  ".css",
  ".txt"
]);

const FILES_TO_SCAN = [
  "package.json",
  "README.md",
  "README.en.md",
  "README.zh-CN.md",
  "src/static/index.html",
  "src/static/locale-ui.js",
  "src/static/operation-events.js",
  "src/cluster/orchestrator.mjs",
  "src/system/bot-plugins.mjs",
  "src/config.mjs"
];

function detectReplacementCharacters(content) {
  return content.includes("\uFFFD");
}

async function main() {
  const failures = [];

  for (const relativePath of FILES_TO_SCAN) {
    const absolutePath = resolve(process.cwd(), relativePath);
    if (!TEXT_EXTENSIONS.has(extname(relativePath)) && !relativePath.endsWith(".md") && !relativePath.endsWith(".json")) {
      continue;
    }

    const content = await readFile(absolutePath, "utf8");
    if (detectReplacementCharacters(content)) {
      failures.push(`${relativePath}: found replacement character U+FFFD`);
    }
  }

  if (failures.length) {
    throw new Error(`Text encoding check failed:\n${failures.join("\n")}`);
  }

  console.log("Text encoding check passed.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

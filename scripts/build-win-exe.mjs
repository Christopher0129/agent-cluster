import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(projectDir, "src");
const buildDir = join(projectDir, "build", "sea");
const configuredOutputDir = String(process.env.AGENT_CLUSTER_OUTPUT_DIR || "").trim();
const distDir = configuredOutputDir
  ? resolve(projectDir, configuredOutputDir)
  : join(projectDir, "dist");
const bundlePath = join(buildDir, "bundle.cjs");
const seaConfigPath = join(buildDir, "sea-config.json");
const outputExeName = process.env.AGENT_CLUSTER_EXE_NAME || "AgentClusterWorkbench.exe";
const outputExePath = join(distDir, outputExeName);
const entryPath = join(srcDir, "sea-main.mjs");
const configuredBaseConfig = String(process.env.AGENT_CLUSTER_BASE_CONFIG || "").trim();
const baseConfigPath = configuredBaseConfig
  ? resolve(projectDir, configuredBaseConfig)
  : join(projectDir, "cluster.config.json");

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

function moduleIdFor(filePath) {
  return `/${toPosixPath(relative(projectDir, filePath))}`;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return specifier;
  }

  return resolve(dirname(fromFile), specifier);
}

function parseImportClause(clause, requireExpression) {
  const trimmed = clause.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inside = trimmed
      .slice(1, -1)
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\bas\b/g, ":");
    return `const { ${inside} } = ${requireExpression};`;
  }

  if (trimmed.startsWith("* as ")) {
    return `const ${trimmed.slice(5).trim()} = ${requireExpression};`;
  }

  return `const ${trimmed} = ${requireExpression};`;
}

function transformModuleSource(source, filePath, discoveredDeps) {
  let transformed = source.replace(/^\uFEFF/, "");
  const exportNames = new Set();

  transformed = transformed.replace(
    /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (match, clause, specifier) => {
      const resolved = resolveImport(filePath, specifier);
      if (specifier.startsWith(".")) {
        discoveredDeps.add(resolved);
        return parseImportClause(clause, `__require(${JSON.stringify(moduleIdFor(resolved))})`);
      }

      return parseImportClause(clause, `require(${JSON.stringify(specifier)})`);
    }
  );

  transformed = transformed.replace(/^export\s+async function\s+([A-Za-z0-9_$]+)/gm, (_, name) => {
    exportNames.add(name);
    return `async function ${name}`;
  });

  transformed = transformed.replace(/^export\s+function\s+([A-Za-z0-9_$]+)/gm, (_, name) => {
    exportNames.add(name);
    return `function ${name}`;
  });

  transformed = transformed.replace(/^export\s+class\s+([A-Za-z0-9_$]+)/gm, (_, name) => {
    exportNames.add(name);
    return `class ${name}`;
  });

  transformed = transformed.replace(/^export\s+const\s+([A-Za-z0-9_$]+)\s*=/gm, (_, name) => {
    exportNames.add(name);
    return `const ${name} =`;
  });

  transformed = transformed.replace(/^export\s+\{[\s\S]*?\};?\s*$/gm, "");

  transformed += `\nmodule.exports = { ${Array.from(exportNames).join(", ")} };\n`;
  return transformed;
}

async function collectModules(entryFile) {
  const queue = [entryFile];
  const seen = new Set();
  const modules = new Map();

  while (queue.length) {
    const currentFile = queue.shift();
    if (seen.has(currentFile)) {
      continue;
    }

    seen.add(currentFile);
    const source = await readFile(currentFile, "utf8");
    const discoveredDeps = new Set();
    const transformed = transformModuleSource(source, currentFile, discoveredDeps);
    modules.set(moduleIdFor(currentFile), transformed);

    for (const dependency of discoveredDeps) {
      if (!seen.has(dependency)) {
        queue.push(dependency);
      }
    }
  }

  return modules;
}

function renderBundle(modules, entryModuleId) {
  const renderedModules = Array.from(modules.entries())
    .map(
      ([moduleId, code]) => `${JSON.stringify(moduleId)}: function(module, exports, __require) {\n${code}\n}`
    )
    .join(",\n");

  return [
    `"use strict";`,
    `const __modules = {`,
    renderedModules,
    `};`,
    `const __cache = Object.create(null);`,
    `function __require(moduleId) {`,
    `  if (!moduleId.startsWith("/")) {`,
    `    return require(moduleId);`,
    `  }`,
    `  if (__cache[moduleId]) {`,
    `    return __cache[moduleId].exports;`,
    `  }`,
    `  const module = { exports: {} };`,
    `  __cache[moduleId] = module;`,
    `  __modules[moduleId](module, module.exports, __require);`,
    `  return module.exports;`,
    `}`,
    `__require(${JSON.stringify(entryModuleId)});`,
    ``
  ].join("\n");
}

async function ensureCleanDirs() {
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await rm(outputExePath, { force: true });
}

async function writeSeaConfig() {
  const assets = {
    "cluster.config.json": baseConfigPath,
    "static/index.html": join(srcDir, "static", "index.html"),
    "static/app.js": join(srcDir, "static", "app.js"),
    "static/provider-catalog.js": join(srcDir, "static", "provider-catalog.js"),
    "static/style.css": join(srcDir, "static", "style.css")
  };

  const config = {
    main: bundlePath,
    output: outputExePath,
    assets,
    disableExperimentalSEAWarning: true
  };

  await writeFile(seaConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function runBuildSea() {
  const result = spawnSync(process.execPath, ["--build-sea", seaConfigPath], {
    cwd: projectDir,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`node --build-sea failed with exit code ${result.status}.`);
  }
}

async function main() {
  if (!existsSync(entryPath)) {
    throw new Error(`SEA entry file not found: ${entryPath}`);
  }

  await ensureCleanDirs();
  const modules = await collectModules(entryPath);
  await writeFile(bundlePath, renderBundle(modules, moduleIdFor(entryPath)), "utf8");
  await writeSeaConfig();
  runBuildSea();
  await rm(buildDir, { recursive: true, force: true });

  console.log(`Built Windows executable: ${outputExePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

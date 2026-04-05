import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const staticDir = join(srcDir, "static");
const PE_POINTER_OFFSET = 0x3c;
const PE_SIGNATURE = "PE\u0000\u0000";
const PE_OPTIONAL_HEADER_MAGIC_PE32 = 0x10b;
const PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b;
const PE_SUBSYSTEM_OFFSET = 68;
const PE_SUBSYSTEM_WINDOWS_GUI = 2;
const configuredBaseConfig = String(process.env.AGENT_CLUSTER_BASE_CONFIG || "").trim();
const baseConfigPath = configuredBaseConfig
  ? resolve(projectDir, configuredBaseConfig)
  : join(projectDir, "cluster.config.blank.json");

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

function normalizeNamedImportClause(clause) {
  return clause
    .slice(1, -1)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\bas\b/g, ":");
}

function findTopLevelComma(text) {
  let braceDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === "," && braceDepth === 0) {
      return index;
    }
  }

  return -1;
}

export function parseImportClause(clause, requireExpression, tempVarName = "__importedModule") {
  const trimmed = clause.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return `const { ${normalizeNamedImportClause(trimmed)} } = ${requireExpression};`;
  }

  if (trimmed.startsWith("* as ")) {
    return `const ${trimmed.slice(5).trim()} = ${requireExpression};`;
  }

  const topLevelCommaIndex = findTopLevelComma(trimmed);
  if (topLevelCommaIndex !== -1) {
    const defaultImport = trimmed.slice(0, topLevelCommaIndex).trim();
    const secondaryImport = trimmed.slice(topLevelCommaIndex + 1).trim();
    const statements = [
      `const ${tempVarName} = ${requireExpression};`,
      `const ${defaultImport} = ${tempVarName};`
    ];

    if (secondaryImport) {
      statements.push(parseImportClause(secondaryImport, tempVarName, `${tempVarName}Nested`));
    }

    return statements.join("\n");
  }

  return `const ${trimmed} = ${requireExpression};`;
}

export function transformModuleSource(source, filePath, discoveredDeps) {
  let transformed = source.replace(/^\uFEFF/, "");
  const exportNames = new Set();
  let importCounter = 0;

  transformed = transformed.replace(
    /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?\s*$/gm,
    (match, clause, specifier) => {
      const resolved = resolveImport(filePath, specifier);
      importCounter += 1;
      const tempVarName = `__importedModule${importCounter}`;
      if (specifier.startsWith(".")) {
        discoveredDeps.add(resolved);
        return parseImportClause(
          clause,
          `__require(${JSON.stringify(moduleIdFor(resolved))})`,
          tempVarName
        );
      }

      return parseImportClause(clause, `require(${JSON.stringify(specifier)})`, tempVarName);
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

async function collectFilesRecursive(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const absolutePath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFilesRecursive(absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      results.push(absolutePath);
    }
  }

  return results;
}

export async function collectStaticAssets() {
  const files = await collectFilesRecursive(staticDir);
  return Object.fromEntries(
    files
      .map((filePath) => {
        const relativePath = toPosixPath(relative(staticDir, filePath));
        return [`static/${relativePath}`, filePath];
      })
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export async function buildSeaAssets() {
  return {
    "cluster.config.json": baseConfigPath,
    ...(await collectStaticAssets())
  };
}

async function writeSeaConfig() {
  const assets = await buildSeaAssets();

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

export function patchPeSubsystemBuffer(buffer, subsystem = PE_SUBSYSTEM_WINDOWS_GUI) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PE_POINTER_OFFSET + 4) {
    throw new Error("Expected a PE executable buffer.");
  }

  const peHeaderOffset = buffer.readUInt32LE(PE_POINTER_OFFSET);
  if (peHeaderOffset <= 0 || peHeaderOffset + 4 + 20 + PE_SUBSYSTEM_OFFSET + 2 > buffer.length) {
    throw new Error("Invalid PE header offset.");
  }

  const signature = buffer.toString("binary", peHeaderOffset, peHeaderOffset + 4);
  if (signature !== PE_SIGNATURE) {
    throw new Error("Invalid PE signature.");
  }

  const optionalHeaderOffset = peHeaderOffset + 4 + 20;
  const magic = buffer.readUInt16LE(optionalHeaderOffset);
  if (![PE_OPTIONAL_HEADER_MAGIC_PE32, PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS].includes(magic)) {
    throw new Error(`Unsupported PE optional header magic: 0x${magic.toString(16)}`);
  }

  buffer.writeUInt16LE(subsystem, optionalHeaderOffset + PE_SUBSYSTEM_OFFSET);
  return buffer;
}

export async function patchWindowsGuiSubsystem(exePath) {
  const buffer = await readFile(exePath);
  patchPeSubsystemBuffer(buffer, PE_SUBSYSTEM_WINDOWS_GUI);
  await writeFile(exePath, buffer);
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
  await patchWindowsGuiSubsystem(outputExePath);
  await rm(buildDir, { recursive: true, force: true });

  console.log(`Built Windows executable: ${outputExePath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

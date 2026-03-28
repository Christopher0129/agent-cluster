import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { readDocumentText } from "./document-reader.mjs";

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

export function resolveWorkspaceRoot(workspaceDir) {
  return resolve(String(workspaceDir || "."));
}

export async function ensureWorkspaceDirectory(workspaceDir) {
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

export function resolveWorkspacePath(workspaceDir, filePath = ".") {
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

export async function getWorkspaceTree(workspaceDir, options = {}) {
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

export async function readWorkspaceFiles(workspaceDir, filePaths, options = {}) {
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

export async function listWorkspacePath(workspaceDir, filePath = ".", options = {}) {
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

export async function writeWorkspaceFiles(workspaceDir, files, options = {}) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const maxFiles = Math.max(1, Number(options.maxFiles || DEFAULT_MAX_WRITE_FILES));
  const writtenFiles = [];

  for (const file of normalizedFiles.slice(0, maxFiles)) {
    const resolved = assertPathWithinWorkspace(workspaceDir, file?.path);
    const encoding = String(file?.encoding || "utf8");
    const content =
      encoding === "base64"
        ? Buffer.from(String(file?.content ?? ""), "base64")
        : Buffer.from(String(file?.content ?? ""), "utf8");
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    await writeFile(resolved.absolutePath, content);
    writtenFiles.push({
      path: resolved.relativePath,
      bytes: content.byteLength
    });
  }

  return writtenFiles;
}

export async function getWorkspaceFilePreview(workspaceDir, filePath, options = {}) {
  const [result] = await readWorkspaceFiles(workspaceDir, [filePath], options);
  return result;
}

export function workspaceExists(workspaceDir) {
  return existsSync(resolveWorkspaceRoot(workspaceDir));
}

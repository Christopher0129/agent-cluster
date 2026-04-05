import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureWorkspaceDirectory, resolveWorkspacePath } from "./fs.mjs";

export const CLUSTER_CACHE_DIR = ".agent-cluster-cache";

function sanitizeCacheRunId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");

  return normalized || `run_${Date.now()}`;
}

async function countDirectoryEntries(dirPath) {
  let files = 0;
  let directories = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = resolveWorkspacePath(dirPath, entry.name).absolutePath;
    if (entry.isDirectory()) {
      directories += 1;
      const child = await countDirectoryEntries(absolutePath);
      files += child.files;
      directories += child.directories;
      continue;
    }

    if (entry.isFile()) {
      files += 1;
    }
  }

  return { files, directories };
}

function resolveCacheContext(workspaceDir) {
  const resolved = resolveWorkspacePath(workspaceDir, CLUSTER_CACHE_DIR);
  return {
    cacheDir: resolved.absolutePath,
    cachePath: resolved.relativePath
  };
}

export async function writeClusterRunCache(workspaceDir, runId, payload) {
  await ensureWorkspaceDirectory(workspaceDir);
  const safeRunId = sanitizeCacheRunId(runId);
  const fileResolved = resolveWorkspacePath(
    workspaceDir,
    `${CLUSTER_CACHE_DIR}/runs/${safeRunId}.json`
  );
  const content = `${JSON.stringify(payload, null, 2)}\n`;

  await mkdir(dirname(fileResolved.absolutePath), { recursive: true });
  await writeFile(fileResolved.absolutePath, content, "utf8");

  return {
    path: fileResolved.relativePath,
    bytes: Buffer.byteLength(content, "utf8")
  };
}

export async function clearClusterRunCache(workspaceDir) {
  await ensureWorkspaceDirectory(workspaceDir);
  const { cacheDir, cachePath } = resolveCacheContext(workspaceDir);

  if (!existsSync(cacheDir)) {
    return {
      existed: false,
      cachePath,
      removedFiles: 0,
      removedDirectories: 0
    };
  }

  const cacheStat = await stat(cacheDir);
  if (!cacheStat.isDirectory()) {
    await rm(cacheDir, { force: true });
    return {
      existed: true,
      cachePath,
      removedFiles: 1,
      removedDirectories: 0
    };
  }

  const counts = await countDirectoryEntries(cacheDir);
  await rm(cacheDir, { recursive: true, force: true });

  return {
    existed: true,
    cachePath,
    removedFiles: counts.files,
    removedDirectories: counts.directories + 1
  };
}

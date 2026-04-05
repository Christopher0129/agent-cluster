import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { loadRuntimeConfig } from "../config.mjs";
import { pickFolderDialog } from "../system/dialogs.mjs";
import {
  ensureWorkspaceDirectory,
  getWorkspaceFilePreview,
  getWorkspaceTree,
  writeWorkspaceFiles
} from "../workspace/fs.mjs";
import { clearClusterRunCache } from "../workspace/cache.mjs";
import { readRequestBody, sendJson } from "./common.mjs";

const FOLDER_PICK_JOB_TTL_MS = 5 * 60 * 1000;

function createFolderPickJobSnapshot(job) {
  if (!job) {
    return null;
  }

  return {
    jobId: job.id,
    status: job.status,
    path: job.path,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export function createFolderPickJobStore({
  pickFolder = pickFolderDialog,
  createId = () => randomUUID(),
  now = () => Date.now(),
  ttlMs = FOLDER_PICK_JOB_TTL_MS
} = {}) {
  const jobs = new Map();

  function cleanup(currentTime = now()) {
    for (const [jobId, job] of jobs.entries()) {
      if (job.status === "pending") {
        continue;
      }
      if (job.expiresAt > 0 && job.expiresAt <= currentTime) {
        jobs.delete(jobId);
      }
    }
  }

  function finalize(job, nextState) {
    job.status = nextState.status;
    job.path = nextState.path ?? "";
    job.error = nextState.error ?? "";
    job.updatedAt = now();
    job.expiresAt = job.updatedAt + ttlMs;
    return createFolderPickJobSnapshot(job);
  }

  function start(initialDir = "") {
    cleanup();

    const createdAt = now();
    const job = {
      id: createId(),
      status: "pending",
      path: "",
      error: "",
      createdAt,
      updatedAt: createdAt,
      expiresAt: 0
    };
    jobs.set(job.id, job);

    Promise.resolve()
      .then(() => pickFolder(initialDir))
      .then((selectedPath) => {
        finalize(job, {
          status: selectedPath ? "completed" : "cancelled",
          path: String(selectedPath || "")
        });
      })
      .catch((error) => {
        finalize(job, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error || "Folder picker failed.")
        });
      });

    return createFolderPickJobSnapshot(job);
  }

  function get(jobId) {
    cleanup();
    return createFolderPickJobSnapshot(jobs.get(String(jobId || "").trim()));
  }

  return {
    cleanup,
    get,
    start
  };
}

const folderPickJobStore = createFolderPickJobStore();

export function resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, overrideDir = "") {
  const config = loadRuntimeConfig(projectDir, runtimeConfigOptions);
  const normalizedOverride = String(overrideDir || "").trim();
  if (!normalizedOverride) {
    return {
      dir: config.workspace.dir,
      resolvedDir: config.workspace.resolvedDir
    };
  }

  return {
    dir: normalizedOverride,
    resolvedDir: isAbsolute(normalizedOverride)
      ? normalizedOverride
      : resolve(projectDir, normalizedOverride)
  };
}

export async function handleWorkspaceSummary(response, url, projectDir, runtimeConfigOptions) {
  try {
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(url.searchParams.get("workspaceDir") || "").trim()
    );
    const rootDir = await ensureWorkspaceDirectory(workspace.resolvedDir);
    const tree = await getWorkspaceTree(rootDir);
    sendJson(response, 200, {
      ok: true,
      workspace: {
        dir: workspace.dir,
        resolvedDir: rootDir,
        tree: tree.lines
      }
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleWorkspaceFileRead(response, url, projectDir, runtimeConfigOptions) {
  try {
    const filePath = String(url.searchParams.get("path") || "").trim();
    const workspaceDir = String(url.searchParams.get("workspaceDir") || "").trim();
    if (!filePath) {
      sendJson(response, 400, {
        ok: false,
        error: "Workspace file path is required."
      });
      return;
    }

    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const preview = await getWorkspaceFilePreview(workspace.resolvedDir, filePath);
    sendJson(response, 200, {
      ok: true,
      workspace,
      file: preview
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleWorkspaceFileWrite(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const filePath = String(body?.path || "").trim();
    const workspaceDir = String(body?.workspaceDir || "").trim();
    if (!filePath) {
      sendJson(response, 400, {
        ok: false,
        error: "Workspace file path is required."
      });
      return;
    }

    const content = String(body?.content ?? "");
    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const written = await writeWorkspaceFiles(workspace.resolvedDir, [
      {
        path: filePath,
        content
      }
    ]);
    sendJson(response, 200, {
      ok: true,
      workspace,
      written
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleWorkspaceImport(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspaceDir = String(body?.workspaceDir || "").trim();
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) {
      sendJson(response, 400, {
        ok: false,
        error: "At least one file is required for import."
      });
      return;
    }

    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const written = await writeWorkspaceFiles(
      workspace.resolvedDir,
      files.map((file) => ({
        path: file?.path,
        content: file?.contentBase64,
        encoding: "base64"
      })),
      {
        maxFiles: 50
      }
    );

    sendJson(response, 200, {
      ok: true,
      workspace,
      written
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleWorkspaceCacheClear(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspaceDir = String(body?.workspaceDir || "").trim();
    const workspace = resolveWorkspaceRequestContext(projectDir, runtimeConfigOptions, workspaceDir);
    const cache = await clearClusterRunCache(workspace.resolvedDir);

    sendJson(response, 200, {
      ok: true,
      workspace,
      cache
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleFolderPick(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(body?.currentDir || "").trim()
    );
    sendJson(response, 200, {
      ok: true,
      ...folderPickJobStore.start(workspace.resolvedDir)
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleFolderPickStatus(response, url) {
  try {
    const jobId = String(url.searchParams.get("jobId") || "").trim();
    if (!jobId) {
      sendJson(response, 400, {
        ok: false,
        error: "Folder pick job id is required."
      });
      return;
    }

    const job = folderPickJobStore.get(jobId);
    if (!job) {
      sendJson(response, 404, {
        ok: false,
        error: "Folder pick job was not found or has expired."
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      ...job
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

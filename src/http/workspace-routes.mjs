import { isAbsolute, resolve } from "node:path";
import { loadRuntimeConfig } from "../config.mjs";
import { pickFolderDialog } from "../system/dialogs.mjs";
import {
  ensureWorkspaceDirectory,
  getWorkspaceFilePreview,
  getWorkspaceTree,
  writeWorkspaceFiles
} from "../workspace/fs.mjs";
import { readRequestBody, sendJson } from "./common.mjs";

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

export async function handleFolderPick(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const workspace = resolveWorkspaceRequestContext(
      projectDir,
      runtimeConfigOptions,
      String(body?.currentDir || "").trim()
    );
    const selectedPath = await pickFolderDialog(workspace.resolvedDir);
    sendJson(response, 200, {
      ok: true,
      path: selectedPath || ""
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

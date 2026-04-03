function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function createFallbackTranslator() {
  const catalog = {
    "workspace.loadingSummary": "正在读取工作区...",
    "workspace.emptyTree": "(工作区为空)",
    "workspace.summaryPrefix": "根目录：{rootDir}\n\n{tree}",
    "workspace.summaryLoadFailed": "读取工作区失败：{error}",
    "workspace.readPathRequired": "请输入要读取的相对路径。",
    "workspace.readingFile": "正在读取文件...",
    "workspace.readFileFailed": "读取文件失败：{error}",
    "workspace.truncatedSuffix": "\n\n[内容过长，已截断]",
    "workspace.pickingFolder": "正在打开文件夹选择器...",
    "workspace.folderNotSelected": "未选择文件夹。",
    "workspace.folderSelected": "已选择工作区目录，点击“保存配置”即可持久化。",
    "workspace.folderPickFailed": "选择文件夹失败：{error}",
    "workspace.importSelectRequired": "请先选择要导入的文件。",
    "workspace.importingFiles": "正在导入 {count} 个文件...",
    "workspace.importedPreview": "已导入 {count} 个文件，正在预览 {path}...",
    "workspace.importedDone": "文件已导入。",
    "workspace.importedStatus": "已导入 {count} 个文件到工作区。",
    "workspace.importFailed": "导入文件失败：{error}",
    "workspace.clearingCache": "正在清除集群运行缓存...",
    "workspace.cacheCleared": "已清除集群缓存：删除 {files} 个文件，{dirs} 个目录。",
    "workspace.cacheAlreadyEmpty": "未发现可清除的集群缓存。",
    "workspace.cacheClearFailed": "清除集群缓存失败：{error}",
    "workspace.cacheClearConfirm": "确定要删除集群运行缓存吗？这会移除工作区中的分工材料缓存。",
    "workspace.cachePreviewCleared": "集群运行缓存已清除。"
  };

  return (key, values = {}) => interpolate(catalog[key] ?? key, values);
}

export function createWorkspaceUi({
  elements,
  setSaveStatus,
  translate = createFallbackTranslator()
}) {
  const {
    workspaceDirInput,
    pickWorkspaceButton,
    refreshWorkspaceButton,
    clearWorkspaceCacheButton,
    workspaceTreeOutput,
    importWorkspaceFilesInput,
    importWorkspaceFilesButton,
    workspaceImportTargetInput,
    workspaceFilePathInput,
    readWorkspaceFileButton,
    workspaceFileOutput
  } = elements;

  function getDirValue() {
    return workspaceDirInput?.value.trim() || "";
  }

  function collectSettings() {
    return {
      dir: getDirValue()
    };
  }

  function applySettings(workspaceSettings = {}) {
    if (workspaceDirInput) {
      workspaceDirInput.value = workspaceSettings.dir || "./workspace";
    }
  }

  function buildWorkspaceQuery(workspaceDir) {
    const normalizedDir = String(workspaceDir || "").trim();
    return normalizedDir ? `?workspaceDir=${encodeURIComponent(normalizedDir)}` : "";
  }

  function normalizeRelativeImportPath(value) {
    return String(value || "")
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  function joinRelativePath(left, right) {
    const normalizedLeft = normalizeRelativeImportPath(left);
    const normalizedRight = normalizeRelativeImportPath(right);
    if (!normalizedLeft) {
      return normalizedRight;
    }
    if (!normalizedRight) {
      return normalizedLeft;
    }
    return `${normalizedLeft}/${normalizedRight}`;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }

  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    return arrayBufferToBase64(buffer);
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  async function loadSummary() {
    if (workspaceTreeOutput) {
      workspaceTreeOutput.textContent = translate("workspace.loadingSummary");
    }

    try {
      const payload = await fetchJson(`/api/workspace${buildWorkspaceQuery(getDirValue())}`);
      const treeText = payload.workspace.tree?.length
        ? payload.workspace.tree.join("\n")
        : translate("workspace.emptyTree");
      if (workspaceTreeOutput) {
        workspaceTreeOutput.textContent = translate("workspace.summaryPrefix", {
          rootDir: payload.workspace.resolvedDir,
          tree: treeText
        });
      }
    } catch (error) {
      if (workspaceTreeOutput) {
        workspaceTreeOutput.textContent = translate("workspace.summaryLoadFailed", {
          error: error.message
        });
      }
    }
  }

  async function readFilePreview() {
    const filePath = workspaceFilePathInput?.value.trim() || "";
    if (!filePath) {
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = translate("workspace.readPathRequired");
      }
      workspaceFilePathInput?.focus();
      return;
    }

    if (workspaceFileOutput) {
      workspaceFileOutput.textContent = translate("workspace.readingFile");
    }

    try {
      const query = new URLSearchParams({
        path: filePath
      });
      if (getDirValue()) {
        query.set("workspaceDir", getDirValue());
      }

      const payload = await fetchJson(`/api/workspace/file?${query.toString()}`);
      const file = payload.file || {};
      const suffix = file.truncated ? translate("workspace.truncatedSuffix") : "";
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = `${file.content || ""}${suffix}`;
      }
    } catch (error) {
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = translate("workspace.readFileFailed", {
          error: error.message
        });
      }
    }
  }

  async function pickFolder() {
    if (pickWorkspaceButton) {
      pickWorkspaceButton.disabled = true;
    }
    setSaveStatus(translate("workspace.pickingFolder"), "neutral");

    try {
      const payload = await fetchJson("/api/system/pick-folder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          currentDir: getDirValue()
        })
      });

      if (!payload.path) {
        setSaveStatus(translate("workspace.folderNotSelected"), "neutral");
        return;
      }

      if (workspaceDirInput) {
        workspaceDirInput.value = payload.path;
      }
      setSaveStatus(translate("workspace.folderSelected"), "ok");
      await loadSummary();
    } catch (error) {
      setSaveStatus(
        translate("workspace.folderPickFailed", {
          error: error.message
        }),
        "error"
      );
    } finally {
      if (pickWorkspaceButton) {
        pickWorkspaceButton.disabled = false;
      }
    }
  }

  async function importFiles() {
    const selectedFiles = Array.from(importWorkspaceFilesInput?.files || []);
    if (!selectedFiles.length) {
      setSaveStatus(translate("workspace.importSelectRequired"), "error");
      importWorkspaceFilesInput?.focus();
      return;
    }

    const workspaceDir = getDirValue();
    const targetDir = normalizeRelativeImportPath(workspaceImportTargetInput?.value);
    if (importWorkspaceFilesButton) {
      importWorkspaceFilesButton.disabled = true;
    }
    if (importWorkspaceFilesInput) {
      importWorkspaceFilesInput.disabled = true;
    }
    setSaveStatus(
      translate("workspace.importingFiles", {
        count: selectedFiles.length
      }),
      "neutral"
    );

    try {
      const files = await Promise.all(
        selectedFiles.map(async (file) => ({
          path: joinRelativePath(targetDir, file.webkitRelativePath || file.name),
          contentBase64: await fileToBase64(file)
        }))
      );

      const payload = await fetchJson("/api/workspace/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          workspaceDir,
          files
        })
      });

      const firstPath = payload.written?.[0]?.path || files[0]?.path || "";
      if (firstPath) {
        if (workspaceFilePathInput) {
          workspaceFilePathInput.value = firstPath;
        }
        if (workspaceFileOutput) {
          workspaceFileOutput.textContent = translate("workspace.importedPreview", {
            count: payload.written.length,
            path: firstPath
          });
        }
      } else if (workspaceFileOutput) {
        workspaceFileOutput.textContent = translate("workspace.importedDone");
      }

      await loadSummary();
      if (firstPath) {
        await readFilePreview();
      }
      setSaveStatus(
        translate("workspace.importedStatus", {
          count: payload.written.length
        }),
        "ok"
      );
    } catch (error) {
      const errorMessage = translate("workspace.importFailed", {
        error: error.message
      });
      setSaveStatus(errorMessage, "error");
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = errorMessage;
      }
    } finally {
      if (importWorkspaceFilesButton) {
        importWorkspaceFilesButton.disabled = false;
      }
      if (importWorkspaceFilesInput) {
        importWorkspaceFilesInput.disabled = false;
        importWorkspaceFilesInput.value = "";
      }
    }
  }

  async function clearClusterCache() {
    const confirmed = window.confirm(translate("workspace.cacheClearConfirm"));
    if (!confirmed) {
      return;
    }

    if (clearWorkspaceCacheButton) {
      clearWorkspaceCacheButton.disabled = true;
    }
    setSaveStatus(translate("workspace.clearingCache"), "neutral");

    try {
      const payload = await fetchJson("/api/workspace/cache/clear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          workspaceDir: getDirValue()
        })
      });

      const cache = payload.cache || {};
      const message = cache.existed
        ? translate("workspace.cacheCleared", {
            files: cache.removedFiles ?? 0,
            dirs: cache.removedDirectories ?? 0
          })
        : translate("workspace.cacheAlreadyEmpty");

      setSaveStatus(message, "ok");
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = translate("workspace.cachePreviewCleared");
      }
      await loadSummary();
    } catch (error) {
      const errorMessage = translate("workspace.cacheClearFailed", {
        error: error.message
      });
      setSaveStatus(errorMessage, "error");
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = errorMessage;
      }
    } finally {
      if (clearWorkspaceCacheButton) {
        clearWorkspaceCacheButton.disabled = false;
      }
    }
  }

  function refreshLocale() {
    if (workspaceTreeOutput && !workspaceTreeOutput.textContent.trim()) {
      workspaceTreeOutput.textContent = translate("workspace.loadingSummary");
    }
    if (workspaceFileOutput && !workspaceFileOutput.textContent.trim()) {
      workspaceFileOutput.textContent = translate("workspace.readPathRequired");
    }
  }

  function bindEvents() {
    pickWorkspaceButton?.addEventListener("click", pickFolder);
    refreshWorkspaceButton?.addEventListener("click", loadSummary);
    clearWorkspaceCacheButton?.addEventListener("click", clearClusterCache);
    importWorkspaceFilesButton?.addEventListener("click", importFiles);
    readWorkspaceFileButton?.addEventListener("click", readFilePreview);
  }

  return {
    applySettings,
    bindEvents,
    collectSettings,
    getDirValue,
    importFiles,
    loadSummary,
    pickFolder,
    readFilePreview,
    clearClusterCache,
    refreshLocale
  };
}

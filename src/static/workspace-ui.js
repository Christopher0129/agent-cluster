export function createWorkspaceUi({
  elements,
  setSaveStatus
}) {
  const {
    workspaceDirInput,
    pickWorkspaceButton,
    refreshWorkspaceButton,
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
      workspaceTreeOutput.textContent = "正在读取工作区...";
    }

    try {
      const payload = await fetchJson(`/api/workspace${buildWorkspaceQuery(getDirValue())}`);
      const treeText = payload.workspace.tree?.length ? payload.workspace.tree.join("\n") : "(工作区为空)";
      if (workspaceTreeOutput) {
        workspaceTreeOutput.textContent = `根目录：${payload.workspace.resolvedDir}\n\n${treeText}`;
      }
    } catch (error) {
      if (workspaceTreeOutput) {
        workspaceTreeOutput.textContent = `读取工作区失败：${error.message}`;
      }
    }
  }

  async function readFilePreview() {
    const filePath = workspaceFilePathInput?.value.trim() || "";
    if (!filePath) {
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = "请输入要读取的相对路径。";
      }
      workspaceFilePathInput?.focus();
      return;
    }

    if (workspaceFileOutput) {
      workspaceFileOutput.textContent = "正在读取文件...";
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
      const suffix = file.truncated ? "\n\n[内容过长，已截断]" : "";
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = `${file.content || ""}${suffix}`;
      }
    } catch (error) {
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = `读取文件失败：${error.message}`;
      }
    }
  }

  async function pickFolder() {
    if (pickWorkspaceButton) {
      pickWorkspaceButton.disabled = true;
    }
    setSaveStatus("正在打开文件夹选择器...", "neutral");

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
        setSaveStatus("未选择文件夹。", "neutral");
        return;
      }

      if (workspaceDirInput) {
        workspaceDirInput.value = payload.path;
      }
      setSaveStatus("已选择工作区目录，点击“保存配置”即可持久化。", "ok");
      await loadSummary();
    } catch (error) {
      setSaveStatus(`选择文件夹失败：${error.message}`, "error");
    } finally {
      if (pickWorkspaceButton) {
        pickWorkspaceButton.disabled = false;
      }
    }
  }

  async function importFiles() {
    const selectedFiles = Array.from(importWorkspaceFilesInput?.files || []);
    if (!selectedFiles.length) {
      setSaveStatus("请先选择要导入的文件。", "error");
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
    setSaveStatus(`正在导入 ${selectedFiles.length} 个文件...`, "neutral");

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
          workspaceFileOutput.textContent = `已导入 ${payload.written.length} 个文件，正在预览 ${firstPath}...`;
        }
      } else if (workspaceFileOutput) {
        workspaceFileOutput.textContent = "文件已导入。";
      }

      await loadSummary();
      if (firstPath) {
        await readFilePreview();
      }
      setSaveStatus(`已导入 ${payload.written.length} 个文件到工作区。`, "ok");
    } catch (error) {
      setSaveStatus(`导入文件失败：${error.message}`, "error");
      if (workspaceFileOutput) {
        workspaceFileOutput.textContent = `导入文件失败：${error.message}`;
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

  function bindEvents() {
    pickWorkspaceButton?.addEventListener("click", pickFolder);
    refreshWorkspaceButton?.addEventListener("click", loadSummary);
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
    readFilePreview
  };
}

const LOCALE_STORAGE_KEY = "agent-cluster:locale";
const DEFAULT_LOCALE = "zh-CN";

const MESSAGE_CATALOG = {
  "zh-CN": {
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
  },
  "en-US": {
    "workspace.loadingSummary": "Loading workspace...",
    "workspace.emptyTree": "(workspace is empty)",
    "workspace.summaryPrefix": "Root: {rootDir}\n\n{tree}",
    "workspace.summaryLoadFailed": "Failed to load workspace: {error}",
    "workspace.readPathRequired": "Enter a relative path to preview.",
    "workspace.readingFile": "Loading file preview...",
    "workspace.readFileFailed": "Failed to read file: {error}",
    "workspace.truncatedSuffix": "\n\n[content truncated]",
    "workspace.pickingFolder": "Opening folder picker...",
    "workspace.folderNotSelected": "No folder selected.",
    "workspace.folderSelected": "Workspace folder selected. Click Save to persist it.",
    "workspace.folderPickFailed": "Failed to choose folder: {error}",
    "workspace.importSelectRequired": "Choose at least one file to import.",
    "workspace.importingFiles": "Importing {count} file(s)...",
    "workspace.importedPreview": "Imported {count} file(s). Previewing {path}...",
    "workspace.importedDone": "Files imported.",
    "workspace.importedStatus": "Imported {count} file(s) into the workspace.",
    "workspace.importFailed": "Failed to import files: {error}",
    "workspace.clearingCache": "Clearing cluster run cache...",
    "workspace.cacheCleared": "Cluster cache cleared: removed {files} file(s) and {dirs} directorie(s).",
    "workspace.cacheAlreadyEmpty": "No cluster cache was found.",
    "workspace.cacheClearFailed": "Failed to clear cluster cache: {error}",
    "workspace.cacheClearConfirm": "Delete the cluster run cache? This removes cached delegation materials from the workspace.",
    "workspace.cachePreviewCleared": "Cluster run cache was cleared."
  }
};

function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function normalizeLocale(value) {
  return String(value || "").trim() === "en-US" ? "en-US" : DEFAULT_LOCALE;
}

function resolveFieldLabel(input) {
  return input?.closest(".field, .toggle-field")?.querySelector(":scope > span") || null;
}

function getPropertyValue(node, property) {
  if (!node) {
    return "";
  }

  if (property.startsWith("dataset.")) {
    return node.dataset?.[property.slice("dataset.".length)] ?? "";
  }
  if (property === "ariaLabel") {
    return node.getAttribute("aria-label") || "";
  }
  return node[property] ?? "";
}

function setPropertyValue(node, property, value) {
  if (!node) {
    return;
  }

  if (property.startsWith("dataset.")) {
    node.dataset[property.slice("dataset.".length)] = value;
    return;
  }
  if (property === "ariaLabel") {
    node.setAttribute("aria-label", value);
    return;
  }
  node[property] = value;
}

function createPatch(resolve, property, enValue) {
  return { resolve, property, enValue };
}

function buildEnglishPatches(elements, root) {
  const panel = (panelId) => root.querySelector(`[data-console-panel="${panelId}"]`);
  const navButton = (panelId) => root.querySelector(`[data-console-nav="${panelId}"]`);
  const heading = (panelId) => panel(panelId)?.querySelector("h3");
  const copy = (panelId) => panel(panelId)?.querySelector(".section-copy");
  const inlineButton = (id) => elements[id];

  return [
    createPatch(() => root.querySelector("title"), "textContent", "Agent Cluster Workbench"),
    createPatch(() => elements.languageLabel, "textContent", "Language"),
    createPatch(() => root.querySelector(".credit-title"), "textContent", "Multi-Model Agent Cluster Console"),
    createPatch(() => root.querySelector(".hero-copy"), "textContent", "design by Dreaming World"),
    createPatch(() => root.querySelector(".dream-title"), "textContent", "Control and Collaboration"),
    createPatch(() => root.querySelector(".console-sidebar-head .panel-kicker"), "textContent", "Navigation"),
    createPatch(() => root.querySelector(".console-sidebar-head h2"), "textContent", "Workbench Navigation"),
    createPatch(
      () => root.querySelector(".console-sidebar-head .section-copy"),
      "textContent",
      "Choose a panel on the left to switch the workspace on the right."
    ),
    createPatch(() => navButton("cluster"), "textContent", "Cluster"),
    createPatch(() => navButton("schemes"), "textContent", "Schemes"),
    createPatch(() => navButton("phases"), "textContent", "Phases"),
    createPatch(() => navButton("secrets"), "textContent", "Secrets"),
    createPatch(() => navButton("batch"), "textContent", "Batch Add"),
    createPatch(() => navButton("models"), "textContent", "Models"),
    createPatch(() => navButton("bot"), "textContent", "Bots"),
    createPatch(() => navButton("workspace"), "textContent", "Workspace"),
    createPatch(() => navButton("run"), "textContent", "Run"),
    createPatch(
      () => root.querySelector(".console-sidebar-status p"),
      "textContent",
      "The right-side fixed panels still keep the agent topology and full-model connectivity checks."
    ),
    createPatch(() => elements.reloadButton, "textContent", "Reload"),
    createPatch(() => elements.exitAppButton, "textContent", "Exit"),
    createPatch(() => elements.saveButton, "textContent", "Save"),
    createPatch(() => elements.saveStatusClose, "ariaLabel", "Close notification"),
    createPatch(() => panel("cluster"), "dataset.panelKicker", "Config"),
    createPatch(() => panel("cluster"), "dataset.panelTitle", "Cluster Settings"),
    createPatch(() => panel("cluster"), "dataset.panelDescription", "Configure global concurrency, the controller model, and delegation depth."),
    createPatch(() => heading("cluster"), "textContent", "Core Settings"),
    createPatch(() => resolveFieldLabel(elements.portInput), "textContent", "Port"),
    createPatch(() => resolveFieldLabel(elements.parallelInput), "textContent", "Max Parallel"),
    createPatch(() => resolveFieldLabel(elements.subordinateParallelInput), "textContent", "Subordinate Parallel Limit"),
    createPatch(() => resolveFieldLabel(elements.groupLeaderMaxDelegatesInput), "textContent", "Leader Delegate Cap"),
    createPatch(() => resolveFieldLabel(elements.delegateMaxDepthInput), "textContent", "Delegate Max Depth"),
    createPatch(() => resolveFieldLabel(elements.controllerSelect), "textContent", "Controller Model"),
    createPatch(() => panel("schemes"), "dataset.panelKicker", "Scheme"),
    createPatch(() => panel("schemes"), "dataset.panelTitle", "Scheme Settings"),
    createPatch(() => panel("schemes"), "dataset.panelDescription", "Switch the active scheme and keep an isolated model set for each scheme."),
    createPatch(() => heading("schemes"), "textContent", "Scheme Settings"),
    createPatch(() => resolveFieldLabel(elements.schemeSelect), "textContent", "Current Scheme"),
    createPatch(() => resolveFieldLabel(elements.schemeNameInput), "textContent", "Scheme Name"),
    createPatch(() => elements.addSchemeButton, "textContent", "Add Scheme"),
    createPatch(() => elements.removeSchemeButton, "textContent", "Remove Scheme"),
    createPatch(() => elements.schemeHint, "textContent", "Models, connectivity tests, and runs all follow the active scheme."),
    createPatch(() => panel("phases"), "dataset.panelKicker", "Phases"),
    createPatch(() => panel("phases"), "dataset.panelTitle", "Phase Concurrency"),
    createPatch(() => panel("phases"), "dataset.panelDescription", "Control the concurrency cap for research, implementation, validation, and handoff."),
    createPatch(() => heading("phases"), "textContent", "Phase Concurrency"),
    createPatch(() => copy("phases"), "textContent", "Leave blank to use the system default. Effective values never exceed max parallel."),
    createPatch(() => resolveFieldLabel(elements.phaseResearchInput), "textContent", "Research"),
    createPatch(() => resolveFieldLabel(elements.phaseImplementationInput), "textContent", "Implementation"),
    createPatch(() => resolveFieldLabel(elements.phaseValidationInput), "textContent", "Validation"),
    createPatch(() => resolveFieldLabel(elements.phaseHandoffInput), "textContent", "Handoff"),
    createPatch(() => panel("secrets"), "dataset.panelKicker", "Secrets"),
    createPatch(() => panel("secrets"), "dataset.panelTitle", "Shared Secrets"),
    createPatch(() => panel("secrets"), "dataset.panelDescription", "Manage shared API key environment variables in one place."),
    createPatch(() => heading("secrets"), "textContent", "Shared Secrets"),
    createPatch(() => copy("secrets"), "textContent", "Store local runtime secrets for models and bot connectors."),
    createPatch(() => elements.addSecretButton, "textContent", "Add Secret"),
    createPatch(() => panel("batch"), "dataset.panelKicker", "Batch"),
    createPatch(() => panel("batch"), "dataset.panelTitle", "Batch Add Models"),
    createPatch(() => panel("batch"), "dataset.panelDescription", "Generate multiple model entries that share one base URL and model name with different API keys."),
    createPatch(() => heading("batch"), "textContent", "Batch Add Models"),
    createPatch(() => copy("batch"), "textContent", "Best for one URL and one model name with multiple API keys."),
    createPatch(() => elements.batchAddButton, "textContent", "Generate Batch"),
    createPatch(() => panel("bot"), "dataset.panelKicker", "Bots"),
    createPatch(() => panel("bot"), "dataset.panelTitle", "Bot Settings"),
    createPatch(() => panel("bot"), "dataset.panelDescription", "Bridge chat platform commands into the agent cluster."),
    createPatch(() => panel("workspace"), "dataset.panelKicker", "Workspace"),
    createPatch(() => panel("workspace"), "dataset.panelTitle", "Workspace"),
    createPatch(() => panel("workspace"), "dataset.panelDescription", "Models can only read, generate, and modify files inside the current workspace."),
    createPatch(() => heading("workspace"), "textContent", "Workspace Directory"),
    createPatch(() => copy("workspace"), "textContent", "Models can only read and generate files inside this directory."),
    createPatch(() => elements.clearWorkspaceCacheButton, "textContent", "Clear Cluster Cache"),
    createPatch(() => elements.pickWorkspaceButton, "textContent", "Choose Folder"),
    createPatch(() => elements.refreshWorkspaceButton, "textContent", "Refresh Workspace"),
    createPatch(() => resolveFieldLabel(elements.workspaceDirInput), "textContent", "Directory Path"),
    createPatch(() => root.querySelector("#workspaceTreePanel h4"), "textContent", "File Tree"),
    createPatch(
      () => root.querySelector("#workspaceTreePanel .section-copy"),
      "textContent",
      "Collapsed by default to avoid flooding the layout with very deep trees."
    ),
    createPatch(() => root.querySelector("#importWorkspaceFilesButton"), "textContent", "Import to Workspace"),
    createPatch(() => root.querySelector('#workspace .subpanel-head.compact h4'), "textContent", "Import and Preview"),
    createPatch(() => resolveFieldLabel(elements.importWorkspaceFilesInput), "textContent", "Local Files"),
    createPatch(() => resolveFieldLabel(elements.workspaceImportTargetInput), "textContent", "Target Subdirectory"),
    createPatch(() => root.querySelectorAll('#workspace .subpanel-head.compact h4')[1], "textContent", "Read File"),
    createPatch(() => elements.readWorkspaceFileButton, "textContent", "Read File"),
    createPatch(() => resolveFieldLabel(elements.workspaceFilePathInput), "textContent", "Relative Path"),
    createPatch(() => panel("run"), "dataset.panelKicker", "Run"),
    createPatch(() => panel("run"), "dataset.panelTitle", "Run Task"),
    createPatch(() => panel("run"), "dataset.panelDescription", "Enter a task and inspect live status, planning, worker results, and final synthesis."),
    createPatch(() => heading("run"), "textContent", "Live Status"),
    createPatch(() => resolveFieldLabel(elements.taskInput), "textContent", "Task"),
    createPatch(() => elements.runButton, "textContent", "Run Cluster"),
    createPatch(() => elements.cancelButton, "textContent", "Cancel Task")
  ];
}

export function createLocaleUi({ root = document, elements, onChange = null } = {}) {
  const patches = buildEnglishPatches(elements, root);
  const baselineValues = new Map();
  let currentLocale = DEFAULT_LOCALE;

  function t(key, values = {}) {
    const locale = normalizeLocale(currentLocale);
    const catalog = MESSAGE_CATALOG[locale] || MESSAGE_CATALOG[DEFAULT_LOCALE];
    const fallbackCatalog = MESSAGE_CATALOG[DEFAULT_LOCALE];
    return interpolate(catalog[key] ?? fallbackCatalog[key] ?? key, values);
  }

  function applyLocale(nextLocale) {
    currentLocale = normalizeLocale(nextLocale);

    patches.forEach((patch, index) => {
      const node = patch.resolve(root, elements);
      if (!node) {
        return;
      }

      if (!baselineValues.has(index)) {
        baselineValues.set(index, getPropertyValue(node, patch.property));
      }

      setPropertyValue(
        node,
        patch.property,
        currentLocale === "en-US" ? patch.enValue : baselineValues.get(index)
      );
    });

    if (elements.languageSelect) {
      elements.languageSelect.value = currentLocale;
    }

    const html = root.documentElement || root.querySelector("html");
    if (html) {
      html.lang = currentLocale === "en-US" ? "en" : "zh-CN";
    }

    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, currentLocale);
    } catch {
      // Ignore storage failures.
    }

    onChange?.(currentLocale);
  }

  function restoreLocale() {
    let storedLocale = DEFAULT_LOCALE;

    try {
      storedLocale = localStorage.getItem(LOCALE_STORAGE_KEY) || DEFAULT_LOCALE;
    } catch {
      storedLocale = DEFAULT_LOCALE;
    }

    applyLocale(storedLocale);
  }

  function bindEvents() {
    elements.languageSelect?.addEventListener("change", (event) => {
      applyLocale(event.target.value);
    });
  }

  function getLocale() {
    return currentLocale;
  }

  return {
    applyLocale,
    bindEvents,
    getLocale,
    restoreLocale,
    t
  };
}

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
    "workspace.folderSelected": "已选择工作区目录，点击保存即可持久化。",
    "workspace.folderPickFailed": "选择文件夹失败：{error}",
    "workspace.importSelectRequired": "请先选择要导入的文件。",
    "workspace.importingFiles": "正在导入 {count} 个文件...",
    "workspace.importedPreview": "已导入 {count} 个文件，正在预览 {path}...",
    "workspace.importedDone": "文件已导入。",
    "workspace.importedStatus": "已导入 {count} 个文件到工作区。",
    "workspace.importFailed": "导入文件失败：{error}",
    "workspace.clearingCache": "正在清除集群运行缓存...",
    "workspace.cacheCleared": "集群缓存已清除：删除 {files} 个文件，{dirs} 个目录。",
    "workspace.cacheAlreadyEmpty": "未发现可清除的集群缓存。",
    "workspace.cacheClearFailed": "清除集群缓存失败：{error}",
    "workspace.cacheClearConfirm": "删除集群运行缓存吗？这会移除工作区中的分工材料缓存。",
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

function createPatch(resolve, property, enValue, zhValue = null) {
  return { resolve, property, enValue, zhValue };
}

function buildEnglishPatches(elements, root) {
  const panel = (panelId) => root.querySelector(`[data-console-panel="${panelId}"]`);
  const navButton = (panelId) => root.querySelector(`[data-console-nav="${panelId}"]`);
  const heading = (panelId) => panel(panelId)?.querySelector("h3");
  const copy = (panelId) => panel(panelId)?.querySelector(".section-copy");
  const field = (id) => root.querySelector(`#${id}`);
  const fieldLabel = (id) => resolveFieldLabel(field(id));
  const phaseHints = root.querySelectorAll('[data-console-panel="phases"] .field-hint');

  return [
    createPatch(() => root.querySelector("title"), "textContent", "Agent Cluster Workbench", "Agent 集群工作台"),
    createPatch(() => root.querySelector(".eyebrow"), "textContent", "Agent Cluster Workbench", "Agent 集群工作台"),
    createPatch(() => elements.languageLabel, "textContent", "Language", "语言"),
    createPatch(() => root.querySelector(".credit-title"), "textContent", "Multi-Model Agent Cluster Console", "多模型 Agent 集群控制台"),
    createPatch(() => root.querySelector(".hero-copy"), "textContent", "design by Dreaming World", "design by 想画世界送给你"),
    createPatch(() => root.querySelector(".dream-kicker"), "textContent", "Dream Console", "梦境控制台"),
    createPatch(() => root.querySelector(".dream-title"), "textContent", "Control and Collaboration", "控制与协作"),
    createPatch(() => root.querySelector(".console-sidebar-head .panel-kicker"), "textContent", "Navigation", "导航"),
    createPatch(() => root.querySelector(".console-sidebar-head h2"), "textContent", "Workbench Navigation", "工作台导航"),
    createPatch(
      () => root.querySelector(".console-sidebar-head .section-copy"),
      "textContent",
      "Choose a panel on the left to switch the workspace on the right.",
      "点击左侧菜单，右侧切换到对应的设置或运行面板。"
    ),
    createPatch(() => root.querySelector(".console-nav-label"), "textContent", "Config", "配置"),
    createPatch(() => navButton("cluster"), "textContent", "Cluster", "集群设置"),
    createPatch(() => navButton("schemes"), "textContent", "Schemes", "方案配置"),
    createPatch(() => navButton("phases"), "textContent", "Phases", "阶段并发"),
    createPatch(() => navButton("secrets"), "textContent", "Secrets", "共享密钥"),
    createPatch(() => navButton("batch"), "textContent", "Batch Add", "批量添加"),
    createPatch(() => navButton("models"), "textContent", "Models", "模型列表"),
    createPatch(() => navButton("multiAgent"), "textContent", "Multi-Agent", "协作框架"),
    createPatch(() => navButton("connectivity"), "textContent", "Connectivity", "模型通联"),
    createPatch(() => navButton("bot"), "textContent", "Bots", "Bot 配置"),
    createPatch(() => navButton("workspace"), "textContent", "Workspace", "工作区"),
    createPatch(() => navButton("run"), "textContent", "Run", "运行任务"),
    createPatch(
      () => root.querySelector(".console-sidebar-status p"),
      "textContent",
      "The right-side fixed panels keep the agent topology, inspector, and collaboration chatroom.",
      "右侧固定面板保留 Agent 拓扑图、检查器和协作聊天室。"
    ),
    createPatch(() => root.querySelector('#languageSelect option[value="zh-CN"]'), "textContent", "Chinese", "中文"),
    createPatch(() => elements.reloadButton, "textContent", "Reload", "重新加载"),
    createPatch(() => elements.exitAppButton, "textContent", "Exit", "退出程序"),
    createPatch(() => elements.saveButton, "textContent", "Save", "保存配置"),
    createPatch(() => elements.saveStatusClose, "ariaLabel", "Close notification", "关闭通知"),
    createPatch(() => root.querySelector("#runState"), "textContent", "Idle", "空闲"),

    createPatch(() => panel("cluster"), "dataset.panelKicker", "Config", "配置"),
    createPatch(() => panel("cluster"), "dataset.panelTitle", "Cluster Settings", "集群设置"),
    createPatch(
      () => panel("cluster"),
      "dataset.panelDescription",
      "Configure global concurrency, the controller model, and delegation depth.",
      "配置全局并发、主控模型和委派深度。"
    ),
    createPatch(() => heading("cluster"), "textContent", "Core Settings", "基础设置"),
    createPatch(() => panel("cluster")?.querySelector(".subpanel-head .chip"), "textContent", "Cluster", "集群"),
    createPatch(() => fieldLabel("portInput"), "textContent", "Port", "监听端口"),
    createPatch(() => fieldLabel("parallelInput"), "textContent", "Max Parallel", "最大并发"),
    createPatch(() => fieldLabel("subordinateParallelInput"), "textContent", "Subordinate Parallel Limit", "组员并发上限"),
    createPatch(() => fieldLabel("groupLeaderMaxDelegatesInput"), "textContent", "Leader Delegate Cap", "组长委派上限"),
    createPatch(() => fieldLabel("delegateMaxDepthInput"), "textContent", "Delegate Max Depth", "委派最大层级"),
    createPatch(() => fieldLabel("controllerSelect"), "textContent", "Controller Model", "主控模型"),

    createPatch(() => panel("schemes"), "dataset.panelKicker", "Scheme", "方案"),
    createPatch(() => panel("schemes"), "dataset.panelTitle", "Scheme Settings", "方案配置"),
    createPatch(
      () => panel("schemes"),
      "dataset.panelDescription",
      "Switch the active scheme and keep an isolated model set for each scheme.",
      "切换当前方案，并为每个方案维护独立的模型集合。"
    ),
    createPatch(() => heading("schemes"), "textContent", "Scheme Settings", "方案配置"),
    createPatch(() => panel("schemes")?.querySelector(".subpanel-head .chip"), "textContent", "Schemes", "方案"),
    createPatch(() => fieldLabel("schemeSelect"), "textContent", "Current Scheme", "当前方案"),
    createPatch(() => fieldLabel("schemeNameInput"), "textContent", "Scheme Name", "方案名称"),
    createPatch(() => elements.addSchemeButton, "textContent", "Add Scheme", "新增方案"),
    createPatch(() => elements.removeSchemeButton, "textContent", "Remove Scheme", "删除当前方案"),
    createPatch(() => elements.schemeHint, "textContent", "Models, connectivity tests, and runs all follow the active scheme.", "模型、通联测试和运行都会跟随当前方案。"),

    createPatch(() => panel("phases"), "dataset.panelKicker", "Phases", "阶段"),
    createPatch(() => panel("phases"), "dataset.panelTitle", "Phase Concurrency", "阶段并发"),
    createPatch(
      () => panel("phases"),
      "dataset.panelDescription",
      "Control the concurrency cap for research, implementation, validation, and handoff.",
      "分别控制调研、实现、验证和交付四个阶段的并发上限。"
    ),
    createPatch(() => heading("phases"), "textContent", "Phase Concurrency", "阶段并发"),
    createPatch(() => panel("phases")?.querySelector(".subpanel-head .chip"), "textContent", "Phases", "阶段"),
    createPatch(() => copy("phases"), "textContent", "Leave blank to use the system default. Effective values never exceed max parallel.", "留空表示使用系统默认值，实际生效值不会超过“最大并发”。"),
    createPatch(() => fieldLabel("phaseResearchInput"), "textContent", "Research", "调研"),
    createPatch(() => fieldLabel("phaseImplementationInput"), "textContent", "Implementation", "实现"),
    createPatch(() => fieldLabel("phaseValidationInput"), "textContent", "Validation", "验证"),
    createPatch(() => fieldLabel("phaseHandoffInput"), "textContent", "Handoff", "交付"),
    createPatch(() => phaseHints?.[0], "textContent", "Web search, case collection, and material gathering. For search-heavy tasks, 1 to 2 is usually enough.", "联网搜索、案例收集和资料整理。搜索密集任务通常 1 到 2 个就够。"),
    createPatch(() => phaseHints?.[1], "textContent", "Code changes, scripts, and generated files. Raise this according to your available models.", "写代码、改脚本和生成文件。可按你的可用模型数量适当放开。"),
    createPatch(() => phaseHints?.[2], "textContent", "Testing, review, and build checks. Keep it aligned with machine load.", "测试、复核和构建检查。建议结合机器负载控制。"),
    createPatch(() => phaseHints?.[3], "textContent", "Final document assembly and synthesis. Usually 1 is enough to avoid duplicate output.", "最终文档和汇总通常 1 个就够，避免重复输出。"),

    createPatch(() => panel("secrets"), "dataset.panelKicker", "Secrets", "密钥"),
    createPatch(() => panel("secrets"), "dataset.panelTitle", "Shared Secrets", "共享密钥"),
    createPatch(
      () => panel("secrets"),
      "dataset.panelDescription",
      "Manage shared API key environment variables in one place.",
      "统一管理共享 API Key 环境变量。"
    ),
    createPatch(() => heading("secrets"), "textContent", "Shared Secrets", "共享密钥"),
    createPatch(() => copy("secrets"), "textContent", "Store local runtime secrets for models and bot connectors.", "保存本地运行所需密钥，供模型和 Bot 连接器复用。"),
    createPatch(() => elements.addSecretButton, "textContent", "Add Secret", "添加密钥"),

    createPatch(() => panel("batch"), "dataset.panelKicker", "Batch", "批量"),
    createPatch(() => panel("batch"), "dataset.panelTitle", "Batch Add Models", "批量添加模型"),
    createPatch(
      () => panel("batch"),
      "dataset.panelDescription",
      "Generate multiple model entries that share one base URL and model name with different API keys.",
      "同一 Base URL 与模型名下，批量生成多组不同 API Key 的模型配置。"
    ),
    createPatch(() => heading("batch"), "textContent", "Batch Add Models", "批量添加模型"),
    createPatch(() => copy("batch"), "textContent", "Best for one URL and one model name with multiple API keys.", "适合同一 URL 与模型名、但使用多组 API Key 的场景。"),
    createPatch(() => elements.batchAddButton, "textContent", "Generate Batch", "批量生成"),
    createPatch(() => fieldLabel("batchIdPrefixInput"), "textContent", "ID Prefix", "ID 前缀"),
    createPatch(() => fieldLabel("batchLabelPrefixInput"), "textContent", "Display Label Prefix", "显示名称前缀"),
    createPatch(() => fieldLabel("batchEnvPrefixInput"), "textContent", "Secret Env Prefix", "密钥变量名前缀"),
    createPatch(() => fieldLabel("batchProviderSelect"), "textContent", "Provider", "服务商"),
    createPatch(() => fieldLabel("batchModelNameInput"), "textContent", "Model Name", "模型名"),
    createPatch(() => fieldLabel("batchRoleSelect"), "textContent", "Role", "角色"),
    createPatch(() => root.querySelector('#batchRoleSelect option[value="worker"]'), "textContent", "Worker Only", "仅工作"),
    createPatch(() => root.querySelector('#batchRoleSelect option[value="controller"]'), "textContent", "Controller Only", "仅主控"),
    createPatch(() => root.querySelector('#batchRoleSelect option[value="hybrid"]'), "textContent", "Controller + Worker", "主控 + 工作"),
    createPatch(() => fieldLabel("batchBaseUrlInput"), "textContent", "Base URL", "基础 URL"),
    createPatch(() => fieldLabel("batchAuthStyleSelect"), "textContent", "Auth Style", "鉴权方式"),
    createPatch(() => fieldLabel("batchApiKeyHeaderInput"), "textContent", "API Key Header", "API Key 请求头"),
    createPatch(() => fieldLabel("batchReasoningSelect"), "textContent", "Reasoning", "推理强度"),
    createPatch(() => fieldLabel("batchThinkingInput"), "textContent", "Enable Thinking", "开启 Thinking 模式"),
    createPatch(() => field("batchThinkingInput")?.closest(".toggle-control")?.querySelector("span"), "textContent", "Useful for complex tasks. Some providers automatically disable thinking during web search for compatibility.", "适合复杂任务，部分服务商会在联网搜索时自动关闭。"),
    createPatch(() => fieldLabel("batchWebSearchInput"), "textContent", "Allow Web Search", "允许联网搜索"),
    createPatch(() => fieldLabel("batchTemperatureInput"), "textContent", "Temperature", "温度"),
    createPatch(() => root.querySelector("#batchCapabilityList")?.closest(".field")?.querySelector(":scope > span"), "textContent", "Capabilities", "职责能力"),
    createPatch(() => fieldLabel("batchSpecialtiesCustomInput"), "textContent", "Custom Specialties", "自定义补充"),
    createPatch(() => root.querySelector("#batchKeysList")?.closest(".field")?.querySelector(":scope > span"), "textContent", "API Key List", "API Key 列表"),
    createPatch(() => root.querySelector("#batchKeysList")?.closest(".field")?.querySelector(".field-hint"), "textContent", "Paste one key per line and the form will split them into multiple inputs automatically.", "支持逐行粘贴多条 Key，并自动拆分为多个输入框。"),

    createPatch(() => panel("models"), "dataset.panelKicker", "Models", "模型"),
    createPatch(() => panel("models"), "dataset.panelTitle", "Models", "模型列表"),
    createPatch(
      () => panel("models"),
      "dataset.panelDescription",
      "Manage all models in the active scheme and test connectivity here.",
      "管理当前方案下的全部模型，并在这里完成通联测试。"
    ),
    createPatch(() => heading("models"), "textContent", "Models", "模型列表"),
    createPatch(() => copy("models"), "textContent", "Edit each model, switch providers, and test connectivity directly.", "逐个编辑模型配置、切换 Provider，并直接测试连接。"),
    createPatch(() => elements.addModelButton, "textContent", "Add Model", "添加模型"),

    createPatch(() => panel("multiAgent"), "dataset.panelKicker", "Framework", "框架"),
    createPatch(() => panel("multiAgent"), "dataset.panelTitle", "Multi-Agent Framework", "多智能体框架"),
    createPatch(
      () => panel("multiAgent"),
      "dataset.panelDescription",
      "Enable or disable the collaboration layer and tune chat-oriented runtime parameters.",
      "单独启用或关闭协作框架，并调整会话展示与执行参数。"
    ),
    createPatch(() => heading("multiAgent"), "textContent", "Framework Settings", "框架设置"),
    createPatch(() => panel("multiAgent")?.querySelector(".subpanel-head .chip"), "textContent", "Framework", "框架"),
    createPatch(() => copy("multiAgent"), "textContent", "Keep the original cluster behavior when disabled, or enable chat-oriented collaboration tracking and execution modes.", "关闭时保持原始集群编排；开启后会记录协作消息，并按模式调整执行方式。"),
    createPatch(() => fieldLabel("multiAgentEnabledInput"), "textContent", "Enable Framework", "启用框架"),
    createPatch(() => fieldLabel("multiAgentModeSelect"), "textContent", "Mode", "协作模式"),
    createPatch(() => fieldLabel("multiAgentSpeakerStrategySelect"), "textContent", "Speaker Strategy", "发言策略"),
    createPatch(() => fieldLabel("multiAgentMaxRoundsInput"), "textContent", "Max Rounds", "最大轮次"),
    createPatch(() => fieldLabel("multiAgentTerminationKeywordInput"), "textContent", "Termination Keyword", "终止关键词"),
    createPatch(() => fieldLabel("multiAgentMessageWindowInput"), "textContent", "Message Window", "消息窗口"),
    createPatch(() => fieldLabel("multiAgentSummarizeInput"), "textContent", "Summarize Long Messages", "长消息摘要化"),
    createPatch(() => fieldLabel("multiAgentIncludeSystemInput"), "textContent", "Include System Messages", "包含系统消息"),
    createPatch(() => root.querySelector("#multiAgentSettingsHint"), "textContent", "When enabled, the app records collaboration messages, phase handoffs, and the final session snapshot. Group chat keeps parallel execution, sequential mode serializes top-level tasks, and workflow mode strengthens phase handoffs.", "开启后会记录协作消息、阶段接力和最终会话快照。群聊模式保留并行，顺序模式会串行化顶层任务，工作流模式会强化跨阶段交接。"),

    createPatch(() => panel("connectivity"), "dataset.panelKicker", "Connectivity", "通联"),
    createPatch(() => panel("connectivity"), "dataset.panelTitle", "Model Connectivity", "模型通联"),
    createPatch(
      () => panel("connectivity"),
      "dataset.panelDescription",
      "Test the current scheme from the left menu instead of occupying the right-side runtime viewport.",
      "把当前方案的模型通联测试收纳到左侧菜单，不再占用右侧运行视图。"
    ),
    createPatch(() => heading("connectivity"), "textContent", "Scheme Connectivity", "方案通联"),
    createPatch(() => copy("connectivity"), "textContent", "Automatic checks run on startup, and you can re-test the active scheme here at any time.", "程序启动时会自动检查，也可以随时在这里重试当前方案。"),
    createPatch(() => root.querySelector("#schemeConnectivityStatus"), "textContent", "Waiting", "等待检测"),
    createPatch(() => root.querySelector("#schemeConnectivityRetestButton"), "textContent", "Retest", "重新检测"),
    createPatch(() => root.querySelector("#schemeConnectivityList .placeholder"), "textContent", "Waiting for automatic checks...", "等待自动检测..."),

    createPatch(() => panel("bot"), "dataset.panelKicker", "Bots", "Bot"),
    createPatch(() => panel("bot"), "dataset.panelTitle", "Bot Settings", "Bot 配置"),
    createPatch(
      () => panel("bot"),
      "dataset.panelDescription",
      "Bridge chat platform commands into the agent cluster.",
      "把聊天平台命令桥接到 Agent 集群。"
    ),
    createPatch(() => heading("bot"), "textContent", "Bot Settings", "Bot 配置"),
    createPatch(() => copy("bot"), "textContent", "Bridge chat commands into the agent cluster.", "通过命令前缀把聊天平台消息桥接到 Agent 集群。"),
    createPatch(() => root.querySelector("#botConfigStatus"), "textContent", "Loading presets", "预设加载中"),
    createPatch(() => fieldLabel("botInstallDirInput"), "textContent", "Install Directory", "安装目录"),
    createPatch(() => fieldLabel("botCommandPrefixInput"), "textContent", "Command Prefix", "命令前缀"),
    createPatch(() => fieldLabel("botAutoStartInput"), "textContent", "Auto Start Bots", "自动启动 Bot"),
    createPatch(() => fieldLabel("botProgressUpdatesInput"), "textContent", "Forward Progress Updates", "转发进度消息"),
    createPatch(() => fieldLabel("botCustomCommandInput"), "textContent", "Custom Install Command", "自定义安装命令"),
    createPatch(() => root.querySelector("#startAllBotsButton"), "textContent", "Start All Bots", "启动全部 Bot"),
    createPatch(() => root.querySelector("#stopAllBotsButton"), "textContent", "Stop All Bots", "停止全部 Bot"),
    createPatch(() => root.querySelector("#refreshBotRuntimeButton"), "textContent", "Refresh Status", "刷新状态"),
    createPatch(() => root.querySelector("#runCustomBotInstallButton"), "textContent", "Run Custom Command", "执行自定义命令"),
    createPatch(() => root.querySelector("#copyBotCommandsButton"), "textContent", "Copy Selected Commands", "复制已选命令"),
    createPatch(() => root.querySelector("#botPresetList .placeholder"), "textContent", "Loading bot presets...", "正在加载 Bot 预设..."),
    createPatch(() => root.querySelector("#botInstallOutput"), "textContent", "Select a preset to view install commands, runtime status, and bridge logs.", "选择一个预设后，可查看安装命令、运行状态和桥接日志。"),

    createPatch(() => panel("workspace"), "dataset.panelKicker", "Workspace", "工作区"),
    createPatch(() => panel("workspace"), "dataset.panelTitle", "Workspace", "工作区"),
    createPatch(
      () => panel("workspace"),
      "dataset.panelDescription",
      "Models can only read, generate, and modify files inside the current workspace.",
      "模型只能在当前工作区内读取、生成和修改文件。"
    ),
    createPatch(() => heading("workspace"), "textContent", "Workspace Directory", "工作区目录"),
    createPatch(() => copy("workspace"), "textContent", "Models can only read and generate files inside this directory.", "模型只能在这个目录内读取和生成文件。"),
    createPatch(() => elements.clearWorkspaceCacheButton, "textContent", "Clear Cluster Cache", "清除集群缓存"),
    createPatch(() => elements.pickWorkspaceButton, "textContent", "Choose Folder", "选择文件夹"),
    createPatch(() => elements.refreshWorkspaceButton, "textContent", "Refresh Workspace", "刷新工作区"),
    createPatch(() => fieldLabel("workspaceDirInput"), "textContent", "Directory Path", "目录路径"),
    createPatch(() => root.querySelector("#workspaceTreePanel h4"), "textContent", "File Tree", "文件树"),
    createPatch(() => root.querySelector("#workspaceTreePanel .section-copy"), "textContent", "Collapsed by default to avoid flooding the layout with very deep trees.", "默认折叠，避免超深目录挤满界面。"),
    createPatch(() => root.querySelector("#workspaceTreePanel .chip"), "textContent", "Workspace", "工作区"),
    createPatch(() => root.querySelector("#workspaceTreeOutput"), "textContent", "Save the settings to load the workspace tree here.", "保存配置后可在这里查看工作区文件树。"),
    createPatch(() => root.querySelector("#importWorkspaceFilesButton"), "textContent", "Import to Workspace", "导入到工作区"),
    createPatch(() => root.querySelector('#workspace .subpanel-head.compact h4'), "textContent", "Import and Preview", "导入与预览"),
    createPatch(() => fieldLabel("importWorkspaceFilesInput"), "textContent", "Local Files", "本地文件"),
    createPatch(() => fieldLabel("workspaceImportTargetInput"), "textContent", "Target Subdirectory", "导入到子目录"),
    createPatch(() => root.querySelectorAll('#workspace .subpanel-head.compact h4')[1], "textContent", "Read File", "读取文件"),
    createPatch(() => elements.readWorkspaceFileButton, "textContent", "Read File", "读取文件"),
    createPatch(() => fieldLabel("workspaceFilePathInput"), "textContent", "Relative Path", "相对路径"),
    createPatch(() => root.querySelector("#workspaceFileOutput"), "textContent", "Enter a relative path to preview the file content.", "输入相对路径后可查看文件内容。"),

    createPatch(() => panel("run"), "dataset.panelKicker", "Run", "运行"),
    createPatch(() => panel("run"), "dataset.panelTitle", "Run Task", "运行任务"),
    createPatch(
      () => panel("run"),
      "dataset.panelDescription",
      "Enter a task and inspect live status, planning, worker results, and final synthesis.",
      "输入任务，查看实时状态、任务计划、工作模型结果和最终汇总。"
    ),
    createPatch(() => heading("run"), "textContent", "Live Status", "实时状态"),
    createPatch(() => fieldLabel("taskInput"), "textContent", "Task", "分析任务"),
    createPatch(() => elements.runButton, "textContent", "Run Cluster", "运行集群"),
    createPatch(() => elements.cancelButton, "textContent", "Cancel Task", "终止任务"),
    createPatch(() => root.querySelector("#configHint"), "textContent", "Run directly after saving your settings.", "保存配置后即可直接运行。"),
    createPatch(() => root.querySelector("#consoleNav"), "ariaLabel", "Workbench navigation", "工作台导航"),
    createPatch(() => elements.liveOutput?.closest(".subpanel")?.querySelector("h3"), "textContent", "Live Status", "实时状态"),
    createPatch(() => elements.liveOutput?.closest(".subpanel")?.querySelector(".chip"), "textContent", "Live", "实时"),
    createPatch(() => elements.planOutput?.closest(".subpanel")?.querySelector("h3"), "textContent", "Task Plan", "任务计划"),
    createPatch(() => elements.planOutput?.closest(".subpanel")?.querySelector(".chip"), "textContent", "Controller", "主控"),
    createPatch(() => elements.workerOutput?.closest(".subpanel")?.querySelector("h3"), "textContent", "Worker Results", "工作模型结果"),
    createPatch(() => elements.workerOutput?.closest(".subpanel")?.querySelector(".chip"), "textContent", "Workers", "工作模型"),
    createPatch(() => elements.synthesisOutput?.closest(".subpanel")?.querySelector("h3"), "textContent", "Final Synthesis", "最终汇总"),
    createPatch(() => elements.synthesisOutput?.closest(".subpanel")?.querySelector(".chip"), "textContent", "Synthesis", "汇总"),
    createPatch(() => root.querySelector("#taskTracePanel h3") || elements.traceOutput?.closest(".subpanel")?.querySelector("h3"), "textContent", "Task Trace", "任务 Trace"),
    createPatch(() => (root.querySelector("#taskTracePanel") || elements.traceOutput?.closest(".subpanel"))?.querySelector(".chip"), "textContent", "Trace", "调用链"),
    createPatch(() => elements.sessionOutput?.closest(".subpanel")?.querySelector("h3"), "textContent", "Session Stats", "会话统计"),
    createPatch(() => elements.sessionOutput?.closest(".subpanel")?.querySelector(".chip"), "textContent", "Session", "会话"),
    createPatch(() => root.querySelector("#planOutput"), "textContent", "Waiting for a run...", "等待运行..."),
    createPatch(() => root.querySelector("#workerOutput .placeholder"), "textContent", "No worker results yet.", "运行后会在这里显示各个工作模型的结果。"),
    createPatch(() => root.querySelector("#synthesisOutput .placeholder"), "textContent", "The controller model returns the final synthesis here.", "主控模型会在这里给出最终结论。"),
    createPatch(() => root.querySelector("#traceOutput .placeholder"), "textContent", "Run the cluster to populate the task trace and call chain.", "运行后会在这里显示任务 Trace 和调用链。"),
    createPatch(() => root.querySelector("#sessionOutput .placeholder"), "textContent", "Run the cluster to populate session memory, token/cost stats, retries, and circuit-breaker state.", "运行后会在这里显示会话记忆、Token / 成本、重试与熔断状态。"),

    createPatch(() => root.querySelector(".agent-viewport-head .panel-kicker"), "textContent", "Agents", "代理集群"),
    createPatch(() => root.querySelector(".agent-viewport-head h2"), "textContent", "Virtual Cluster View", "虚拟集群视图"),
    createPatch(() => root.querySelector("#agentVizSummary"), "textContent", "Idle", "空闲"),
    createPatch(() => root.querySelector(".agent-viz-hint"), "textContent", "Use the wheel to zoom, drag the canvas, and click a node to inspect its task and status.", "滚轮缩放，拖动画布，点击节点可查看任务与状态。"),
    createPatch(() => elements.agentVizResetButton, "textContent", "Center", "居中"),
    createPatch(() => root.querySelector("#agentVizStage"), "ariaLabel", "Agent cluster graph", "Agent 集群动态图"),
    createPatch(() => root.querySelector("#agentVizSvg"), "ariaLabel", "Agent cluster topology", "Agent 集群拓扑图"),
    createPatch(() => root.querySelector("#agentVizInspector .placeholder"), "textContent", "Click a node after the run starts to inspect details. Hovering previews the current action.", "运行后点击节点可查看详情，悬停时会预览当前动作。"),
    createPatch(() => elements.multiAgentChatTitle, "textContent", "Agent Chatroom", "Agent 聊天室"),
    createPatch(() => elements.multiAgentChatDescription, "textContent", "Enable the multi-agent framework on the left to inspect controller, leader, and child-agent collaboration here.", "开启左侧多智能体框架后，这里会展示主控、组长和子 Agent 之间的交流细节。"),
    createPatch(() => elements.multiAgentChatStatus, "textContent", "Disabled", "未启用"),
    createPatch(() => elements.multiAgentChatMeta, "textContent", "Group Chat · 0 messages", "动态群聊 · 0 条消息"),
    createPatch(() => root.querySelector("#multiAgentChatSummary .placeholder"), "textContent", "The session summary appears here after a run starts.", "等待运行后生成会话摘要。"),
    createPatch(() => root.querySelector("#multiAgentChatroom .placeholder"), "textContent", "No collaboration messages yet.", "当前还没有协作消息。"),
    createPatch(() => elements.saveStatus, "textContent", "Local configuration loaded.", "本地配置已加载。")
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
        currentLocale === "en-US" ? patch.enValue : patch.zhValue ?? baselineValues.get(index)
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

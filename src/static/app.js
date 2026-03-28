import {
  DEFAULT_PROVIDER_ID,
  getProviderDefinition,
  listProviderDefinitions,
  providerSupportsCapability
} from "./provider-catalog.js";
import {
  buildAgentLayout as buildAgentTreeLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "./agent-graph-layout.js";

const saveStatus = document.querySelector("#saveStatus");
const saveButton = document.querySelector("#saveButton");
const reloadButton = document.querySelector("#reloadButton");
const exitAppButton = document.querySelector("#exitAppButton");
const addSecretButton = document.querySelector("#addSecretButton");
const addModelButton = document.querySelector("#addModelButton");
const batchAddButton = document.querySelector("#batchAddButton");
const secretList = document.querySelector("#secretList");
const modelList = document.querySelector("#modelList");
const portInput = document.querySelector("#portInput");
const parallelInput = document.querySelector("#parallelInput");
const subordinateParallelInput = document.querySelector("#subordinateParallelInput");
const groupLeaderMaxDelegatesInput = document.querySelector("#groupLeaderMaxDelegatesInput");
const delegateMaxDepthInput = document.querySelector("#delegateMaxDepthInput");
const schemeSelect = document.querySelector("#schemeSelect");
const schemeNameInput = document.querySelector("#schemeNameInput");
const addSchemeButton = document.querySelector("#addSchemeButton");
const removeSchemeButton = document.querySelector("#removeSchemeButton");
const schemeHint = document.querySelector("#schemeHint");
const phaseResearchInput = document.querySelector("#phaseResearchInput");
const phaseImplementationInput = document.querySelector("#phaseImplementationInput");
const phaseValidationInput = document.querySelector("#phaseValidationInput");
const phaseHandoffInput = document.querySelector("#phaseHandoffInput");
const controllerSelect = document.querySelector("#controllerSelect");
const taskInput = document.querySelector("#taskInput");
const runButton = document.querySelector("#runButton");
const cancelButton = document.querySelector("#cancelButton");
const runState = document.querySelector("#runState");
const configHint = document.querySelector("#configHint");
const planOutput = document.querySelector("#planOutput");
const workerOutput = document.querySelector("#workerOutput");
const synthesisOutput = document.querySelector("#synthesisOutput");
const liveOutput = document.querySelector("#liveOutput");
const agentVizSummary = document.querySelector("#agentVizSummary");
const agentVizTimer = document.querySelector("#agentVizTimer");
const agentVizCanvas = document.querySelector("#agentVizCanvas");
const agentVizStage = document.querySelector("#agentVizStage");
const agentVizZoomLayer = document.querySelector("#agentVizZoomLayer");
const agentVizSvg = document.querySelector("#agentVizSvg");
const agentVizTooltip = document.querySelector("#agentVizTooltip");
const agentVizInspector = document.querySelector("#agentVizInspector");
const agentVizZoomLabel = document.querySelector("#agentVizZoomLabel");
const agentVizZoomOutButton = document.querySelector("#agentVizZoomOut");
const agentVizZoomInButton = document.querySelector("#agentVizZoomIn");
const agentVizResetButton = document.querySelector("#agentVizReset");
const schemeConnectivityStatus = document.querySelector("#schemeConnectivityStatus");
const schemeConnectivityList = document.querySelector("#schemeConnectivityList");
const schemeConnectivityRetestButton = document.querySelector("#schemeConnectivityRetestButton");
const saveToast = document.querySelector("#saveToast");
const saveStatusClose = document.querySelector("#saveStatusClose");
const botConfigStatus = document.querySelector("#botConfigStatus");
const botInstallDirInput = document.querySelector("#botInstallDirInput");
const botCommandPrefixInput = document.querySelector("#botCommandPrefixInput");
const botAutoStartInput = document.querySelector("#botAutoStartInput");
const botProgressUpdatesInput = document.querySelector("#botProgressUpdatesInput");
const botCustomCommandInput = document.querySelector("#botCustomCommandInput");
const botPresetList = document.querySelector("#botPresetList");
const botInstallOutput = document.querySelector("#botInstallOutput");
const startAllBotsButton = document.querySelector("#startAllBotsButton");
const stopAllBotsButton = document.querySelector("#stopAllBotsButton");
const refreshBotRuntimeButton = document.querySelector("#refreshBotRuntimeButton");
const runCustomBotInstallButton = document.querySelector("#runCustomBotInstallButton");
const copyBotCommandsButton = document.querySelector("#copyBotCommandsButton");
const workspaceDirInput = document.querySelector("#workspaceDirInput");
const pickWorkspaceButton = document.querySelector("#pickWorkspaceButton");
const refreshWorkspaceButton = document.querySelector("#refreshWorkspaceButton");
const workspaceTreeOutput = document.querySelector("#workspaceTreeOutput");
const importWorkspaceFilesInput = document.querySelector("#importWorkspaceFilesInput");
const importWorkspaceFilesButton = document.querySelector("#importWorkspaceFilesButton");
const workspaceImportTargetInput = document.querySelector("#workspaceImportTargetInput");
const workspaceFilePathInput = document.querySelector("#workspaceFilePathInput");
const readWorkspaceFileButton = document.querySelector("#readWorkspaceFileButton");
const workspaceFileOutput = document.querySelector("#workspaceFileOutput");
const consoleNav = document.querySelector("#consoleNav");
const consolePanelKicker = document.querySelector("#consolePanelKicker");
const consolePanelTitle = document.querySelector("#consolePanelTitle");
const consolePanelDescription = document.querySelector("#consolePanelDescription");
const secretTemplate = document.querySelector("#secretTemplate");
const modelTemplate = document.querySelector("#modelTemplate");

const batchIdPrefixInput = document.querySelector("#batchIdPrefixInput");
const batchLabelPrefixInput = document.querySelector("#batchLabelPrefixInput");
const batchEnvPrefixInput = document.querySelector("#batchEnvPrefixInput");
const batchProviderSelect = document.querySelector("#batchProviderSelect");
const batchProviderHint = document.querySelector("#batchProviderHint");
const batchModelNameInput = document.querySelector("#batchModelNameInput");
const batchBaseUrlInput = document.querySelector("#batchBaseUrlInput");
const batchAuthStyleSelect = document.querySelector("#batchAuthStyleSelect");
const batchApiKeyHeaderInput = document.querySelector("#batchApiKeyHeaderInput");
const batchReasoningSelect = document.querySelector("#batchReasoningSelect");
const batchWebSearchInput = document.querySelector("#batchWebSearchInput");
const batchTemperatureInput = document.querySelector("#batchTemperatureInput");
const batchCapabilityList = document.querySelector("#batchCapabilityList");
const batchSpecialtiesCustomInput = document.querySelector("#batchSpecialtiesCustomInput");
const batchKeysList = document.querySelector("#batchKeysList");
const consoleNavButtons = Array.from(document.querySelectorAll("[data-console-nav]"));
const consolePanels = Array.from(document.querySelectorAll("[data-console-panel]"));

const LIVE_EVENT_LIMIT = 60;
const DEFAULT_CONSOLE_PANEL_ID = "cluster";
const CONSOLE_PANEL_STORAGE_KEY = "agent-cluster:active-console-panel";
const PROVIDER_DEFINITIONS = listProviderDefinitions();
let currentOperationId = "";
let currentOperationStream = null;
let currentClusterRequestController = null;
let saveToastTimer = null;
let agentRunTimerInterval = null;
const PHASE_PARALLEL_INPUTS = {
  research: phaseResearchInput,
  implementation: phaseImplementationInput,
  validation: phaseValidationInput,
  handoff: phaseHandoffInput
};
const AGENT_PREFIXES = {
  research: { leader: "调研组长", subordinate: "调研下属" },
  implementation: { leader: "编码组长", subordinate: "编码下属" },
  validation: { leader: "验证组长", subordinate: "验证下属" },
  handoff: { leader: "交付组长", subordinate: "交付下属" },
  general: { leader: "分析组长", subordinate: "分析下属" }
};
const MODEL_CAPABILITY_OPTIONS = [
  { value: "controller", label: "主控" },
  { value: "research", label: "调研" },
  { value: "implementation", label: "编码" },
  { value: "coding_manager", label: "编码总管理" },
  { value: "validation", label: "验证" },
  { value: "handoff", label: "交付" },
  { value: "general", label: "通用" }
];
const knownModelConfigs = new Map();
const schemeUiState = {
  schemes: [],
  currentSchemeId: "",
  connectivityBySchemeId: new Map(),
  connectivityRunToken: 0
};
const botUiState = {
  defaultInstallDir: "bot-connectors",
  presets: [],
  enabledPresetIds: new Set(),
  presetConfigById: new Map(),
  runtimeById: new Map(),
  secretValueByName: new Map(),
  installStatusById: new Map(),
  installingPresetId: ""
};
const agentGraphState = {
  operationId: "",
  agents: new Map(),
  controllerId: "",
  controllerLabel: ""
};
const agentVizState = {
  scale: 1,
  minScale: 0.001,
  maxScale: 3.2,
  panX: 0,
  panY: 0,
  graphWidth: 1200,
  graphHeight: 760,
  hasViewportInteraction: false,
  isDragging: false,
  dragPointerId: null,
  dragMoved: false,
  dragStartX: 0,
  dragStartY: 0,
  lastPointerX: 0,
  lastPointerY: 0,
  pointerDownAgentId: "",
  runStartedAt: 0,
  selectedAgentId: "",
  hoveredAgentId: ""
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function getProviderDefinitions() {
  return PROVIDER_DEFINITIONS;
}

function getConsolePanel(panelId) {
  const normalized = String(panelId || "").trim();
  return consolePanels.find((panel) => panel.dataset.consolePanel === normalized) || null;
}

function setConsolePanelHeader(panel) {
  if (!panel) {
    return;
  }

  if (consolePanelKicker) {
    consolePanelKicker.textContent = panel.dataset.panelKicker || "配置";
  }
  if (consolePanelTitle) {
    consolePanelTitle.textContent = panel.dataset.panelTitle || "工作台";
  }
  if (consolePanelDescription) {
    consolePanelDescription.textContent = panel.dataset.panelDescription || "";
  }
}

function setActiveConsolePanel(panelId, options = {}) {
  const { persist = true } = options;
  const nextPanel = getConsolePanel(panelId) || getConsolePanel(DEFAULT_CONSOLE_PANEL_ID);
  if (!nextPanel) {
    return;
  }

  const nextId = nextPanel.dataset.consolePanel || DEFAULT_CONSOLE_PANEL_ID;
  for (const button of consoleNavButtons) {
    const isActive = button.dataset.consoleNav === nextId;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }

  for (const panel of consolePanels) {
    const isActive = panel === nextPanel;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  }

  setConsolePanelHeader(nextPanel);

  if (persist) {
    try {
      window.localStorage?.setItem(CONSOLE_PANEL_STORAGE_KEY, nextId);
    } catch {}
  }
}

function restoreConsolePanel() {
  let preferredPanelId = DEFAULT_CONSOLE_PANEL_ID;
  try {
    preferredPanelId = window.localStorage?.getItem(CONSOLE_PANEL_STORAGE_KEY) || preferredPanelId;
  } catch {}

  setActiveConsolePanel(preferredPanelId, { persist: false });
}

function getProviderHintText(providerId) {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    return "";
  }

  const examples = Array.isArray(definition.exampleModels) && definition.exampleModels.length
    ? ` 示例模型：${definition.exampleModels.join(" / ")}`
    : "";
  return `${definition.label} · ${definition.group} · 默认地址 ${definition.defaultBaseUrl}${examples}`;
}

function populateProviderSelect(select, preferredValue = DEFAULT_PROVIDER_ID) {
  if (!select) {
    return;
  }

  const previousValue = String(preferredValue || select.value || DEFAULT_PROVIDER_ID).trim();
  const definitions = getProviderDefinitions();
  const groups = new Map();

  for (const definition of definitions) {
    const group = String(definition.group || "Other");
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group).push(definition);
  }

  select.innerHTML = "";
  for (const [groupLabel, items] of groups.entries()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupLabel;
    for (const definition of items) {
      const option = document.createElement("option");
      option.value = definition.id;
      option.textContent = definition.label;
      optgroup.append(option);
    }
    select.append(optgroup);
  }

  const fallbackValue =
    getProviderDefinition(previousValue)?.id ||
    getProviderDefinitions()[0]?.id ||
    DEFAULT_PROVIDER_ID;
  select.value = fallbackValue;
}

function shouldAdoptProviderDefault(input, previousDefault = "", nextDefault = "") {
  const currentValue = String(input?.value || "").trim();
  if (!currentValue) {
    return true;
  }
  if (previousDefault && currentValue === previousDefault) {
    return true;
  }
  return currentValue === nextDefault;
}

function applyProviderDefaults({
  providerId,
  previousProviderId,
  baseUrlInput,
  authStyleSelect,
  apiKeyHeaderInput
}) {
  const nextDefinition = getProviderDefinition(providerId);
  if (!nextDefinition) {
    return;
  }

  const previousDefinition = getProviderDefinition(previousProviderId);
  const previousBaseUrl = previousDefinition?.defaultBaseUrl || "";
  const previousAuthStyle = previousDefinition?.defaultAuthStyle || "";
  const previousApiKeyHeader = previousDefinition?.defaultApiKeyHeader || "";

  if (shouldAdoptProviderDefault(baseUrlInput, previousBaseUrl, nextDefinition.defaultBaseUrl)) {
    baseUrlInput.value = nextDefinition.defaultBaseUrl || "";
  }
  if (shouldAdoptProviderDefault(authStyleSelect, previousAuthStyle, nextDefinition.defaultAuthStyle)) {
    authStyleSelect.value = nextDefinition.defaultAuthStyle || "bearer";
  }
  if (
    shouldAdoptProviderDefault(
      apiKeyHeaderInput,
      previousApiKeyHeader,
      nextDefinition.defaultApiKeyHeader
    )
  ) {
    apiKeyHeaderInput.value = nextDefinition.defaultApiKeyHeader || "";
  }
}

function resolveAgentPrefix(phase, kind) {
  const bucket = AGENT_PREFIXES[String(phase || "").trim()] || AGENT_PREFIXES.general;
  return bucket[kind] || AGENT_PREFIXES.general[kind] || "";
}

function formatLeaderDisplayLabel(workerId, phase) {
  const model = knownModelConfigs.get(workerId);
  const baseLabel = model?.label || workerId || "未命名组长";
  return `${resolveAgentPrefix(phase, "leader")} · ${baseLabel}`;
}

function summarizeAgentStatus(agent) {
  switch (agent.status) {
    case "thinking":
      return "思考中";
    case "delegating":
      return "任务分配";
    case "spawning":
      return "生成下属";
    case "running":
      return "执行中";
    case "retrying":
      return "重试中";
    case "synthesizing":
      return "汇总中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已终止";
    default:
      return "待命";
  }
}

function ensureAgentState(partial = {}) {
  const id = String(partial.id || "").trim();
  if (!id) {
    return null;
  }

  const existing = agentGraphState.agents.get(id) || {
    id,
    label: partial.label || id,
    kind: partial.kind || "leader",
    parentId: partial.parentId || "",
    parentLabel: partial.parentLabel || "",
    phase: partial.phase || "",
    status: "idle",
    action: "等待任务",
    notes: [],
    modelId: partial.modelId || "",
    modelLabel: partial.modelLabel || "",
    taskTitle: "",
    updatedAt: Date.now()
  };

  const next = {
    ...existing,
    ...partial,
    notes: Array.isArray(existing.notes) ? existing.notes : [],
    updatedAt: Date.now()
  };

  agentGraphState.agents.set(id, next);
  return next;
}

function appendAgentNote(agentId, message, timestamp = "") {
  if (!agentId || !message) {
    return;
  }

  const entry = ensureAgentState({ id: agentId });
  if (!entry) {
    return;
  }

  const note = `${timestamp ? `${timestamp} ` : ""}${message}`;
  if (entry.notes[entry.notes.length - 1] === note) {
    return;
  }

  entry.notes.push(note);
  if (entry.notes.length > 20) {
    entry.notes.shift();
  }
}

function renderList(items, emptyText = "无") {
  const normalized = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!normalized.length) {
    return `<p class="placeholder">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${normalized.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function normalizeSpecialties(value) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )
    );
  }

  return Array.from(
    new Set(
      String(value || "")
        .split(/[,\n，；;]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function normalizeStringList(value) {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : String(value || "").split(/[,\n]/))
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function splitSpecialties(value) {
  const selectedValues = normalizeSpecialties(value);
  const presetValues = new Set(MODEL_CAPABILITY_OPTIONS.map((option) => option.value));
  return {
    presets: selectedValues.filter((item) => presetValues.has(item)),
    custom: selectedValues.filter((item) => !presetValues.has(item))
  };
}

function renderCapabilityOptions(container, selectedValues = []) {
  if (!container) {
    return;
  }

  const selected = new Set(normalizeSpecialties(selectedValues));
  container.innerHTML = "";

  for (const option of MODEL_CAPABILITY_OPTIONS) {
    const item = document.createElement("label");
    item.className = "capability-pill";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = option.value;
    input.dataset.capability = option.value;
    input.checked = selected.has(option.value);

    const text = document.createElement("span");
    text.textContent = option.label;

    item.append(input, text);
    container.append(item);
  }
}

function collectSpecialtiesFromInputs(container, customValue = "") {
  const selected = Array.from(container?.querySelectorAll("[data-capability]:checked") || []).map(
    (input) => input.value
  );
  return Array.from(new Set([...selected, ...normalizeSpecialties(customValue)]));
}

function hideSaveToast() {
  if (saveToast) {
    saveToast.hidden = true;
  }
  if (saveToastTimer) {
    clearTimeout(saveToastTimer);
    saveToastTimer = null;
  }
}

function setSaveStatus(message, tone = "neutral") {
  saveStatus.textContent = message;
  if (!saveToast) {
    return;
  }

  saveToast.dataset.tone = tone;
  if (tone === "neutral") {
    hideSaveToast();
    return;
  }

  saveToast.hidden = false;
  if (saveToastTimer) {
    clearTimeout(saveToastTimer);
  }
  saveToastTimer = setTimeout(() => {
    hideSaveToast();
  }, 5000);
}

function setBotConfigStatus(message, tone = "neutral") {
  if (!botConfigStatus) {
    return;
  }

  botConfigStatus.textContent = message;
  botConfigStatus.dataset.tone = tone;
}

function setModelTestStatus(card, message, tone = "neutral") {
  const status = card.querySelector("[data-model-test-status]");
  if (!status) {
    return;
  }

  status.textContent = message;
  status.dataset.tone = tone;
}

function createSecretRow(secret = { name: "", value: "" }) {
  const fragment = secretTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".secret-row");
  row.querySelector("[data-secret-name]").value = secret.name || "";
  row.querySelector("[data-secret-value]").value = secret.value || "";
  return row;
}

function updateModelCardTitle(card) {
  const id = card.querySelector("[data-model-id]").value.trim();
  const label = card.querySelector("[data-model-label]").value.trim();
  card.querySelector("[data-model-title]").textContent = label || id || "新模型";
}

function updateModelCardFields(card, options = {}) {
  const { applyDefaults = false } = options;
  const providerSelect = card.querySelector("[data-model-provider]");
  const provider = providerSelect.value;
  const previousProviderId = providerSelect.dataset.previousProviderId || "";
  const authStyle = card.querySelector("[data-model-auth-style]").value;
  const reasoning = card.querySelector("[data-model-reasoning]");
  const webSearch = card.querySelector("[data-model-web-search]");
  const temperature = card.querySelector("[data-model-temperature]");
  const apiKeyEnv = card.querySelector("[data-model-api-key-env]");
  const apiKeyValue = card.querySelector("[data-model-api-key-value]");
  const apiKeyHeader = card.querySelector("[data-model-api-key-header]");
  const baseUrl = card.querySelector("[data-model-base-url]");
  const providerHint = card.querySelector("[data-model-provider-hint]");

  if (applyDefaults && provider !== previousProviderId) {
    applyProviderDefaults({
      providerId: provider,
      previousProviderId,
      baseUrlInput: baseUrl,
      authStyleSelect: card.querySelector("[data-model-auth-style]"),
      apiKeyHeaderInput: apiKeyHeader
    });
  }

  const resolvedAuthStyle = card.querySelector("[data-model-auth-style]").value;
  reasoning.disabled = !providerSupportsCapability(provider, "reasoning");
  webSearch.disabled = !providerSupportsCapability(provider, "webSearch");
  temperature.disabled = !providerSupportsCapability(provider, "temperature");
  apiKeyEnv.disabled = resolvedAuthStyle === "none";
  apiKeyValue.disabled = resolvedAuthStyle === "none";
  apiKeyHeader.disabled = resolvedAuthStyle !== "api-key";
  if (providerHint) {
    providerHint.textContent = getProviderHintText(provider);
  }
  providerSelect.dataset.previousProviderId = provider;
}

function updateBatchFields(options = {}) {
  const { applyDefaults = false } = options;
  const provider = batchProviderSelect.value;
  const previousProviderId = batchProviderSelect.dataset.previousProviderId || "";
  if (applyDefaults && provider !== previousProviderId) {
    applyProviderDefaults({
      providerId: provider,
      previousProviderId,
      baseUrlInput: batchBaseUrlInput,
      authStyleSelect: batchAuthStyleSelect,
      apiKeyHeaderInput: batchApiKeyHeaderInput
    });
  }

  batchReasoningSelect.disabled = !providerSupportsCapability(provider, "reasoning");
  batchWebSearchInput.disabled = !providerSupportsCapability(provider, "webSearch");
  batchTemperatureInput.disabled = !providerSupportsCapability(provider, "temperature");
  const resolvedAuthStyle = batchAuthStyleSelect.value;
  batchApiKeyHeaderInput.disabled = resolvedAuthStyle !== "api-key";
  batchEnvPrefixInput.disabled = resolvedAuthStyle === "none";
  if (batchProviderHint) {
    batchProviderHint.textContent = getProviderHintText(provider);
  }
  batchProviderSelect.dataset.previousProviderId = provider;
  updateBatchKeyRowStates();
}

function getBatchKeyRows() {
  return Array.from(batchKeysList?.querySelectorAll(".batch-key-row") || []);
}

function getBatchKeyInputs() {
  return Array.from(batchKeysList?.querySelectorAll("[data-batch-key-input]") || []);
}

function createBatchKeyRow(value = "") {
  const row = document.createElement("div");
  row.className = "batch-key-row";

  const input = document.createElement("input");
  input.type = "password";
  input.value = value;
  input.dataset.batchKeyInput = "true";

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "ghost small";
  addButton.dataset.batchKeyAdd = "true";
  addButton.title = "新增一行 API Key";
  addButton.textContent = "+";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "ghost danger small";
  removeButton.dataset.batchKeyRemove = "true";
  removeButton.title = "删除当前 API Key 行";
  removeButton.textContent = "-";

  row.append(input, addButton, removeButton);
  return row;
}

function updateBatchKeyRowStates() {
  if (!batchKeysList) {
    return;
  }

  const rows = getBatchKeyRows();
  const disabled = batchAuthStyleSelect.value === "none";

  if (!rows.length) {
    batchKeysList.append(createBatchKeyRow());
    return updateBatchKeyRowStates();
  }

  rows.forEach((row, index) => {
    const input = row.querySelector("[data-batch-key-input]");
    const addButton = row.querySelector("[data-batch-key-add]");
    const removeButton = row.querySelector("[data-batch-key-remove]");
    row.dataset.disabled = disabled ? "true" : "false";
    if (input) {
      input.disabled = disabled;
      input.placeholder = disabled ? "当前鉴权方式无需 API Key" : `请输入第 ${index + 1} 个 API Key`;
    }
    if (addButton) {
      addButton.disabled = disabled;
    }
    if (removeButton) {
      removeButton.disabled = disabled || rows.length === 1;
    }
  });
}

function setBatchKeyRows(values = []) {
  if (!batchKeysList) {
    return;
  }

  const normalized =
    Array.isArray(values) && values.length
      ? values.map((item) => String(item ?? ""))
      : [""];

  batchKeysList.innerHTML = "";
  for (const value of normalized) {
    batchKeysList.append(createBatchKeyRow(value));
  }

  updateBatchKeyRowStates();
}

function collectBatchKeys() {
  return getBatchKeyInputs()
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function createModelCard(model = {}) {
  const fragment = modelTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".model-card");
  const { presets, custom } = splitSpecialties(model.specialties);
  const providerSelect = card.querySelector("[data-model-provider]");

  card.querySelector("[data-model-id]").value = model.id || "";
  card.querySelector("[data-model-label]").value = model.label || "";
  populateProviderSelect(providerSelect, model.provider || DEFAULT_PROVIDER_ID);
  card.querySelector("[data-model-name]").value = model.model || "";
  card.querySelector("[data-model-base-url]").value = model.baseUrl || "";
  card.querySelector("[data-model-api-key-env]").value = model.apiKeyEnv || "";
  card.querySelector("[data-model-api-key-value]").value = model.apiKeyValue || "";
  card.querySelector("[data-model-auth-style]").value =
    model.authStyle || getProviderDefinition(providerSelect.value)?.defaultAuthStyle || "bearer";
  card.querySelector("[data-model-api-key-header]").value = model.apiKeyHeader || "";
  card.querySelector("[data-model-reasoning]").value = model.reasoningEffort || "";
  card.querySelector("[data-model-web-search]").checked = Boolean(model.webSearch);
  card.querySelector("[data-model-temperature]").value = model.temperature ?? "";
  renderCapabilityOptions(card.querySelector("[data-model-capability-list]"), presets);
  card.querySelector("[data-model-specialties-custom]").value = custom.join(", ");

  updateModelCardTitle(card);
  updateModelCardFields(card, { applyDefaults: true });
  setModelTestStatus(card, "未测试");
  return card;
}

function collectSecrets() {
  return Array.from(secretList.querySelectorAll(".secret-row")).map((row) => ({
    name: row.querySelector("[data-secret-name]").value.trim(),
    value: row.querySelector("[data-secret-value]").value
  }));
}

function collectModelFromCard(card) {
  return {
    id: card.querySelector("[data-model-id]").value.trim(),
    label: card.querySelector("[data-model-label]").value.trim(),
    provider: card.querySelector("[data-model-provider]").value,
    model: card.querySelector("[data-model-name]").value.trim(),
    baseUrl: card.querySelector("[data-model-base-url]").value.trim(),
    apiKeyEnv: card.querySelector("[data-model-api-key-env]").value.trim(),
    apiKeyValue: card.querySelector("[data-model-api-key-value]").value,
    authStyle: card.querySelector("[data-model-auth-style]").value,
    apiKeyHeader: card.querySelector("[data-model-api-key-header]").value.trim(),
    reasoningEffort: card.querySelector("[data-model-reasoning]").value,
    webSearch: card.querySelector("[data-model-web-search]").checked,
    temperature: card.querySelector("[data-model-temperature]").value,
    specialties: collectSpecialtiesFromInputs(
      card.querySelector("[data-model-capability-list]"),
      card.querySelector("[data-model-specialties-custom]").value
    )
  };
}

function collectModels() {
  return Array.from(modelList.querySelectorAll(".model-card")).map(collectModelFromCard);
}

function cloneModelDraft(model = {}) {
  return {
    id: String(model.id || ""),
    label: String(model.label || ""),
    provider: String(model.provider || DEFAULT_PROVIDER_ID),
    model: String(model.model || ""),
    baseUrl: String(model.baseUrl || ""),
    apiKeyEnv: String(model.apiKeyEnv || ""),
    apiKeyValue: String(model.apiKeyValue || ""),
    authStyle: String(model.authStyle || "bearer"),
    apiKeyHeader: String(model.apiKeyHeader || ""),
    reasoningEffort: String(model.reasoningEffort || ""),
    webSearch: Boolean(model.webSearch),
    temperature: model.temperature ?? "",
    specialties: Array.isArray(model.specialties)
      ? [...model.specialties]
      : normalizeSpecialties(model.specialties)
  };
}

function cloneSchemeDraft(scheme = {}) {
  return {
    id: String(scheme.id || ""),
    label: String(scheme.label || ""),
    controller: String(scheme.controller || ""),
    models: Array.isArray(scheme.models) ? scheme.models.map(cloneModelDraft) : []
  };
}

function buildFallbackScheme(models = [], controller = "") {
  return {
    id: "gpt_scheme",
    label: "gpt方案",
    controller: String(controller || models[0]?.id || ""),
    models: (Array.isArray(models) ? models : []).map(cloneModelDraft)
  };
}

function getSchemeDisplayName(scheme) {
  const normalized = cloneSchemeDraft(scheme);
  return normalized.label || normalized.id || "未命名方案";
}

function getCurrentScheme() {
  return schemeUiState.schemes.find((scheme) => scheme.id === schemeUiState.currentSchemeId) || null;
}

function buildUniqueSchemeId(baseLabel = "scheme") {
  const used = new Set(schemeUiState.schemes.map((scheme) => scheme.id).filter(Boolean));
  return buildUniqueName(baseLabel, used);
}

function captureCurrentSchemeDraft() {
  const currentScheme = getCurrentScheme();
  if (!currentScheme) {
    return null;
  }

  currentScheme.label = schemeNameInput?.value.trim() || currentScheme.label || currentScheme.id || "未命名方案";
  currentScheme.controller = controllerSelect?.value || currentScheme.controller || "";
  currentScheme.models = collectModels().map(cloneModelDraft);
  return currentScheme;
}

function ensureSchemeConnectivityState(schemeId, models = []) {
  const normalizedSchemeId = String(schemeId || "").trim();
  if (!normalizedSchemeId) {
    return {
      tone: "neutral",
      message: "等待检测",
      results: []
    };
  }

  const existing = schemeUiState.connectivityBySchemeId.get(normalizedSchemeId) || {
    tone: "neutral",
    message: "等待检测",
    results: []
  };
  const existingById = new Map(existing.results.map((item) => [item.id, item]));
  const normalizedResults = (Array.isArray(models) ? models : []).map((model) => ({
    id: model.id || "",
    label: model.label || model.id || "未命名模型",
    tone: existingById.get(model.id)?.tone || "neutral",
    status: existingById.get(model.id)?.status || "未测试",
    detail: existingById.get(model.id)?.detail || ""
  }));

  const next = {
    tone: existing.tone || "neutral",
    message: existing.message || "等待检测",
    results: normalizedResults
  };
  schemeUiState.connectivityBySchemeId.set(normalizedSchemeId, next);
  return next;
}

function updateSchemeConnectivityEntry(schemeId, modelId, patch = {}) {
  const scheme = schemeUiState.schemes.find((item) => item.id === schemeId);
  const state = ensureSchemeConnectivityState(schemeId, scheme?.models || []);
  const index = state.results.findIndex((item) => item.id === modelId);
  if (index === -1) {
    return state;
  }

  state.results[index] = {
    ...state.results[index],
    ...patch
  };
  schemeUiState.connectivityBySchemeId.set(schemeId, state);
  return state;
}

function buildConnectivityDisplay(payload = {}) {
  const degraded = Boolean(payload?.degraded);
  const workflowMode = String(payload?.diagnostics?.workflowProbe?.mode || "").trim();
  const summary = String(payload?.summary || "").trim();
  const reply = String(payload?.reply || "").trim();
  const parts = [];

  if (summary) {
    parts.push(summary);
  }
  if (workflowMode === "fallback" && !degraded) {
    parts.push("Workflow probe used compatibility fallback.");
  }
  if (reply) {
    parts.push(`Basic reply: ${reply}`);
  }

  return {
    tone: degraded ? "warning" : "ok",
    status: degraded ? "可用(降级)" : "可用",
    detail: parts.join(" ")
  };
}

function getConnectivityCounts(results = []) {
  const counts = {
    total: Array.isArray(results) ? results.length : 0,
    ok: 0,
    warning: 0,
    error: 0,
    testing: 0,
    neutral: 0
  };

  for (const item of Array.isArray(results) ? results : []) {
    const tone = String(item?.tone || "neutral").trim();
    if (tone === "ok") {
      counts.ok += 1;
      continue;
    }
    if (tone === "warning") {
      counts.warning += 1;
      continue;
    }
    if (tone === "error") {
      counts.error += 1;
      continue;
    }
    if (tone === "testing") {
      counts.testing += 1;
      continue;
    }
    counts.neutral += 1;
  }

  counts.available = counts.ok + counts.warning;
  counts.completed = counts.ok + counts.warning + counts.error;
  return counts;
}

function buildConnectivitySummaryMessage(results = []) {
  const counts = getConnectivityCounts(results);
  if (!counts.total) {
    return {
      tone: "neutral",
      message: "当前方案没有模型",
      counts
    };
  }

  if (counts.testing > 0) {
    return {
      tone: "testing",
      message: `并发检测中 ${counts.completed}/${counts.total} · 可用 ${counts.available} · 失败 ${counts.error}`,
      counts
    };
  }

  if (counts.error > 0 || counts.warning > 0) {
    return {
      tone: "warning",
      message: `检测完成 · 可用 ${counts.available}/${counts.total} · 降级 ${counts.warning} · 失败 ${counts.error}`,
      counts
    };
  }

  if (counts.ok === counts.total) {
    return {
      tone: "ok",
      message: `检测完成 · 全部可用 ${counts.ok}/${counts.total}`,
      counts
    };
  }

  return {
    tone: "neutral",
    message: "等待检测",
    counts
  };
}

function sortConnectivityResults(results = []) {
  const rank = {
    error: 0,
    testing: 1,
    warning: 2,
    ok: 3,
    neutral: 4
  };

  return [...results].sort((left, right) => {
    const toneDelta =
      (rank[String(left?.tone || "neutral")] ?? 99) -
      (rank[String(right?.tone || "neutral")] ?? 99);
    if (toneDelta !== 0) {
      return toneDelta;
    }

    return String(left?.label || left?.id || "").localeCompare(
      String(right?.label || right?.id || ""),
      "zh-CN"
    );
  });
}

function renderSchemeConnectivityListLegacy() {
  if (!schemeConnectivityList || !schemeConnectivityStatus) {
    return;
  }

  const currentScheme = getCurrentScheme();
  if (!currentScheme) {
    schemeConnectivityStatus.textContent = "无方案";
    schemeConnectivityStatus.dataset.tone = "neutral";
    schemeConnectivityList.innerHTML = "<p class=\"placeholder\">请先添加至少一个方案。</p>";
    return;
  }

  const state = ensureSchemeConnectivityState(currentScheme.id, currentScheme.models);
  const modelById = new Map((currentScheme.models || []).map((model) => [model.id, model]));
  schemeConnectivityStatus.textContent = state.message || "等待检测";
  schemeConnectivityStatus.dataset.tone = state.tone || "neutral";

  if (!state.results.length) {
    schemeConnectivityList.innerHTML = "<p class=\"placeholder\">当前方案还没有可检测的模型。</p>";
    return;
  }

  schemeConnectivityList.innerHTML = state.results
    .map((result) => {
      const model = modelById.get(result.id) || {};
      const meta = [model.provider, model.model].filter(Boolean).join(" / ");
      return [
        `<article class="scheme-connectivity-row" data-tone="${escapeAttribute(result.tone || "neutral")}">`,
        `  <div class="scheme-connectivity-head">`,
        `    <div class="scheme-connectivity-title">`,
        `      <strong>${escapeHtml(result.label || result.id || "未命名模型")}</strong>`,
        `      <span class="scheme-connectivity-meta">${escapeHtml(meta || result.id || "")}</span>`,
        "    </div>",
        `    <span class="chip" data-tone="${escapeAttribute(result.tone || "neutral")}">${escapeHtml(result.status || "未测试")}</span>`,
        "  </div>",
        `  <p class="scheme-connectivity-copy">${escapeHtml(result.detail || "等待连接测试结果。")}</p>`,
        "</article>"
      ].join("");
    })
    .join("");
}

function syncCurrentSchemeHint() {
  if (!schemeHint) {
    return;
  }

  const currentScheme = getCurrentScheme();
  schemeHint.textContent = currentScheme
    ? `当前方案：${getSchemeDisplayName(currentScheme)}。批量配置、模型列表和本次运行都会使用它。`
    : "批量配置、模型列表和本次运行都会使用当前方案。";
}

function renderSchemeControls() {
  if (!schemeSelect || !schemeNameInput) {
    return;
  }

  schemeSelect.innerHTML = "";
  for (const scheme of schemeUiState.schemes) {
    const option = document.createElement("option");
    option.value = scheme.id;
    option.textContent = getSchemeDisplayName(scheme);
    schemeSelect.append(option);
  }

  if (!schemeUiState.schemes.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无方案";
    option.disabled = true;
    option.selected = true;
    schemeSelect.append(option);
    schemeNameInput.value = "";
    schemeNameInput.disabled = true;
    if (removeSchemeButton) {
      removeSchemeButton.disabled = true;
    }
    syncCurrentSchemeHint();
    renderSchemeConnectivityList();
    return;
  }

  const nextSchemeId = schemeUiState.schemes.some((scheme) => scheme.id === schemeUiState.currentSchemeId)
    ? schemeUiState.currentSchemeId
    : schemeUiState.schemes[0].id;
  schemeUiState.currentSchemeId = nextSchemeId;
  schemeSelect.value = nextSchemeId;

  const currentScheme = getCurrentScheme();
  schemeNameInput.disabled = false;
  schemeNameInput.value = currentScheme?.label || "";
  if (removeSchemeButton) {
    removeSchemeButton.disabled = schemeUiState.schemes.length <= 1;
  }
  syncCurrentSchemeHint();
}

function applyStoredConnectivityToVisibleModelCards() {
  const currentScheme = getCurrentScheme();
  if (!currentScheme) {
    return;
  }

  const state = ensureSchemeConnectivityState(currentScheme.id, currentScheme.models);
  const byId = new Map(state.results.map((result) => [result.id, result]));
  for (const card of Array.from(modelList.querySelectorAll(".model-card"))) {
    const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
    const result = byId.get(modelId);
    if (!result) {
      setModelTestStatus(card, "未测试");
      continue;
    }
    setModelTestStatus(card, result.status || "未测试", result.tone || "neutral");
  }
}

function renderCurrentSchemeModels() {
  const currentScheme = getCurrentScheme();
  knownModelConfigs.clear();
  modelList.innerHTML = "";

  if (!currentScheme) {
    updateControllerOptions("");
    renderSchemeConnectivityList();
    return;
  }

  for (const model of currentScheme.models || []) {
    knownModelConfigs.set(model.id, model);
    modelList.append(createModelCard(model));
  }

  updateControllerOptions(currentScheme.controller || "");
  applyStoredConnectivityToVisibleModelCards();
  renderSchemeConnectivityList();
}

function switchCurrentScheme(nextSchemeId, options = {}) {
  const { preserveDraft = true } = options;
  if (preserveDraft) {
    captureCurrentSchemeDraft();
  }

  const normalizedNextSchemeId = String(nextSchemeId || "").trim();
  if (!normalizedNextSchemeId || !schemeUiState.schemes.some((scheme) => scheme.id === normalizedNextSchemeId)) {
    return;
  }

  schemeUiState.currentSchemeId = normalizedNextSchemeId;
  renderSchemeControls();
  renderCurrentSchemeModels();
}

function addSchemeDraft() {
  captureCurrentSchemeDraft();
  const nextIndex = schemeUiState.schemes.length + 1;
  const nextScheme = cloneSchemeDraft({
    id: buildUniqueSchemeId(`scheme_${nextIndex}`),
    label: `新方案 ${nextIndex}`,
    controller: "",
    models: []
  });
  schemeUiState.schemes.push(nextScheme);
  switchCurrentScheme(nextScheme.id, { preserveDraft: false });
}

function removeCurrentSchemeDraft() {
  if (schemeUiState.schemes.length <= 1) {
    setSaveStatus("至少保留一个方案。", "error");
    return;
  }

  const removingIndex = schemeUiState.schemes.findIndex((scheme) => scheme.id === schemeUiState.currentSchemeId);
  if (removingIndex === -1) {
    return;
  }

  const [removed] = schemeUiState.schemes.splice(removingIndex, 1);
  if (removed?.id) {
    schemeUiState.connectivityBySchemeId.delete(removed.id);
  }
  const fallbackScheme = schemeUiState.schemes[Math.max(0, removingIndex - 1)] || schemeUiState.schemes[0];
  switchCurrentScheme(fallbackScheme?.id, { preserveDraft: false });
}

function collectPhaseParallelSettings() {
  const phaseParallel = {};

  for (const [phase, input] of Object.entries(PHASE_PARALLEL_INPUTS)) {
    const value = String(input?.value || "").trim();
    if (value) {
      phaseParallel[phase] = value;
    }
  }

  return phaseParallel;
}

function updateControllerOptions(preferredValue = "") {
  const models = collectModels();
  const currentValue = preferredValue || controllerSelect.value;

  controllerSelect.innerHTML = "";

  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无模型";
    option.disabled = true;
    option.selected = true;
    controllerSelect.append(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id || "";
    option.textContent = model.label || model.id || "未命名模型";
    controllerSelect.append(option);
  }

  const nextValue = models.find((model) => model.id === currentValue) ? currentValue : models[0].id;
  controllerSelect.value = nextValue;
}

function getBotInstallDirValue() {
  return botInstallDirInput?.value.trim() || botUiState.defaultInstallDir || "bot-connectors";
}

function getBotCommandPrefixValue() {
  return botCommandPrefixInput?.value.trim() || "/agent";
}

function setBotInstallOutput(message) {
  if (!botInstallOutput) {
    return;
  }

  botInstallOutput.textContent = message;
}

function getBotPresetById(presetId) {
  return botUiState.presets.find((preset) => preset.id === String(presetId || "").trim()) || null;
}

function getBotPresetConfig(presetId) {
  return botUiState.presetConfigById.get(String(presetId || "").trim()) || {
    envText: ""
  };
}

function normalizeBotEnvName(value) {
  return String(value || "").trim();
}

function parseBotEnvText(envText) {
  const values = new Map();

  for (const line of String(envText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    values.set(match[1], match[2] ?? "");
  }

  return values;
}

function getBotPresetFields(preset) {
  return Array.isArray(preset?.fields)
    ? preset.fields.filter((field) => normalizeBotEnvName(field?.envName))
    : [];
}

function getBotPresetFieldEnvNames(preset) {
  return getBotPresetFields(preset).map((field) => normalizeBotEnvName(field.envName));
}

function getAllBotStructuredEnvNames() {
  const names = new Set();

  for (const preset of botUiState.presets) {
    for (const envName of getBotPresetFieldEnvNames(preset)) {
      names.add(envName);
    }
  }

  return names;
}

function buildSecretValueMap(secrets = []) {
  const values = new Map();

  for (const entry of Array.isArray(secrets) ? secrets : []) {
    const name = normalizeBotEnvName(entry?.name);
    if (!name) {
      continue;
    }

    values.set(name, String(entry?.value ?? ""));
  }

  return values;
}

function stripStructuredBotEnvText(envText, knownNames = []) {
  const blocked = new Set(
    Array.from(knownNames || [])
      .map((name) => normalizeBotEnvName(name))
      .filter(Boolean)
  );

  if (!blocked.size) {
    return String(envText || "").trim();
  }

  return String(envText || "")
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.trim().match(/^([\w.-]+)\s*=/);
      return !match || !blocked.has(match[1]);
    })
    .join("\n")
    .trim();
}

function sanitizeBotPresetConfig(presetId, value) {
  const preset = getBotPresetById(presetId);
  return {
    envText: stripStructuredBotEnvText(String(value?.envText || ""), getBotPresetFieldEnvNames(preset))
  };
}

function resolveBotAdvancedEnvPlaceholder(preset) {
  const hiddenNames = new Set(getBotPresetFieldEnvNames(preset));
  const hints = (Array.isArray(preset?.envHints) ? preset.envHints : []).filter((hint) => {
    const parsed = parseBotEnvText(hint);
    const firstName = Array.from(parsed.keys())[0] || "";
    return !firstName || !hiddenNames.has(firstName);
  });

  return hints.join("\n") || "HTTP_PROXY=http://127.0.0.1:7890\nCUSTOM_FLAG=1";
}

function resolveBotFieldDefaultValue(field) {
  if (field?.defaultValue != null) {
    return String(field.defaultValue);
  }

  if (field?.type === "toggle") {
    return String(field?.falseValue ?? "0");
  }

  return "";
}

function resolveBotFieldValue(presetId, field, presetConfig = getBotPresetConfig(presetId)) {
  const envName = normalizeBotEnvName(field?.envName);
  if (!envName) {
    return resolveBotFieldDefaultValue(field);
  }

  if (botUiState.secretValueByName.has(envName)) {
    return botUiState.secretValueByName.get(envName);
  }

  const legacyValues = parseBotEnvText(presetConfig?.envText);
  if (legacyValues.has(envName)) {
    return legacyValues.get(envName);
  }

  return resolveBotFieldDefaultValue(field);
}

function readBotFieldValue(input) {
  if (!input) {
    return "";
  }

  if (input.dataset.fieldType === "toggle") {
    return input.checked ? input.dataset.trueValue || "1" : input.dataset.falseValue || "0";
  }

  return input.value;
}

function syncBotSecretValuesFromDom(source = null) {
  const inputs =
    source && source.matches?.("[data-bot-field]")
      ? [source]
      : Array.from(botPresetList?.querySelectorAll("[data-bot-field]") || []);

  for (const input of inputs) {
    const envName = normalizeBotEnvName(input.dataset.fieldName);
    if (!envName) {
      continue;
    }

    botUiState.secretValueByName.set(envName, String(readBotFieldValue(input) ?? ""));
  }
}

function collectBotSecretEntries() {
  const result = [];

  for (const preset of botUiState.presets) {
    const presetConfig = getBotPresetConfig(preset.id);
    const legacyValues = parseBotEnvText(presetConfig.envText);

    for (const field of getBotPresetFields(preset)) {
      const envName = normalizeBotEnvName(field?.envName);
      if (!envName) {
        continue;
      }

      const input = botPresetList?.querySelector(
        `[data-bot-field][data-preset-id="${preset.id}"][data-field-name="${envName}"]`
      );
      const defaultValue = resolveBotFieldDefaultValue(field);
      const value = String(
        input
          ? readBotFieldValue(input)
          : botUiState.secretValueByName.get(envName) ?? legacyValues.get(envName) ?? defaultValue
      );
      const hasStoredValue = botUiState.secretValueByName.has(envName);

      if (!hasStoredValue && !legacyValues.has(envName) && value === defaultValue) {
        continue;
      }

      result.push({
        name: envName,
        value
      });
    }
  }

  return result;
}

function mergeSecretEntries(...collections) {
  const merged = new Map();

  for (const collection of collections) {
    for (const entry of Array.isArray(collection) ? collection : []) {
      const name = normalizeBotEnvName(entry?.name);
      if (!name) {
        continue;
      }

      merged.set(name, {
        name,
        value: String(entry?.value ?? "")
      });
    }
  }

  return Array.from(merged.values());
}

function filterVisibleSharedSecrets(secrets = []) {
  const hiddenNames = getAllBotStructuredEnvNames();

  return (Array.isArray(secrets) ? secrets : []).filter((entry) => {
    const name = normalizeBotEnvName(entry?.name);
    return !name || !hiddenNames.has(name);
  });
}

function renderBotStructuredField(preset, field, presetConfig) {
  const envName = normalizeBotEnvName(field?.envName);
  if (!envName) {
    return "";
  }

  const label = field.label || envName;
  const descriptionParts = [];
  if (field.description) {
    descriptionParts.push(String(field.description));
  }
  descriptionParts.push("本地加密保存");
  const fieldHint = descriptionParts.join(" · ");
  const requiredTag = field.required
    ? '<span class="bot-field-required" aria-label="必填">必填</span>'
    : "";

  if (field.type === "toggle") {
    const currentValue = resolveBotFieldValue(preset.id, field, presetConfig);
    const checked = currentValue === String(field.trueValue ?? "1");
    return `
      <div class="field toggle-field bot-preset-field bot-preset-field-wide">
        <span>${escapeHtml(label)}${requiredTag}</span>
        <div class="toggle-control">
          <input
            data-bot-field
            data-preset-id="${escapeAttribute(preset.id)}"
            data-field-name="${escapeAttribute(envName)}"
            data-field-type="toggle"
            data-true-value="${escapeAttribute(String(field.trueValue ?? "1"))}"
            data-false-value="${escapeAttribute(String(field.falseValue ?? "0"))}"
            type="checkbox"
            ${checked ? "checked" : ""}
          />
          <span>${escapeHtml(fieldHint)}</span>
        </div>
      </div>
    `;
  }

  const inputType = field.type === "password" ? "password" : "text";
  const autocomplete = field.type === "password" ? "new-password" : "off";
  return `
    <label class="field bot-preset-field">
      <span>${escapeHtml(label)}${requiredTag}</span>
      <input
        data-bot-field
        data-preset-id="${escapeAttribute(preset.id)}"
        data-field-name="${escapeAttribute(envName)}"
        data-field-type="${escapeAttribute(field.type || "text")}"
        type="${escapeAttribute(inputType)}"
        autocomplete="${escapeAttribute(autocomplete)}"
        placeholder="${escapeAttribute(field.placeholder || "")}"
        value="${escapeAttribute(resolveBotFieldValue(preset.id, field, presetConfig))}"
      />
      <small class="field-hint">${escapeHtml(fieldHint)}</small>
    </label>
  `;
}

function collectEnabledBotPresetIdsFromDom() {
  return Array.from(botPresetList?.querySelectorAll("[data-bot-enabled]:checked") || [])
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function collectBotPresetConfigsFromDom() {
  const result = {};
  for (const textarea of Array.from(botPresetList?.querySelectorAll("[data-bot-env]") || [])) {
    const presetId = textarea.dataset.presetId || "";
    if (!presetId) {
      continue;
    }
    result[presetId] = {
      envText: textarea.value
    };
  }
  return result;
}

function syncEnabledBotPresetIds(sourceIds = null) {
  botUiState.enabledPresetIds = new Set(
    normalizeStringList(sourceIds == null ? collectEnabledBotPresetIdsFromDom() : sourceIds)
  );
}

function syncBotPresetConfigs(source = null) {
  const raw = source && typeof source === "object" ? source : collectBotPresetConfigsFromDom();
  botUiState.presetConfigById = new Map(
    Object.entries(raw).map(([presetId, value]) => [
      presetId,
      {
        envText: String(value?.envText || "")
      }
    ])
  );
}

function resolveBotPresetStatus(presetId) {
  if (botUiState.installingPresetId === presetId) {
    return {
      message: "安装中...",
      tone: "warning"
    };
  }

  return botUiState.installStatusById.get(presetId) || {
    message: "未安装",
    tone: "neutral"
  };
}

function resolveBotRuntimeStatus(presetId) {
  const runtime = botUiState.runtimeById.get(presetId);
  if (!runtime) {
    return {
      message: "未启动",
      tone: "neutral",
      detail: ""
    };
  }

  const startedAt = runtime.startedAt ? formatTimestamp(runtime.startedAt) : "";
  switch (runtime.status) {
    case "running":
      return {
        message: runtime.pid ? `运行中 · PID ${runtime.pid}` : "运行中",
        tone: "ok",
        detail: startedAt ? `启动时间：${startedAt}` : ""
      };
    case "stopping":
      return {
        message: "停止中...",
        tone: "warning",
        detail: ""
      };
    case "failed":
      return {
        message: "运行失败",
        tone: "error",
        detail: runtime.lastError || ""
      };
    default:
      return {
        message: "未启动",
        tone: "neutral",
        detail: runtime.lastOutput || ""
      };
  }
}

function renderBotPresetList(preferredEnabledIds = null, preferredPresetConfigs = null) {
  if (!botPresetList) {
    return;
  }

  if (botPresetList.children.length) {
    syncBotSecretValuesFromDom();
  }

  if (preferredEnabledIds != null) {
    syncEnabledBotPresetIds(preferredEnabledIds);
  } else if (botPresetList.children.length) {
    syncEnabledBotPresetIds();
  }

  if (preferredPresetConfigs != null) {
    syncBotPresetConfigs(preferredPresetConfigs);
  } else if (botPresetList.children.length) {
    syncBotPresetConfigs();
  }

  if (!botUiState.presets.length) {
    botPresetList.innerHTML = '<p class="placeholder">暂无可用 Bot 预设。</p>';
    return;
  }

  const enabledIds = botUiState.enabledPresetIds;
  botPresetList.innerHTML = botUiState.presets
    .map((preset) => {
      const status = resolveBotPresetStatus(preset.id);
      const runtime = resolveBotRuntimeStatus(preset.id);
      const presetConfig = getBotPresetConfig(preset.id);
      const structuredFields = getBotPresetFields(preset);
      const extraEnvText = stripStructuredBotEnvText(
        presetConfig.envText,
        getBotPresetFieldEnvNames(preset)
      );
      const tags = Array.isArray(preset.tags) ? preset.tags : [];
      const disabled = Boolean(botUiState.installingPresetId);
      return `
        <article class="bot-preset-card" data-preset-id="${escapeAttribute(preset.id)}">
          <div class="bot-preset-head">
            <div class="bot-preset-title">
              <h3>${escapeHtml(preset.label)}</h3>
              <div class="bot-preset-meta">
                <span class="chip">${escapeHtml(preset.channel || "Bot")}</span>
                <span class="chip">${escapeHtml(preset.source || "预设")}</span>
                ${tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
              </div>
            </div>
            <div class="bot-preset-meta">
              <span class="bot-preset-status" data-tone="${escapeAttribute(status.tone)}">${escapeHtml(status.message)}</span>
              <span class="bot-preset-status" data-tone="${escapeAttribute(runtime.tone)}">${escapeHtml(runtime.message)}</span>
            </div>
          </div>
          <p class="bot-preset-desc">${escapeHtml(preset.description || "未提供说明。")}</p>
          <pre class="bot-preset-command">${escapeHtml(preset.installCommand || "")}</pre>
          <div class="bot-preset-runtime">
            ${
              structuredFields.length
                ? `
                  <div class="bot-preset-field-grid">
                    ${structuredFields
                      .map((field) => renderBotStructuredField(preset, field, presetConfig))
                      .join("")}
                  </div>
                  <p class="bot-preset-note">这些参数会加密保存到本地，不会明文写入配置文件。</p>
                `
                : ""
            }
            <label class="field">
              <span>${structuredFields.length ? "附加环境变量（高级）" : "环境变量（每行一个 KEY=VALUE）"}</span>
              <textarea
                data-bot-env
                data-preset-id="${escapeAttribute(preset.id)}"
                placeholder="${escapeAttribute(resolveBotAdvancedEnvPlaceholder(preset))}"
              >${escapeHtml(extraEnvText)}</textarea>
              ${
                structuredFields.length
                  ? '<small class="field-hint">只在需要额外代理、日志或高级变量时填写；上面的结构化字段不需要重复写在这里。</small>'
                  : ""
              }
            </label>
            ${runtime.detail ? `<p class="meta-row">${escapeHtml(runtime.detail)}</p>` : ""}
          </div>
          <div class="bot-preset-actions">
            <label class="bot-preset-toggle">
              <input
                data-bot-enabled
                type="checkbox"
                value="${escapeAttribute(preset.id)}"
                ${enabledIds.has(preset.id) ? "checked" : ""}
              />
              <span>纳入默认配置</span>
            </label>
            <div class="panel-actions">
              <button
                data-bot-install
                type="button"
                class="small"
                ${disabled ? "disabled" : ""}
              >
                一键安装
              </button>
              <button data-bot-start type="button" class="ghost small">启动</button>
              <button data-bot-stop type="button" class="ghost danger small">停止</button>
              <button data-bot-copy type="button" class="ghost small">复制命令</button>
              <button data-bot-docs type="button" class="ghost small">打开文档</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function collectSettingsPayload() {
  syncEnabledBotPresetIds();
  syncBotPresetConfigs();
  syncBotSecretValuesFromDom();
  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();

  return {
    server: {
      port: portInput.value
    },
    cluster: {
      activeSchemeId: currentScheme?.id || schemeUiState.currentSchemeId || "",
      activeSchemeLabel: currentScheme?.label || "",
      controller: controllerSelect.value,
      maxParallel: parallelInput.value,
      subordinateMaxParallel: subordinateParallelInput?.value,
      groupLeaderMaxDelegates: groupLeaderMaxDelegatesInput?.value,
      delegateMaxDepth: delegateMaxDepthInput?.value,
      phaseParallel: collectPhaseParallelSettings()
    },
    workspace: {
      dir: workspaceDirInput.value.trim()
    },
    bot: {
      installDir: getBotInstallDirValue(),
      commandPrefix: getBotCommandPrefixValue(),
      autoStart: Boolean(botAutoStartInput?.checked),
      progressUpdates: botProgressUpdatesInput?.checked !== false,
      customCommand: botCustomCommandInput?.value.trim() || "",
      enabledPresets: Array.from(botUiState.enabledPresetIds),
      presetConfigs: Object.fromEntries(
        Array.from(botUiState.presetConfigById.entries()).map(([presetId, value]) => [
          presetId,
          sanitizeBotPresetConfig(presetId, value)
        ])
      )
    },
    secrets: mergeSecretEntries(collectSecrets(), collectBotSecretEntries()),
    schemes: schemeUiState.schemes.map((scheme) => ({
      id: scheme.id,
      label: scheme.label,
      controller: scheme.id === schemeUiState.currentSchemeId ? controllerSelect.value : scheme.controller,
      models: (scheme.id === schemeUiState.currentSchemeId ? collectModels() : scheme.models).map(cloneModelDraft)
    })),
    models: currentScheme ? currentScheme.models.map(cloneModelDraft) : collectModels()
  };
}

function renderSettings(settings) {
  knownModelConfigs.clear();
  botUiState.secretValueByName = buildSecretValueMap(settings.secrets || []);
  portInput.value = settings.server?.port ?? 4040;
  parallelInput.value = settings.cluster?.maxParallel ?? 3;
  if (subordinateParallelInput) {
    subordinateParallelInput.value = settings.cluster?.subordinateMaxParallel ?? 3;
  }
  if (groupLeaderMaxDelegatesInput) {
    groupLeaderMaxDelegatesInput.value = settings.cluster?.groupLeaderMaxDelegates ?? 10;
  }
  if (delegateMaxDepthInput) {
    delegateMaxDepthInput.value = settings.cluster?.delegateMaxDepth ?? 1;
  }
  for (const [phase, input] of Object.entries(PHASE_PARALLEL_INPUTS)) {
    if (input) {
      input.value = settings.cluster?.phaseParallel?.[phase] ?? "";
    }
  }
  workspaceDirInput.value = settings.workspace?.dir || "./workspace";
  if (botInstallDirInput) {
    botInstallDirInput.value = settings.bot?.installDir || botUiState.defaultInstallDir;
  }
  if (botCommandPrefixInput) {
    botCommandPrefixInput.value = settings.bot?.commandPrefix || "/agent";
  }
  if (botAutoStartInput) {
    botAutoStartInput.checked = Boolean(settings.bot?.autoStart);
  }
  if (botProgressUpdatesInput) {
    botProgressUpdatesInput.checked = settings.bot?.progressUpdates !== false;
  }
  if (botCustomCommandInput) {
    botCustomCommandInput.value = settings.bot?.customCommand || "";
  }

  const inputSchemes =
    Array.isArray(settings.schemes) && settings.schemes.length
      ? settings.schemes.map(cloneSchemeDraft)
      : [buildFallbackScheme(settings.models || [], settings.cluster?.controller || "")];
  schemeUiState.schemes = inputSchemes;
  schemeUiState.connectivityBySchemeId = new Map(
    Array.from(schemeUiState.connectivityBySchemeId.entries()).filter(([schemeId]) =>
      inputSchemes.some((scheme) => scheme.id === schemeId)
    )
  );
  schemeUiState.currentSchemeId =
    settings.cluster?.activeSchemeId && inputSchemes.some((scheme) => scheme.id === settings.cluster.activeSchemeId)
      ? settings.cluster.activeSchemeId
      : inputSchemes[0]?.id || "";

  secretList.innerHTML = "";
  for (const secret of filterVisibleSharedSecrets(settings.secrets || [])) {
    secretList.append(createSecretRow(secret));
  }
  if (!secretList.children.length) {
    secretList.append(createSecretRow({ name: "OPENAI_API_KEY", value: "" }));
  }

  renderSchemeControls();
  renderCurrentSchemeModels();
  renderBotPresetList(settings.bot?.enabledPresets || [], settings.bot?.presetConfigs || {});
}

function renderPlan(plan) {
  planOutput.textContent = JSON.stringify(plan, null, 2);
}

function renderWorkers(executions) {
  if (!executions?.length) {
    workerOutput.innerHTML = '<p class="placeholder">暂无工作模型结果。</p>';
    return;
  }

  workerOutput.innerHTML = executions
    .map((execution) => {
      const output = execution.output || {};
      return `
        <section class="worker-card">
          <div class="worker-head">
            <strong>${escapeHtml(execution.workerLabel || execution.workerId || "工作模型")}</strong>
            <span class="badge ${escapeHtml(execution.status || "unknown")}">${escapeHtml(execution.status || "unknown")}</span>
          </div>
          <p class="meta-row">公开思考摘要：${escapeHtml(output.thinkingSummary || "未提供")}</p>
          <p>${escapeHtml(output.summary || "未返回摘要。")}</p>
          <h3>关键发现</h3>
          ${renderList(output.keyFindings, "未提供关键发现。")}
          <h3>风险</h3>
          ${renderList(output.risks, "未提供风险。")}
          <h3>组长委派说明</h3>
          ${renderList(output.delegationNotes, output.subordinateCount ? "未提供委派说明。" : "本任务未创建下属 agent。")}
          <h3>下属 Agent</h3>
          ${renderList(
            (output.subordinateResults || []).map(
              (item) => `${item.agentLabel || item.agentId}: ${item.summary || item.status || "无摘要"}`
            ),
            "未创建下属 agent。"
          )}
          <h3>后续动作</h3>
          ${renderList(output.followUps, "未提供后续动作。")}
          <h3>验证状态</h3>
          <p>${escapeHtml(output.verificationStatus || "not_applicable")}</p>
          <h3>执行命令</h3>
          ${renderList(output.executedCommands, "未执行命令。")}
          <h3>生成文件</h3>
          ${renderList(output.generatedFiles, "未生成文件。")}
        </section>
      `;
    })
    .join("");
}

function renderSynthesis(result, timings) {
  synthesisOutput.innerHTML = `
    <article class="synthesis-card">
      <p class="final-answer">${escapeHtml(result?.finalAnswer || "未返回最终结论。")}</p>
      <div class="meta-row">总耗时：${escapeHtml(timings?.totalMs ?? "n/a")} ms</div>
      <h3>执行摘要</h3>
      ${renderList(result?.executiveSummary, "未提供执行摘要。")}
      <h3>共识</h3>
      ${renderList(result?.consensus, "未提供共识项。")}
      <h3>分歧</h3>
      ${renderList(result?.disagreements, "未提供分歧项。")}
      <h3>下一步</h3>
      ${renderList(result?.nextActions, "未提供下一步建议。")}
    </article>
  `;
}

function resetLiveFeed() {
  liveOutput.innerHTML = '<p class="placeholder">运行后会在这里显示计划、重试和完成状态。</p>';
}

function setAgentVizSummary(message, tone = "neutral") {
  if (!agentVizSummary) {
    return;
  }

  agentVizSummary.textContent = message;
  agentVizSummary.dataset.tone = tone;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isAgentActiveStatus(status) {
  return ["thinking", "delegating", "spawning", "running", "retrying", "synthesizing"].includes(status);
}

function resolvePhaseLabel(phase) {
  switch (phase) {
    case "research":
      return "调研";
    case "implementation":
      return "实现";
    case "validation":
      return "验证";
    case "handoff":
      return "交付";
    default:
      return "通用";
  }
}

function resolveNodePalette(agent) {
  if (agent.kind === "controller") {
    return {
      accent: "#7aeaff",
      glow: "rgba(122, 234, 255, 0.34)",
      core: "#143d72",
      ring: "rgba(122, 234, 255, 0.9)"
    };
  }

  switch (agent.phase) {
    case "research":
      return {
        accent: "#58d7ff",
        glow: "rgba(88, 215, 255, 0.32)",
        core: "#113a62",
        ring: "rgba(88, 215, 255, 0.86)"
      };
    case "implementation":
      return {
        accent: "#6f9dff",
        glow: "rgba(111, 157, 255, 0.32)",
        core: "#182f67",
        ring: "rgba(111, 157, 255, 0.9)"
      };
    case "validation":
      return {
        accent: "#5ef0d2",
        glow: "rgba(94, 240, 210, 0.28)",
        core: "#0f4252",
        ring: "rgba(94, 240, 210, 0.88)"
      };
    case "handoff":
      return {
        accent: "#ffbf71",
        glow: "rgba(255, 191, 113, 0.28)",
        core: "#4b2f1d",
        ring: "rgba(255, 191, 113, 0.88)"
      };
    default:
      return {
        accent: "#74dfff",
        glow: "rgba(116, 223, 255, 0.3)",
        core: "#14385d",
        ring: "rgba(116, 223, 255, 0.88)"
      };
  }
}

function resolveStatusColor(status) {
  switch (status) {
    case "done":
      return "#36efb1";
    case "failed":
    case "cancelled":
      return "#ff6e8d";
    case "retrying":
      return "#ffd36d";
    case "thinking":
    case "delegating":
    case "spawning":
    case "synthesizing":
      return "#8ae8ff";
    default:
      return "#8fb8eb";
  }
}

function splitNodeLabel(label, maxCharsPerLine = 8, maxLines = 2) {
  const chars = Array.from(String(label || "未命名"));
  const lines = [];

  for (let lineIndex = 0; lineIndex < maxLines; lineIndex += 1) {
    const start = lineIndex * maxCharsPerLine;
    if (start >= chars.length) {
      break;
    }
    const end = start + maxCharsPerLine;
    let segment = chars.slice(start, end).join("");
    if (lineIndex === maxLines - 1 && chars.length > end) {
      segment = `${chars.slice(start, Math.max(start, end - 1)).join("")}…`;
    }
    lines.push(segment);
  }

  return lines.length ? lines : ["未命名"];
}

function getAgentNodeRadius(agent) {
  if (agent.kind === "controller") {
    return 58;
  }
  if (agent.kind === "leader") {
    return 46;
  }
  return 34;
}

function renderAgentInspector() {
  if (!agentVizInspector) {
    return;
  }

  const selectedAgent =
    (agentVizState.selectedAgentId && agentGraphState.agents.get(agentVizState.selectedAgentId)) ||
    (agentGraphState.controllerId && agentGraphState.agents.get(agentGraphState.controllerId)) ||
    Array.from(agentGraphState.agents.values()).find((agent) => isAgentActiveStatus(agent.status)) ||
    Array.from(agentGraphState.agents.values())[0];

  if (!selectedAgent) {
    agentVizInspector.innerHTML =
      '<p class="placeholder">运行后点击节点查看详情，悬停可预览 thinking 轨迹。</p>';
    return;
  }

  const metaItems = [
    `角色：${selectedAgent.kind === "controller" ? "主控" : selectedAgent.kind === "leader" ? "组长" : "下属"}`,
    `状态：${summarizeAgentStatus(selectedAgent)}`,
    selectedAgent.phase ? `阶段：${resolvePhaseLabel(selectedAgent.phase)}` : "",
    selectedAgent.modelLabel ? `模型：${selectedAgent.modelLabel}` : "",
    selectedAgent.taskTitle ? `任务：${selectedAgent.taskTitle}` : ""
  ].filter(Boolean);

  const notes = selectedAgent.notes?.length
    ? `<ul>${selectedAgent.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    : '<p class="placeholder">当前没有公开思考轨迹。</p>';

  agentVizInspector.innerHTML = `
    <div class="agent-inspector-head">
      <div>
        <p class="panel-kicker">Agent Detail</p>
        <h3>${escapeHtml(selectedAgent.label || selectedAgent.id)}</h3>
      </div>
      <span class="badge">${escapeHtml(summarizeAgentStatus(selectedAgent))}</span>
    </div>
    <p class="agent-inspector-action">${escapeHtml(selectedAgent.action || "等待任务")}</p>
    <div class="agent-inspector-meta">
      ${metaItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div>
    <div class="agent-inspector-notes">
      <h4>公开思考与轨迹</h4>
      ${notes}
    </div>
  `;
}

function hideAgentTooltip() {
  if (!agentVizTooltip) {
    return;
  }

  agentVizTooltip.hidden = true;
  agentVizTooltip.innerHTML = "";
}

function updateAgentTooltipPosition(clientX, clientY) {
  if (!agentVizStage || !agentVizTooltip || agentVizTooltip.hidden) {
    return;
  }

  const stageRect = agentVizStage.getBoundingClientRect();
  const tooltipRect = agentVizTooltip.getBoundingClientRect();
  const maxLeft = stageRect.width - tooltipRect.width - 12;
  const maxTop = stageRect.height - tooltipRect.height - 12;
  const left = clampNumber(clientX - stageRect.left + 18, 12, Math.max(12, maxLeft));
  const top = clampNumber(clientY - stageRect.top + 18, 12, Math.max(12, maxTop));
  agentVizTooltip.style.left = `${left}px`;
  agentVizTooltip.style.top = `${top}px`;
}

function showAgentTooltip(agent, clientX, clientY) {
  if (!agentVizTooltip || !agent) {
    return;
  }

  const latestNotes = (agent.notes || []).slice(-4);
  const noteMarkup = latestNotes.length
    ? `<ul>${latestNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    : '<p class="placeholder">暂无公开轨迹</p>';

  agentVizTooltip.innerHTML = `
    <div class="agent-tooltip-head">
      <strong>${escapeHtml(agent.label || agent.id)}</strong>
      <span>${escapeHtml(summarizeAgentStatus(agent))}</span>
    </div>
    <p class="agent-tooltip-action">${escapeHtml(agent.action || "等待任务")}</p>
    ${noteMarkup}
  `;
  agentVizTooltip.hidden = false;
  updateAgentTooltipPosition(clientX, clientY);
}

function updateAgentVizZoomLabel() {
  if (!agentVizZoomLabel) {
    return;
  }

  const percent = agentVizState.scale * 100;
  agentVizZoomLabel.textContent =
    percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(percent >= 1 ? 1 : 2)}%`;
}

function applyAgentVizTransform() {
  if (!agentVizZoomLayer) {
    return;
  }

  agentVizZoomLayer.style.width = `${agentVizState.graphWidth}px`;
  agentVizZoomLayer.style.height = `${agentVizState.graphHeight}px`;
  agentVizZoomLayer.style.transform = `translate(${agentVizState.panX}px, ${agentVizState.panY}px) scale(${agentVizState.scale})`;
  updateAgentVizZoomLabel();
}

function fitAgentVizToGraph(force = false) {
  if (!agentVizStage || !force && agentVizState.hasViewportInteraction) {
    return;
  }

  const stageRect = agentVizStage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) {
    return;
  }

  const widthScale = (stageRect.width - 36) / Math.max(1, agentVizState.graphWidth);
  const heightScale = (stageRect.height - 36) / Math.max(1, agentVizState.graphHeight);
  agentVizState.scale = clampNumber(Math.min(widthScale, heightScale, 1), agentVizState.minScale, 1.15);
  agentVizState.panX = (stageRect.width - agentVizState.graphWidth * agentVizState.scale) / 2;
  agentVizState.panY = (stageRect.height - agentVizState.graphHeight * agentVizState.scale) / 2;
  applyAgentVizTransform();
}

function setAgentVizScale(nextScale, anchorX = null, anchorY = null) {
  if (!agentVizStage) {
    return;
  }

  const stageRect = agentVizStage.getBoundingClientRect();
  const pivotX = anchorX ?? stageRect.width / 2;
  const pivotY = anchorY ?? stageRect.height / 2;
  const previousScale = agentVizState.scale;
  const normalizedScale = clampNumber(nextScale, agentVizState.minScale, agentVizState.maxScale);

  if (Math.abs(normalizedScale - previousScale) < 0.0001) {
    return;
  }

  const worldX = (pivotX - agentVizState.panX) / previousScale;
  const worldY = (pivotY - agentVizState.panY) / previousScale;
  agentVizState.scale = normalizedScale;
  agentVizState.panX = pivotX - worldX * normalizedScale;
  agentVizState.panY = pivotY - worldY * normalizedScale;
  agentVizState.hasViewportInteraction = true;
  applyAgentVizTransform();
}

function polarToCartesian(centerX, centerY, radius, angle) {
  return {
    x: Number((centerX + Math.cos(angle) * radius).toFixed(2)),
    y: Number((centerY + Math.sin(angle) * radius).toFixed(2))
  };
}

function buildDonutSectorPath(centerX, centerY, innerRadius, outerRadius, startAngle, endAngle) {
  const span = Math.max(0.001, endAngle - startAngle);
  const largeArc = span > Math.PI ? 1 : 0;
  const outerStart = polarToCartesian(centerX, centerY, outerRadius, startAngle);
  const outerEnd = polarToCartesian(centerX, centerY, outerRadius, endAngle);
  const innerEnd = polarToCartesian(centerX, centerY, innerRadius, endAngle);
  const innerStart = polarToCartesian(centerX, centerY, innerRadius, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z"
  ].join(" ");
}

function buildRadialEdgePath(source, target, centerX, centerY) {
  if (!source || !target) {
    return "";
  }

  const sourceAngle = Number.isFinite(source.angle) ? source.angle : target.angle || -Math.PI / 2;
  const targetAngle = Number.isFinite(target.angle) ? target.angle : source.angle || -Math.PI / 2;
  const controlAngle = (sourceAngle + targetAngle) / 2;
  const sourceRadius = Math.max(0, Number(source.orbitRadius) || 0);
  const targetRadius = Math.max(0, Number(target.orbitRadius) || 0);
  const controlRadius =
    sourceRadius === 0 || targetRadius === 0
      ? Math.max(sourceRadius, targetRadius) * 0.54
      : (sourceRadius + targetRadius) / 2;
  const control = polarToCartesian(centerX, centerY, controlRadius, controlAngle);

  return `M ${source.x} ${source.y} Q ${control.x} ${control.y} ${target.x} ${target.y}`;
}

function buildAgentLayout(agents) {
  return buildAgentTreeLayout(agents, {
    controllerId: agentGraphState.controllerId
  });
}

function buildAgentSvg(layout) {
  const nodeMap = new Map(layout.nodes.map((node) => [node.agent.id, node]));
  const orbitMarkup = (layout.orbits || [])
    .map(
      (orbit) => `
        <circle
          class="agent-orbit-ring ${orbit.kind || ""}"
          cx="${layout.centerX}"
          cy="${layout.centerY}"
          r="${orbit.radius}"
        ></circle>
      `
    )
    .join("");
  const groupMarkup = layout.groups
    .map((group) => {
      const label = `${resolvePhaseLabel(group.leader.phase)}组`;
      return `
        <g class="agent-group" data-phase="${escapeAttribute(group.leader.phase || "general")}">
          <path
            class="agent-group-band"
            d="${buildDonutSectorPath(
              layout.centerX,
              layout.centerY,
              group.bandInnerRadius,
              group.bandOuterRadius,
              group.startAngle,
              group.endAngle
            )}"
          ></path>
          <text class="agent-group-label" x="${group.labelPoint.x}" y="${group.labelPoint.y}">${escapeHtml(label)}</text>
        </g>
      `;
    })
    .join("");

  const edgeMarkup = layout.edges
    .map((edge) => {
      const source = nodeMap.get(edge.from);
      const target = nodeMap.get(edge.to);
      if (!source || !target) {
        return "";
      }

      const path = buildRadialEdgePath(source, target, layout.centerX, layout.centerY);
      return `
        <g class="agent-edge-group ${edge.active ? "active" : ""}" data-phase="${escapeAttribute(edge.phase || "general")}">
          <path class="agent-edge" d="${path}"></path>
          <path class="agent-edge-flow" d="${path}"></path>
        </g>
      `;
    })
    .join("");

  const nodeMarkup = layout.nodes
    .map((node) => {
      const { agent, x, y, radius } = node;
      const lines = splitNodeLabel(agent.label, agent.kind === "subordinate" ? 6 : 8, 2);
      const palette = resolveNodePalette(agent);
      const statusColor = resolveStatusColor(agent.status);
      const orbitDuration =
        agent.status === "thinking"
          ? "5s"
          : agent.status === "delegating" || agent.status === "spawning"
            ? "2.2s"
            : agent.status === "retrying"
              ? "1.6s"
              : "3.4s";
      const captionY = radius + 24;

      return `
        <g
          class="agent-node ${escapeAttribute(agent.kind || "leader")}"
          data-agent-id="${escapeAttribute(agent.id)}"
          data-status="${escapeAttribute(agent.status || "idle")}"
          transform="translate(${x} ${y})"
          style="--node-accent:${palette.accent}; --node-glow:${palette.glow}; --node-core:${palette.core}; --node-ring:${palette.ring}; --node-status:${statusColor};"
        >
          <title>${escapeHtml(agent.label || agent.id)}</title>
          <circle class="agent-node-wave wave-a" r="${radius + 10}">
            <animate attributeName="r" values="${radius + 8};${radius + 26};${radius + 8}" dur="2.4s" repeatCount="indefinite"></animate>
            <animate attributeName="opacity" values="0.7;0;0.7" dur="2.4s" repeatCount="indefinite"></animate>
          </circle>
          <circle class="agent-node-wave wave-b" r="${radius + 16}">
            <animate attributeName="r" values="${radius + 14};${radius + 34};${radius + 14}" dur="2.4s" begin="1.1s" repeatCount="indefinite"></animate>
            <animate attributeName="opacity" values="0.45;0;0.45" dur="2.4s" begin="1.1s" repeatCount="indefinite"></animate>
          </circle>
          <circle class="agent-node-shell" r="${radius + 10}"></circle>
          <circle class="agent-node-ring" r="${radius + 4}"></circle>
          <circle class="agent-node-core" r="${radius}"></circle>
          <circle class="agent-node-inner" r="${Math.round(radius * 0.72)}"></circle>
          <g class="agent-node-orbit">
            <circle class="agent-node-orb" cx="0" cy="${-(radius + 14)}" r="${Math.max(3, Math.round(radius * 0.11))}"></circle>
            <animateTransform
              attributeName="transform"
              attributeType="XML"
              type="rotate"
              from="0"
              to="360"
              dur="${orbitDuration}"
              repeatCount="indefinite"
            ></animateTransform>
          </g>
          <text class="agent-node-title" y="${lines.length > 1 ? -6 : 2}">${escapeHtml(lines[0])}</text>
          ${lines[1] ? `<text class="agent-node-title secondary" y="12">${escapeHtml(lines[1])}</text>` : ""}
          <text class="agent-node-caption" y="${captionY}">${escapeHtml(summarizeAgentStatus(agent))}</text>
        </g>
      `;
    })
    .join("");

  return `
    <defs>
      <filter id="agentNodeGlow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur stdDeviation="10" result="blur"></feGaussianBlur>
        <feMerge>
          <feMergeNode in="blur"></feMergeNode>
          <feMergeNode in="SourceGraphic"></feMergeNode>
        </feMerge>
      </filter>
    </defs>
    ${orbitMarkup}
    ${groupMarkup}
    ${edgeMarkup}
    ${nodeMarkup}
  `;
}

function renderEmptyAgentViz() {
  if (agentVizSvg) {
    agentVizSvg.setAttribute("viewBox", "0 0 1200 760");
    agentVizSvg.innerHTML = `
      <defs>
        <filter id="agentNodeGlow" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="10" result="blur"></feGaussianBlur>
          <feMerge>
            <feMergeNode in="blur"></feMergeNode>
            <feMergeNode in="SourceGraphic"></feMergeNode>
          </feMerge>
        </filter>
      </defs>
      <g class="agent-empty-state" transform="translate(600 320)">
        <circle class="agent-empty-orbit" r="92"></circle>
        <circle class="agent-empty-core" r="38"></circle>
        <circle class="agent-empty-dot" cx="0" cy="-92" r="5">
          <animateTransform
            attributeName="transform"
            attributeType="XML"
            type="rotate"
            from="0"
            to="360"
            dur="7s"
            repeatCount="indefinite"
          ></animateTransform>
        </circle>
        <text class="agent-empty-title" x="0" y="146">等待 Agent 集群启动</text>
        <text class="agent-empty-copy" x="0" y="176">运行后这里会变成动态图谱</text>
      </g>
    `;
  }

  agentVizState.graphWidth = 1200;
  agentVizState.graphHeight = 760;
  agentVizState.selectedAgentId = "";
  agentVizState.hoveredAgentId = "";
  agentVizState.hasViewportInteraction = false;
  agentVizState.dragPointerId = null;
  agentVizState.dragMoved = false;
  agentVizState.pointerDownAgentId = "";
  agentVizState.runStartedAt = 0;
  hideAgentTooltip();
  fitAgentVizToGraph(true);
  updateAgentRunTimer("00:00");
  renderAgentInspector();
}

function resetAgentGraph() {
  agentGraphState.operationId = "";
  agentGraphState.controllerId = "";
  agentGraphState.controllerLabel = "";
  agentGraphState.agents.clear();
  agentVizState.selectedAgentId = "";
  agentVizState.hoveredAgentId = "";
  agentVizState.hasViewportInteraction = false;
  agentVizState.isDragging = false;
  agentVizState.dragPointerId = null;
  agentVizState.dragMoved = false;
  agentVizState.pointerDownAgentId = "";
  stopAgentRunTimer();
  renderEmptyAgentViz();
  setAgentVizSummary("等待运行", "neutral");
}

function renderAgentGraph() {
  if (!agentVizSvg) {
    return;
  }

  const agents = Array.from(agentGraphState.agents.values());
  if (!agents.length) {
    renderEmptyAgentViz();
    return;
  }

  const layout = buildAgentLayout(agents);
  agentVizState.graphWidth = layout.width;
  agentVizState.graphHeight = layout.height;
  agentVizSvg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  agentVizSvg.innerHTML = buildAgentSvg(layout);

  if (!agentVizState.selectedAgentId || !agentGraphState.agents.has(agentVizState.selectedAgentId)) {
    const defaultAgent =
      layout.controller ||
      layout.groups.find((group) => isAgentActiveStatus(group.leader.status))?.leader ||
      layout.groups[0]?.leader ||
      layout.nodes[0]?.agent;
    agentVizState.selectedAgentId = defaultAgent?.id || "";
  }

  renderAgentInspector();
  fitAgentVizToGraph(!agentVizState.hasViewportInteraction);
  applyAgentVizTransform();

  const activity = summarizeAgentActivity(agents);
  setAgentVizSummary(
    activity.activeCount ? `活跃 ${activity.activeCount} / 全部 ${activity.totalCount}` : `已同步 ${activity.totalCount}`,
    activity.activeCount ? "warning" : "ok"
  );
}

function bindAgentVizInteractions() {
  if (!agentVizStage) {
    return;
  }

  const resolveAgentNodeElement = (target) =>
    target instanceof Element ? target.closest("[data-agent-id]") : null;

  agentVizStage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = agentVizStage.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const zoomFactor = event.deltaY < 0 ? 1.12 : 0.9;
      setAgentVizScale(agentVizState.scale * zoomFactor, anchorX, anchorY);
    },
    { passive: false }
  );

  agentVizStage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    const nodeElement = resolveAgentNodeElement(event.target);
    agentVizState.isDragging = true;
    agentVizState.dragMoved = false;
    agentVizState.dragPointerId = event.pointerId;
    agentVizState.dragStartX = event.clientX;
    agentVizState.dragStartY = event.clientY;
    agentVizState.lastPointerX = event.clientX;
    agentVizState.lastPointerY = event.clientY;
    agentVizState.pointerDownAgentId = nodeElement?.dataset.agentId || "";
    agentVizStage.classList.add("dragging");
    agentVizStage.setPointerCapture(event.pointerId);
    if (!agentVizState.pointerDownAgentId) {
      hideAgentTooltip();
    }
  });

  agentVizStage.addEventListener("pointermove", (event) => {
    if (agentVizState.isDragging && event.pointerId === agentVizState.dragPointerId) {
      const deltaX = event.clientX - agentVizState.lastPointerX;
      const deltaY = event.clientY - agentVizState.lastPointerY;
      const totalDeltaX = event.clientX - agentVizState.dragStartX;
      const totalDeltaY = event.clientY - agentVizState.dragStartY;
      agentVizState.lastPointerX = event.clientX;
      agentVizState.lastPointerY = event.clientY;
      if (!agentVizState.dragMoved && Math.hypot(totalDeltaX, totalDeltaY) >= 4) {
        agentVizState.dragMoved = true;
        hideAgentTooltip();
      }
      if (agentVizState.dragMoved) {
        agentVizState.panX += deltaX;
        agentVizState.panY += deltaY;
        agentVizState.hasViewportInteraction = true;
        applyAgentVizTransform();
      }
      return;
    }

    const nodeElement = resolveAgentNodeElement(event.target);
    if (!nodeElement) {
      agentVizState.hoveredAgentId = "";
      hideAgentTooltip();
      return;
    }

    const agentId = nodeElement.dataset.agentId || "";
    const agent = agentGraphState.agents.get(agentId);
    if (!agent) {
      hideAgentTooltip();
      return;
    }

    agentVizState.hoveredAgentId = agentId;
    showAgentTooltip(agent, event.clientX, event.clientY);
  });

  const stopDragging = (event, selectNode = true) => {
    if (agentVizState.dragPointerId != null && event.pointerId !== agentVizState.dragPointerId) {
      return;
    }

    const selectedAgentId =
      selectNode && !agentVizState.dragMoved ? agentVizState.pointerDownAgentId : "";
    if (agentVizState.dragPointerId != null && agentVizStage.hasPointerCapture(agentVizState.dragPointerId)) {
      agentVizStage.releasePointerCapture(agentVizState.dragPointerId);
    }
    agentVizState.isDragging = false;
    agentVizState.dragPointerId = null;
    agentVizState.pointerDownAgentId = "";
    agentVizState.dragMoved = false;
    agentVizStage.classList.remove("dragging");

    if (selectedAgentId && agentGraphState.agents.has(selectedAgentId)) {
      agentVizState.selectedAgentId = selectedAgentId;
      renderAgentInspector();
    }
  };

  agentVizStage.addEventListener("pointerup", (event) => {
    stopDragging(event, true);
  });
  agentVizStage.addEventListener("pointercancel", (event) => {
    stopDragging(event, false);
  });
  agentVizStage.addEventListener("pointerleave", () => {
    if (!agentVizState.isDragging) {
      agentVizState.hoveredAgentId = "";
      hideAgentTooltip();
    }
  });

  agentVizZoomOutButton?.addEventListener("click", () => {
    setAgentVizScale(agentVizState.scale * 0.9);
  });
  agentVizZoomInButton?.addEventListener("click", () => {
    setAgentVizScale(agentVizState.scale * 1.12);
  });
  agentVizResetButton?.addEventListener("click", () => {
    agentVizState.hasViewportInteraction = false;
    fitAgentVizToGraph(true);
  });
  window.addEventListener("resize", () => {
    if (!agentGraphState.agents.size) {
      renderEmptyAgentViz();
      return;
    }

    fitAgentVizToGraph(!agentVizState.hasViewportInteraction);
    applyAgentVizTransform();
  });
}

function closeCurrentOperationStream() {
  if (currentOperationStream) {
    currentOperationStream.close();
    currentOperationStream = null;
  }
}

function formatElapsedDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updateAgentRunTimer(forceText = "") {
  if (!agentVizTimer) {
    return;
  }

  if (forceText) {
    agentVizTimer.textContent = forceText;
    return;
  }

  if (!agentVizState.runStartedAt) {
    agentVizTimer.textContent = "00:00";
    return;
  }

  agentVizTimer.textContent = formatElapsedDuration(Date.now() - agentVizState.runStartedAt);
}

function startAgentRunTimer() {
  agentVizState.runStartedAt = Date.now();
  updateAgentRunTimer();
  if (agentRunTimerInterval) {
    clearInterval(agentRunTimerInterval);
  }
  agentRunTimerInterval = setInterval(() => {
    updateAgentRunTimer();
  }, 1000);
}

function stopAgentRunTimer() {
  if (agentRunTimerInterval) {
    clearInterval(agentRunTimerInterval);
    agentRunTimerInterval = null;
  }
}

function beginOperation(operationId, onEvent) {
  currentOperationId = operationId;
  closeCurrentOperationStream();
  currentOperationStream = openOperationStream(operationId, onEvent);
  startAgentRunTimer();
}

function finishOperation() {
  currentOperationId = "";
  if (cancelButton) {
    cancelButton.disabled = true;
  }
  stopAgentRunTimer();
  if (currentOperationStream) {
    const stream = currentOperationStream;
    currentOperationStream = null;
    setTimeout(() => stream.close(), 300);
  }
}

function formatDelay(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)} 秒`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function resolveControllerEventMeta() {
  const fallbackId = agentGraphState.controllerId || controllerSelect.value || "controller";
  const knownModel = knownModelConfigs.get(fallbackId);
  const fallbackLabel = agentGraphState.controllerLabel || knownModel?.label || "主控 Agent";
  return {
    agentId: fallbackId,
    agentLabel: fallbackLabel,
    agentKind: "controller",
    modelId: fallbackId,
    modelLabel: fallbackLabel
  };
}

function renderClusterCancelledState(detail = "运行已被手动取消。") {
  const message = String(detail || "运行已被手动取消。");
  planOutput.textContent = `任务已终止：${message}`;
  workerOutput.innerHTML = '<p class="placeholder">任务已终止，已停止等待剩余工作模型结果。</p>';
  synthesisOutput.innerHTML = `<p class="placeholder">任务已终止：${escapeHtml(message)}</p>`;
  runState.textContent = "已终止";
}

async function requestOperationCancellation(operationId, maxAttempts = 4) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`/api/operations/${encodeURIComponent(operationId)}/cancel`, {
        method: "POST"
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (error?.status !== 404 || attempt === maxAttempts) {
        throw error;
      }
      await sleep(120 * attempt);
    }
  }

  throw lastError || new Error("Cancel request failed.");
}

function updateAgentGraphFromEvent(event) {
  const timestamp = formatTimestamp(event.timestamp);

  if (event.stage === "planning_start" || event.stage === "planning_done" || event.stage === "planning_retry" || event.stage === "synthesis_start" || event.stage === "synthesis_retry" || event.stage === "cluster_done" || event.stage === "cluster_failed" || event.stage === "cluster_cancelled") {
    const controllerId = event.agentId || event.modelId || "controller";
    const controllerLabel = event.agentLabel || event.modelLabel || "主控 Agent";
    agentGraphState.controllerId = controllerId;
    agentGraphState.controllerLabel = controllerLabel;
    const controller = ensureAgentState({
      id: controllerId,
      label: controllerLabel,
      kind: "controller",
      modelId: event.modelId || controllerId,
      modelLabel: event.modelLabel || controllerLabel,
      status:
        event.stage === "planning_start"
          ? "thinking"
          : event.stage === "planning_retry" || event.stage === "synthesis_retry"
            ? "retrying"
            : event.stage === "synthesis_start"
              ? "synthesizing"
              : event.stage === "cluster_done"
                ? "done"
                : event.stage === "cluster_cancelled"
                  ? "cancelled"
                  : event.stage === "cluster_failed"
                    ? "failed"
                    : "delegating",
      action:
        event.stage === "planning_start"
          ? "主控正在拆解与分配任务"
          : event.stage === "synthesis_start"
            ? "主控正在汇总各组结果"
            : event.stage === "cluster_done"
              ? "主控已完成汇总"
              : event.stage === "cluster_cancelled"
                ? "主控流程已终止"
                : event.stage === "cluster_failed"
                  ? "主控流程执行失败"
                  : event.detail || "主控正在更新计划"
    });
    appendAgentNote(controller.id, event.planStrategy || event.detail || describeOperationEvent(event), timestamp);

    if (event.stage === "planning_done" && Array.isArray(event.planTasks)) {
      for (const task of event.planTasks) {
        const leaderId = `leader:${task.assignedWorker}`;
        const label = formatLeaderDisplayLabel(task.assignedWorker, task.phase);
        ensureAgentState({
          id: leaderId,
          label,
          kind: "leader",
          modelId: task.assignedWorker,
          modelLabel: knownModelConfigs.get(task.assignedWorker)?.label || task.assignedWorker,
          phase: task.phase,
          status: task.delegateCount ? "delegating" : "idle",
          action: task.delegateCount
            ? `已规划 ${task.delegateCount} 个下属 agent`
            : "等待组长直接执行",
          taskTitle: task.title
        });
      }
    }

    renderAgentGraph();
    return;
  }

  const fallbackAgentId =
    event.agentId ||
    (event.agentKind === "subordinate"
      ? `subordinate:${event.modelId}:${event.taskId || "task"}`
      : event.modelId
        ? `leader:${event.modelId}`
        : "");

  if (!fallbackAgentId) {
    return;
  }

  const normalizedKind =
    event.agentKind ||
    (String(event.stage || "").startsWith("subagent_") ? "subordinate" : "leader");
  const inferredLabel =
    event.agentLabel ||
    (normalizedKind === "leader"
      ? formatLeaderDisplayLabel(event.modelId || "", event.phase || "")
      : event.modelLabel || fallbackAgentId);

  const existingAgent = agentGraphState.agents.get(fallbackAgentId) || null;
  const agent = ensureAgentState({
    id: fallbackAgentId,
    label: inferredLabel,
    kind: normalizedKind,
    parentId: resolveAgentGraphParentId(event, normalizedKind, existingAgent),
    parentLabel: event.parentAgentLabel || existingAgent?.parentLabel || "",
    phase: event.phase || "",
    modelId: event.modelId || "",
    modelLabel: event.modelLabel || "",
    taskTitle: event.taskTitle || ""
  });

  switch (event.stage) {
    case "worker_start":
      agent.status = "running";
      agent.action = event.detail || "组长开始执行任务";
      break;
    case "worker_done":
      agent.status = event.tone === "warning" ? "failed" : "done";
      agent.action = "组长已完成任务";
      break;
    case "worker_failed":
      agent.status = "failed";
      agent.action = "组长执行失败";
      break;
    case "worker_retry":
      agent.status = "retrying";
      agent.action = `组长重试中 ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
      break;
    case "leader_delegate_start":
      agent.status = "thinking";
      agent.action = "组长正在思考如何拆分任务";
      break;
    case "leader_delegate_done":
      agent.status = "delegating";
      agent.action = event.detail || "组长已完成任务分派";
      break;
    case "leader_delegate_retry":
      agent.status = "retrying";
      agent.action = `组长拆分方案重试中 ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
      break;
    case "leader_synthesis_start":
      agent.status = "synthesizing";
      agent.action = "组长正在回收并汇总下属结果";
      break;
    case "leader_synthesis_retry":
      agent.status = "retrying";
      agent.action = `组长汇总重试中 ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
      break;
    case "subagent_created":
      agent.status = "spawning";
      agent.action = event.detail || "已创建下属 agent";
      break;
    case "subagent_start":
      agent.status = "running";
      agent.action = "下属开始执行";
      break;
    case "subagent_done":
      agent.status = "done";
      agent.action = "下属已完成";
      break;
    case "subagent_failed":
      agent.status = "failed";
      agent.action = "下属执行失败";
      break;
    case "subagent_retry":
      agent.status = "retrying";
      agent.action = `下属重试中 ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
      break;
    case "workspace_list":
    case "workspace_read":
    case "workspace_write":
    case "workspace_command":
      agent.status = "running";
      agent.action = describeOperationEvent(event);
      break;
    default:
      break;
  }

  appendAgentNote(agent.id, event.thinkingSummary || event.detail || describeOperationEvent(event), timestamp);
  renderAgentGraph();
}

function getWorkspaceDirValue() {
  return workspaceDirInput.value.trim();
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

function describeOperationEvent(event) {
  const actor = event.agentLabel || event.modelLabel || event.modelId || "";
  switch (event.stage) {
    case "submitted":
      return "请求已提交，等待后端处理。";
    case "model_test_retry":
      return `模型 ${event.modelId || ""} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "model_test_done":
      return "模型连接测试完成。";
    case "model_test_failed":
      return `模型连接测试失败：${event.detail || "未知错误"}`;
    case "planning_start":
      return `主控 Agent ${actor} 正在拆解任务。`;
    case "planning_done":
      return `主控 Agent 已生成计划，共 ${event.taskCount ?? 0} 个子任务。`;
    case "planning_retry":
      return `主控 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "cancel_requested":
      return event.detail || "已收到终止任务请求，正在停止运行。";
    case "phase_start":
      return `进入 ${event.phase || ""} 阶段。`;
    case "phase_done":
      return `已完成 ${event.phase || ""} 阶段。`;
    case "worker_start":
      return `组长 Agent ${actor} 开始执行：${event.taskTitle || event.taskId || "子任务"}`;
    case "worker_done":
      return `组长 Agent ${actor} 已完成：${event.taskTitle || event.taskId || "子任务"}`;
    case "workspace_list":
      return `${actor} 已查看目录：${event.detail || ""}`;
    case "workspace_read":
      return `${actor} 已读取文件：${event.detail || ""}`;
    case "workspace_write":
      return `${actor} 已写入文件：${(event.generatedFiles || []).join(", ") || event.detail || ""}`;
    case "workspace_command":
      return `${actor} 已执行命令：${event.detail || ""}，退出码 ${event.exitCode ?? "n/a"}`;
    case "worker_retry":
      return `组长 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "worker_failed":
      return `组长 Agent ${actor} 执行失败：${event.detail || "未知错误"}`;
    case "leader_delegate_start":
      return `组长 Agent ${actor} 正在思考如何分配下属任务。`;
    case "leader_delegate_done":
      return `组长 Agent ${actor} 已完成下属任务分配。`;
    case "leader_delegate_retry":
      return `组长 Agent ${actor} 的分配方案正在重试，第 ${event.attempt}/${event.maxRetries} 次。`;
    case "subagent_created":
      return `已创建下属 Agent ${actor}：${event.taskTitle || event.detail || "等待执行"}`;
    case "subagent_start":
      return `下属 Agent ${actor} 开始执行：${event.taskTitle || event.taskId || "子任务"}`;
    case "subagent_done":
      return `下属 Agent ${actor} 已完成：${event.taskTitle || event.taskId || "子任务"}`;
    case "subagent_retry":
      return `下属 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "subagent_failed":
      return `下属 Agent ${actor} 执行失败：${event.detail || "未知错误"}`;
    case "leader_synthesis_start":
      return `组长 Agent ${actor} 正在回收并汇总下属结果。`;
    case "leader_synthesis_retry":
      return `组长 Agent ${actor} 的汇总过程正在重试，第 ${event.attempt}/${event.maxRetries} 次。`;
    case "validation_gate_failed":
      return event.detail || "验证阶段未通过。";
    case "synthesis_start":
      return `主控 Agent ${actor} 正在汇总结果。`;
    case "synthesis_retry":
      return `主控 Agent ${actor} 正在重试，第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后再次请求。`;
    case "cluster_done":
      return `集群运行完成，总耗时 ${event.totalMs ?? "n/a"} ms。`;
    case "cluster_cancelled":
      return `任务已终止：${event.detail || "运行已被手动取消。"}`;
    case "cluster_failed":
      return `集群运行失败：${event.detail || "未知错误"}`;
    default:
      if (event.detail) {
        return event.detail;
      }
      if (event.message) {
        return event.message;
      }
      return "收到新的运行事件。";
  }
}

function appendLiveEvent(event) {
  if (liveOutput.querySelector(".placeholder")) {
    liveOutput.innerHTML = "";
  }

  const item = document.createElement("article");
  item.className = "feed-item";
  item.dataset.tone = event.tone || "neutral";
  item.innerHTML = `
    <div class="feed-time">${escapeHtml(formatTimestamp(event.timestamp) || "--:--:--")}</div>
    <div class="feed-message">${escapeHtml(describeOperationEvent(event))}</div>
  `;
  liveOutput.append(item);

  const items = Array.from(liveOutput.querySelectorAll(".feed-item"));
  if (items.length > LIVE_EVENT_LIMIT) {
    items[0].remove();
  }
  liveOutput.scrollTop = liveOutput.scrollHeight;
}

function setRunStateFromEvent(event) {
  switch (event.stage) {
    case "planning_start":
      runState.textContent = "规划中";
      break;
    case "phase_start":
      runState.textContent =
        event.phase === "research"
          ? "调研中"
          : event.phase === "validation"
            ? "验证中"
            : event.phase === "handoff"
              ? "交付中"
              : "执行中";
      break;
    case "planning_retry":
    case "worker_retry":
    case "synthesis_retry":
    case "model_test_retry":
    case "subagent_retry":
    case "leader_delegate_retry":
    case "leader_synthesis_retry":
      runState.textContent = `重试中 ${event.attempt}/${event.maxRetries}`;
      break;
    case "leader_delegate_start":
      runState.textContent = "分配中";
      break;
    case "subagent_start":
      runState.textContent = "下属执行中";
      break;
    case "leader_synthesis_start":
      runState.textContent = "组长汇总中";
      break;
    case "cancel_requested":
      runState.textContent = "终止中...";
      break;
    case "synthesis_start":
      runState.textContent = "汇总中";
      break;
    case "cluster_cancelled":
      runState.textContent = "已终止";
      break;
    case "cluster_done":
      runState.textContent = "已完成";
      break;
    case "cluster_failed":
      runState.textContent = "失败";
      break;
    default:
      break;
  }
}

function openOperationStream(operationId, onEvent) {
  const source = new EventSource(`/api/operations/${encodeURIComponent(operationId)}/events`);
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      onEvent(payload);
    } catch {
      // Ignore malformed events from a stale stream.
    }
  };
  return source;
}

function createOperationId(prefix) {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomPart}`;
}

function sanitizeIdFragment(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w-]/g, "_");
}

function buildUniqueName(baseName, used) {
  let candidate = sanitizeIdFragment(baseName) || "model";
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${sanitizeIdFragment(baseName) || "model"}_${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function batchAddModels() {
  const keys = collectBatchKeys();

  if (batchAuthStyleSelect.value !== "none" && !keys.length) {
    setSaveStatus("批量添加失败：请至少填写一个 API Key 输入框。", "error");
    getBatchKeyInputs()[0]?.focus();
    return;
  }

  const existingModels = collectModels();
  const usedIds = new Set(existingModels.map((model) => model.id).filter(Boolean));
  const usedEnvNames = new Set(existingModels.map((model) => model.apiKeyEnv).filter(Boolean));
  const baseIdPrefix = batchIdPrefixInput.value.trim() || "codex_worker";
  const baseLabelPrefix = batchLabelPrefixInput.value.trim() || "Codex Worker";
  const baseEnvPrefix = batchEnvPrefixInput.value.trim() || "CODEX_API_KEY";
  const authStyle = batchAuthStyleSelect.value;
  const provider = batchProviderSelect.value;
  const sharedModel = batchModelNameInput.value.trim();
  const sharedBaseUrl = batchBaseUrlInput.value.trim();
  const batchSpecialties = collectSpecialtiesFromInputs(
    batchCapabilityList,
    batchSpecialtiesCustomInput.value
  );

  if (!sharedModel) {
    setSaveStatus("批量添加失败：请填写模型名。", "error");
    batchModelNameInput.focus();
    return;
  }

  if (!sharedBaseUrl) {
    setSaveStatus("批量添加失败：请填写 Base URL。", "error");
    batchBaseUrlInput.focus();
    return;
  }

  const count = authStyle === "none" ? 1 : keys.length;
  for (let index = 0; index < count; index += 1) {
    const suffix = index + 1;
    const modelId = buildUniqueName(`${baseIdPrefix}_${suffix}`, usedIds);
    const envName = authStyle === "none" ? "" : buildUniqueName(`${baseEnvPrefix}_${suffix}`, usedEnvNames);
    modelList.append(
      createModelCard({
        id: modelId,
        label: `${baseLabelPrefix} ${suffix}`,
        provider,
        model: sharedModel,
        baseUrl: sharedBaseUrl,
        apiKeyEnv: envName,
        apiKeyValue: authStyle === "none" ? "" : keys[index] || "",
        authStyle,
        apiKeyHeader: batchApiKeyHeaderInput.value.trim(),
        reasoningEffort: batchReasoningSelect.value,
        webSearch: batchWebSearchInput.checked,
        temperature: batchTemperatureInput.value.trim(),
        specialties: batchSpecialties
      })
    );
  }

  updateControllerOptions();
  captureCurrentSchemeDraft();
  renderSchemeConnectivityList();
  setSaveStatus(`已批量添加 ${count} 个模型卡。`, "ok");
}

async function loadWorkspaceSummary() {
  workspaceTreeOutput.textContent = "正在读取工作区...";
  try {
    const response = await fetch(`/api/workspace${buildWorkspaceQuery(getWorkspaceDirValue())}`);
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    const treeText = payload.workspace.tree?.length ? payload.workspace.tree.join("\n") : "(工作区为空)";
    workspaceTreeOutput.textContent = `根目录：${payload.workspace.resolvedDir}\n\n${treeText}`;
  } catch (error) {
    workspaceTreeOutput.textContent = `读取工作区失败：${error.message}`;
  }
}

async function readWorkspaceFilePreview() {
  const filePath = workspaceFilePathInput.value.trim();
  if (!filePath) {
    workspaceFileOutput.textContent = "请输入要读取的相对路径。";
    workspaceFilePathInput.focus();
    return;
  }

  workspaceFileOutput.textContent = "正在读取文件...";
  try {
    const query = new URLSearchParams({
      path: filePath
    });
    if (getWorkspaceDirValue()) {
      query.set("workspaceDir", getWorkspaceDirValue());
    }
    const response = await fetch(`/api/workspace/file?${query.toString()}`);
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    const file = payload.file || {};
    const suffix = file.truncated ? "\n\n[内容过长，已截断]" : "";
    workspaceFileOutput.textContent = `${file.content || ""}${suffix}`;
  } catch (error) {
    workspaceFileOutput.textContent = `读取文件失败：${error.message}`;
  }
}

async function pickWorkspaceFolder() {
  pickWorkspaceButton.disabled = true;
  setSaveStatus("正在打开文件夹选择器...", "neutral");

  try {
    const response = await fetch("/api/system/pick-folder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        currentDir: getWorkspaceDirValue()
      })
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    if (!payload.path) {
      setSaveStatus("未选择文件夹。", "neutral");
      return;
    }

    workspaceDirInput.value = payload.path;
    setSaveStatus("已选择工作区目录。点击“保存配置”即可持久化。", "ok");
    await loadWorkspaceSummary();
  } catch (error) {
    setSaveStatus(`选择文件夹失败：${error.message}`, "error");
  } finally {
    pickWorkspaceButton.disabled = false;
  }
}

async function importWorkspaceFiles() {
  const selectedFiles = Array.from(importWorkspaceFilesInput.files || []);
  if (!selectedFiles.length) {
    setSaveStatus("请先选择要导入的文件。", "error");
    importWorkspaceFilesInput.focus();
    return;
  }

  const workspaceDir = getWorkspaceDirValue();
  const targetDir = normalizeRelativeImportPath(workspaceImportTargetInput.value);
  importWorkspaceFilesButton.disabled = true;
  importWorkspaceFilesInput.disabled = true;
  setSaveStatus(`正在导入 ${selectedFiles.length} 个文件...`, "neutral");

  try {
    const files = await Promise.all(
      selectedFiles.map(async (file) => ({
        path: joinRelativePath(targetDir, file.webkitRelativePath || file.name),
        contentBase64: await fileToBase64(file)
      }))
    );

    const response = await fetch("/api/workspace/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceDir,
        files
      })
    });
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    const firstPath = payload.written?.[0]?.path || files[0]?.path || "";
    if (firstPath) {
      workspaceFilePathInput.value = firstPath;
      workspaceFileOutput.textContent = `已导入 ${payload.written.length} 个文件，正在预览 ${firstPath}...`;
    } else {
      workspaceFileOutput.textContent = "文件已导入。";
    }

    await loadWorkspaceSummary();
    if (firstPath) {
      await readWorkspaceFilePreview();
    }
    setSaveStatus(`已导入 ${payload.written.length} 个文件到工作区。`, "ok");
  } catch (error) {
    setSaveStatus(`导入文件失败：${error.message}`, "error");
    workspaceFileOutput.textContent = `导入文件失败：${error.message}`;
  } finally {
    importWorkspaceFilesButton.disabled = false;
    importWorkspaceFilesInput.disabled = false;
    importWorkspaceFilesInput.value = "";
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "readonly");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  document.body.append(scratch);
  scratch.select();
  document.execCommand("copy");
  scratch.remove();
}

async function loadBotPresets() {
  setBotConfigStatus("正在加载 Bot 预设...", "neutral");

  try {
    const response = await fetch("/api/bot/presets");
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    botUiState.presets = Array.isArray(payload.presets) ? payload.presets : [];
    botUiState.defaultInstallDir = botUiState.presets[0]?.defaultInstallDir || botUiState.defaultInstallDir;
    renderBotPresetList(Array.from(botUiState.enabledPresetIds));
    setBotConfigStatus(`已加载 ${botUiState.presets.length} 个 Bot 预设`, "ok");
  } catch (error) {
    botUiState.presets = [];
    renderBotPresetList([]);
    setBotConfigStatus(`Bot 预设加载失败：${error.message}`, "error");
  }
}

async function loadBotRuntimeStatus() {
  try {
    const response = await fetch("/api/bot/runtime");
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    botUiState.runtimeById = new Map(
      (payload.runtime?.bots || []).map((item) => [item.id, item])
    );

    const runningCount = (payload.runtime?.bots || []).filter((item) => item.status === "running").length;
    setBotConfigStatus(runningCount ? `已启动 ${runningCount} 个 Bot` : "Bot 连接器未启动", runningCount ? "ok" : "neutral");
    renderBotPresetList();
  } catch (error) {
    setBotConfigStatus(`读取 Bot 运行状态失败：${error.message}`, "error");
  }
}

async function ensureBotAutoStart() {
  try {
    const response = await fetch("/api/bot/runtime/ensure-auto-start", {
      method: "POST"
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    botUiState.runtimeById = new Map(
      (payload.snapshot?.bots || []).map((item) => [item.id, item])
    );
    renderBotPresetList();
  } catch (error) {
    setBotConfigStatus(`Bot 自动启动失败：${error.message}`, "error");
  }
}

async function copyBotCommand(commandText, label = "Bot 命令") {
  try {
    await copyTextToClipboard(commandText);
    setBotInstallOutput(commandText);
    setBotConfigStatus(`${label}已复制到剪贴板`, "ok");
  } catch (error) {
    setBotInstallOutput(commandText);
    setBotConfigStatus(`复制失败，请手动复制输出区内容：${error.message}`, "error");
  }
}

async function copySelectedBotCommands() {
  const enabledIds = Array.from(botUiState.enabledPresetIds);
  const presets = (enabledIds.length
    ? enabledIds.map((presetId) => getBotPresetById(presetId)).filter(Boolean)
    : botUiState.presets
  ).filter(Boolean);

  if (!presets.length) {
    setBotConfigStatus("没有可复制的 Bot 命令。", "error");
    return;
  }

  const joined = presets
    .map((preset) => `# ${preset.label}\n${preset.installCommand}`)
    .join("\n\n");
  await copyBotCommand(joined, `${presets.length} 条 Bot 命令`);
}

async function installBotPreset(presetId) {
  const preset = getBotPresetById(presetId);
  if (!preset) {
    setBotConfigStatus("未找到对应的 Bot 预设。", "error");
    return;
  }

  botUiState.installingPresetId = presetId;
  botUiState.installStatusById.set(presetId, {
    message: "安装中...",
    tone: "warning"
  });
  renderBotPresetList();
  setBotConfigStatus(`正在安装 ${preset.label}...`, "warning");
  setBotInstallOutput(`正在执行：${preset.installCommand}`);

  try {
    const response = await fetch("/api/bot/install", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceDir: getWorkspaceDirValue(),
        installDir: getBotInstallDirValue(),
        presetId
      })
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    botUiState.installStatusById.set(presetId, {
      message: "已安装",
      tone: "ok"
    });
    setBotInstallOutput(
      `目标目录：${payload.targetDir}\n命令：${payload.command}\n\n${payload.output || "(无输出)"}`
    );
    setBotConfigStatus(`${preset.label} 已安装到 ${payload.targetRelativeDir}`, "ok");
    await loadWorkspaceSummary();
    await loadBotRuntimeStatus();
  } catch (error) {
    botUiState.installStatusById.set(presetId, {
      message: "安装失败",
      tone: "error"
    });
    setBotInstallOutput(`安装失败：${error.message}`);
    setBotConfigStatus(`${preset.label} 安装失败：${error.message}`, "error");
  } finally {
    botUiState.installingPresetId = "";
    renderBotPresetList();
  }
}

async function runCustomBotInstall() {
  const command = botCustomCommandInput?.value.trim() || "";
  if (!command) {
    setBotConfigStatus("请先填写自定义安装命令。", "error");
    botCustomCommandInput?.focus();
    return;
  }

  runCustomBotInstallButton.disabled = true;
  setBotConfigStatus("正在执行自定义 Bot 命令...", "warning");
  setBotInstallOutput(`正在执行：${command}`);

  try {
    const response = await fetch("/api/bot/install-custom", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceDir: getWorkspaceDirValue(),
        installDir: getBotInstallDirValue(),
        command
      })
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    setBotInstallOutput(
      `目标目录：${payload.targetDir}\n命令：${payload.command}\n\n${payload.output || "(无输出)"}`
    );
    setBotConfigStatus(`自定义 Bot 命令已执行到 ${payload.targetRelativeDir}`, "ok");
    await loadWorkspaceSummary();
  } catch (error) {
    setBotInstallOutput(`自定义命令执行失败：${error.message}`);
    setBotConfigStatus(`自定义命令执行失败：${error.message}`, "error");
  } finally {
    runCustomBotInstallButton.disabled = false;
  }
}

async function startBotRuntime(botId = "") {
  const requestBody = botId ? { botId } : {};
  const button = botId ? null : startAllBotsButton;
  if (button) {
    button.disabled = true;
  }

  try {
    syncEnabledBotPresetIds();
    syncBotPresetConfigs();
    await saveSettings();

    const response = await fetch("/api/bot/runtime/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    botUiState.runtimeById = new Map(
      (payload.snapshot?.bots || []).map((item) => [item.id, item])
    );
    setBotConfigStatus(botId ? `${botId} 已启动` : "已启动默认 Bot 连接器", "ok");
    setBotInstallOutput(
      botId
        ? `已启动连接器：${botId}`
        : `已启动：${(payload.started || []).join(", ") || "默认 Bot 连接器"}`
    );
    renderBotPresetList();
  } catch (error) {
    setBotConfigStatus(`启动 Bot 失败：${error.message}`, "error");
    setBotInstallOutput(`启动 Bot 失败：${error.message}`);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function stopBotRuntime(botId = "") {
  const requestBody = botId ? { botId } : {};
  const button = botId ? null : stopAllBotsButton;
  if (button) {
    button.disabled = true;
  }

  try {
    const response = await fetch("/api/bot/runtime/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    botUiState.runtimeById = new Map(
      (payload.runtime?.bots || []).map((item) => [item.id, item])
    );
    setBotConfigStatus(botId ? `${botId} 已停止` : "已停止全部 Bot", "ok");
    setBotInstallOutput(botId ? `已停止连接器：${botId}` : "已停止全部 Bot 连接器。");
    renderBotPresetList();
  } catch (error) {
    setBotConfigStatus(`停止 Bot 失败：${error.message}`, "error");
    setBotInstallOutput(`停止 Bot 失败：${error.message}`);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function loadSettings() {
  setSaveStatus("正在读取本地配置...", "neutral");

  try {
    const response = await fetch("/api/settings");
    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    renderSettings(payload.settings);
    configHint.textContent = `配置文件：${payload.settingsPath}`;
    setSaveStatus("本地配置已加载。", "ok");
    await loadWorkspaceSummary();
    await ensureBotAutoStart();
    await loadBotRuntimeStatus();
    await runCurrentSchemeConnectivityTests({ force: true });
  } catch (error) {
    setSaveStatus(`加载配置失败：${error.message}`, "error");
  }
}

async function saveSettings() {
  saveButton.disabled = true;
  setSaveStatus("正在保存配置...", "neutral");

  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(collectSettingsPayload())
    });

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(payload.error);
    }

    renderSettings(payload.settings);
    configHint.textContent = `配置文件：${payload.settingsPath}`;
    setSaveStatus("配置已保存，API Key 已加密存储。若修改了端口，请重启程序后生效。", "ok");
    await loadWorkspaceSummary();
    await ensureBotAutoStart();
    await loadBotRuntimeStatus();
    await runCurrentSchemeConnectivityTests({ force: true });
  } catch (error) {
    setSaveStatus(`保存配置失败：${error.message}`, "error");
  } finally {
    saveButton.disabled = false;
  }
}

async function exitApplication() {
  if (exitAppButton) {
    exitAppButton.disabled = true;
  }
  if (saveButton) {
    saveButton.disabled = true;
  }
  if (reloadButton) {
    reloadButton.disabled = true;
  }
  if (runButton) {
    runButton.disabled = true;
  }
  if (cancelButton) {
    cancelButton.disabled = true;
  }

  if (currentClusterRequestController && !currentClusterRequestController.signal.aborted) {
    currentClusterRequestController.abort(new Error("Application exit requested."));
  }

  setSaveStatus("正在退出程序并清理后台进程...", "warning");
  setBotConfigStatus("正在退出程序...", "warning");
  runState.textContent = "退出中...";

  try {
    const response = await fetch("/api/system/exit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        reason: "User requested application exit."
      })
    });

    if (response.ok) {
      setSaveStatus("程序正在退出，Bot 子进程与本地服务会一并关闭。", "ok");
      setTimeout(() => {
        try {
          window.close();
        } catch {
          // Ignore browser close failures.
        }
      }, 250);
      return;
    }

    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    setSaveStatus(`退出程序失败：${error.message}`, "error");
    setBotConfigStatus(`退出程序失败：${error.message}`, "error");
    runState.textContent = "退出失败";

    if (exitAppButton) {
      exitAppButton.disabled = false;
    }
    if (saveButton) {
      saveButton.disabled = false;
    }
    if (reloadButton) {
      reloadButton.disabled = false;
    }
    if (runButton) {
      runButton.disabled = false;
    }
    if (cancelButton) {
      cancelButton.disabled = !currentOperationId;
    }
  }
}

async function runCluster() {
  setActiveConsolePanel("run");
  const task = taskInput.value.trim();
  if (!task) {
    runState.textContent = "需填写任务";
    taskInput.focus();
    return;
  }

  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();
  if (!currentScheme?.id) {
    runState.textContent = "缺少方案";
    setSaveStatus("请先配置至少一个可运行方案。", "error");
    return;
  }

  const operationId = createOperationId("cluster");
  resetLiveFeed();
  resetAgentGraph();
  agentGraphState.operationId = operationId;
  beginOperation(operationId, (event) => {
    updateAgentGraphFromEvent(event);
    appendLiveEvent(event);
    setRunStateFromEvent(event);
  });

  runButton.disabled = true;
  if (cancelButton) {
    cancelButton.disabled = false;
  }
  runState.textContent = "启动中";
  planOutput.textContent = "主控模型正在规划...";
  workerOutput.innerHTML = '<p class="placeholder">工作模型等待任务分配...</p>';
  synthesisOutput.innerHTML = '<p class="placeholder">等待主控模型汇总...</p>';
  const requestController = new AbortController();
  currentClusterRequestController = requestController;

  try {
    const response = await fetch("/api/cluster/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ task, operationId, schemeId: currentScheme.id }),
      signal: requestController.signal
    });

    const payload = await response.json();
    if (!payload.ok) {
      if (payload.cancelled) {
        planOutput.textContent = `任务已终止：${payload.error || "运行已被手动取消。"}`;
        workerOutput.innerHTML = '<p class="placeholder">任务已终止，未继续执行剩余工作模型。</p>';
        synthesisOutput.innerHTML = `<p class="placeholder">任务已终止：${escapeHtml(payload.error || "运行已被手动取消。")}</p>`;
        runState.textContent = "已终止";
        return;
      }
      throw new Error(payload.error);
    }

    renderPlan(payload.plan);
    renderWorkers(payload.executions);
    renderSynthesis(payload.synthesis, payload.timings);
    runState.textContent = "已完成";
  } catch (error) {
    if (requestController.signal.aborted) {
      return;
    }

    planOutput.textContent = `执行失败：${error.message}`;
    workerOutput.innerHTML = '<p class="placeholder">未生成工作模型结果。</p>';
    synthesisOutput.innerHTML = `<p class="error">执行失败：${escapeHtml(error.message)}</p>`;
    runState.textContent = "失败";
    appendLiveEvent({
      timestamp: new Date().toISOString(),
      tone: "error",
      stage: "cluster_failed",
      detail: error.message
    });
  } finally {
    if (currentClusterRequestController === requestController) {
      currentClusterRequestController = null;
    }

    if (!requestController.signal.aborted) {
      runButton.disabled = false;
      finishOperation();
    }
  }
}

async function cancelClusterRun() {
  if (!currentOperationId) {
    return;
  }

  if (cancelButton) {
    cancelButton.disabled = true;
  }
  runState.textContent = "终止中...";

  if (currentClusterRequestController && !currentClusterRequestController.signal.aborted) {
    currentClusterRequestController.abort(new Error("Cluster run cancelled locally."));
  }

  const localCancelEvent = {
    timestamp: new Date().toISOString(),
    tone: "warning",
    stage: "cancel_requested",
    detail: "已立即终止本地等待，正在请求后端停止任务。",
    ...resolveControllerEventMeta()
  };
  updateAgentGraphFromEvent(localCancelEvent);
  appendLiveEvent(localCancelEvent);
  renderClusterCancelledState("已立即终止当前任务，正在清理远端请求。");

  try {
    const operationId = currentOperationId;
    await requestOperationCancellation(operationId);

    const cancelledEvent = {
      timestamp: new Date().toISOString(),
      tone: "warning",
      stage: "cluster_cancelled",
      detail: "任务已立即终止，并已通知后端停止当前请求。",
      ...resolveControllerEventMeta()
    };
    updateAgentGraphFromEvent(cancelledEvent);
    appendLiveEvent(cancelledEvent);
    renderClusterCancelledState("任务已立即终止，并已通知后端停止当前请求。");
    runButton.disabled = false;
    finishOperation();
  } catch (error) {
    if (cancelButton) {
      cancelButton.disabled = false;
    }
    renderClusterCancelledState("本地等待已停止，但后端终止请求失败，请再次点击“终止任务”。");
    appendLiveEvent({
      timestamp: new Date().toISOString(),
      tone: "error",
      stage: "cluster_failed",
      detail: `终止任务失败：${error.message}`
    });
    runState.textContent = "终止失败";
  }
}

function formatModelTestRetryStatus(event) {
  return `重试中（第 ${event.attempt}/${event.maxRetries} 次，${formatDelay(event.nextDelayMs)} 后重试）`;
}

async function runModelConnectivityTest(model, hooks = {}) {
  const secrets = hooks.secrets || collectSecrets();
  const operationId = createOperationId("model_test");
  const stream = openOperationStream(operationId, (event) => {
    hooks.onEvent?.(event);
  });

  try {
    const response = await fetch("/api/model/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        operationId,
        model,
        secrets
      })
    });

    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    return payload;
  } finally {
    setTimeout(() => stream.close(), 300);
  }
}

async function testSingleModelLegacy(card) {
  const button = card.querySelector("[data-model-test]");
  const model = collectModelFromCard(card);

  button.disabled = true;
  setModelTestStatus(card, "测试中...", "testing");

  try {
    const payload = await runModelConnectivityTest(model, {
      secrets: collectSecrets(),
      onEvent(event) {
        if (event.stage === "submitted") {
          setModelTestStatus(card, "已提交测试请求...", "testing");
          return;
        }

        if (event.stage === "model_test_retry") {
          setModelTestStatus(card, formatModelTestRetryStatus(event), "testing");
          return;
        }

        if (event.stage === "model_test_failed") {
          setModelTestStatus(card, `连接失败：${event.detail || "未知错误"}`, "error");
        }
      }
    });
    const summary = payload.summary ? `（${payload.summary}）` : "";
    const reply = payload.reply ? `，基础返回：${payload.reply}` : "";
    const detail = `可用${summary}${reply}`;
    setModelTestStatus(card, detail, "ok");
    const currentScheme = getCurrentScheme();
    if (currentScheme?.id) {
      updateSchemeConnectivityEntry(currentScheme.id, model.id, {
        tone: "ok",
        status: "可用",
        detail
      });
      renderSchemeConnectivityList();
    }
  } catch (error) {
    const detail = `连接失败：${error.message}`;
    setModelTestStatus(card, detail, "error");
    const currentScheme = getCurrentScheme();
    if (currentScheme?.id) {
      updateSchemeConnectivityEntry(currentScheme.id, model.id, {
        tone: "error",
        status: "失败",
        detail
      });
      renderSchemeConnectivityList();
    }
  } finally {
    button.disabled = false;
  }
}

async function runCurrentSchemeConnectivityTestsLegacy(options = {}) {
  const { force = false } = options;
  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();
  if (!currentScheme?.id) {
    renderSchemeConnectivityList();
    return;
  }

  const existingState = ensureSchemeConnectivityState(currentScheme.id, currentScheme.models);
  const shouldSkip =
    !force &&
    existingState.results.length === currentScheme.models.length &&
    existingState.results.every((item) => item.status && item.status !== "未测试" && item.status !== "检测中");
  if (shouldSkip) {
    renderSchemeConnectivityList();
    return;
  }

  const runToken = Date.now();
  schemeUiState.connectivityRunToken = runToken;
  const secrets = collectSecrets();
  const total = currentScheme.models.length;
  if (!total) {
    schemeUiState.connectivityBySchemeId.set(currentScheme.id, {
      tone: "neutral",
      message: "当前方案没有模型",
      results: []
    });
    renderSchemeConnectivityList();
    return;
  }

  schemeUiState.connectivityBySchemeId.set(currentScheme.id, {
    tone: "warning",
    message: `检测中 0/${total}`,
    results: currentScheme.models.map((model) => ({
      id: model.id || "",
      label: model.label || model.id || "未命名模型",
      tone: "testing",
      status: "排队中",
      detail: "等待开始检测。"
    }))
  });
  renderSchemeConnectivityList();
  applyStoredConnectivityToVisibleModelCards();
  if (schemeConnectivityRetestButton) {
    schemeConnectivityRetestButton.disabled = true;
  }

  let completed = 0;
  let passed = 0;

  try {
    for (const model of currentScheme.models) {
      if (schemeUiState.connectivityRunToken !== runToken) {
        return;
      }

      updateSchemeConnectivityEntry(currentScheme.id, model.id, {
        tone: "testing",
        status: "检测中",
        detail: "正在发送连接测试请求..."
      });
      renderSchemeConnectivityList();
      applyStoredConnectivityToVisibleModelCards();

      try {
        const payload = await runModelConnectivityTest(model, {
          secrets,
          onEvent(event) {
            if (schemeUiState.connectivityRunToken !== runToken) {
              return;
            }

            if (event.stage === "model_test_retry") {
              updateSchemeConnectivityEntry(currentScheme.id, model.id, {
                tone: "testing",
                status: "重试中",
                detail: formatModelTestRetryStatus(event)
              });
              renderSchemeConnectivityList();
              applyStoredConnectivityToVisibleModelCards();
            }
          }
        });
        const summary = payload.summary ? `（${payload.summary}）` : "";
        const reply = payload.reply ? `，基础返回：${payload.reply}` : "";
        updateSchemeConnectivityEntry(currentScheme.id, model.id, {
          tone: "ok",
          status: "可用",
          detail: `可用${summary}${reply}`
        });
        passed += 1;
      } catch (error) {
        updateSchemeConnectivityEntry(currentScheme.id, model.id, {
          tone: "error",
          status: "失败",
          detail: `连接失败：${error.message}`
        });
      }

      completed += 1;
      const tone = completed === total && passed === total ? "ok" : completed === total ? "warning" : "warning";
      const message =
        completed === total
          ? `检测完成 ${passed}/${total} 可用`
          : `检测中 ${completed}/${total}`;
      const nextState = ensureSchemeConnectivityState(currentScheme.id, currentScheme.models);
      schemeUiState.connectivityBySchemeId.set(currentScheme.id, {
        ...nextState,
        tone,
        message
      });
      renderSchemeConnectivityList();
      applyStoredConnectivityToVisibleModelCards();
    }
  } finally {
    if (schemeUiState.connectivityRunToken === runToken && schemeConnectivityRetestButton) {
      schemeConnectivityRetestButton.disabled = false;
    }
  }
}

function syncSchemeConnectivitySummaryState(schemeId) {
  const scheme = schemeUiState.schemes.find((item) => item.id === schemeId);
  const state = ensureSchemeConnectivityState(schemeId, scheme?.models || []);
  const summary = buildConnectivitySummaryMessage(state.results);
  const next = {
    ...state,
    tone: summary.tone,
    message: summary.message
  };
  schemeUiState.connectivityBySchemeId.set(schemeId, next);
  return next;
}

function renderSchemeConnectivityList() {
  if (!schemeConnectivityList || !schemeConnectivityStatus) {
    return;
  }

  const currentScheme = getCurrentScheme();
  if (!currentScheme) {
    schemeConnectivityStatus.textContent = "无方案";
    schemeConnectivityStatus.dataset.tone = "neutral";
    schemeConnectivityList.innerHTML = "<p class=\"placeholder\">请先添加至少一个方案。</p>";
    return;
  }

  const state = syncSchemeConnectivitySummaryState(currentScheme.id);
  const summary = buildConnectivitySummaryMessage(state.results);
  const modelById = new Map((currentScheme.models || []).map((model) => [model.id, model]));
  const sortedResults = sortConnectivityResults(state.results);
  const progressPercent = summary.counts.total
    ? Math.round((summary.counts.completed / summary.counts.total) * 100)
    : 0;
  const overviewCards = [
    { label: "总数", value: summary.counts.total, tone: "neutral" },
    { label: "可用", value: summary.counts.available, tone: "ok" },
    { label: "降级", value: summary.counts.warning, tone: "warning" },
    { label: "失败", value: summary.counts.error, tone: "error" },
    { label: "检测中", value: summary.counts.testing, tone: "testing" }
  ];

  schemeConnectivityStatus.textContent = summary.message || "等待检测";
  schemeConnectivityStatus.dataset.tone = summary.tone || "neutral";

  if (!sortedResults.length) {
    schemeConnectivityList.innerHTML = "<p class=\"placeholder\">当前方案还没有可检测的模型。</p>";
    return;
  }

  schemeConnectivityList.innerHTML = [
    '<section class="scheme-connectivity-overview">',
    '  <div class="scheme-connectivity-progress">',
    `    <div class="scheme-connectivity-progress-bar" aria-hidden="true"><span style="width:${progressPercent}%"></span></div>`,
    `    <p class="scheme-connectivity-progress-copy">${escapeHtml(summary.message || "等待检测")}</p>`,
    "  </div>",
    '  <div class="scheme-connectivity-stats">',
    overviewCards
      .map(
        (item) =>
          `<span class="scheme-connectivity-stat" data-tone="${escapeAttribute(item.tone)}">${escapeHtml(item.label)} ${escapeHtml(item.value)}</span>`
      )
      .join(""),
    "  </div>",
    "</section>",
    '<section class="scheme-connectivity-results">',
    sortedResults
      .map((result) => {
        const model = modelById.get(result.id) || {};
        const meta = [model.provider, model.model].filter(Boolean).join(" / ");
        return [
          `<article class="scheme-connectivity-row" data-tone="${escapeAttribute(result.tone || "neutral")}">`,
          '  <div class="scheme-connectivity-head">',
          '    <div class="scheme-connectivity-title">',
          `      <strong>${escapeHtml(result.label || result.id || "未命名模型")}</strong>`,
          `      <span class="scheme-connectivity-meta">${escapeHtml(meta || result.id || "")}</span>`,
          "    </div>",
          `    <span class="chip" data-tone="${escapeAttribute(result.tone || "neutral")}">${escapeHtml(result.status || "未测试")}</span>`,
          "  </div>",
          `  <p class="scheme-connectivity-copy">${escapeHtml(result.detail || "等待连接测试结果。")}</p>`,
          "</article>"
        ].join("");
      })
      .join(""),
    "</section>"
  ].join("");
}

async function testSingleModel(card) {
  const button = card.querySelector("[data-model-test]");
  const model = collectModelFromCard(card);

  button.disabled = true;
  setModelTestStatus(card, "测试中...", "testing");

  try {
    const payload = await runModelConnectivityTest(model, {
      secrets: collectSecrets(),
      onEvent(event) {
        if (event.stage === "submitted") {
          setModelTestStatus(card, "已提交测试请求...", "testing");
          return;
        }

        if (event.stage === "model_test_retry") {
          setModelTestStatus(card, formatModelTestRetryStatus(event), "testing");
          return;
        }

        if (event.stage === "model_test_failed") {
          setModelTestStatus(card, `连接失败：${event.detail || "未知错误"}`, "error");
        }
      }
    });
    const display = buildConnectivityDisplay(payload);
    setModelTestStatus(card, display.detail || display.status, display.tone);
    const currentScheme = getCurrentScheme();
    if (currentScheme?.id) {
      updateSchemeConnectivityEntry(currentScheme.id, model.id, display);
      renderSchemeConnectivityList();
    }
  } catch (error) {
    const detail = `连接失败：${error.message}`;
    setModelTestStatus(card, detail, "error");
    const currentScheme = getCurrentScheme();
    if (currentScheme?.id) {
      updateSchemeConnectivityEntry(currentScheme.id, model.id, {
        tone: "error",
        status: "失败",
        detail
      });
      renderSchemeConnectivityList();
    }
  } finally {
    button.disabled = false;
  }
}

async function runCurrentSchemeConnectivityTests(options = {}) {
  const { force = false } = options;
  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();
  if (!currentScheme?.id) {
    renderSchemeConnectivityList();
    return;
  }

  const existingState = ensureSchemeConnectivityState(currentScheme.id, currentScheme.models);
  const shouldSkip =
    !force &&
    existingState.results.length === currentScheme.models.length &&
    existingState.results.every(
      (item) =>
        item.status &&
        item.status !== "未测试" &&
        item.status !== "检测中" &&
        item.status !== "排队中"
    );
  if (shouldSkip) {
    renderSchemeConnectivityList();
    return;
  }

  const runToken = Date.now();
  schemeUiState.connectivityRunToken = runToken;
  const secrets = collectSecrets();
  const total = currentScheme.models.length;

  if (!total) {
    schemeUiState.connectivityBySchemeId.set(currentScheme.id, {
      tone: "neutral",
      message: "当前方案没有模型",
      results: []
    });
    renderSchemeConnectivityList();
    return;
  }

  const initialResults = currentScheme.models.map((model) => ({
    id: model.id || "",
    label: model.label || model.id || "未命名模型",
    tone: "testing",
    status: "检测中",
    detail: "正在发送连接测试请求..."
  }));
  schemeUiState.connectivityBySchemeId.set(currentScheme.id, {
    tone: "testing",
    message: `并发检测中 0/${total}`,
    results: initialResults
  });
  renderSchemeConnectivityList();
  applyStoredConnectivityToVisibleModelCards();
  if (schemeConnectivityRetestButton) {
    schemeConnectivityRetestButton.disabled = true;
  }

  try {
    await Promise.allSettled(
      currentScheme.models.map(async (model) => {
        if (schemeUiState.connectivityRunToken !== runToken) {
          return;
        }

        updateSchemeConnectivityEntry(currentScheme.id, model.id, {
          tone: "testing",
          status: "检测中",
          detail: "正在发送连接测试请求..."
        });
        renderSchemeConnectivityList();
        applyStoredConnectivityToVisibleModelCards();

        try {
          const payload = await runModelConnectivityTest(model, {
            secrets,
            onEvent(event) {
              if (schemeUiState.connectivityRunToken !== runToken) {
                return;
              }

              if (event.stage === "model_test_retry") {
                updateSchemeConnectivityEntry(currentScheme.id, model.id, {
                  tone: "testing",
                  status: "重试中",
                  detail: formatModelTestRetryStatus(event)
                });
                renderSchemeConnectivityList();
                applyStoredConnectivityToVisibleModelCards();
              }
            }
          });

          if (schemeUiState.connectivityRunToken !== runToken) {
            return;
          }

          updateSchemeConnectivityEntry(currentScheme.id, model.id, buildConnectivityDisplay(payload));
        } catch (error) {
          if (schemeUiState.connectivityRunToken !== runToken) {
            return;
          }

          updateSchemeConnectivityEntry(currentScheme.id, model.id, {
            tone: "error",
            status: "失败",
            detail: `连接失败：${error.message}`
          });
        }

        if (schemeUiState.connectivityRunToken !== runToken) {
          return;
        }

        syncSchemeConnectivitySummaryState(currentScheme.id);
        renderSchemeConnectivityList();
        applyStoredConnectivityToVisibleModelCards();
      })
    );
  } finally {
    if (schemeUiState.connectivityRunToken === runToken) {
      syncSchemeConnectivitySummaryState(currentScheme.id);
      renderSchemeConnectivityList();
      applyStoredConnectivityToVisibleModelCards();
    }
    if (schemeUiState.connectivityRunToken === runToken && schemeConnectivityRetestButton) {
      schemeConnectivityRetestButton.disabled = false;
    }
  }
}

consoleNav?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-console-nav]");
  if (!button) {
    return;
  }

  setActiveConsolePanel(button.dataset.consoleNav || DEFAULT_CONSOLE_PANEL_ID);
});

secretList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-secret-remove]");
  if (!button) {
    return;
  }

  button.closest(".secret-row")?.remove();
});

modelList.addEventListener("click", (event) => {
  const testButton = event.target.closest("[data-model-test]");
  if (testButton) {
    const card = testButton.closest(".model-card");
    if (card) {
      testSingleModel(card);
    }
    return;
  }

  const removeButton = event.target.closest("[data-model-remove]");
  if (!removeButton) {
    return;
  }

  removeButton.closest(".model-card")?.remove();
  updateControllerOptions();
  captureCurrentSchemeDraft();
  renderSchemeConnectivityList();
});

modelList.addEventListener("input", (event) => {
  const card = event.target.closest(".model-card");
  if (!card) {
    return;
  }

  updateModelCardTitle(card);
  updateControllerOptions();
  setModelTestStatus(card, "未测试");
  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();
  const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
  if (currentScheme?.id && modelId) {
    updateSchemeConnectivityEntry(currentScheme.id, modelId, {
      tone: "neutral",
      status: "未测试",
      detail: "配置已修改，请重新检测。"
    });
  }
  renderSchemeConnectivityList();
});

modelList.addEventListener("change", (event) => {
  const card = event.target.closest(".model-card");
  if (!card) {
    return;
  }

  updateModelCardFields(card, { applyDefaults: true });
  updateControllerOptions();
  setModelTestStatus(card, "未测试");
  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();
  const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
  if (currentScheme?.id && modelId) {
    updateSchemeConnectivityEntry(currentScheme.id, modelId, {
      tone: "neutral",
      status: "未测试",
      detail: "配置已修改，请重新检测。"
    });
  }
  renderSchemeConnectivityList();
});

schemeSelect?.addEventListener("change", async (event) => {
  switchCurrentScheme(event.target.value);
  await runCurrentSchemeConnectivityTests();
});

schemeNameInput?.addEventListener("input", () => {
  const currentScheme = getCurrentScheme();
  if (!currentScheme) {
    return;
  }

  currentScheme.label = schemeNameInput.value.trim() || currentScheme.label || currentScheme.id;
  renderSchemeControls();
});

addSchemeButton?.addEventListener("click", () => {
  addSchemeDraft();
  setSaveStatus("已新增方案，可继续编辑该方案的模型。", "ok");
});

removeSchemeButton?.addEventListener("click", () => {
  removeCurrentSchemeDraft();
});

controllerSelect?.addEventListener("change", () => {
  const currentScheme = getCurrentScheme();
  if (!currentScheme) {
    return;
  }

  currentScheme.controller = controllerSelect.value;
});

schemeConnectivityRetestButton?.addEventListener("click", async () => {
  await runCurrentSchemeConnectivityTests({ force: true });
});

addSecretButton.addEventListener("click", () => {
  secretList.append(createSecretRow());
});

addModelButton.addEventListener("click", () => {
  modelList.append(
    createModelCard({
      id: "",
      label: "",
      provider: DEFAULT_PROVIDER_ID,
      model: "",
      baseUrl: "",
      apiKeyEnv: "",
      apiKeyValue: "",
      authStyle: "bearer",
      apiKeyHeader: "",
      reasoningEffort: "",
      webSearch: false,
      temperature: "",
      specialties: []
    })
  );
  updateControllerOptions();
  captureCurrentSchemeDraft();
  renderSchemeConnectivityList();
});

batchAddButton.addEventListener("click", batchAddModels);
batchProviderSelect.addEventListener("change", () => updateBatchFields({ applyDefaults: true }));
batchAuthStyleSelect.addEventListener("change", updateBatchFields);
batchKeysList?.addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-batch-key-add]");
  if (addButton) {
    const currentRow = addButton.closest(".batch-key-row");
    const nextRow = createBatchKeyRow();
    currentRow?.insertAdjacentElement("afterend", nextRow);
    updateBatchKeyRowStates();
    nextRow.querySelector("[data-batch-key-input]")?.focus();
    return;
  }

  const removeButton = event.target.closest("[data-batch-key-remove]");
  if (!removeButton) {
    return;
  }

  const rows = getBatchKeyRows();
  const currentRow = removeButton.closest(".batch-key-row");
  if (!currentRow) {
    return;
  }

  if (rows.length === 1) {
    currentRow.querySelector("[data-batch-key-input]")?.focus();
    return;
  }

  const fallbackRow = currentRow.previousElementSibling || currentRow.nextElementSibling;
  currentRow.remove();
  updateBatchKeyRowStates();
  fallbackRow?.querySelector?.("[data-batch-key-input]")?.focus();
});
batchKeysList?.addEventListener("paste", (event) => {
  const input = event.target.closest("[data-batch-key-input]");
  if (!input) {
    return;
  }

  const pastedText = event.clipboardData?.getData("text") || "";
  if (!/[\r\n]/.test(pastedText)) {
    return;
  }

  const values = pastedText
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!values.length) {
    return;
  }

  event.preventDefault();
  setBatchKeyRows(values);
  getBatchKeyInputs()[Math.max(0, values.length - 1)]?.focus();
});
botPresetList?.addEventListener("change", (event) => {
  if (event.target.closest("[data-bot-enabled]")) {
    syncEnabledBotPresetIds();
    return;
  }
  if (event.target.closest("[data-bot-field]")) {
    syncBotSecretValuesFromDom(event.target);
    return;
  }
  if (event.target.closest("[data-bot-env]")) {
    syncBotPresetConfigs();
  }
});
botPresetList?.addEventListener("input", (event) => {
  if (event.target.closest("[data-bot-field]")) {
    syncBotSecretValuesFromDom(event.target);
    return;
  }
  if (event.target.closest("[data-bot-env]")) {
    syncBotPresetConfigs();
  }
});
botPresetList?.addEventListener("click", async (event) => {
  const installButton = event.target.closest("[data-bot-install]");
  if (installButton) {
    const presetId = installButton.closest("[data-preset-id]")?.dataset.presetId || "";
    await installBotPreset(presetId);
    return;
  }

  const startButton = event.target.closest("[data-bot-start]");
  if (startButton) {
    const presetId = startButton.closest("[data-preset-id]")?.dataset.presetId || "";
    await startBotRuntime(presetId);
    return;
  }

  const stopButton = event.target.closest("[data-bot-stop]");
  if (stopButton) {
    const presetId = stopButton.closest("[data-preset-id]")?.dataset.presetId || "";
    await stopBotRuntime(presetId);
    return;
  }

  const copyButton = event.target.closest("[data-bot-copy]");
  if (copyButton) {
    const presetId = copyButton.closest("[data-preset-id]")?.dataset.presetId || "";
    const preset = getBotPresetById(presetId);
    if (preset?.installCommand) {
      await copyBotCommand(preset.installCommand, `${preset.label} 命令`);
    }
    return;
  }

  const docsButton = event.target.closest("[data-bot-docs]");
  if (!docsButton) {
    return;
  }

  const presetId = docsButton.closest("[data-preset-id]")?.dataset.presetId || "";
  const preset = getBotPresetById(presetId);
  if (preset?.docsUrl) {
    window.open(preset.docsUrl, "_blank", "noopener,noreferrer");
  }
});
pickWorkspaceButton.addEventListener("click", pickWorkspaceFolder);
refreshWorkspaceButton.addEventListener("click", loadWorkspaceSummary);
importWorkspaceFilesButton.addEventListener("click", importWorkspaceFiles);
readWorkspaceFileButton.addEventListener("click", readWorkspaceFilePreview);
saveButton.addEventListener("click", saveSettings);
reloadButton.addEventListener("click", loadSettings);
exitAppButton?.addEventListener("click", exitApplication);
runButton.addEventListener("click", runCluster);
cancelButton?.addEventListener("click", cancelClusterRun);
runCustomBotInstallButton?.addEventListener("click", runCustomBotInstall);
copyBotCommandsButton?.addEventListener("click", copySelectedBotCommands);
startAllBotsButton?.addEventListener("click", () => startBotRuntime());
stopAllBotsButton?.addEventListener("click", () => stopBotRuntime());
refreshBotRuntimeButton?.addEventListener("click", loadBotRuntimeStatus);
saveStatusClose?.addEventListener("click", hideSaveToast);

async function initializeApp() {
  restoreConsolePanel();
  try {
    await loadBotPresets();
  } finally {
    await loadSettings();
  }
}

populateProviderSelect(batchProviderSelect, DEFAULT_PROVIDER_ID);
setBatchKeyRows([""]);
updateBatchFields({ applyDefaults: true });
bindAgentVizInteractions();
renderCapabilityOptions(batchCapabilityList, []);
if (cancelButton) {
  cancelButton.disabled = true;
}
resetAgentGraph();
initializeApp();

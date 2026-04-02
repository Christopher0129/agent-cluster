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
import { createBotUi } from "./bot-ui.js";
import { createConnectivityUi } from "./connectivity-ui.js";
import { describeOperationEvent as describeOperationEventMessage } from "./operation-events.js";
import { createRunConsoleUi } from "./run-console-ui.js";
import { createWorkspaceUi } from "./workspace-ui.js";

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
const traceOutput = document.querySelector("#traceOutput");
const sessionOutput = document.querySelector("#sessionOutput");
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
const traceUiState = {
  spans: new Map(),
  session: null
};
const runConsoleUi = createRunConsoleUi({
  workerOutput,
  traceOutput,
  sessionOutput,
  traceUiState,
  escapeHtml,
  escapeAttribute,
  renderList
});
const workspaceUi = createWorkspaceUi({
  elements: {
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
  },
  setSaveStatus
});
const botUi = createBotUi({
  state: botUiState,
  elements: {
    botConfigStatus,
    botInstallDirInput,
    botCommandPrefixInput,
    botAutoStartInput,
    botProgressUpdatesInput,
    botCustomCommandInput,
    botPresetList,
    botInstallOutput,
    startAllBotsButton,
    stopAllBotsButton,
    refreshBotRuntimeButton,
    runCustomBotInstallButton,
    copyBotCommandsButton
  },
  escapeHtml,
  escapeAttribute,
  normalizeStringList,
  formatTimestamp,
  getWorkspaceDirValue: workspaceUi.getDirValue,
  loadWorkspaceSummary: workspaceUi.loadSummary,
  saveSettings
});
const connectivityUi = createConnectivityUi({
  state: schemeUiState,
  elements: {
    schemeConnectivityStatus,
    schemeConnectivityList,
    schemeConnectivityRetestButton,
    modelList
  },
  escapeHtml,
  escapeAttribute,
  getCurrentScheme,
  setModelTestStatus,
  collectSecrets,
  collectModelFromCard,
  runModelConnectivityTest,
  formatModelTestRetryStatus
});

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

function collectSettingsPayload() {
  captureCurrentSchemeDraft();
  const currentScheme = getCurrentScheme();
  const botSettings = botUi.collectSettings();

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
    workspace: workspaceUi.collectSettings(),
    bot: botSettings,
    secrets: mergeSecretEntries(collectSecrets(), botUi.collectSecretEntries()),
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
  workspaceUi.applySettings(settings.workspace || {});
  botUi.applySettings(settings.bot || {}, settings.secrets || []);

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
  for (const secret of botUi.filterVisibleSharedSecrets(settings.secrets || [])) {
    secretList.append(createSecretRow(secret));
  }
  if (!secretList.children.length) {
    secretList.append(createSecretRow({ name: "OPENAI_API_KEY", value: "" }));
  }

  renderSchemeControls();
  renderCurrentSchemeModels();
}

function renderPlan(plan) {
  planOutput.textContent = JSON.stringify(plan, null, 2);
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
    appendAgentNote(controller.id, event.planStrategy || event.detail || describeOperationEventMessage(event, { formatDelay }), timestamp);

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
      agent.action = describeOperationEventMessage(event, { formatDelay });
      break;
    default:
      break;
  }

  appendAgentNote(agent.id, event.thinkingSummary || event.detail || describeOperationEventMessage(event, { formatDelay }), timestamp);
  renderAgentGraph();
}

function getWorkspaceDirValue() {
  return workspaceUi.getDirValue();
}

function appendLiveEvent(event) {
  if (event.stage === "session_update" || String(event.stage || "").startsWith("trace_")) {
    return;
  }

  if (liveOutput.querySelector(".placeholder")) {
    liveOutput.innerHTML = "";
  }

  const item = document.createElement("article");
  item.className = "feed-item";
  item.dataset.tone = event.tone || "neutral";
  item.innerHTML = `
    <div class="feed-time">${escapeHtml(formatTimestamp(event.timestamp) || "--:--:--")}</div>
    <div class="feed-message">${escapeHtml(describeOperationEventMessage(event, { formatDelay }))}</div>
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
  return workspaceUi.loadSummary();
}

async function readWorkspaceFilePreview() {
  return workspaceUi.readFilePreview();
}

async function pickWorkspaceFolder() {
  return workspaceUi.pickFolder();
}

async function importWorkspaceFiles() {
  return workspaceUi.importFiles();
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
    await workspaceUi.loadSummary();
    await botUi.ensureAutoStart();
    await botUi.loadRuntimeStatus();
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
    await workspaceUi.loadSummary();
    await botUi.ensureAutoStart();
    await botUi.loadRuntimeStatus();
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
  runConsoleUi.resetTracePanels();
  agentGraphState.operationId = operationId;
  beginOperation(operationId, (event) => {
    updateAgentGraphFromEvent(event);
    runConsoleUi.updateTraceStateFromEvent(event);
    runConsoleUi.updateSessionStateFromEvent(event);
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
    runConsoleUi.renderWorkers(payload.executions);
    renderSynthesis(payload.synthesis, payload.timings);
    if (payload.session) {
      runConsoleUi.updateSessionStateFromEvent({
        stage: "cluster_done",
        session: payload.session
      });
    }
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

function ensureSchemeConnectivityState(schemeId, models = []) {
  return connectivityUi.ensureState(schemeId, models);
}

function updateSchemeConnectivityEntry(schemeId, modelId, patch = {}) {
  return connectivityUi.updateEntry(schemeId, modelId, patch);
}

function renderSchemeConnectivityList() {
  return connectivityUi.renderList();
}

function applyStoredConnectivityToVisibleModelCards() {
  return connectivityUi.applyStoredStatusesToVisibleCards();
}

async function testSingleModel(card) {
  return connectivityUi.testSingleModel(card);
}

async function runCurrentSchemeConnectivityTests(options = {}) {
  captureCurrentSchemeDraft();
  return connectivityUi.runCurrentSchemeConnectivityTests(options);
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
  setModelTestStatus(card, "???");
  captureCurrentSchemeDraft();
  const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
  connectivityUi.markModelDirty(modelId);
});
modelList.addEventListener("change", (event) => {
  const card = event.target.closest(".model-card");
  if (!card) {
    return;
  }
  updateModelCardFields(card, { applyDefaults: true });
  updateControllerOptions();
  setModelTestStatus(card, "???");
  captureCurrentSchemeDraft();
  const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
  connectivityUi.markModelDirty(modelId);
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
saveButton.addEventListener("click", saveSettings);
reloadButton.addEventListener("click", loadSettings);
exitAppButton?.addEventListener("click", exitApplication);
runButton.addEventListener("click", runCluster);
cancelButton?.addEventListener("click", cancelClusterRun);
saveStatusClose?.addEventListener("click", hideSaveToast);

async function initializeApp() {
  restoreConsolePanel();
  try {
    await botUi.loadPresets();
  } finally {
    await loadSettings();
  }
}

populateProviderSelect(batchProviderSelect, DEFAULT_PROVIDER_ID);
setBatchKeyRows([""]);
updateBatchFields({ applyDefaults: true });
bindAgentVizInteractions();
renderCapabilityOptions(batchCapabilityList, []);
workspaceUi.bindEvents();
botUi.bindEvents();
if (cancelButton) {
  cancelButton.disabled = true;
}
resetAgentGraph();
initializeApp();

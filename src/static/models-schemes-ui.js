import {
  DEFAULT_PROVIDER_ID,
  getProviderDefinition,
  listProviderDefinitions,
  providerSupportsCapability
} from "./provider-catalog.js";

function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function resolveRuntimeLocale() {
  if (
    typeof document !== "undefined" &&
    String(document.documentElement?.lang || "").toLowerCase().startsWith("en")
  ) {
    return "en-US";
  }
  return "zh-CN";
}

function createFallbackTranslator() {
  const catalog = {
    "zh-CN": {
      "capability.controller": "主控",
      "capability.research": "调研",
      "capability.implementation": "实现",
      "capability.coding_manager": "编码管理",
      "capability.validation": "验证",
      "capability.handoff": "交付",
      "capability.general": "通用",
      "model.untested": "未测试",
      "model.new": "新模型",
      "model.untitled": "未命名模型",
      "scheme.default": "GPT 方案",
      "scheme.untitled": "未命名方案",
      "scheme.none": "无方案",
      "scheme.new": "新方案 {index}",
      "scheme.keepOne": "至少保留一个方案。",
      "scheme.added": "已新增一个方案。",
      "scheme.activeHint": "当前激活方案：{name}。批量建模、模型列表和本次运行都基于这个方案。",
      "scheme.activeHintEmpty": "批量建模、模型列表和本次运行都基于当前激活方案。",
      "scheme.noModels": "无模型",
      "provider.examples": "示例模型",
      "provider.defaultUrl": "默认地址",
      "provider.groupFallback": "其他",
      "batch.addKeyRow": "新增 API Key 行",
      "batch.removeKeyRow": "移除当前 API Key 行",
      "batch.noApiKeyRequired": "无需 API Key",
      "batch.apiKeyLabel": "API Key {index}",
      "batch.failed.noKey": "批量添加失败：请至少填写一个 API Key。",
      "batch.failed.noModel": "批量添加失败：模型名称不能为空。",
      "batch.failed.noBaseUrl": "批量添加失败：Base URL 不能为空。",
      "batch.added": "已新增 {count} 个模型卡片。",
      "field.modelId": "模型 ID",
      "field.displayName": "显示名称",
      "field.provider": "服务商",
      "field.role": "角色",
      "field.remoteModel": "远端模型名",
      "field.baseUrl": "基础 URL",
      "field.apiKeyEnv": "API Key 变量名",
      "field.apiKeyValue": "API Key",
      "field.authStyle": "鉴权方式",
      "field.apiKeyHeader": "API Key 请求头",
      "field.reasoning": "推理强度",
      "field.thinking": "开启 Thinking 模式",
      "field.thinkingHint": "适合复杂问题。部分 Provider 会在联网搜索时自动关闭 Thinking 以保持兼容。",
      "field.webSearch": "允许联网搜索",
      "field.webSearchHint": "仅在所选 Provider 支持联网搜索工具时生效。",
      "field.temperature": "温度",
      "field.capabilities": "职务角色",
      "field.customSpecialties": "自定义补充",
      "button.testConnection": "测试连接",
      "button.remove": "删除",
      "role.worker": "仅工作",
      "role.controller": "仅主控",
      "role.hybrid": "主控 + 工作",
      "controller.noneEligible": "没有可作为主控的模型"
    },
    "en-US": {
      "capability.controller": "Controller",
      "capability.research": "Research",
      "capability.implementation": "Implementation",
      "capability.coding_manager": "Coding Manager",
      "capability.validation": "Validation",
      "capability.handoff": "Handoff",
      "capability.general": "General",
      "model.untested": "Untested",
      "model.new": "New Model",
      "model.untitled": "Untitled Model",
      "scheme.default": "GPT Scheme",
      "scheme.untitled": "Untitled Scheme",
      "scheme.none": "No schemes",
      "scheme.new": "New Scheme {index}",
      "scheme.keepOne": "Keep at least one scheme.",
      "scheme.added": "Added a new scheme.",
      "scheme.activeHint": "Active scheme: {name}. Batch creation, the model list, and this run all target this scheme.",
      "scheme.activeHintEmpty": "Batch creation, the model list, and this run all target the active scheme.",
      "scheme.noModels": "No models",
      "provider.examples": "Example models",
      "provider.defaultUrl": "Default URL",
      "provider.groupFallback": "Other",
      "batch.addKeyRow": "Add API key row",
      "batch.removeKeyRow": "Remove current API key row",
      "batch.noApiKeyRequired": "No API key required",
      "batch.apiKeyLabel": "API key {index}",
      "batch.failed.noKey": "Batch add failed: enter at least one API key.",
      "batch.failed.noModel": "Batch add failed: model name is required.",
      "batch.failed.noBaseUrl": "Batch add failed: base URL is required.",
      "batch.added": "Added {count} model card(s).",
      "field.modelId": "Model ID",
      "field.displayName": "Display Name",
      "field.provider": "Provider",
      "field.role": "Role",
      "field.remoteModel": "Remote Model Name",
      "field.baseUrl": "Base URL",
      "field.apiKeyEnv": "API Key Env Name",
      "field.apiKeyValue": "API Key",
      "field.authStyle": "Auth Style",
      "field.apiKeyHeader": "API Key Header",
      "field.reasoning": "Reasoning",
      "field.thinking": "Enable Thinking",
      "field.thinkingHint":
        "Useful for complex tasks. Some providers automatically disable thinking during web search for compatibility.",
      "field.webSearch": "Allow Web Search",
      "field.webSearchHint": "Only available when the selected provider supports web search tools.",
      "field.temperature": "Temperature",
      "field.capabilities": "Capabilities",
      "field.customSpecialties": "Custom Specialties",
      "button.testConnection": "Test Connection",
      "button.remove": "Remove",
      "role.worker": "Worker Only",
      "role.controller": "Controller Only",
      "role.hybrid": "Controller + Worker",
      "controller.noneEligible": "No controller-capable models"
    }
  };

  return (key, values = {}) => {
    const locale = resolveRuntimeLocale();
    return interpolate(catalog[locale]?.[key] ?? catalog["zh-CN"]?.[key] ?? key, values);
  };
}

const PROVIDER_DEFINITIONS = listProviderDefinitions();
const MODEL_CAPABILITY_OPTIONS = [
  { value: "controller", labelKey: "capability.controller" },
  { value: "research", labelKey: "capability.research" },
  { value: "implementation", labelKey: "capability.implementation" },
  { value: "coding_manager", labelKey: "capability.coding_manager" },
  { value: "validation", labelKey: "capability.validation" },
  { value: "handoff", labelKey: "capability.handoff" },
  { value: "general", labelKey: "capability.general" }
];
const MODEL_ROLE_OPTIONS = [
  { value: "worker", labelKey: "role.worker" },
  { value: "controller", labelKey: "role.controller" },
  { value: "hybrid", labelKey: "role.hybrid" }
];

export function createModelsSchemesUi({
  state,
  knownModelConfigs,
  elements,
  setSaveStatus,
  setModelTestStatus,
  callbacks = {}
}) {
  const {
    modelList,
    modelTemplate,
    schemeSelect,
    schemeNameInput,
    addSchemeButton,
    removeSchemeButton,
    schemeHint,
    controllerSelect,
    addModelButton,
    batchAddButton,
    batchIdPrefixInput,
    batchLabelPrefixInput,
    batchEnvPrefixInput,
    batchProviderSelect,
    batchProviderHint,
    batchModelNameInput,
    batchRoleSelect,
    batchBaseUrlInput,
    batchAuthStyleSelect,
    batchApiKeyHeaderInput,
    batchReasoningSelect,
    batchThinkingInput,
    batchWebSearchInput,
    batchTemperatureInput,
    batchCapabilityList,
    batchSpecialtiesCustomInput,
    batchKeysList
  } = elements;

  const translate = createFallbackTranslator();
  const callbackRefs = { ...callbacks };

  function setCallbacks(nextCallbacks = {}) {
    Object.assign(callbackRefs, nextCallbacks);
  }

  function getUntestedStatusLabel() {
    return translate("model.untested");
  }

  function getProviderHintText(providerId) {
    const definition = getProviderDefinition(providerId);
    if (!definition) {
      return "";
    }

    const examples =
      Array.isArray(definition.exampleModels) && definition.exampleModels.length
        ? ` ${translate("provider.examples")}: ${definition.exampleModels.join(" / ")}`
        : "";
    return `${definition.label} | ${definition.group || translate("provider.groupFallback")} | ${translate("provider.defaultUrl")} ${definition.defaultBaseUrl}${examples}`;
  }

  function populateProviderSelect(select, preferredValue = DEFAULT_PROVIDER_ID) {
    if (!select) {
      return;
    }

    const previousValue = String(preferredValue || select.value || DEFAULT_PROVIDER_ID).trim();
    const groups = new Map();

    for (const definition of PROVIDER_DEFINITIONS) {
      const group = String(definition.group || translate("provider.groupFallback"));
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
      getProviderDefinition(previousValue)?.id || PROVIDER_DEFINITIONS[0]?.id || DEFAULT_PROVIDER_ID;
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

  function normalizeModelRole(value, fallback = "worker") {
    const trimmed = String(value || "").trim().toLowerCase();
    if (!trimmed) {
      return fallback;
    }
    if (trimmed === "both" || trimmed === "dual" || trimmed === "dual-role" || trimmed === "dual_role") {
      return "hybrid";
    }
    return ["controller", "worker", "hybrid"].includes(trimmed) ? trimmed : fallback;
  }

  function inferModelRole(model = {}) {
    return normalizeModelRole(
      model.role,
      normalizeSpecialties(model.specialties).includes("controller") ? "controller" : "worker"
    );
  }

  function modelCanActAsController(model = {}) {
    const role = inferModelRole(model);
    return role === "controller" || role === "hybrid";
  }

  function populateModelRoleSelect(select, preferredValue = "worker") {
    if (!select) {
      return;
    }

    const previousValue = normalizeModelRole(preferredValue, "worker");
    select.innerHTML = "";
    for (const optionConfig of MODEL_ROLE_OPTIONS) {
      const option = document.createElement("option");
      option.value = optionConfig.value;
      option.textContent = translate(optionConfig.labelKey);
      select.append(option);
    }
    select.value = previousValue;
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
      text.textContent = translate(option.labelKey);

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

  function updateModelCardTitle(card) {
    const id = card.querySelector("[data-model-id]")?.value.trim() || "";
    const label = card.querySelector("[data-model-label]")?.value.trim() || "";
    const title = card.querySelector("[data-model-title]");
    if (title) {
      title.textContent = label || id || translate("model.new");
    }
  }

  function setCardFieldLabel(card, selector, label) {
    const control = card?.querySelector(selector);
    const labelNode = control?.closest(".field, .toggle-field")?.querySelector(":scope > span");
    if (labelNode) {
      labelNode.textContent = label;
    }
  }

  function localizeModelCard(card) {
    setCardFieldLabel(card, "[data-model-id]", translate("field.modelId"));
    setCardFieldLabel(card, "[data-model-label]", translate("field.displayName"));
    setCardFieldLabel(card, "[data-model-provider]", translate("field.provider"));
    setCardFieldLabel(card, "[data-model-role]", translate("field.role"));
    setCardFieldLabel(card, "[data-model-name]", translate("field.remoteModel"));
    setCardFieldLabel(card, "[data-model-base-url]", translate("field.baseUrl"));
    setCardFieldLabel(card, "[data-model-api-key-env]", translate("field.apiKeyEnv"));
    setCardFieldLabel(card, "[data-model-api-key-value]", translate("field.apiKeyValue"));
    setCardFieldLabel(card, "[data-model-auth-style]", translate("field.authStyle"));
    setCardFieldLabel(card, "[data-model-api-key-header]", translate("field.apiKeyHeader"));
    setCardFieldLabel(card, "[data-model-reasoning]", translate("field.reasoning"));
    setCardFieldLabel(card, "[data-model-thinking]", translate("field.thinking"));
    setCardFieldLabel(card, "[data-model-web-search]", translate("field.webSearch"));
    setCardFieldLabel(card, "[data-model-temperature]", translate("field.temperature"));
    setCardFieldLabel(card, "[data-model-specialties-custom]", translate("field.customSpecialties"));

    const capabilitiesLabel = card
      ?.querySelector("[data-model-capability-list]")
      ?.closest(".field")
      ?.querySelector(":scope > span");
    if (capabilitiesLabel) {
      capabilitiesLabel.textContent = translate("field.capabilities");
    }

    const thinkingHint = card
      ?.querySelector("[data-model-thinking]")
      ?.closest(".toggle-control")
      ?.querySelector("span");
    if (thinkingHint) {
      thinkingHint.textContent = translate("field.thinkingHint");
    }

    const webSearchHint = card
      ?.querySelector("[data-model-web-search]")
      ?.closest(".toggle-control")
      ?.querySelector("span");
    if (webSearchHint) {
      webSearchHint.textContent = translate("field.webSearchHint");
    }

    const testButton = card?.querySelector("[data-model-test]");
    if (testButton) {
      testButton.textContent = translate("button.testConnection");
    }

    const removeButton = card?.querySelector("[data-model-remove]");
    if (removeButton) {
      removeButton.textContent = translate("button.remove");
    }
  }

  function updateModelCardFields(card, options = {}) {
    const { applyDefaults = false } = options;
    const providerSelect = card.querySelector("[data-model-provider]");
    const provider = providerSelect?.value || DEFAULT_PROVIDER_ID;
    const previousProviderId = providerSelect?.dataset.previousProviderId || "";
    const reasoning = card.querySelector("[data-model-reasoning]");
    const thinking = card.querySelector("[data-model-thinking]");
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

    const thinkingSupported = providerSupportsCapability(provider, "thinking");
    const thinkingEnabled = thinkingSupported ? Boolean(thinking?.checked) : false;
    const resolvedAuthStyle = card.querySelector("[data-model-auth-style]")?.value || "bearer";
    if (reasoning) {
      reasoning.disabled =
        !providerSupportsCapability(provider, "reasoning") || !thinkingEnabled;
    }
    if (thinking) {
      thinking.disabled = !thinkingSupported;
    }
    if (webSearch) {
      webSearch.disabled = !providerSupportsCapability(provider, "webSearch");
    }
    if (temperature) {
      temperature.disabled = !providerSupportsCapability(provider, "temperature");
    }
    if (apiKeyEnv) {
      apiKeyEnv.disabled = resolvedAuthStyle === "none";
    }
    if (apiKeyValue) {
      apiKeyValue.disabled = resolvedAuthStyle === "none";
    }
    if (apiKeyHeader) {
      apiKeyHeader.disabled = resolvedAuthStyle !== "api-key";
    }
    if (providerHint) {
      providerHint.textContent = getProviderHintText(provider);
    }
    if (providerSelect) {
      providerSelect.dataset.previousProviderId = provider;
    }
  }

  function updateBatchFields(options = {}) {
    const { applyDefaults = false } = options;
    const provider = batchProviderSelect?.value || DEFAULT_PROVIDER_ID;
    const previousProviderId = batchProviderSelect?.dataset.previousProviderId || "";

    if (applyDefaults && provider !== previousProviderId) {
      applyProviderDefaults({
        providerId: provider,
        previousProviderId,
        baseUrlInput: batchBaseUrlInput,
        authStyleSelect: batchAuthStyleSelect,
        apiKeyHeaderInput: batchApiKeyHeaderInput
      });
    }

    const thinkingSupported = providerSupportsCapability(provider, "thinking");
    const thinkingEnabled = thinkingSupported ? Boolean(batchThinkingInput?.checked) : false;

    if (batchThinkingInput) {
      batchThinkingInput.disabled = !thinkingSupported;
    }
    if (batchReasoningSelect) {
      batchReasoningSelect.disabled =
        !providerSupportsCapability(provider, "reasoning") || !thinkingEnabled;
    }
    if (batchWebSearchInput) {
      batchWebSearchInput.disabled = !providerSupportsCapability(provider, "webSearch");
    }
    if (batchTemperatureInput) {
      batchTemperatureInput.disabled = !providerSupportsCapability(provider, "temperature");
    }

    const resolvedAuthStyle = batchAuthStyleSelect?.value || "bearer";
    if (batchApiKeyHeaderInput) {
      batchApiKeyHeaderInput.disabled = resolvedAuthStyle !== "api-key";
    }
    if (batchEnvPrefixInput) {
      batchEnvPrefixInput.disabled = resolvedAuthStyle === "none";
    }
    if (batchProviderHint) {
      batchProviderHint.textContent = getProviderHintText(provider);
    }
    if (batchProviderSelect) {
      batchProviderSelect.dataset.previousProviderId = provider;
    }
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
    addButton.title = translate("batch.addKeyRow");
    addButton.textContent = "+";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost danger small";
    removeButton.dataset.batchKeyRemove = "true";
    removeButton.title = translate("batch.removeKeyRow");
    removeButton.textContent = "-";

    row.append(input, addButton, removeButton);
    return row;
  }

  function updateBatchKeyRowStates() {
    if (!batchKeysList) {
      return;
    }

    const rows = getBatchKeyRows();
    const disabled = batchAuthStyleSelect?.value === "none";

    if (!rows.length) {
      batchKeysList.append(createBatchKeyRow());
      updateBatchKeyRowStates();
      return;
    }

    rows.forEach((row, index) => {
      const input = row.querySelector("[data-batch-key-input]");
      const addButton = row.querySelector("[data-batch-key-add]");
      const removeButton = row.querySelector("[data-batch-key-remove]");
      row.dataset.disabled = disabled ? "true" : "false";
      if (input) {
        input.disabled = disabled;
        input.placeholder = disabled
          ? translate("batch.noApiKeyRequired")
          : translate("batch.apiKeyLabel", { index: index + 1 });
      }
      if (addButton) {
        addButton.disabled = disabled;
        addButton.title = translate("batch.addKeyRow");
      }
      if (removeButton) {
        removeButton.disabled = disabled || rows.length === 1;
        removeButton.title = translate("batch.removeKeyRow");
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
    const roleSelect = card.querySelector("[data-model-role]");

    card.querySelector("[data-model-id]").value = model.id || "";
    card.querySelector("[data-model-label]").value = model.label || "";
    populateProviderSelect(providerSelect, model.provider || DEFAULT_PROVIDER_ID);
    populateModelRoleSelect(roleSelect, inferModelRole(model));
    card.querySelector("[data-model-name]").value = model.model || "";
    card.querySelector("[data-model-base-url]").value = model.baseUrl || "";
    card.querySelector("[data-model-api-key-env]").value = model.apiKeyEnv || "";
    card.querySelector("[data-model-api-key-value]").value = model.apiKeyValue || "";
    card.querySelector("[data-model-auth-style]").value =
      model.authStyle || getProviderDefinition(providerSelect.value)?.defaultAuthStyle || "bearer";
    card.querySelector("[data-model-api-key-header]").value = model.apiKeyHeader || "";
    card.querySelector("[data-model-reasoning]").value = model.reasoningEffort || "";
    card.querySelector("[data-model-thinking]").checked = Boolean(model.thinkingEnabled);
    card.querySelector("[data-model-web-search]").checked = Boolean(model.webSearch);
    card.querySelector("[data-model-temperature]").value = model.temperature ?? "";
    renderCapabilityOptions(card.querySelector("[data-model-capability-list]"), presets);
    card.querySelector("[data-model-specialties-custom]").value = custom.join(", ");

    localizeModelCard(card);
    updateModelCardTitle(card);
    updateModelCardFields(card, { applyDefaults: true });
    setModelTestStatus(card, getUntestedStatusLabel());
    return card;
  }

  function collectModelFromCard(card) {
    return {
      id: card.querySelector("[data-model-id]")?.value.trim() || "",
      label: card.querySelector("[data-model-label]")?.value.trim() || "",
      provider: card.querySelector("[data-model-provider]")?.value || DEFAULT_PROVIDER_ID,
      role: normalizeModelRole(card.querySelector("[data-model-role]")?.value || "worker", "worker"),
      model: card.querySelector("[data-model-name]")?.value.trim() || "",
      baseUrl: card.querySelector("[data-model-base-url]")?.value.trim() || "",
      apiKeyEnv: card.querySelector("[data-model-api-key-env]")?.value.trim() || "",
      apiKeyValue: card.querySelector("[data-model-api-key-value]")?.value || "",
      authStyle: card.querySelector("[data-model-auth-style]")?.value || "bearer",
      apiKeyHeader: card.querySelector("[data-model-api-key-header]")?.value.trim() || "",
      thinkingEnabled: Boolean(card.querySelector("[data-model-thinking]")?.checked),
      reasoningEffort: card.querySelector("[data-model-reasoning]")?.value || "",
      webSearch: Boolean(card.querySelector("[data-model-web-search]")?.checked),
      temperature: card.querySelector("[data-model-temperature]")?.value ?? "",
      specialties: collectSpecialtiesFromInputs(
        card.querySelector("[data-model-capability-list]"),
        card.querySelector("[data-model-specialties-custom]")?.value || ""
      )
    };
  }

  function collectModels() {
    return Array.from(modelList?.querySelectorAll(".model-card") || []).map(collectModelFromCard);
  }

  function cloneModelDraft(model = {}) {
    return {
      id: String(model.id || ""),
      label: String(model.label || ""),
      provider: String(model.provider || DEFAULT_PROVIDER_ID),
      role: normalizeModelRole(model.role || "", "worker"),
      model: String(model.model || ""),
      baseUrl: String(model.baseUrl || ""),
      apiKeyEnv: String(model.apiKeyEnv || ""),
      apiKeyValue: String(model.apiKeyValue || ""),
      authStyle: String(model.authStyle || "bearer"),
      apiKeyHeader: String(model.apiKeyHeader || ""),
      thinkingEnabled: Boolean(model.thinkingEnabled),
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
      label: translate("scheme.default"),
      controller: String(controller || models[0]?.id || ""),
      models: (Array.isArray(models) ? models : []).map(cloneModelDraft)
    };
  }

  function getSchemeDisplayName(scheme) {
    const normalized = cloneSchemeDraft(scheme);
    return normalized.label || normalized.id || translate("scheme.untitled");
  }

  function getCurrentScheme() {
    return state.schemes.find((scheme) => scheme.id === state.currentSchemeId) || null;
  }

  function getDefaultNewModelRole() {
    return collectModels().some((model) => modelCanActAsController(model)) ? "worker" : "controller";
  }

  function buildUniqueSchemeId(baseLabel = "scheme") {
    const used = new Set(state.schemes.map((scheme) => scheme.id).filter(Boolean));
    return buildUniqueName(baseLabel, used);
  }

  function captureCurrentSchemeDraft() {
    const currentScheme = getCurrentScheme();
    if (!currentScheme) {
      return null;
    }

    currentScheme.label =
      schemeNameInput?.value.trim() || currentScheme.label || currentScheme.id || translate("scheme.untitled");
    currentScheme.controller = String(controllerSelect?.value || "").trim();
    currentScheme.models = collectModels().map(cloneModelDraft);
    return currentScheme;
  }

  function syncCurrentSchemeHint() {
    if (!schemeHint) {
      return;
    }

    const currentScheme = getCurrentScheme();
    schemeHint.textContent = currentScheme
      ? translate("scheme.activeHint", { name: getSchemeDisplayName(currentScheme) })
      : translate("scheme.activeHintEmpty");
  }

  function renderSchemeControls() {
    if (!schemeSelect || !schemeNameInput) {
      return;
    }

    schemeSelect.innerHTML = "";
    for (const scheme of state.schemes) {
      const option = document.createElement("option");
      option.value = scheme.id;
      option.textContent = getSchemeDisplayName(scheme);
      schemeSelect.append(option);
    }

    if (!state.schemes.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = translate("scheme.none");
      option.disabled = true;
      option.selected = true;
      schemeSelect.append(option);
      schemeNameInput.value = "";
      schemeNameInput.disabled = true;
      if (removeSchemeButton) {
        removeSchemeButton.disabled = true;
      }
      syncCurrentSchemeHint();
      callbackRefs.renderConnectivityList?.();
      return;
    }

    const nextSchemeId = state.schemes.some((scheme) => scheme.id === state.currentSchemeId)
      ? state.currentSchemeId
      : state.schemes[0].id;
    state.currentSchemeId = nextSchemeId;
    schemeSelect.value = nextSchemeId;

    const currentScheme = getCurrentScheme();
    schemeNameInput.disabled = false;
    schemeNameInput.value = currentScheme?.label || "";
    if (removeSchemeButton) {
      removeSchemeButton.disabled = state.schemes.length <= 1;
    }
    syncCurrentSchemeHint();
  }

  function updateControllerOptions(preferredValue = "") {
    const models = collectModels();
    const controllerCapableModels = models.filter((model) => modelCanActAsController(model));
    const currentValue = preferredValue || controllerSelect?.value || "";

    if (!controllerSelect) {
      return;
    }

    controllerSelect.innerHTML = "";

    if (!models.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = translate("scheme.noModels");
      option.disabled = true;
      option.selected = true;
      controllerSelect.append(option);
      return;
    }

    if (!controllerCapableModels.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = translate("controller.noneEligible");
      option.disabled = true;
      option.selected = true;
      controllerSelect.append(option);
      return;
    }

    for (const model of controllerCapableModels) {
      const option = document.createElement("option");
      option.value = model.id || "";
      option.textContent = model.label || model.id || translate("model.untitled");
      controllerSelect.append(option);
    }

    const nextValue = controllerCapableModels.find((model) => model.id === currentValue)
      ? currentValue
      : controllerCapableModels[0].id;
    controllerSelect.value = nextValue;
  }

  function renderCurrentSchemeModels() {
    const currentScheme = getCurrentScheme();
    knownModelConfigs.clear();
    if (modelList) {
      modelList.innerHTML = "";
    }

    if (!currentScheme) {
      updateControllerOptions("");
      callbackRefs.renderConnectivityList?.();
      return;
    }

    for (const model of currentScheme.models || []) {
      knownModelConfigs.set(model.id, model);
      modelList?.append(createModelCard(model));
    }

    updateControllerOptions(currentScheme.controller || "");
    callbackRefs.applyStoredConnectivityToVisibleCards?.();
    callbackRefs.renderConnectivityList?.();
  }

  function switchCurrentScheme(nextSchemeId, options = {}) {
    const { preserveDraft = true } = options;
    if (preserveDraft) {
      captureCurrentSchemeDraft();
    }

    const normalizedNextSchemeId = String(nextSchemeId || "").trim();
    if (!normalizedNextSchemeId || !state.schemes.some((scheme) => scheme.id === normalizedNextSchemeId)) {
      return;
    }

    state.currentSchemeId = normalizedNextSchemeId;
    renderSchemeControls();
    renderCurrentSchemeModels();
  }

  function addSchemeDraft() {
    captureCurrentSchemeDraft();
    const nextIndex = state.schemes.length + 1;
    const nextScheme = cloneSchemeDraft({
      id: buildUniqueSchemeId(`scheme_${nextIndex}`),
      label: translate("scheme.new", { index: nextIndex }),
      controller: "",
      models: []
    });
    state.schemes.push(nextScheme);
    switchCurrentScheme(nextScheme.id, { preserveDraft: false });
  }

  function removeCurrentSchemeDraft() {
    if (state.schemes.length <= 1) {
      setSaveStatus(translate("scheme.keepOne"), "error");
      return;
    }

    const removingIndex = state.schemes.findIndex((scheme) => scheme.id === state.currentSchemeId);
    if (removingIndex === -1) {
      return;
    }

    const [removed] = state.schemes.splice(removingIndex, 1);
    if (removed?.id) {
      state.connectivityBySchemeId.delete(removed.id);
    }
    const fallbackScheme = state.schemes[Math.max(0, removingIndex - 1)] || state.schemes[0];
    switchCurrentScheme(fallbackScheme?.id, { preserveDraft: false });
  }

  function batchAddModels() {
    const keys = collectBatchKeys();

    if (batchAuthStyleSelect?.value !== "none" && !keys.length) {
      setSaveStatus(translate("batch.failed.noKey"), "error");
      getBatchKeyInputs()[0]?.focus();
      return;
    }

    const existingModels = collectModels();
    const usedIds = new Set(existingModels.map((model) => model.id).filter(Boolean));
    const usedEnvNames = new Set(existingModels.map((model) => model.apiKeyEnv).filter(Boolean));
    const baseIdPrefix = batchIdPrefixInput?.value.trim() || "codex_worker";
    const baseLabelPrefix = batchLabelPrefixInput?.value.trim() || "Codex Worker";
    const baseEnvPrefix = batchEnvPrefixInput?.value.trim() || "CODEX_API_KEY";
    const authStyle = batchAuthStyleSelect?.value || "bearer";
    const provider = batchProviderSelect?.value || DEFAULT_PROVIDER_ID;
    const role = normalizeModelRole(batchRoleSelect?.value || "worker", "worker");
    const sharedModel = batchModelNameInput?.value.trim() || "";
    const sharedBaseUrl = batchBaseUrlInput?.value.trim() || "";
    const batchSpecialties = collectSpecialtiesFromInputs(
      batchCapabilityList,
      batchSpecialtiesCustomInput?.value || ""
    );

    if (!sharedModel) {
      setSaveStatus(translate("batch.failed.noModel"), "error");
      batchModelNameInput?.focus();
      return;
    }

    if (!sharedBaseUrl) {
      setSaveStatus(translate("batch.failed.noBaseUrl"), "error");
      batchBaseUrlInput?.focus();
      return;
    }

    const count = authStyle === "none" ? 1 : keys.length;
    for (let index = 0; index < count; index += 1) {
      const suffix = index + 1;
      const modelId = buildUniqueName(`${baseIdPrefix}_${suffix}`, usedIds);
      const envName = authStyle === "none" ? "" : buildUniqueName(`${baseEnvPrefix}_${suffix}`, usedEnvNames);
      modelList?.append(
        createModelCard({
          id: modelId,
          label: `${baseLabelPrefix} ${suffix}`,
          provider,
          role,
          model: sharedModel,
          baseUrl: sharedBaseUrl,
          apiKeyEnv: envName,
          apiKeyValue: authStyle === "none" ? "" : keys[index] || "",
          authStyle,
          apiKeyHeader: batchApiKeyHeaderInput?.value.trim() || "",
          thinkingEnabled: Boolean(batchThinkingInput?.checked),
          reasoningEffort: batchReasoningSelect?.value || "",
          webSearch: Boolean(batchWebSearchInput?.checked),
          temperature: batchTemperatureInput?.value.trim() || "",
          specialties: batchSpecialties
        })
      );
    }

    updateControllerOptions();
    captureCurrentSchemeDraft();
    callbackRefs.renderConnectivityList?.();
    setSaveStatus(translate("batch.added", { count }), "ok");
  }

  function applySettings(settings) {
    knownModelConfigs.clear();
    const inputSchemes =
      Array.isArray(settings?.schemes) && settings.schemes.length
        ? settings.schemes.map(cloneSchemeDraft)
        : [buildFallbackScheme(settings?.models || [], settings?.cluster?.controller || "")];

    state.schemes = inputSchemes;
    state.connectivityBySchemeId = new Map(
      Array.from(state.connectivityBySchemeId.entries()).filter(([schemeId]) =>
        inputSchemes.some((scheme) => scheme.id === schemeId)
      )
    );
    state.currentSchemeId =
      settings?.cluster?.activeSchemeId &&
      inputSchemes.some((scheme) => scheme.id === settings.cluster.activeSchemeId)
        ? settings.cluster.activeSchemeId
        : inputSchemes[0]?.id || "";

    renderSchemeControls();
    renderCurrentSchemeModels();
  }

  function collectState() {
    captureCurrentSchemeDraft();
    const currentScheme = getCurrentScheme();
    const currentSchemeDraft = currentScheme ? cloneSchemeDraft(currentScheme) : null;
    return {
      currentScheme: currentSchemeDraft,
      schemes: state.schemes.map(cloneSchemeDraft),
      models: currentSchemeDraft ? currentSchemeDraft.models.map(cloneModelDraft) : collectModels().map(cloneModelDraft)
    };
  }

  function bindEvents() {
    modelList?.addEventListener("click", (event) => {
      const testButton = event.target.closest("[data-model-test]");
      if (testButton) {
        const card = testButton.closest(".model-card");
        if (card) {
          callbackRefs.testSingleModel?.(card);
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
      callbackRefs.renderConnectivityList?.();
    });

    modelList?.addEventListener("input", (event) => {
      const card = event.target.closest(".model-card");
      if (!card) {
        return;
      }

      updateModelCardTitle(card);
      updateControllerOptions();
      setModelTestStatus(card, getUntestedStatusLabel());
      captureCurrentSchemeDraft();
      const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
      callbackRefs.markModelDirty?.(modelId);
    });

    modelList?.addEventListener("change", (event) => {
      const card = event.target.closest(".model-card");
      if (!card) {
        return;
      }

      updateModelCardFields(card, { applyDefaults: true });
      updateControllerOptions();
      setModelTestStatus(card, getUntestedStatusLabel());
      captureCurrentSchemeDraft();
      const modelId = card.querySelector("[data-model-id]")?.value.trim() || "";
      callbackRefs.markModelDirty?.(modelId);
    });

    schemeSelect?.addEventListener("change", async (event) => {
      switchCurrentScheme(event.target.value);
      await callbackRefs.runCurrentSchemeConnectivityTests?.();
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
      setSaveStatus(translate("scheme.added"), "ok");
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

    addModelButton?.addEventListener("click", () => {
      modelList?.append(
        createModelCard({
          id: "",
          label: "",
          provider: DEFAULT_PROVIDER_ID,
          role: getDefaultNewModelRole(),
          model: "",
          baseUrl: "",
          apiKeyEnv: "",
          apiKeyValue: "",
          authStyle: "bearer",
          apiKeyHeader: "",
          thinkingEnabled: false,
          reasoningEffort: "",
          webSearch: false,
          temperature: "",
          specialties: []
        })
      );
      updateControllerOptions();
      captureCurrentSchemeDraft();
      callbackRefs.renderConnectivityList?.();
    });

    batchAddButton?.addEventListener("click", batchAddModels);
    batchProviderSelect?.addEventListener("change", () => updateBatchFields({ applyDefaults: true }));
    batchAuthStyleSelect?.addEventListener("change", () => updateBatchFields());
    batchThinkingInput?.addEventListener("change", () => updateBatchFields());

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
  }

  function initialize() {
    populateProviderSelect(batchProviderSelect, DEFAULT_PROVIDER_ID);
    populateModelRoleSelect(batchRoleSelect, "worker");
    setBatchKeyRows([""]);
    updateBatchFields({ applyDefaults: true });
    renderCapabilityOptions(batchCapabilityList, []);
  }

  function refreshLocale() {
    captureCurrentSchemeDraft();
    renderSchemeControls();
    renderCurrentSchemeModels();

    const batchSpecialties = collectSpecialtiesFromInputs(
      batchCapabilityList,
      batchSpecialtiesCustomInput?.value || ""
    );
    populateModelRoleSelect(batchRoleSelect, batchRoleSelect?.value || "worker");
    renderCapabilityOptions(batchCapabilityList, batchSpecialties);
    updateBatchFields();
    updateBatchKeyRowStates();
  }

  return {
    applySettings,
    bindEvents,
    captureCurrentSchemeDraft,
    collectModelFromCard,
    collectModels,
    collectState,
    getCurrentScheme,
    initialize,
    refreshLocale,
    setCallbacks
  };
}

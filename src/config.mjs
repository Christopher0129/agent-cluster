import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  materializeSavedSettingsSync,
  serializeSavedSettingsSync
} from "./security/secrets.mjs";
import { applySecretMapToProcessEnv } from "./security/process-env.mjs";
import {
  isSupportedProvider,
  listProviderDefinitions,
  providerSupportsCapability
} from "./static/provider-catalog.js";

const SUPPORTED_AUTH_STYLES = new Set(["bearer", "api-key", "none"]);
const DEFAULT_SETTINGS_PATH = "./runtime.settings.json";
const DEFAULT_WORKSPACE_DIR = "./workspace";
const DEFAULT_BOT_INSTALL_DIR = "bot-connectors";
const DEFAULT_SUBORDINATE_MAX_PARALLEL = 3;
const DEFAULT_GROUP_LEADER_MAX_DELEGATES = 10;
const DEFAULT_DELEGATION_MAX_DEPTH = 1;
const DEFAULT_SCHEME_ID = "gpt_scheme";
const DEFAULT_SCHEME_LABEL = "gpt方案";
const CLUSTER_PHASES = ["research", "implementation", "validation", "handoff"];

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
  if (!match) {
    return null;
  }

  let value = match[2] ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeModelId(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w-]/g, "_");
  return normalized || fallback;
}

function sanitizeSchemeId(value, fallback) {
  return sanitizeModelId(value, fallback);
}

function normalizePort(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 65535) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeNonNegativeInteger(value, fallback) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeOptionalPositiveInteger(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 1) {
    return null;
  }

  return Math.floor(number);
}

function normalizeOptionalNonNegativeInteger(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return Math.floor(number);
}

function normalizeWorkspaceDir(value, fallback = DEFAULT_WORKSPACE_DIR) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeWorkspaceSubdir(value, fallback = DEFAULT_BOT_INSTALL_DIR) {
  const normalized = String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || fallback;
}

function normalizeSchemeLabel(value, fallback = DEFAULT_SCHEME_LABEL) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizePhaseParallelSettings(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : {};
  const normalized = {};

  for (const phase of CLUSTER_PHASES) {
    const resolved = normalizeOptionalNonNegativeInteger(source[phase]);
    if (resolved !== null) {
      normalized[phase] = resolved;
      continue;
    }

    const fallbackValue = normalizeOptionalNonNegativeInteger(backup[phase]);
    if (fallbackValue !== null) {
      normalized[phase] = fallbackValue;
    }
  }

  return normalized;
}

function parseSpecialties(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : Array.isArray(fallback)
        ? fallback
        : [];

  return Array.from(
    new Set(
      source
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeBotConfig(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : {};
  const rawPresetConfigs =
    source.presetConfigs && typeof source.presetConfigs === "object" ? source.presetConfigs : {};
  const fallbackPresetConfigs =
    backup.presetConfigs && typeof backup.presetConfigs === "object" ? backup.presetConfigs : {};
  const presetConfigs = {};

  for (const presetId of new Set([
    ...Object.keys(fallbackPresetConfigs),
    ...Object.keys(rawPresetConfigs)
  ])) {
    const entry = rawPresetConfigs[presetId];
    const fallbackEntry = fallbackPresetConfigs[presetId];
    presetConfigs[presetId] = {
      envText: String(entry?.envText ?? fallbackEntry?.envText ?? "").trim()
    };
  }

  return {
    installDir: normalizeWorkspaceSubdir(source.installDir, backup.installDir || DEFAULT_BOT_INSTALL_DIR),
    customCommand: String(source.customCommand ?? backup.customCommand ?? "").trim(),
    enabledPresets: normalizeStringList(source.enabledPresets, backup.enabledPresets),
    commandPrefix: String(source.commandPrefix ?? backup.commandPrefix ?? "/agent").trim() || "/agent",
    autoStart: Boolean(source.autoStart ?? backup.autoStart),
    progressUpdates: source.progressUpdates ?? backup.progressUpdates ?? true,
    presetConfigs
  };
}

function buildLegacySchemeDefinition(config, fallbackId = DEFAULT_SCHEME_ID, fallbackLabel = DEFAULT_SCHEME_LABEL) {
  const models = config?.models;
  const controller = String(config?.cluster?.controller || "").trim();
  if (!models || typeof models !== "object" || !Object.keys(models).length) {
    return null;
  }

  return {
    id: sanitizeSchemeId(config?.cluster?.activeSchemeId, fallbackId),
    label: normalizeSchemeLabel(config?.cluster?.activeSchemeLabel, fallbackLabel),
    controller,
    models: cloneJson(models)
  };
}

function extractConfiguredSchemes(config) {
  const rawSchemes = config?.schemes;
  const schemes = [];
  const seenIds = new Set();

  function appendScheme(id, value, index) {
    const fallbackId = index === 0 ? DEFAULT_SCHEME_ID : `scheme_${index + 1}`;
    let schemeId = sanitizeSchemeId(id || value?.id, fallbackId);
    while (seenIds.has(schemeId)) {
      schemeId = `${schemeId}_${index + 1}`;
    }
    seenIds.add(schemeId);

    schemes.push({
      id: schemeId,
      label: normalizeSchemeLabel(value?.label, schemeId === DEFAULT_SCHEME_ID ? DEFAULT_SCHEME_LABEL : schemeId),
      controller: String(value?.controller || "").trim(),
      models: cloneJson(value?.models && typeof value.models === "object" ? value.models : {})
    });
  }

  if (Array.isArray(rawSchemes)) {
    rawSchemes.forEach((value, index) => appendScheme(value?.id, value, index));
  } else if (rawSchemes && typeof rawSchemes === "object") {
    Object.entries(rawSchemes).forEach(([id, value], index) => appendScheme(id, value, index));
  }

  if (!schemes.length) {
    const legacyScheme = buildLegacySchemeDefinition(config);
    if (legacyScheme) {
      schemes.push(legacyScheme);
    }
  }

  return schemes;
}

function resolveSelectedSchemeId(schemes, preferredId = "") {
  const normalizedPreferredId = String(preferredId || "").trim();
  if (normalizedPreferredId && schemes.some((scheme) => scheme.id === normalizedPreferredId)) {
    return normalizedPreferredId;
  }

  return schemes[0]?.id || "";
}

function normalizeModelsPayload(modelsArray, controllerId, secrets) {
  const normalizedModels = {};
  const entries = Array.isArray(modelsArray) ? modelsArray : [];
  if (entries.length < 2) {
    throw new Error("At least two models are required: one controller and at least one worker.");
  }

  for (let index = 0; index < entries.length; index += 1) {
    const source = entries[index] || {};
    const fallbackId = `model_${index + 1}`;
    const modelId = sanitizeModelId(source.id, fallbackId);

    if (normalizedModels[modelId]) {
      throw new Error(`Duplicate model id "${modelId}".`);
    }

    const provider = String(source.provider || "").trim();
    if (!isSupportedProvider(provider)) {
      throw new Error(`Model "${modelId}" has unsupported provider "${provider}".`);
    }

    const model = String(source.model || "").trim();
    const baseUrl = String(source.baseUrl || "").trim().replace(/\/+$/, "");
    if (!model) {
      throw new Error(`Model "${modelId}" is missing a model name.`);
    }
    if (!baseUrl) {
      throw new Error(`Model "${modelId}" is missing a baseUrl.`);
    }

    const authStyle = String(source.authStyle || "bearer").trim();
    if (!SUPPORTED_AUTH_STYLES.has(authStyle)) {
      throw new Error(`Model "${modelId}" has unsupported authStyle "${authStyle}".`);
    }

    const apiKeyEnv = String(source.apiKeyEnv || "").trim();
    if (authStyle !== "none" && !apiKeyEnv) {
      throw new Error(`Model "${modelId}" must specify apiKeyEnv unless authStyle is "none".`);
    }

    const normalizedModel = {
      provider,
      model,
      baseUrl,
      apiKeyEnv,
      authStyle,
      label: String(source.label || modelId).trim() || modelId,
      specialties: parseSpecialties(source.specialties)
    };

    const apiKeyHeader = String(source.apiKeyHeader || "").trim();
    if (authStyle === "api-key") {
      normalizedModel.apiKeyHeader = apiKeyHeader || "api-key";
    }

    const reasoningEffort = String(source.reasoningEffort || "").trim();
    if (providerSupportsCapability(provider, "reasoning") && reasoningEffort) {
      normalizedModel.reasoning = { effort: reasoningEffort };
    }

    if (providerSupportsCapability(provider, "webSearch")) {
      normalizedModel.webSearch = Boolean(source.webSearch);
    }

    const temperatureValue = String(source.temperature ?? "").trim();
    if (providerSupportsCapability(provider, "temperature") && temperatureValue) {
      const temperature = Number(temperatureValue);
      if (!Number.isFinite(temperature)) {
        throw new Error(`Model "${modelId}" has invalid temperature "${temperatureValue}".`);
      }
      normalizedModel.temperature = temperature;
    }

    const apiKeyValue = String(source.apiKeyValue ?? "").trim();
    if (authStyle !== "none" && apiKeyEnv && apiKeyValue) {
      secrets[apiKeyEnv] = apiKeyValue;
    }

    normalizedModels[modelId] = normalizedModel;
  }

  if (!normalizedModels[controllerId]) {
    throw new Error(`Selected controller "${controllerId}" does not exist in the model list.`);
  }

  if (Object.keys(normalizedModels).length < 2) {
    throw new Error("At least one worker model is required besides the controller.");
  }

  return normalizedModels;
}

function buildEditableModelsFromScheme(scheme, savedSecrets = {}) {
  const controllerId = String(scheme?.controller || "").trim();
  const modelsInput = scheme?.models && typeof scheme.models === "object" ? scheme.models : {};
  const normalizedModels = {};

  for (const [modelId, modelConfig] of Object.entries(modelsInput)) {
    normalizedModels[modelId] = normalizeModelConfig(modelId, modelConfig, controllerId);
  }

  return Object.values(normalizedModels)
    .sort((left, right) => {
      if (left.id === controllerId) {
        return -1;
      }
      if (right.id === controllerId) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    })
    .map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      apiKeyEnv: model.apiKeyEnv || "",
      apiKeyValue: model.apiKeyEnv
        ? String(savedSecrets[model.apiKeyEnv] ?? process.env[model.apiKeyEnv] ?? "")
        : "",
      authStyle: model.authStyle || "bearer",
      apiKeyHeader: model.apiKeyHeader || "",
      reasoningEffort: model.reasoning?.effort || "",
      webSearch: Boolean(model.webSearch),
      temperature: model.temperature ?? "",
      specialties: model.specialties.join(", ")
    }));
}

function readJsonFileIfExists(filePath, fallback = null) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveBaseConfigPath(projectDir, options = {}) {
  if (options.configPath) {
    return isAbsolute(options.configPath)
      ? options.configPath
      : resolve(projectDir, options.configPath);
  }

  const configuredPath = process.env.AGENT_CLUSTER_CONFIG || "./cluster.config.json";
  return isAbsolute(configuredPath) ? configuredPath : resolve(projectDir, configuredPath);
}

function resolveSettingsPath(projectDir, options = {}) {
  if (options.settingsPath) {
    return isAbsolute(options.settingsPath)
      ? options.settingsPath
      : resolve(projectDir, options.settingsPath);
  }

  const configuredPath = String(process.env.AGENT_CLUSTER_SETTINGS || "").trim();
  if (configuredPath) {
    return isAbsolute(configuredPath) ? configuredPath : resolve(projectDir, configuredPath);
  }

  const defaultSettingsPath = resolve(projectDir, DEFAULT_SETTINGS_PATH);
  if (existsSync(defaultSettingsPath)) {
    return defaultSettingsPath;
  }

  const legacyCandidates = [
    resolve(projectDir, "dist", "runtime.settings.json")
  ];
  for (const candidate of legacyCandidates) {
    if (candidate !== defaultSettingsPath && existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultSettingsPath;
}

function loadBaseConfig(projectDir, options = {}) {
  if (options.baseConfig && typeof options.baseConfig === "object") {
    return {
      configPath: options.configPathLabel || "[embedded default config]",
      parsed: cloneJson(options.baseConfig)
    };
  }

  const configPath = resolveBaseConfigPath(projectDir, options);
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}. Create cluster.config.json or point AGENT_CLUSTER_CONFIG to a valid file.`
    );
  }

  return {
    configPath,
    parsed: JSON.parse(readFileSync(configPath, "utf8"))
  };
}

function mergeBaseConfigWithSettings(baseConfig, savedSettings) {
  const merged = cloneJson(baseConfig || {});

  if (savedSettings?.server && typeof savedSettings.server === "object") {
    merged.server = {
      ...(merged.server || {}),
      ...savedSettings.server
    };
  }

  if (savedSettings?.cluster && typeof savedSettings.cluster === "object") {
    const nextCluster = {
      ...(merged.cluster || {}),
      ...savedSettings.cluster
    };
    nextCluster.phaseParallel = normalizePhaseParallelSettings(
      savedSettings.cluster.phaseParallel,
      merged.cluster?.phaseParallel
    );
    merged.cluster = {
      ...nextCluster
    };
  }

  if (savedSettings?.workspace && typeof savedSettings.workspace === "object") {
    merged.workspace = {
      ...(merged.workspace || {}),
      ...savedSettings.workspace
    };
  }

  if (savedSettings?.bot && typeof savedSettings.bot === "object") {
    merged.bot = {
      ...(merged.bot || {}),
      ...savedSettings.bot
    };
  }

  if (savedSettings?.schemes && typeof savedSettings.schemes === "object" && Object.keys(savedSettings.schemes).length) {
    merged.schemes = cloneJson(savedSettings.schemes);
  }

  if (savedSettings?.models && typeof savedSettings.models === "object" && Object.keys(savedSettings.models).length) {
    merged.models = cloneJson(savedSettings.models);
  }

  return merged;
}

function normalizeModelConfig(modelId, modelConfig, controllerId) {
  if (!modelConfig || typeof modelConfig !== "object") {
    throw new Error(`Model "${modelId}" must be an object.`);
  }

  const provider = String(modelConfig.provider || "").trim();
  const model = String(modelConfig.model || "").trim();
  const baseUrl = String(modelConfig.baseUrl || "").trim().replace(/\/+$/, "");

  if (!provider) {
    throw new Error(`Model "${modelId}" is missing "provider".`);
  }
  if (!isSupportedProvider(provider)) {
    throw new Error(`Model "${modelId}" has unsupported provider "${provider}".`);
  }
  if (!model) {
    throw new Error(`Model "${modelId}" is missing "model".`);
  }
  if (!baseUrl) {
    throw new Error(`Model "${modelId}" is missing "baseUrl".`);
  }

  const authStyle = String(modelConfig.authStyle || "bearer").trim();
  if (!SUPPORTED_AUTH_STYLES.has(authStyle)) {
    throw new Error(`Model "${modelId}" has unsupported authStyle "${authStyle}".`);
  }

  return {
    ...modelConfig,
    id: modelId,
    provider,
    model,
    baseUrl,
    label: String(modelConfig.label || modelId),
    role: modelId === controllerId ? "controller" : "worker",
    authStyle,
    apiKeyEnv: String(modelConfig.apiKeyEnv || "").trim(),
    apiKeyHeader: String(modelConfig.apiKeyHeader || "").trim(),
    specialties: parseSpecialties(modelConfig.specialties)
  };
}

function normalizeSavedSettingsPayload(payload, fallbackConfig) {
  const serverPort = normalizePort(payload?.server?.port, normalizePort(fallbackConfig?.server?.port, 4040));
  const maxParallel = normalizeNonNegativeInteger(
    payload?.cluster?.maxParallel,
    normalizeNonNegativeInteger(fallbackConfig?.cluster?.maxParallel, 3)
  );
  const subordinateMaxParallel = normalizeNonNegativeInteger(
    payload?.cluster?.subordinateMaxParallel,
    normalizeNonNegativeInteger(
      fallbackConfig?.cluster?.subordinateMaxParallel,
      DEFAULT_SUBORDINATE_MAX_PARALLEL
    )
  );
  const groupLeaderMaxDelegates = normalizeNonNegativeInteger(
    payload?.cluster?.groupLeaderMaxDelegates,
    normalizeNonNegativeInteger(
      fallbackConfig?.cluster?.groupLeaderMaxDelegates,
      DEFAULT_GROUP_LEADER_MAX_DELEGATES
    )
  );
  const delegateMaxDepth = normalizeNonNegativeInteger(
    payload?.cluster?.delegateMaxDepth,
    normalizeNonNegativeInteger(
      fallbackConfig?.cluster?.delegateMaxDepth,
      DEFAULT_DELEGATION_MAX_DEPTH
    )
  );
  const phaseParallel = normalizePhaseParallelSettings(
    payload?.cluster?.phaseParallel,
    fallbackConfig?.cluster?.phaseParallel
  );
  const workspaceDir = normalizeWorkspaceDir(payload?.workspace?.dir, fallbackConfig?.workspace?.dir);

  const modelsArray = Array.isArray(payload?.models) ? payload.models : [];
  const controllerId = String(payload?.cluster?.controller || "").trim();

  const secrets = {};
  if (Array.isArray(payload?.secrets)) {
    for (const entry of payload.secrets) {
      const name = String(entry?.name || "").trim();
      if (!name) {
        continue;
      }
      secrets[name] = String(entry?.value || "");
    }
  }

  const explicitSchemes = Array.isArray(payload?.schemes) ? payload.schemes : [];
  const schemeInputs =
    explicitSchemes.length
      ? explicitSchemes
      : modelsArray.length
        ? [
            {
              id: payload?.cluster?.activeSchemeId || DEFAULT_SCHEME_ID,
              label: payload?.cluster?.activeSchemeLabel || DEFAULT_SCHEME_LABEL,
              controller: controllerId,
              models: modelsArray
            }
          ]
        : [];

  if (!schemeInputs.length) {
    throw new Error("At least one scheme is required.");
  }

  const schemes = {};
  const normalizedSchemeOrder = [];
  for (let index = 0; index < schemeInputs.length; index += 1) {
    const source = schemeInputs[index] || {};
    const fallbackId = index === 0 ? DEFAULT_SCHEME_ID : `scheme_${index + 1}`;
    const schemeId = sanitizeSchemeId(source.id, fallbackId);
    if (schemes[schemeId]) {
      throw new Error(`Duplicate scheme id "${schemeId}".`);
    }

    const schemeControllerId = String(source?.controller || source?.cluster?.controller || "").trim();
    if (!schemeControllerId) {
      throw new Error(`Scheme "${schemeId}" must specify a controller model.`);
    }

    const normalizedModels = normalizeModelsPayload(source?.models, schemeControllerId, secrets);
    schemes[schemeId] = {
      label: normalizeSchemeLabel(source?.label, schemeId === DEFAULT_SCHEME_ID ? DEFAULT_SCHEME_LABEL : schemeId),
      controller: schemeControllerId,
      models: normalizedModels
    };
    normalizedSchemeOrder.push(schemeId);
  }

  const activeSchemeId = sanitizeSchemeId(
    payload?.cluster?.activeSchemeId,
    normalizedSchemeOrder[0] || DEFAULT_SCHEME_ID
  );
  if (!schemes[activeSchemeId]) {
    throw new Error(`Selected scheme "${activeSchemeId}" does not exist.`);
  }

  const activeScheme = schemes[activeSchemeId];

  return {
    server: {
      port: serverPort
    },
    cluster: {
      activeSchemeId,
      activeSchemeLabel: activeScheme.label,
      controller: activeScheme.controller,
      maxParallel,
      subordinateMaxParallel,
      groupLeaderMaxDelegates,
      delegateMaxDepth,
      phaseParallel
    },
    workspace: {
      dir: workspaceDir
    },
    bot: normalizeBotConfig(payload?.bot, fallbackConfig?.bot),
    secrets,
    models: activeScheme.models,
    schemes
  };
}

function buildEditableSecrets(models, savedSecrets) {
  const names = new Set();

  for (const model of models) {
    if (model.apiKeyEnv) {
      names.add(model.apiKeyEnv);
    }
  }

  for (const name of Object.keys(savedSecrets || {})) {
    if (name) {
      names.add(name);
    }
  }

  return Array.from(names)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      value: String((savedSecrets && savedSecrets[name]) ?? process.env[name] ?? "")
    }));
}

export function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      continue;
    }

    const [key, value] = parsed;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadSavedSettings(projectDir, options = {}) {
  const settingsPath = resolveSettingsPath(projectDir, options);
  const rawSettings = readJsonFileIfExists(settingsPath, null);
  return {
    settingsPath,
    settings: materializeSavedSettingsSync(settingsPath, rawSettings)
  };
}

export function resolveConfigBundle(projectDir, options = {}) {
  const { configPath, parsed: baseConfig } = loadBaseConfig(projectDir, options);
  const { settingsPath, settings } = loadSavedSettings(projectDir, options);
  const mergedConfig = mergeBaseConfigWithSettings(baseConfig, settings);

  return {
    configPath,
    settingsPath,
    baseConfig,
    settings,
    mergedConfig
  };
}

export function applyResolvedSecrets(bundle) {
  applySecretMapToProcessEnv(bundle?.settings?.secrets);
  return bundle;
}

export function getEditableSettings(projectDir, options = {}) {
  const envPath = resolve(projectDir, ".env");
  loadEnvFile(envPath);

  const { configPath, settingsPath, settings, mergedConfig } = applyResolvedSecrets(
    resolveConfigBundle(projectDir, options)
  );
  const runtimeConfig = loadRuntimeConfig(projectDir, options);
  const schemes = extractConfiguredSchemes(mergedConfig).map((scheme) => ({
    id: scheme.id,
    label: scheme.label,
    controller: scheme.controller,
    models: buildEditableModelsFromScheme(scheme, settings?.secrets || {})
  }));
  const activeScheme =
    schemes.find((scheme) => scheme.id === runtimeConfig.cluster.activeSchemeId) ||
    schemes[0] || {
      id: DEFAULT_SCHEME_ID,
      label: DEFAULT_SCHEME_LABEL,
      controller: "",
      models: []
    };
  const models = activeScheme.models;

  return {
    configPath,
    settingsPath,
    providerDefinitions: listProviderDefinitions(),
    settings: {
      server: {
        port: normalizePort(mergedConfig?.server?.port, 4040)
      },
      cluster: {
        activeSchemeId: runtimeConfig.cluster.activeSchemeId,
        activeSchemeLabel: runtimeConfig.cluster.activeSchemeLabel,
        controller: runtimeConfig.cluster.controller,
        maxParallel: runtimeConfig.cluster.maxParallel,
        subordinateMaxParallel: runtimeConfig.cluster.subordinateMaxParallel,
        groupLeaderMaxDelegates: runtimeConfig.cluster.groupLeaderMaxDelegates,
        delegateMaxDepth: runtimeConfig.cluster.delegateMaxDepth,
        phaseParallel: normalizePhaseParallelSettings(mergedConfig?.cluster?.phaseParallel)
      },
      workspace: {
        dir: normalizeWorkspaceDir(mergedConfig?.workspace?.dir, DEFAULT_WORKSPACE_DIR)
      },
      bot: normalizeBotConfig(mergedConfig?.bot),
      secrets: buildEditableSecrets(schemes.flatMap((scheme) => scheme.models), settings?.secrets || {}),
      schemes,
      models
    }
  };
}

export async function saveEditableSettings(projectDir, payload, options = {}) {
  const envPath = resolve(projectDir, ".env");
  loadEnvFile(envPath);

  const { baseConfig } = resolveConfigBundle(projectDir, options);
  const normalized = normalizeSavedSettingsPayload(payload, baseConfig);
  const settingsPath = resolveSettingsPath(projectDir, options);
  const persisted = serializeSavedSettingsSync(settingsPath, normalized);

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  applySecretMapToProcessEnv(normalized.secrets);

  return {
    settingsPath,
    providerDefinitions: listProviderDefinitions(),
    settings: getEditableSettings(projectDir, options).settings
  };
}

export function loadRuntimeConfig(projectDir, options = {}) {
  const envPath = resolve(projectDir, ".env");
  loadEnvFile(envPath);

  const { configPath, settingsPath, settings, mergedConfig: parsed } = applyResolvedSecrets(
    resolveConfigBundle(projectDir, options)
  );
  const configuredSchemes = extractConfiguredSchemes(parsed);
  if (!configuredSchemes.length) {
    throw new Error(`Config file ${configPath} must include either a "models" object or a non-empty "schemes" object.`);
  }

  const requestedSchemeId = String(options?.schemeId || "").trim();
  if (requestedSchemeId && !configuredSchemes.some((scheme) => scheme.id === requestedSchemeId)) {
    throw new Error(`Scheme "${requestedSchemeId}" was not found in saved configuration. Save settings before using this scheme.`);
  }
  const preferredSchemeId = requestedSchemeId || String(parsed?.cluster?.activeSchemeId || "").trim();
  const activeSchemeId = resolveSelectedSchemeId(configuredSchemes, preferredSchemeId);
  const activeScheme =
    configuredSchemes.find((scheme) => scheme.id === activeSchemeId) || configuredSchemes[0];
  const controllerId = String(activeScheme?.controller || "").trim();
  const modelsInput = activeScheme?.models;
  if (!controllerId || !modelsInput || typeof modelsInput !== "object" || !modelsInput[controllerId]) {
    throw new Error(`Selected scheme "${activeScheme?.label || activeSchemeId}" must define a valid controller model.`);
  }

  const models = {};
  for (const [modelId, modelConfig] of Object.entries(modelsInput)) {
    models[modelId] = normalizeModelConfig(modelId, modelConfig, controllerId);
  }

  const workerIds = Object.keys(models).filter((modelId) => modelId !== controllerId);
  if (!workerIds.length) {
    throw new Error(`At least one worker model is required besides the controller.`);
  }

  return {
    projectDir,
    configPath,
    settingsPath,
    server: {
      port: normalizePort(parsed?.server?.port, normalizePort(process.env.PORT, 4040))
    },
    cluster: {
      activeSchemeId,
      activeSchemeLabel: activeScheme.label,
      controller: controllerId,
      maxParallel: normalizeNonNegativeInteger(parsed?.cluster?.maxParallel, 3),
      subordinateMaxParallel: normalizeNonNegativeInteger(
        parsed?.cluster?.subordinateMaxParallel,
        DEFAULT_SUBORDINATE_MAX_PARALLEL
      ),
      groupLeaderMaxDelegates: normalizeNonNegativeInteger(
        parsed?.cluster?.groupLeaderMaxDelegates,
        DEFAULT_GROUP_LEADER_MAX_DELEGATES
      ),
      delegateMaxDepth: normalizeNonNegativeInteger(
        parsed?.cluster?.delegateMaxDepth,
        DEFAULT_DELEGATION_MAX_DEPTH
      ),
      phaseParallel: normalizePhaseParallelSettings(parsed?.cluster?.phaseParallel),
      schemes: configuredSchemes.map((scheme) => ({
        id: scheme.id,
        label: scheme.label,
        controller: scheme.controller,
        modelCount: Object.keys(scheme.models || {}).length
      }))
    },
    workspace: {
      dir: normalizeWorkspaceDir(parsed?.workspace?.dir, DEFAULT_WORKSPACE_DIR),
      resolvedDir: resolve(
        projectDir,
        normalizeWorkspaceDir(parsed?.workspace?.dir, DEFAULT_WORKSPACE_DIR)
      )
    },
    bot: normalizeBotConfig(parsed?.bot),
    models
  };
}

export function summarizeConfig(config) {
  const controller = config.models[config.cluster.controller];
  const workers = Object.values(config.models).filter((model) => model.id !== controller.id);

  return {
    configPath: config.configPath,
    settingsPath: config.settingsPath,
    controller: {
      id: controller.id,
      label: controller.label,
      model: controller.model,
      provider: controller.provider,
      specialties: controller.specialties
    },
    activeScheme: {
      id: config.cluster.activeSchemeId,
      label: config.cluster.activeSchemeLabel
    },
    schemes: config.cluster.schemes || [],
    workers: workers.map((worker) => ({
      id: worker.id,
      label: worker.label,
      model: worker.model,
      provider: worker.provider,
      specialties: worker.specialties
    })),
    maxParallel: config.cluster.maxParallel,
    subordinateMaxParallel: config.cluster.subordinateMaxParallel,
    groupLeaderMaxDelegates: config.cluster.groupLeaderMaxDelegates,
    delegateMaxDepth: config.cluster.delegateMaxDepth,
    phaseParallel: config.cluster.phaseParallel,
    workspace: {
      dir: config.workspace.dir,
      resolvedDir: config.workspace.resolvedDir
    },
    bot: {
      installDir: config.bot.installDir,
      enabledPresets: config.bot.enabledPresets
    }
  };
}

const RAW_PROVIDER_CATALOG = [
  {
    id: "openai-responses",
    label: "OpenAI Responses",
    group: "Global",
    protocol: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: true,
      thinking: true,
      webSearch: true,
      temperature: false
    },
    exampleModels: ["gpt-5.4", "gpt-5.3-codex"],
    description: "Official OpenAI Responses API and compatible gateways."
  },
  {
    id: "openai-chat",
    label: "OpenAI Chat",
    group: "Global",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["gpt-4.1", "gpt-4.1-mini"],
    description: "Chat Completions API and OpenAI-compatible gateways."
  },
  {
    id: "claude-chat",
    label: "Claude",
    group: "Global",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultAuthStyle: "api-key",
    defaultApiKeyHeader: "x-api-key",
    capabilities: {
      reasoning: false,
      thinking: true,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["claude-sonnet-4-5", "claude-opus-4-1"],
    description: "Official Anthropic Messages API."
  },
  {
    id: "qwen-chat",
    label: "Qwen Chat",
    group: "China",
    protocol: "openai-chat",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["qwen-max", "qwen-plus"],
    description: "DashScope OpenAI-compatible chat endpoint for Qwen."
  },
  {
    id: "qwen-responses",
    label: "Qwen Responses",
    group: "China",
    protocol: "openai-responses",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: false
    },
    exampleModels: ["qwen3-max"],
    description: "DashScope OpenAI-compatible Responses endpoint for Qwen."
  },
  {
    id: "kimi-chat",
    label: "Kimi Chat",
    group: "China",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: true,
      webSearch: true,
      temperature: true
    },
    exampleModels: ["kimi-k2.5", "moonshot-v1-32k"],
    description:
      "Moonshot Kimi OpenAI-compatible chat endpoint. Web search uses the official $web_search built-in tool."
  },
  {
    id: "kimi-coding",
    label: "Kimi Coding",
    group: "China",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.moonshot.cn/anthropic",
    defaultAuthStyle: "api-key",
    defaultApiKeyHeader: "x-api-key",
    capabilities: {
      reasoning: false,
      thinking: true,
      webSearch: true,
      temperature: true
    },
    exampleModels: ["kimi-k2.5"],
    description:
      "Moonshot Kimi Coding Anthropic-compatible endpoint. Use the /anthropic base URL and the Anthropic web search tool."
  },
  {
    id: "doubao-chat",
    label: "Doubao Chat",
    group: "China",
    protocol: "openai-chat",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: true
    },
    exampleModels: ["doubao-seed-1.6", "doubao-1.5-pro-32k"],
    description: "Volcengine Ark chat endpoint for Doubao-compatible models."
  },
  {
    id: "doubao-responses",
    label: "Doubao Responses",
    group: "China",
    protocol: "openai-responses",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultAuthStyle: "bearer",
    defaultApiKeyHeader: "",
    capabilities: {
      reasoning: false,
      thinking: false,
      webSearch: false,
      temperature: false
    },
    exampleModels: ["doubao-seed-1.6"],
    description: "Volcengine Ark Responses-compatible endpoint."
  }
];

export const DEFAULT_PROVIDER_ID = "openai-chat";

export const PROVIDER_CATALOG = Object.freeze(
  RAW_PROVIDER_CATALOG.map((entry) =>
    Object.freeze({
      ...entry,
      exampleModels: Object.freeze([...(entry.exampleModels || [])]),
      capabilities: Object.freeze({
        reasoning: Boolean(entry.capabilities?.reasoning),
        thinking: Boolean(entry.capabilities?.thinking),
        webSearch: Boolean(entry.capabilities?.webSearch),
        temperature: Boolean(entry.capabilities?.temperature)
      })
    })
  )
);

const PROVIDER_BY_ID = new Map(PROVIDER_CATALOG.map((entry) => [entry.id, entry]));

export function normalizeProviderId(value) {
  return String(value || "").trim();
}

export function getProviderDefinition(providerId) {
  return PROVIDER_BY_ID.get(normalizeProviderId(providerId)) || null;
}

export function getSupportedProviderIds() {
  return PROVIDER_CATALOG.map((entry) => entry.id);
}

export function isSupportedProvider(providerId) {
  return PROVIDER_BY_ID.has(normalizeProviderId(providerId));
}

export function resolveProviderProtocol(providerId) {
  const definition = getProviderDefinition(providerId);
  return definition?.protocol || normalizeProviderId(providerId);
}

export function providerSupportsCapability(providerId, capability) {
  const definition = getProviderDefinition(providerId);
  return Boolean(definition?.capabilities?.[capability]);
}

export function listProviderDefinitions() {
  return PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    exampleModels: [...entry.exampleModels],
    capabilities: { ...entry.capabilities }
  }));
}

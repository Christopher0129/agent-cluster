import { createProviderForModel } from "./factory.mjs";
import { parseJsonFromText } from "../utils/json-output.mjs";
import {
  isSupportedProvider,
  providerSupportsCapability
} from "../static/provider-catalog.js";

const SUPPORTED_AUTH_STYLES = new Set(["bearer", "api-key", "none"]);
const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const THINKING_PROBE_REPLY = "THINKING_OK";
const WEB_SEARCH_PROBE_QUERY = "OpenAI API";

function mapSecrets(entries) {
  const secrets = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }
    secrets[name] = String(entry?.value || "");
  }
  return secrets;
}

function normalizeModelInput(payload) {
  const source = payload?.model || {};
  const provider = String(source.provider || "").trim();
  const model = String(source.model || "").trim();
  const baseUrl = String(source.baseUrl || "").trim().replace(/\/+$/, "");
  const authStyle = String(source.authStyle || "bearer").trim();
  const apiKeyEnv = String(source.apiKeyEnv || "").trim();
  const apiKeyValue = String(source.apiKeyValue || "").trim();
  const secrets = mapSecrets(payload?.secrets);

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider "${provider}".`);
  }
  if (!model) {
    throw new Error("Model name is required.");
  }
  if (!baseUrl) {
    throw new Error("Base URL is required.");
  }
  if (!SUPPORTED_AUTH_STYLES.has(authStyle)) {
    throw new Error(`Unsupported authStyle "${authStyle}".`);
  }

  const normalized = {
    id: String(source.id || "connectivity_test_model").trim() || "connectivity_test_model",
    label: String(source.label || source.id || model).trim() || model,
    provider,
    model,
    baseUrl,
    authStyle,
    apiKeyEnv,
    apiKeyHeader: String(source.apiKeyHeader || "").trim(),
    maxOutputTokens: 24,
    timeoutMs: 60000
  };

  const reasoningEffort = normalizeReasoningEffort(source.reasoningEffort || source.reasoning?.effort);
  const thinkingEnabled = inferThinkingEnabled(source, provider);

  if (providerSupportsCapability(provider, "thinking")) {
    normalized.thinkingEnabled = thinkingEnabled;
  }

  if (providerSupportsCapability(provider, "reasoning") && thinkingEnabled) {
    normalized.reasoning = { effort: reasoningEffort || "medium" };
  }

  if (providerSupportsCapability(provider, "webSearch")) {
    normalized.webSearch = Boolean(source.webSearch);
  }

  if (providerSupportsCapability(provider, "temperature")) {
    const temperatureValue = String(source.temperature ?? "").trim();
    if (temperatureValue) {
      const temperature = Number(temperatureValue);
      if (!Number.isFinite(temperature)) {
        throw new Error(`Invalid temperature "${temperatureValue}".`);
      }
      normalized.temperature = temperature;
    }
  }

  if (authStyle !== "none") {
    const resolvedApiKey = apiKeyValue || (apiKeyEnv ? secrets[apiKeyEnv] || process.env[apiKeyEnv] || "" : "");
    if (!resolvedApiKey) {
      throw new Error(
        `No API key found for model "${normalized.id}". Fill API Key in the model card or provide a matching value for ${apiKeyEnv || "the configured key variable"}.`
      );
    }
    normalized.apiKey = resolvedApiKey;
  }

  return normalized;
}

function normalizeReasoningEffort(value, fallback = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return SUPPORTED_REASONING_EFFORTS.has(normalized) ? normalized : fallback;
}

function inferThinkingEnabled(source, provider) {
  if (!providerSupportsCapability(provider, "thinking")) {
    return false;
  }

  if (typeof source?.thinkingEnabled === "boolean") {
    return source.thinkingEnabled;
  }

  if (typeof source?.thinking === "boolean") {
    return source.thinking;
  }

  if (source?.thinking && typeof source.thinking === "object") {
    if (typeof source.thinking.enabled === "boolean") {
      return source.thinking.enabled;
    }

    const thinkingType = String(source.thinking.type || "")
      .trim()
      .toLowerCase();
    if (thinkingType === "enabled") {
      return true;
    }
    if (thinkingType === "disabled") {
      return false;
    }
  }

  if (providerSupportsCapability(provider, "reasoning")) {
    return Boolean(normalizeReasoningEffort(source?.reasoningEffort || source?.reasoning?.effort));
  }

  return false;
}

function createProbeProvider(modelConfig, overrides = {}) {
  return createProviderForModel({
    ...modelConfig,
    ...overrides
  });
}

function summarizeBasicReply(response) {
  const text = String(response?.text || "").trim();
  if (text) {
    return text;
  }

  const statusHint = String(
    response?.raw?.choices?.[0]?.finish_reason ||
      response?.raw?.status ||
      response?.raw?.output?.[0]?.status ||
      ""
  ).trim();
  if (statusHint) {
    return `[empty text response; status=${statusHint}]`;
  }

  return "[empty text response; request completed successfully]";
}

function createThinkingProbePrompt() {
  return {
    instructions: [
      "You are a thinking-mode connectivity probe for an agent cluster.",
      `Do any internal reasoning you need, then reply with exactly ${THINKING_PROBE_REPLY}.`,
      "Do not return JSON. Do not add any other text."
    ].join(" "),
    input: [
      "Quick reasoning task:",
      "1. Confirm whether 1, 1, 2, 3, 5 follows the Fibonacci pattern.",
      "2. Confirm whether reversing that sequence changes its last element.",
      `After reasoning, reply with exactly ${THINKING_PROBE_REPLY}.`
    ].join("\n")
  };
}

function createWorkflowProbePrompt(modelConfig, mode = "strict") {
  if (mode === "fallback") {
    return {
      instructions: [
        "You are a compact workflow connectivity probe.",
        "Return one compact JSON object only.",
        'Schema: {"status":"ok","usedWebSearch":true|false,"checks":["string"],"query":"string","marker":"string","note":"string"}'
      ].join(" "),
      input: [
        "Reply with valid JSON only.",
        `Set checks to ["fallback:${modelConfig.model}"].`,
        modelConfig.webSearch
          ? `If web search is enabled, use it exactly once for "${WEB_SEARCH_PROBE_QUERY}".`
          : "Do not browse.",
        `Set usedWebSearch to ${modelConfig.webSearch ? "true only if search actually ran, otherwise false" : "false"}.`,
        `Set query to ${modelConfig.webSearch ? `"${WEB_SEARCH_PROBE_QUERY}" when search ran, otherwise ""` : '""'}.`,
        "Set marker to one short hostname or title fragment.",
        "Keep note short."
      ].join("\n")
    };
  }

  return {
    instructions: [
      "You are a compact workflow connectivity probe.",
      "Return JSON only.",
      "Return one valid JSON object that matches the schema exactly.",
      modelConfig.webSearch
        ? `If web search is enabled for this model, use it exactly once for "${WEB_SEARCH_PROBE_QUERY}" before answering.`
        : "Do not browse.",
      'Schema: {"status":"ok","usedWebSearch":true|false,"checks":["string"],"query":"string","marker":"string","note":"string"}'
    ].join(" "),
    input: [
      "Return one compact JSON object only.",
      `Set checks to ["structured:${modelConfig.model}"${modelConfig.webSearch ? ',"web-search"' : ',"no-web-search"'}].`,
      modelConfig.webSearch
        ? `Use web search exactly once for "${WEB_SEARCH_PROBE_QUERY}". Set usedWebSearch to true only if search actually ran.`
        : "Set usedWebSearch to false.",
      `Set query to ${modelConfig.webSearch ? `"${WEB_SEARCH_PROBE_QUERY}" when search ran, otherwise ""` : '""'}.`,
      "Set marker to one short hostname or title fragment.",
      "Keep note under 8 words."
    ].join("\n")
  };
}

function normalizeWorkflowProbePayload(parsed) {
  if (String(parsed?.status || "").trim().toLowerCase() !== "ok") {
    throw new Error('Workflow probe returned JSON, but "status" was not "ok".');
  }
  if (!Array.isArray(parsed?.checks)) {
    throw new Error('Workflow probe returned JSON, but "checks" was not an array.');
  }

  return {
    reportedWebSearch: Boolean(parsed?.usedWebSearch),
    usedWebSearch: Boolean(parsed?.usedWebSearch),
    checks: parsed.checks.map((item) => String(item || "").trim()).filter(Boolean),
    query: String(parsed?.query || "").trim(),
    marker: String(parsed?.marker || "").trim(),
    note: String(parsed?.note || "").trim()
  };
}

function detectChatWebSearch(raw) {
  return Array.isArray(raw?.choices)
    ? raw.choices.some((choice) =>
        Array.isArray(choice?.message?.tool_calls)
          ? choice.message.tool_calls.some(
              (toolCall) =>
                String(toolCall?.function?.name || "")
                  .trim()
                  .toLowerCase() === "$web_search"
            )
          : false
      )
    : false;
}

function detectResponsesWebSearch(raw) {
  if (
    Array.isArray(raw?.output) &&
    raw.output.some((item) =>
      String(item?.type || "")
        .trim()
        .toLowerCase()
        .includes("web_search")
    )
  ) {
    return true;
  }

  return Array.isArray(raw?.output)
    ? raw.output.some((item) =>
        Array.isArray(item?.content)
          ? item.content.some((content) =>
              Array.isArray(content?.annotations)
                ? content.annotations.some((annotation) => {
                    const type = String(annotation?.type || "")
                      .trim()
                      .toLowerCase();
                    return type.includes("web_search") || type.includes("citation");
                  })
                : false
            )
          : false
      )
    : false;
}

function detectAnthropicWebSearch(raw) {
  return Array.isArray(raw?.content)
    ? raw.content.some((item) => {
        const type = String(item?.type || "")
          .trim()
          .toLowerCase();
        const name = String(item?.name || item?.tool_name || "")
          .trim()
          .toLowerCase();
        return (
          type.includes("web_search") ||
          name.includes("web_search") ||
          (type.includes("tool") && name.includes("search"))
        );
      })
    : false;
}

function detectWebSearchEvidence(modelConfig, response) {
  if (response?.meta?.webSearchObserved) {
    return {
      observed: true,
      confirmationMethod: "tool_trace"
    };
  }

  const raw = response?.raw;
  const provider = String(modelConfig?.provider || "").trim();
  let observed = false;
  if (provider === "openai-responses") {
    observed = detectResponsesWebSearch(raw);
  } else if (provider === "claude-chat" || provider === "kimi-coding") {
    observed = detectAnthropicWebSearch(raw);
  } else {
    observed = detectChatWebSearch(raw) || detectResponsesWebSearch(raw) || detectAnthropicWebSearch(raw);
  }

  return {
    observed,
    confirmationMethod: observed ? "response_trace" : ""
  };
}

function detectResponsesThinking(raw) {
  if (Array.isArray(raw?.output) && raw.output.some((item) => String(item?.type || "").toLowerCase() === "reasoning")) {
    return true;
  }

  return false;
}

function detectChatThinking(raw) {
  const choice = raw?.choices?.[0];
  const reasoningContent = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    return true;
  }
  if (Array.isArray(reasoningContent) && reasoningContent.length) {
    return true;
  }

  const content = choice?.message?.content;
  if (
    Array.isArray(content) &&
    content.some(
      (item) =>
        String(item?.type || "").toLowerCase().includes("reasoning") &&
        typeof item?.text === "string" &&
        item.text.trim()
    )
  ) {
    return true;
  }

  return false;
}

function detectAnthropicThinking(raw) {
  return Array.isArray(raw?.content)
    ? raw.content.some((item) =>
        ["thinking", "redacted_thinking"].includes(String(item?.type || "").toLowerCase())
      )
    : false;
}

function detectThinkingEvidence(modelConfig, raw) {
  const provider = String(modelConfig?.provider || "").trim();
  if (provider === "openai-responses") {
    return detectResponsesThinking(raw);
  }
  if (provider === "claude-chat" || provider === "kimi-coding") {
    return detectAnthropicThinking(raw);
  }
  return detectChatThinking(raw) || detectResponsesThinking(raw) || detectAnthropicThinking(raw);
}

function assessWorkflowProbe(modelConfig, workflowProbe) {
  const webSearchEnabled = Boolean(modelConfig?.webSearch);
  const webSearchUsed = Boolean(workflowProbe?.usedWebSearch);
  const webSearchVerified = webSearchEnabled && webSearchUsed;
  const degradedBecauseWebSearch = webSearchEnabled && !webSearchUsed;
  const thinkingEnabled = Boolean(modelConfig?.thinkingEnabled);
  const thinkingVerified = thinkingEnabled && Boolean(workflowProbe?.thinkingProbe?.verified);
  const degradedBecauseThinking = thinkingEnabled && !thinkingVerified;
  const degraded =
    Boolean(workflowProbe?.degraded) || degradedBecauseWebSearch || degradedBecauseThinking;

  let summary = "";
  if (degradedBecauseWebSearch && degradedBecauseThinking) {
    summary =
      "Basic probe passed, but the workflow checks did not confirm that either web search or thinking mode executed successfully on this model.";
  } else if (degradedBecauseWebSearch) {
    summary =
      "Basic probe passed, but the workflow probe did not confirm that web search executed successfully on this model.";
  } else if (degradedBecauseThinking) {
    summary =
      "Basic probe passed, but the workflow checks did not confirm that thinking mode executed successfully on this model.";
  } else if (workflowProbe?.degraded) {
    summary =
      "Basic probe passed. Workflow probe was downgraded because the model did not return stable structured text to the diagnostic prompt.";
  } else if (webSearchVerified && thinkingVerified) {
    summary =
      "Basic probe + workflow probe passed. Structured JSON, web-search availability, and thinking mode were verified.";
  } else if (webSearchVerified) {
    summary =
      "Basic probe + workflow probe passed. Structured JSON and web-search availability were verified.";
  } else if (thinkingVerified) {
    summary =
      "Basic probe + workflow probe passed. Structured JSON and thinking mode were verified.";
  } else if (workflowProbe?.mode === "fallback") {
    summary = "Basic probe passed. Workflow probe succeeded with a compatibility fallback.";
  } else {
    summary = "Basic probe + workflow probe passed.";
  }

  return {
    degraded,
    summary,
    webSearch: {
      enabled: webSearchEnabled,
      used: webSearchUsed,
      verified: webSearchVerified,
      confirmationMethod:
        String(workflowProbe?.webSearchEvidence?.confirmationMethod || "").trim() ||
        (workflowProbe?.reportedWebSearch ? "probe_report" : ""),
      query: String(workflowProbe?.query || "").trim(),
      marker: String(workflowProbe?.marker || "").trim()
    },
    thinking: {
      enabled: thinkingEnabled,
      verified: thinkingVerified,
      error: String(workflowProbe?.thinkingProbe?.error || "").trim()
    }
  };
}

function isRecoverableWorkflowProbeError(error) {
  const message = String(error?.message || error || "").trim().toLowerCase();
  return (
    message.includes("returned no text output") ||
    message.includes("empty text cannot be parsed as json") ||
    message.includes("no json object or array found in model output")
  );
}

async function runBasicProbe(modelConfig, runtimeOptions = {}) {
  const provider = createProbeProvider(modelConfig, {
    maxOutputTokens: 32,
    timeoutMs: Math.max(60000, Number(modelConfig.timeoutMs) || 60000)
  });

  const response = await provider.invoke({
    instructions: "You are a connectivity test endpoint. Reply with exactly OK.",
    input: "Connectivity test. Reply with OK only.",
    purpose: "connectivity_test_basic",
    onRetry: runtimeOptions.onRetry,
    allowEmptyText: true
  });

  return summarizeBasicReply(response);
}

async function runWorkflowProbeVariant(modelConfig, runtimeOptions = {}, mode = "strict") {
  const provider = createProbeProvider(modelConfig, {
    maxOutputTokens: mode === "fallback" ? 80 : 96,
    timeoutMs: Math.max(90000, Number(modelConfig.timeoutMs) || 90000)
  });
  const prompt = createWorkflowProbePrompt(modelConfig, mode);

  const response = await provider.invoke({
    instructions: prompt.instructions,
    input: prompt.input,
    purpose: "connectivity_test_workflow",
    onRetry: runtimeOptions.onRetry
  });

  const parsed = parseJsonFromText(response.text);
  const normalized = normalizeWorkflowProbePayload(parsed);
  const webSearchEvidence = detectWebSearchEvidence(modelConfig, response);

  return {
    ...normalized,
    usedWebSearch: normalized.usedWebSearch || webSearchEvidence.observed,
    webSearchEvidence
  };
}

async function runWorkflowProbe(modelConfig, runtimeOptions = {}) {
  try {
    const strictResult = await runWorkflowProbeVariant(modelConfig, runtimeOptions, "strict");
    return {
      ...strictResult,
      mode: "strict",
      degraded: false
    };
  } catch (error) {
    if (!isRecoverableWorkflowProbeError(error)) {
      throw error;
    }

    try {
      const fallbackResult = await runWorkflowProbeVariant(modelConfig, runtimeOptions, "fallback");
      return {
        ...fallbackResult,
        mode: "fallback",
        degraded: false,
        fallbackReason: error.message
      };
    } catch (fallbackError) {
      if (!isRecoverableWorkflowProbeError(fallbackError)) {
        throw fallbackError;
      }

      return {
        usedWebSearch: false,
        reportedWebSearch: false,
        checks: [`basic:${modelConfig.model}`],
        query: "",
        marker: "",
        note: `Workflow probe degraded: ${fallbackError.message}`,
        webSearchEvidence: {
          observed: false,
          confirmationMethod: ""
        },
        mode: "degraded",
        degraded: true,
        fallbackReason: error.message
      };
    }
  }
}

async function runThinkingProbe(modelConfig, runtimeOptions = {}) {
  const provider = createProbeProvider(
    {
      ...modelConfig,
      webSearch: false
    },
    {
      maxOutputTokens: Math.max(512, Number(modelConfig.maxOutputTokens) || 512),
      timeoutMs: Math.max(90000, Number(modelConfig.timeoutMs) || 90000)
    }
  );
  const prompt = createThinkingProbePrompt();

  try {
    const response = await provider.invoke({
      instructions: prompt.instructions,
      input: prompt.input,
      purpose: "connectivity_test_thinking",
      onRetry: runtimeOptions.onRetry
    });

    return {
      verified:
        String(response.text || "").trim() === THINKING_PROBE_REPLY &&
        detectThinkingEvidence(modelConfig, response.raw),
      reply: String(response.text || "").trim(),
      error: ""
    };
  } catch (error) {
    return {
      verified: false,
      reply: "",
      error: error.message
    };
  }
}

export async function testModelConnectivity(payload, runtimeOptions = {}) {
  const modelConfig = normalizeModelInput(payload);
  const basicReply = await runBasicProbe(modelConfig, runtimeOptions);
  let workflowProbe;

  try {
    workflowProbe = await runWorkflowProbe(modelConfig, runtimeOptions);
  } catch (error) {
    throw new Error(`Basic probe passed, but workflow probe failed: ${error.message}`);
  }

  const thinkingProbe = modelConfig.thinkingEnabled
    ? await runThinkingProbe(modelConfig, runtimeOptions)
    : null;
  if (thinkingProbe) {
    workflowProbe.thinkingProbe = thinkingProbe;
  }

  const assessment = assessWorkflowProbe(modelConfig, workflowProbe);

  return {
    ok: true,
    degraded: assessment.degraded,
    model: {
      id: modelConfig.id,
      label: modelConfig.label,
      provider: modelConfig.provider,
      endpoint: modelConfig.baseUrl
    },
    reply: basicReply.slice(0, 120),
    summary: assessment.summary,
    diagnostics: {
      workflowProbe,
      webSearch: assessment.webSearch,
      thinking: assessment.thinking
    }
  };
}

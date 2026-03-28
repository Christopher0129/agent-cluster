import { createProviderForModel } from "./factory.mjs";
import { parseJsonFromText } from "../utils/json-output.mjs";
import {
  isSupportedProvider,
  providerSupportsCapability
} from "../static/provider-catalog.js";

const SUPPORTED_AUTH_STYLES = new Set(["bearer", "api-key", "none"]);

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

  if (providerSupportsCapability(provider, "reasoning")) {
    const reasoningEffort = String(source.reasoningEffort || "").trim();
    if (reasoningEffort) {
      normalized.reasoning = { effort: reasoningEffort };
    }
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

function createWorkflowProbePrompt(modelConfig, mode = "strict") {
  if (mode === "fallback") {
    return {
      instructions: [
        "You are a workflow connectivity probe for an agent cluster.",
        "Return one compact JSON object only.",
        'Schema: {"status":"ok","usedWebSearch":true|false,"checks":["string"],"note":"string"}'
      ].join(" "),
      input: [
        "Reply with valid JSON only.",
        `Set checks to ["fallback:${modelConfig.model}"].`,
        `Set usedWebSearch to ${modelConfig.webSearch ? "true only if you actually used it, otherwise false" : "false"}.`,
        "Keep note short."
      ].join("\n")
    };
  }

  return {
    instructions: [
      "You are a workflow connectivity probe for an agent cluster.",
      "Return JSON only.",
      "Your response must be valid JSON that matches the schema exactly.",
      "Provide compact, execution-safe text.",
      modelConfig.webSearch
        ? "If web search is enabled for this model, use it before answering when possible, then report whether web search was used."
        : "Do not browse; just return the JSON payload.",
      'Schema: {"status":"ok","usedWebSearch":true|false,"checks":["string"],"note":"string"}'
    ].join(" "),
    input: [
      "Simulate a small but realistic agent workflow step.",
      "Task: confirm that this endpoint can handle structured JSON output suitable for delegation, synthesis, and status reporting.",
      "Keep the response concise and machine-readable.",
      modelConfig.webSearch
        ? "When possible, actually use web search once before answering. If search is unavailable, still return JSON and set usedWebSearch to false."
        : "No web search is required for this probe."
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
    usedWebSearch: Boolean(parsed?.usedWebSearch),
    checks: parsed.checks.map((item) => String(item || "").trim()).filter(Boolean),
    note: String(parsed?.note || "").trim()
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
    maxOutputTokens: mode === "fallback" ? 96 : 160,
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
  return normalizeWorkflowProbePayload(parsed);
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
        checks: [`basic:${modelConfig.model}`],
        note: `Workflow probe degraded: ${fallbackError.message}`,
        mode: "degraded",
        degraded: true,
        fallbackReason: error.message
      };
    }
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

  return {
    ok: true,
    degraded: Boolean(workflowProbe?.degraded),
    model: {
      id: modelConfig.id,
      label: modelConfig.label,
      provider: modelConfig.provider,
      endpoint: modelConfig.baseUrl
    },
    reply: basicReply.slice(0, 120),
    summary: workflowProbe?.degraded
      ? "Basic probe passed. Workflow probe was downgraded because the model did not return stable structured text to the diagnostic prompt."
      : modelConfig.webSearch
        ? "Basic probe + workflow probe passed. Structured JSON and web-search path were checked."
        : workflowProbe?.mode === "fallback"
          ? "Basic probe passed. Workflow probe succeeded with a compatibility fallback."
          : "Basic probe + workflow probe passed.",
    diagnostics: {
      workflowProbe
    }
  };
}

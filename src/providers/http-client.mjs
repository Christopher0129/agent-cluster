import {
  abortableSleep,
  createAbortError,
  getAbortMessage,
  isAbortError,
  throwIfAborted
} from "../utils/abort.mjs";

function resolveApiKey(modelConfig) {
  if (modelConfig.apiKey) {
    return modelConfig.apiKey;
  }

  if (modelConfig.apiKeyEnv && process.env[modelConfig.apiKeyEnv]) {
    return process.env[modelConfig.apiKeyEnv];
  }

  if (modelConfig.authStyle === "none") {
    return "";
  }

  throw new Error(
    `Model "${modelConfig.id}" requires an API key. Set ${modelConfig.apiKeyEnv || "apiKey"} first.`
  );
}

function buildHeaders(modelConfig) {
  const headers = {
    "Content-Type": "application/json",
    ...(modelConfig.extraHeaders || {})
  };

  const authStyle = modelConfig.authStyle || "bearer";
  if (authStyle === "none" && modelConfig.apiKeyEnv) {
    throw new Error(
      `Model "${modelConfig.id}" is configured with authStyle "none", so no API key will be sent to ${modelConfig.baseUrl}. Change authStyle to "bearer" or "api-key", or clear apiKeyEnv if the endpoint is intentionally unauthenticated.`
    );
  }

  const apiKey = resolveApiKey(modelConfig);

  if (authStyle === "bearer") {
    headers.Authorization = `Bearer ${apiKey}`;
  } else if (authStyle === "api-key") {
    headers[modelConfig.apiKeyHeader || "api-key"] = apiKey;
  } else if (authStyle !== "none") {
    throw new Error(`Unsupported authStyle "${authStyle}" on model "${modelConfig.id}".`);
  }

  return headers;
}

function isCodexLikeModel(modelConfig) {
  return /codex/i.test(String(modelConfig?.model || modelConfig?.id || ""));
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529].includes(status);
}

function isRetryableNetworkError(error) {
  if (!error) {
    return false;
  }

  if (isAbortError(error)) {
    return false;
  }

  if (error.timeout) {
    return true;
  }

  const detail = `${error.message || ""} ${error.cause?.code || ""} ${error.cause?.message || ""}`.toLowerCase();
  return /fetch failed|network|timed out|timeout|econnreset|econnrefused|socket|enotfound|eai_again|other side closed/.test(
    detail
  );
}

function resolveRetryAttempts(modelConfig) {
  const explicit = Number(modelConfig.retryAttempts);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }

  return 10;
}

function resolveRetryBaseMs(modelConfig) {
  const explicit = Number(modelConfig.retryBaseMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  return isCodexLikeModel(modelConfig) ? 1500 : 800;
}

function resolveRetryMaxMs(modelConfig) {
  const explicit = Number(modelConfig.retryMaxMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  return isCodexLikeModel(modelConfig) ? 15000 : 10000;
}

function parseRetryAfterMs(headerValue) {
  const value = String(headerValue || "").trim();
  if (!value) {
    return 0;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return 0;
}

function computeRetryDelayMs(modelConfig, attempt, error) {
  const baseMs = resolveRetryBaseMs(modelConfig);
  const maxMs = resolveRetryMaxMs(modelConfig);
  const exponentialMs = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitterMs = Math.round(exponentialMs * 0.2 * Math.random());
  const retryAfterMs = Math.min(maxMs, Math.max(0, Number(error?.retryAfterMs || 0)));
  return Math.max(exponentialMs + jitterMs, retryAfterMs);
}

function isHtmlPayload(response, responseText) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const trimmed = String(responseText || "").trim().toLowerCase();
  return contentType.includes("text/html") || trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function summarizeHtmlGatewayError(response, url, responseText) {
  const titleMatch = String(responseText || "").match(/<title>([^<]+)<\/title>/i);
  const title = compactWhitespace(titleMatch?.[1] || "");
  const status = response.status;
  const summary = title || `HTTP ${status}`;
  return `Request to ${url} failed: upstream gateway returned ${status}${summary ? ` (${summary})` : ""}. This usually means the provider base URL is temporarily down or its upstream model service failed.`;
}

function summarizeHtmlNonApiError(response, url, responseText) {
  const titleMatch = String(responseText || "").match(/<title>([^<]+)<\/title>/i);
  const title = compactWhitespace(titleMatch?.[1] || "");
  const status = Number(response?.status) || 0;
  const prefix = status > 0 ? `HTTP ${status}` : "HTML page";
  const summary = title ? ` (${title})` : "";
  return `Request to ${url} failed: the provider returned an HTML page instead of API JSON${summary || ` (${prefix})`}. This usually means the base URL is behind browser protection, points to a website page instead of the API endpoint, or the reverse proxy gateway is misconfigured.`;
}

function isMoonshotResponsesRoute(urlOrBaseUrl) {
  return /^https:\/\/api\.moonshot\.cn\/v1(?:\/responses)?$/i.test(String(urlOrBaseUrl || "").replace(/\/+$/, ""));
}

function isMoonshotAnthropicMisroute(urlOrBaseUrl) {
  return /^https:\/\/api\.moonshot\.cn\/v1(?:\/messages)?$/i.test(
    String(urlOrBaseUrl || "").replace(/\/+$/, "")
  );
}

function buildMoonshotResponsesHint(modelConfig, url, response, parsedBody, responseText) {
  if (!isMoonshotResponsesRoute(url) && !isMoonshotResponsesRoute(modelConfig?.baseUrl)) {
    return "";
  }

  const status = Number(response?.status) || 0;
  const detail = `${parsedBody?.error?.message || ""} ${parsedBody?.message || ""} ${responseText || ""}`.trim();
  if (status !== 404 && !/没找到对象|not found|404/i.test(detail)) {
    return "";
  }

  return ' Moonshot 的公开 API 通常走 "/chat/completions"。如果你当前 baseUrl 是 "https://api.moonshot.cn/v1"，请把 provider 改成 "openai-chat"，不要选 "openai-responses"。';
}

function buildMoonshotAnthropicHint(modelConfig, url, response, parsedBody, responseText) {
  const provider = String(modelConfig?.provider || "").trim().toLowerCase();
  if (
    provider !== "kimi-coding" &&
    !isMoonshotAnthropicMisroute(url) &&
    !isMoonshotAnthropicMisroute(modelConfig?.baseUrl)
  ) {
    return "";
  }

  const status = Number(response?.status) || 0;
  const detail = `${parsedBody?.error?.message || ""} ${parsedBody?.message || ""} ${responseText || ""}`.trim();
  if (status !== 404 && !/没找到对象|not found|404/i.test(detail)) {
    return "";
  }

  return ' Moonshot 的 Anthropic 兼容接口通常走 "https://api.moonshot.cn/anthropic/messages"。如果你在使用 Kimi Coding / Claude Code 兼容路由，请把 baseUrl 改成 "https://api.moonshot.cn/anthropic"。';
}

function buildErrorMessage(response, url, responseText, parsedBody, modelConfig) {
  if (isHtmlPayload(response, responseText) && isRetryableStatus(response.status)) {
    return summarizeHtmlGatewayError(response, url, responseText);
  }

  if (isHtmlPayload(response, responseText)) {
    return summarizeHtmlNonApiError(response, url, responseText);
  }

  const detail =
    parsedBody?.error?.message ||
    parsedBody?.message ||
    compactWhitespace(responseText).slice(0, 300) ||
    `HTTP ${response.status}`;

  return `Request to ${url} failed: ${detail}${buildMoonshotResponsesHint(modelConfig, url, response, parsedBody, responseText)}${buildMoonshotAnthropicHint(modelConfig, url, response, parsedBody, responseText)}`;
}

function createTimeoutError(url, timeoutMs, cause = undefined) {
  const error = new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
  error.name = "TimeoutError";
  error.timeout = true;
  error.status = 408;
  error.retryable = true;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

async function postJsonOnce(url, body, modelConfig, hooks = {}) {
  const externalSignal = hooks.signal;
  throwIfAborted(externalSignal);

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(modelConfig.timeoutMs || 210000));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError(url, timeoutMs));
  }, timeoutMs);

  const forwardAbort = () => {
    controller.abort(externalSignal?.reason || createAbortError(getAbortMessage(externalSignal)));
  };

  externalSignal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: buildHeaders(modelConfig),
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (externalSignal?.aborted && !timedOut) {
        throw createAbortError(getAbortMessage(externalSignal), error);
      }

      if (timedOut) {
        throw createTimeoutError(url, timeoutMs, error);
      }

      const wrapped = new Error(
        `Request to ${url} failed: ${error.message}`
      );
      wrapped.retryable = isRetryableNetworkError(error);
      wrapped.cause = error;
      throw wrapped;
    }

    const responseText = await response.text();
    if (isHtmlPayload(response, responseText)) {
      const error = new Error(
        isRetryableStatus(response.status)
          ? summarizeHtmlGatewayError(response, url, responseText)
          : summarizeHtmlNonApiError(response, url, responseText)
      );
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      error.retryable = response.ok ? true : undefined;
      throw error;
    }

    let parsedBody = null;
    try {
      parsedBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      parsedBody = { raw: responseText };
    }

    if (!response.ok) {
      const error = new Error(buildErrorMessage(response, url, responseText, parsedBody, modelConfig));
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw error;
    }

    return parsedBody;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

export async function postJson(url, body, modelConfig, hooks = {}) {
  throwIfAborted(hooks.signal);
  const retries = resolveRetryAttempts(modelConfig);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postJsonOnce(url, body, modelConfig, hooks);
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) {
        throw error;
      }
      const retryable = Boolean(error.retryable) || isRetryableStatus(error.status);
      if (!retryable || attempt === retries) {
        if (attempt > 0) {
          error.message = `${error.message} Retried ${attempt} time${attempt === 1 ? "" : "s"}.`;
        }
        throw error;
      }

      const backoffMs = computeRetryDelayMs(modelConfig, attempt, error);
      if (typeof hooks.onRetry === "function") {
        hooks.onRetry({
          attempt: attempt + 1,
          maxRetries: retries,
          nextDelayMs: backoffMs,
          status: error.status || null,
          message: error.message,
          modelId: modelConfig.id,
          model: modelConfig.model,
          baseUrl: modelConfig.baseUrl,
          purpose: hooks.purpose || null
        });
      }
      await abortableSleep(backoffMs, hooks.signal);
    }
  }

  throw lastError;
}

import { postJson } from "./http-client.mjs";
import { providerSupportsCapability } from "../static/provider-catalog.js";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const MAX_SERVER_TOOL_TURNS = 6;
const THINKING_BUDGET_BY_EFFORT = Object.freeze({
  low: 1024,
  medium: 2048,
  high: 3072,
  xhigh: 4096
});

function buildMessageContent(input) {
  if (Array.isArray(input)) {
    return [
      {
        type: "text",
        text: JSON.stringify(input)
      }
    ];
  }

  return [
    {
      type: "text",
      text: String(input || "")
    }
  ];
}

function extractTextFromAnthropicResponse(response) {
  const parts = [];

  for (const item of response?.content || []) {
    if (item?.type === "text" && typeof item?.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.join("\n").trim();
}

function hasStructuredAnthropicResponse(response) {
  return Array.isArray(response?.content) || typeof response?.id === "string";
}

function responseMentionsAnthropicWebSearch(response) {
  return Array.isArray(response?.content)
    ? response.content.some((item) => {
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

function buildAnthropicWebSearchTools(modelConfig) {
  if (!modelConfig?.webSearch) {
    return null;
  }

  return [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3
    }
  ];
}

function resolveThinkingEffort(modelConfig) {
  return String(modelConfig?.reasoning?.effort || modelConfig?.reasoningEffort || "")
    .trim()
    .toLowerCase();
}

function buildAnthropicThinkingConfig(modelConfig) {
  if (!providerSupportsCapability(modelConfig?.provider, "thinking") || !modelConfig?.thinkingEnabled) {
    return null;
  }

  const effort = resolveThinkingEffort(modelConfig) || "medium";
  const requestedBudget =
    THINKING_BUDGET_BY_EFFORT[effort] || THINKING_BUDGET_BY_EFFORT.medium;

  return {
    type: "enabled",
    budget_tokens: requestedBudget
  };
}

export class AnthropicMessagesProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/messages`;
    const messages = [
      {
        role: "user",
        content: buildMessageContent(input)
      }
    ];
    const tools = buildAnthropicWebSearchTools(this.modelConfig);
    let lastRaw = null;
    let serverToolTurns = 0;
    let webSearchObserved = false;

    for (let turn = 0; turn < MAX_SERVER_TOOL_TURNS; turn += 1) {
      const requestedMaxTokens = Math.max(
        64,
        Number(this.modelConfig.maxOutputTokens || DEFAULT_MAX_TOKENS)
      );
      const thinking = buildAnthropicThinkingConfig(this.modelConfig);
      const body = {
        model: this.modelConfig.model,
        max_tokens: thinking
          ? Math.max(requestedMaxTokens, Number(thinking.budget_tokens || 0) + 512)
          : requestedMaxTokens,
        messages
      };

      if (typeof instructions === "string" && instructions.trim()) {
        body.system = instructions.trim();
      }

      if (typeof this.modelConfig.temperature === "number") {
        body.temperature = this.modelConfig.temperature;
      }

      if (tools) {
        body.tools = tools;
      }

      if (thinking) {
        body.thinking = thinking;
      }

      lastRaw = await postJson(
        endpoint,
        body,
        {
          ...this.modelConfig,
          authStyle: this.modelConfig.authStyle || "api-key",
          apiKeyHeader: this.modelConfig.apiKeyHeader || "x-api-key",
          extraHeaders: {
            "anthropic-version":
              this.modelConfig.anthropicVersion || DEFAULT_ANTHROPIC_VERSION,
            ...(this.modelConfig.extraHeaders || {})
          }
        },
        {
          purpose,
          onRetry,
          signal
        }
      );
      webSearchObserved =
        webSearchObserved ||
        responseMentionsAnthropicWebSearch(lastRaw) ||
        (Boolean(tools) &&
          String(lastRaw?.stop_reason || "").trim().toLowerCase() === "pause_turn");

      if (
        String(lastRaw?.stop_reason || "").trim().toLowerCase() === "pause_turn" &&
        Array.isArray(lastRaw?.content) &&
        lastRaw.content.length
      ) {
        serverToolTurns += 1;
        messages.push({
          role: "assistant",
          content: lastRaw.content
        });
        continue;
      }

      const text = extractTextFromAnthropicResponse(lastRaw);
      if (!text) {
        if (allowEmptyText && hasStructuredAnthropicResponse(lastRaw)) {
          return {
            text: "",
            raw: lastRaw,
            meta: {
              serverToolTurns,
              webSearchObserved
            }
          };
        }
        throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
      }

      return {
        text,
        raw: lastRaw,
        meta: {
          serverToolTurns,
          webSearchObserved
        }
      };
    }

    throw new Error(
      `Model "${this.modelConfig.id}" exceeded the maximum server-tool continuation turns.`
    );
  }
}

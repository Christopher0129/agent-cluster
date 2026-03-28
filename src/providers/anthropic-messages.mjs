import { postJson } from "./http-client.mjs";

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

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

export class AnthropicMessagesProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/messages`;
    const body = {
      model: this.modelConfig.model,
      max_tokens: Math.max(64, Number(this.modelConfig.maxOutputTokens || DEFAULT_MAX_TOKENS)),
      messages: [
        {
          role: "user",
          content: buildMessageContent(input)
        }
      ]
    };

    if (typeof instructions === "string" && instructions.trim()) {
      body.system = instructions.trim();
    }

    if (typeof this.modelConfig.temperature === "number") {
      body.temperature = this.modelConfig.temperature;
    }

    const raw = await postJson(
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

    const text = extractTextFromAnthropicResponse(raw);
    if (!text) {
      if (allowEmptyText && hasStructuredAnthropicResponse(raw)) {
        return { text: "", raw };
      }
      throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
    }

    return { text, raw };
  }
}

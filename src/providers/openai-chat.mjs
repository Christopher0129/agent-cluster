import { postJson } from "./http-client.mjs";

function extractMessageContent(choice) {
  if (typeof choice?.text === "string") {
    return choice.text.trim();
  }

  const content = choice?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function hasStructuredChatResponse(raw) {
  return Array.isArray(raw?.choices) && raw.choices.length > 0;
}

export class OpenAIChatProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/chat/completions`;
    const body = {
      model: this.modelConfig.model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ],
      user: `agent-cluster:${purpose}`
    };

    if (typeof this.modelConfig.temperature === "number") {
      body.temperature = this.modelConfig.temperature;
    }

    if (this.modelConfig.maxOutputTokens) {
      body.max_tokens = this.modelConfig.maxOutputTokens;
    }

    const raw = await postJson(endpoint, body, this.modelConfig, {
      purpose,
      onRetry,
      signal
    });
    const text = extractMessageContent(raw?.choices?.[0]);
    if (!text) {
      if (allowEmptyText && hasStructuredChatResponse(raw)) {
        return { text: "", raw };
      }
      throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
    }

    return { text, raw };
  }
}

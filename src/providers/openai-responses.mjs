import { postJson } from "./http-client.mjs";

function buildInputItems({ instructions, input }) {
  const items = [];

  if (typeof instructions === "string" && instructions.trim()) {
    items.push({
      role: "system",
      content: [
        {
          type: "input_text",
          text: instructions
        }
      ]
    });
  }

  if (Array.isArray(input)) {
    return items.concat(input);
  }

  items.push({
    role: "user",
    content: [
      {
        type: "input_text",
        text: String(input || "")
      }
    ]
  });

  return items;
}

function extractTextFromResponse(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item.content || []) {
      if (typeof content?.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function hasStructuredResponsesOutput(response) {
  if (Array.isArray(response?.output) && response.output.length > 0) {
    return true;
  }

  return typeof response?.status === "string" || typeof response?.id === "string";
}

function buildResponseTools(modelConfig) {
  const tools = [];
  if (modelConfig.webSearch) {
    tools.push({ type: "web_search" });
  }
  return tools;
}

export class OpenAIResponsesProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/responses`;
    const body = {
      model: this.modelConfig.model,
      input: buildInputItems({ instructions, input })
    };

    if (this.modelConfig.reasoning) {
      body.reasoning = this.modelConfig.reasoning;
    }

    const tools = buildResponseTools(this.modelConfig);
    if (tools.length) {
      body.tools = tools;
    }

    if (this.modelConfig.maxOutputTokens) {
      body.max_output_tokens = this.modelConfig.maxOutputTokens;
    }

    const raw = await postJson(endpoint, body, this.modelConfig, {
      purpose,
      onRetry,
      signal
    });
    const text = extractTextFromResponse(raw);
    if (!text) {
      if (allowEmptyText && hasStructuredResponsesOutput(raw)) {
        return { text: "", raw };
      }
      throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
    }

    return { text, raw };
  }
}

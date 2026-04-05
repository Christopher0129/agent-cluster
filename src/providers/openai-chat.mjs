import { postJson } from "./http-client.mjs";
import { providerSupportsCapability } from "../static/provider-catalog.js";

const MAX_BUILTIN_TOOL_TURNS = 6;

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

function buildBuiltinToolConfig(modelConfig) {
  if (!modelConfig?.webSearch) {
    return null;
  }

  return [
    {
      type: "builtin_function",
      function: {
        name: "$web_search"
      }
    }
  ];
}

function cloneAssistantMessage(message) {
  return {
    role: "assistant",
    content:
      typeof message?.content === "string" || Array.isArray(message?.content)
        ? message.content
        : "",
    ...(Array.isArray(message?.tool_calls) && message.tool_calls.length
      ? {
          tool_calls: message.tool_calls.map((toolCall) => ({
            ...toolCall,
            function: toolCall?.function ? { ...toolCall.function } : toolCall?.function
          }))
        }
      : {})
  };
}

function parseFunctionArguments(rawArguments) {
  if (typeof rawArguments !== "string") {
    return rawArguments ?? {};
  }

  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return rawArguments;
  }
}

function buildToolResultContent(toolCall) {
  const parsedArguments = parseFunctionArguments(toolCall?.function?.arguments);
  if (typeof parsedArguments === "string") {
    return parsedArguments;
  }
  return JSON.stringify(parsedArguments);
}

function hasStructuredChatResponse(raw) {
  return Array.isArray(raw?.choices) && raw.choices.length > 0;
}

function buildThinkingConfig(modelConfig, { builtinToolsEnabled = false } = {}) {
  if (!providerSupportsCapability(modelConfig?.provider, "thinking")) {
    return null;
  }

  if (builtinToolsEnabled) {
    return { type: "disabled" };
  }

  return {
    type: modelConfig?.thinkingEnabled ? "enabled" : "disabled"
  };
}

export class OpenAIChatProvider {
  constructor(modelConfig) {
    this.modelConfig = modelConfig;
  }

  async invoke({ instructions, input, purpose, onRetry, signal, allowEmptyText = false }) {
    const endpoint = `${this.modelConfig.baseUrl}/chat/completions`;
    const messages = [
      { role: "system", content: instructions },
      { role: "user", content: input }
    ];
    const builtinTools = buildBuiltinToolConfig(this.modelConfig);
    let lastRaw = null;
    let builtinToolTurns = 0;
    let webSearchToolCalls = 0;

    for (let turn = 0; turn < MAX_BUILTIN_TOOL_TURNS; turn += 1) {
      const body = {
        model: this.modelConfig.model,
        messages,
        user: `agent-cluster:${purpose}`
      };

      if (typeof this.modelConfig.temperature === "number") {
        body.temperature = this.modelConfig.temperature;
      }

      if (this.modelConfig.maxOutputTokens) {
        body.max_tokens = this.modelConfig.maxOutputTokens;
      }

      const thinking = buildThinkingConfig(this.modelConfig, {
        builtinToolsEnabled: Boolean(builtinTools)
      });
      if (thinking) {
        body.thinking = thinking;
      }

      if (builtinTools) {
        body.tools = builtinTools;
      }

      lastRaw = await postJson(endpoint, body, this.modelConfig, {
        purpose,
        onRetry,
        signal
      });

      const choice = lastRaw?.choices?.[0];
      const toolCalls = Array.isArray(choice?.message?.tool_calls)
        ? choice.message.tool_calls
        : [];
      if (builtinTools && toolCalls.length) {
        builtinToolTurns += 1;
        webSearchToolCalls += toolCalls.filter(
          (toolCall) => String(toolCall?.function?.name || "").trim() === "$web_search"
        ).length;
        messages.push(cloneAssistantMessage(choice.message));
        for (const toolCall of toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: String(toolCall?.id || ""),
            name: String(toolCall?.function?.name || ""),
            content: buildToolResultContent(toolCall)
          });
        }
        continue;
      }

      const text = extractMessageContent(choice);
      if (!text) {
        if (allowEmptyText && hasStructuredChatResponse(lastRaw)) {
          return {
            text: "",
            raw: lastRaw,
            meta: {
              builtinToolTurns,
              webSearchToolCalls,
              webSearchObserved: webSearchToolCalls > 0
            }
          };
        }
        throw new Error(`Model "${this.modelConfig.id}" returned no text output.`);
      }

      return {
        text,
        raw: lastRaw,
        meta: {
          builtinToolTurns,
          webSearchToolCalls,
          webSearchObserved: webSearchToolCalls > 0
        }
      };
    }

    throw new Error(
      `Model "${this.modelConfig.id}" exceeded the maximum built-in tool turns.`
    );
  }
}

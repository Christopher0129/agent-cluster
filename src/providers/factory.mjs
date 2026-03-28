import { OpenAIResponsesProvider } from "./openai-responses.mjs";
import { OpenAIChatProvider } from "./openai-chat.mjs";
import { AnthropicMessagesProvider } from "./anthropic-messages.mjs";
import { validateModelAccessPolicy } from "./access-policy.mjs";
import { resolveProviderProtocol } from "../static/provider-catalog.js";

export function createProviderForModel(modelConfig) {
  validateModelAccessPolicy(modelConfig);
  const protocol = resolveProviderProtocol(modelConfig.provider);

  if (protocol === "openai-responses") {
    return new OpenAIResponsesProvider(modelConfig);
  }

  if (protocol === "openai-chat") {
    return new OpenAIChatProvider(modelConfig);
  }

  if (protocol === "anthropic-messages") {
    return new AnthropicMessagesProvider(modelConfig);
  }

  throw new Error(
    `Unsupported provider "${modelConfig.provider}" on model "${modelConfig.id}".`
  );
}

export function createProviderRegistry(config) {
  const registry = new Map();

  for (const modelConfig of Object.values(config.models)) {
    registry.set(modelConfig.id, createProviderForModel(modelConfig));
  }

  return registry;
}

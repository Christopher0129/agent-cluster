import { formatDelay } from "./ui-core.js";

function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function resolveRuntimeLocale() {
  if (typeof document !== "undefined" && String(document.documentElement?.lang || "").toLowerCase().startsWith("en")) {
    return "en-US";
  }
  return "zh-CN";
}

function createFallbackTranslator() {
  const catalog = {
    "zh-CN": {
      "connectivity.retryStatus": "重试中（第 {attempt}/{maxRetries} 次，{delay} 后重试）"
    },
    "en-US": {
      "connectivity.retryStatus": "Retrying (attempt {attempt}/{maxRetries}, next try in {delay})"
    }
  };

  return (key, values = {}) =>
    interpolate(catalog[resolveRuntimeLocale()]?.[key] ?? catalog["zh-CN"]?.[key] ?? key, values);
}

export function formatModelTestRetryStatus(event, translate = createFallbackTranslator()) {
  return translate("connectivity.retryStatus", {
    attempt: event.attempt,
    maxRetries: event.maxRetries,
    delay: formatDelay(event.nextDelayMs)
  });
}

export function createModelConnectivityService({
  collectSecrets,
  createOperationId,
  openOperationStream,
  getConnectivityUi,
  captureCurrentSchemeDraft
}) {
  async function runModelConnectivityTest(model, hooks = {}) {
    const secrets = hooks.secrets || collectSecrets();
    const operationId = createOperationId("model_test");
    const stream = openOperationStream(operationId, (event) => {
      hooks.onEvent?.(event);
    });

    try {
      const response = await fetch("/api/model/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          operationId,
          model,
          secrets
        })
      });

      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      return payload;
    } finally {
      setTimeout(() => stream.close(), 300);
    }
  }

  async function runCurrentSchemeConnectivityTests(options = {}) {
    captureCurrentSchemeDraft?.();
    const connectivityUi = getConnectivityUi?.();
    if (!connectivityUi) {
      throw new Error("Connectivity UI is not ready.");
    }
    return connectivityUi.runCurrentSchemeConnectivityTests(options);
  }

  return {
    runCurrentSchemeConnectivityTests,
    runModelConnectivityTest
  };
}

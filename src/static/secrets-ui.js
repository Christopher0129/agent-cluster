function normalizeSecretName(value) {
  return String(value || "").trim();
}

function buildFallbackSecretRow(secret = {}) {
  if (typeof document === "undefined") {
    throw new Error("Secret template is not available.");
  }

  const row = document.createElement("section");
  row.className = "secret-row row-card";

  const nameLabel = document.createElement("label");
  nameLabel.className = "field";
  const nameSpan = document.createElement("span");
  nameSpan.textContent = "环境变量名";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "OPENAI_API_KEY";
  nameInput.dataset.secretName = "";
  nameInput.value = normalizeSecretName(secret.name);
  nameLabel.append(nameSpan, nameInput);

  const valueLabel = document.createElement("label");
  valueLabel.className = "field";
  const valueSpan = document.createElement("span");
  valueSpan.textContent = "密钥值";
  const valueInput = document.createElement("input");
  valueInput.type = "password";
  valueInput.placeholder = "保存到本地 runtime.settings.json";
  valueInput.dataset.secretValue = "";
  valueInput.value = String(secret.value ?? "");
  valueLabel.append(valueSpan, valueInput);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "ghost danger small";
  removeButton.dataset.secretRemove = "";
  removeButton.textContent = "删除";

  row.append(nameLabel, valueLabel, removeButton);
  return row;
}

export function mergeSecretEntries(...collections) {
  const merged = new Map();

  for (const collection of collections) {
    for (const entry of Array.isArray(collection) ? collection : []) {
      const name = normalizeSecretName(entry?.name);
      if (!name) {
        continue;
      }

      merged.set(name, {
        name,
        value: String(entry?.value ?? "")
      });
    }
  }

  return Array.from(merged.values());
}

export function createSecretsUi({ addSecretButton, secretList, secretTemplate }) {
  function createSecretRow(secret = {}) {
    const fragment = secretTemplate?.content?.cloneNode(true);
    const row = fragment?.querySelector?.(".secret-row") || buildFallbackSecretRow(secret);
    const nameInput = row.querySelector("[data-secret-name]");
    const valueInput = row.querySelector("[data-secret-value]");

    if (nameInput) {
      nameInput.value = normalizeSecretName(secret.name);
    }
    if (valueInput) {
      valueInput.value = String(secret.value ?? "");
    }

    return row;
  }

  function collectSecrets() {
    return Array.from(secretList?.querySelectorAll(".secret-row") || [])
      .map((row) => ({
        name: normalizeSecretName(row.querySelector("[data-secret-name]")?.value),
        value: String(row.querySelector("[data-secret-value]")?.value ?? "").trim()
      }))
      .filter((entry) => entry.name);
  }

  function handleSecretListClick(event) {
    const button = event.target.closest("[data-secret-remove]");
    if (!button) {
      return;
    }

    button.closest(".secret-row")?.remove();
  }

  function handleAddSecretClick() {
    secretList?.append(createSecretRow());
  }

  function bindEvents() {
    secretList?.addEventListener("click", handleSecretListClick);
    addSecretButton?.addEventListener("click", handleAddSecretClick);
  }

  return {
    bindEvents,
    collectSecrets,
    createSecretRow
  };
}

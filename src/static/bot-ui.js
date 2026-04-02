export function createBotUi({
  state,
  elements,
  escapeHtml,
  escapeAttribute,
  normalizeStringList,
  formatTimestamp,
  getWorkspaceDirValue,
  loadWorkspaceSummary,
  saveSettings
}) {
  const {
    botConfigStatus,
    botInstallDirInput,
    botCommandPrefixInput,
    botAutoStartInput,
    botProgressUpdatesInput,
    botCustomCommandInput,
    botPresetList,
    botInstallOutput,
    startAllBotsButton,
    stopAllBotsButton,
    refreshBotRuntimeButton,
    runCustomBotInstallButton,
    copyBotCommandsButton
  } = elements;

  function setConfigStatus(message, tone = "neutral") {
    if (!botConfigStatus) {
      return;
    }

    botConfigStatus.textContent = message;
    botConfigStatus.dataset.tone = tone;
  }

  function getInstallDirValue() {
    return botInstallDirInput?.value.trim() || state.defaultInstallDir || "bot-connectors";
  }

  function getCommandPrefixValue() {
    return botCommandPrefixInput?.value.trim() || "/agent";
  }

  function setInstallOutput(message) {
    if (!botInstallOutput) {
      return;
    }

    botInstallOutput.textContent = message;
  }

  function getPresetById(presetId) {
    return state.presets.find((preset) => preset.id === String(presetId || "").trim()) || null;
  }

  function getPresetConfig(presetId) {
    return state.presetConfigById.get(String(presetId || "").trim()) || {
      envText: ""
    };
  }

  function normalizeEnvName(value) {
    return String(value || "").trim();
  }

  function parseEnvText(envText) {
    const values = new Map();

    for (const line of String(envText || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }

      values.set(match[1], match[2] ?? "");
    }

    return values;
  }

  function getPresetFields(preset) {
    return Array.isArray(preset?.fields)
      ? preset.fields.filter((field) => normalizeEnvName(field?.envName))
      : [];
  }

  function getPresetFieldEnvNames(preset) {
    return getPresetFields(preset).map((field) => normalizeEnvName(field.envName));
  }

  function getAllStructuredEnvNames() {
    const names = new Set();

    for (const preset of state.presets) {
      for (const envName of getPresetFieldEnvNames(preset)) {
        names.add(envName);
      }
    }

    return names;
  }

  function buildSecretValueMap(secrets = []) {
    const values = new Map();

    for (const entry of Array.isArray(secrets) ? secrets : []) {
      const name = normalizeEnvName(entry?.name);
      if (!name) {
        continue;
      }

      values.set(name, String(entry?.value ?? ""));
    }

    return values;
  }

  function stripStructuredEnvText(envText, knownNames = []) {
    const blocked = new Set(
      Array.from(knownNames || [])
        .map((name) => normalizeEnvName(name))
        .filter(Boolean)
    );

    if (!blocked.size) {
      return String(envText || "").trim();
    }

    return String(envText || "")
      .split(/\r?\n/)
      .filter((line) => {
        const match = line.trim().match(/^([\w.-]+)\s*=/);
        return !match || !blocked.has(match[1]);
      })
      .join("\n")
      .trim();
  }

  function sanitizePresetConfig(presetId, value) {
    const preset = getPresetById(presetId);
    return {
      envText: stripStructuredEnvText(String(value?.envText || ""), getPresetFieldEnvNames(preset))
    };
  }

  function resolveAdvancedEnvPlaceholder(preset) {
    const hiddenNames = new Set(getPresetFieldEnvNames(preset));
    const hints = (Array.isArray(preset?.envHints) ? preset.envHints : []).filter((hint) => {
      const parsed = parseEnvText(hint);
      const firstName = Array.from(parsed.keys())[0] || "";
      return !firstName || !hiddenNames.has(firstName);
    });

    return hints.join("\n") || "HTTP_PROXY=http://127.0.0.1:7890\nCUSTOM_FLAG=1";
  }

  function resolveFieldDefaultValue(field) {
    if (field?.defaultValue != null) {
      return String(field.defaultValue);
    }

    if (field?.type === "toggle") {
      return String(field?.falseValue ?? "0");
    }

    return "";
  }

  function resolveFieldValue(presetId, field, presetConfig = getPresetConfig(presetId)) {
    const envName = normalizeEnvName(field?.envName);
    if (!envName) {
      return resolveFieldDefaultValue(field);
    }

    if (state.secretValueByName.has(envName)) {
      return state.secretValueByName.get(envName);
    }

    const legacyValues = parseEnvText(presetConfig?.envText);
    if (legacyValues.has(envName)) {
      return legacyValues.get(envName);
    }

    return resolveFieldDefaultValue(field);
  }

  function readFieldValue(input) {
    if (!input) {
      return "";
    }

    if (input.dataset.fieldType === "toggle") {
      return input.checked ? input.dataset.trueValue || "1" : input.dataset.falseValue || "0";
    }

    return input.value;
  }

  function syncSecretValuesFromDom(source = null) {
    const inputs =
      source && source.matches?.("[data-bot-field]")
        ? [source]
        : Array.from(botPresetList?.querySelectorAll("[data-bot-field]") || []);

    for (const input of inputs) {
      const envName = normalizeEnvName(input.dataset.fieldName);
      if (!envName) {
        continue;
      }

      state.secretValueByName.set(envName, String(readFieldValue(input) ?? ""));
    }
  }

  function collectSecretEntries() {
    const result = [];

    for (const preset of state.presets) {
      const presetConfig = getPresetConfig(preset.id);
      const legacyValues = parseEnvText(presetConfig.envText);

      for (const field of getPresetFields(preset)) {
        const envName = normalizeEnvName(field?.envName);
        if (!envName) {
          continue;
        }

        const input = botPresetList?.querySelector(
          `[data-bot-field][data-preset-id="${preset.id}"][data-field-name="${envName}"]`
        );
        const defaultValue = resolveFieldDefaultValue(field);
        const value = String(
          input
            ? readFieldValue(input)
            : state.secretValueByName.get(envName) ?? legacyValues.get(envName) ?? defaultValue
        );
        const hasStoredValue = state.secretValueByName.has(envName);

        if (!hasStoredValue && !legacyValues.has(envName) && value === defaultValue) {
          continue;
        }

        result.push({
          name: envName,
          value
        });
      }
    }

    return result;
  }

  function filterVisibleSharedSecrets(secrets = []) {
    const hiddenNames = getAllStructuredEnvNames();

    return (Array.isArray(secrets) ? secrets : []).filter((entry) => {
      const name = normalizeEnvName(entry?.name);
      return !name || !hiddenNames.has(name);
    });
  }

  function renderStructuredField(preset, field, presetConfig) {
    const envName = normalizeEnvName(field?.envName);
    if (!envName) {
      return "";
    }

    const label = field.label || envName;
    const descriptionParts = [];
    if (field.description) {
      descriptionParts.push(String(field.description));
    }
    descriptionParts.push("本地加密保存");
    const fieldHint = descriptionParts.join(" · ");
    const requiredTag = field.required
      ? '<span class="bot-field-required" aria-label="必填">必填</span>'
      : "";

    if (field.type === "toggle") {
      const currentValue = resolveFieldValue(preset.id, field, presetConfig);
      const checked = currentValue === String(field.trueValue ?? "1");
      return `
        <div class="field toggle-field bot-preset-field bot-preset-field-wide">
          <span>${escapeHtml(label)}${requiredTag}</span>
          <div class="toggle-control">
            <input
              data-bot-field
              data-preset-id="${escapeAttribute(preset.id)}"
              data-field-name="${escapeAttribute(envName)}"
              data-field-type="toggle"
              data-true-value="${escapeAttribute(String(field.trueValue ?? "1"))}"
              data-false-value="${escapeAttribute(String(field.falseValue ?? "0"))}"
              type="checkbox"
              ${checked ? "checked" : ""}
            />
            <span>${escapeHtml(fieldHint)}</span>
          </div>
        </div>
      `;
    }

    const inputType = field.type === "password" ? "password" : "text";
    const autocomplete = field.type === "password" ? "new-password" : "off";
    return `
      <label class="field bot-preset-field">
        <span>${escapeHtml(label)}${requiredTag}</span>
        <input
          data-bot-field
          data-preset-id="${escapeAttribute(preset.id)}"
          data-field-name="${escapeAttribute(envName)}"
          data-field-type="${escapeAttribute(field.type || "text")}"
          type="${escapeAttribute(inputType)}"
          autocomplete="${escapeAttribute(autocomplete)}"
          placeholder="${escapeAttribute(field.placeholder || "")}"
          value="${escapeAttribute(resolveFieldValue(preset.id, field, presetConfig))}"
        />
        <small class="field-hint">${escapeHtml(fieldHint)}</small>
      </label>
    `;
  }

  function collectEnabledPresetIdsFromDom() {
    return Array.from(botPresetList?.querySelectorAll("[data-bot-enabled]:checked") || [])
      .map((input) => input.value.trim())
      .filter(Boolean);
  }

  function collectPresetConfigsFromDom() {
    const result = {};
    for (const textarea of Array.from(botPresetList?.querySelectorAll("[data-bot-env]") || [])) {
      const presetId = textarea.dataset.presetId || "";
      if (!presetId) {
        continue;
      }
      result[presetId] = {
        envText: textarea.value
      };
    }
    return result;
  }

  function syncEnabledPresetIds(sourceIds = null) {
    state.enabledPresetIds = new Set(
      normalizeStringList(sourceIds == null ? collectEnabledPresetIdsFromDom() : sourceIds)
    );
  }

  function syncPresetConfigs(source = null) {
    const raw = source && typeof source === "object" ? source : collectPresetConfigsFromDom();
    state.presetConfigById = new Map(
      Object.entries(raw).map(([presetId, value]) => [
        presetId,
        {
          envText: String(value?.envText || "")
        }
      ])
    );
  }

  function resolvePresetStatus(presetId) {
    if (state.installingPresetId === presetId) {
      return {
        message: "安装中...",
        tone: "warning"
      };
    }

    return state.installStatusById.get(presetId) || {
      message: "未安装",
      tone: "neutral"
    };
  }

  function resolveRuntimeStatus(presetId) {
    const runtime = state.runtimeById.get(presetId);
    if (!runtime) {
      return {
        message: "未启动",
        tone: "neutral",
        detail: ""
      };
    }

    const startedAt = runtime.startedAt ? formatTimestamp(runtime.startedAt) : "";
    switch (runtime.status) {
      case "running":
        return {
          message: runtime.pid ? `运行中 · PID ${runtime.pid}` : "运行中",
          tone: "ok",
          detail: startedAt ? `启动时间：${startedAt}` : ""
        };
      case "stopping":
        return {
          message: "停止中...",
          tone: "warning",
          detail: ""
        };
      case "failed":
        return {
          message: "运行失败",
          tone: "error",
          detail: runtime.lastError || ""
        };
      default:
        return {
          message: "未启动",
          tone: "neutral",
          detail: runtime.lastOutput || ""
        };
    }
  }

  function renderPresetList(preferredEnabledIds = null, preferredPresetConfigs = null) {
    if (!botPresetList) {
      return;
    }

    if (botPresetList.children.length) {
      syncSecretValuesFromDom();
    }

    if (preferredEnabledIds != null) {
      syncEnabledPresetIds(preferredEnabledIds);
    } else if (botPresetList.children.length) {
      syncEnabledPresetIds();
    }

    if (preferredPresetConfigs != null) {
      syncPresetConfigs(preferredPresetConfigs);
    } else if (botPresetList.children.length) {
      syncPresetConfigs();
    }

    if (!state.presets.length) {
      botPresetList.innerHTML = '<p class="placeholder">暂无可用 Bot 预设。</p>';
      return;
    }

    const enabledIds = state.enabledPresetIds;
    botPresetList.innerHTML = state.presets
      .map((preset) => {
        const status = resolvePresetStatus(preset.id);
        const runtime = resolveRuntimeStatus(preset.id);
        const presetConfig = getPresetConfig(preset.id);
        const structuredFields = getPresetFields(preset);
        const extraEnvText = stripStructuredEnvText(
          presetConfig.envText,
          getPresetFieldEnvNames(preset)
        );
        const tags = Array.isArray(preset.tags) ? preset.tags : [];
        const disabled = Boolean(state.installingPresetId);
        return `
          <article class="bot-preset-card" data-preset-id="${escapeAttribute(preset.id)}">
            <div class="bot-preset-head">
              <div class="bot-preset-title">
                <h3>${escapeHtml(preset.label)}</h3>
                <div class="bot-preset-meta">
                  <span class="chip">${escapeHtml(preset.channel || "Bot")}</span>
                  <span class="chip">${escapeHtml(preset.source || "预设")}</span>
                  ${tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
                </div>
              </div>
              <div class="bot-preset-meta">
                <span class="bot-preset-status" data-tone="${escapeAttribute(status.tone)}">${escapeHtml(status.message)}</span>
                <span class="bot-preset-status" data-tone="${escapeAttribute(runtime.tone)}">${escapeHtml(runtime.message)}</span>
              </div>
            </div>
            <p class="bot-preset-desc">${escapeHtml(preset.description || "未提供说明。")}</p>
            <pre class="bot-preset-command">${escapeHtml(preset.installCommand || "")}</pre>
            <div class="bot-preset-runtime">
              ${
                structuredFields.length
                  ? `
                    <div class="bot-preset-field-grid">
                      ${structuredFields
                        .map((field) => renderStructuredField(preset, field, presetConfig))
                        .join("")}
                    </div>
                    <p class="bot-preset-note">这些参数会加密保存到本地，不会明文写入配置文件。</p>
                  `
                  : ""
              }
              <label class="field">
                <span>${structuredFields.length ? "附加环境变量（高级）" : "环境变量（每行一个 KEY=VALUE）"}</span>
                <textarea
                  data-bot-env
                  data-preset-id="${escapeAttribute(preset.id)}"
                  placeholder="${escapeAttribute(resolveAdvancedEnvPlaceholder(preset))}"
                >${escapeHtml(extraEnvText)}</textarea>
                ${
                  structuredFields.length
                    ? '<small class="field-hint">仅在需要额外代理、日志或高级变量时填写；上面的结构化字段不需要重复写在这里。</small>'
                    : ""
                }
              </label>
              ${runtime.detail ? `<p class="meta-row">${escapeHtml(runtime.detail)}</p>` : ""}
            </div>
            <div class="bot-preset-actions">
              <label class="bot-preset-toggle">
                <input
                  data-bot-enabled
                  type="checkbox"
                  value="${escapeAttribute(preset.id)}"
                  ${enabledIds.has(preset.id) ? "checked" : ""}
                />
                <span>纳入默认配置</span>
              </label>
              <div class="panel-actions">
                <button
                  data-bot-install
                  type="button"
                  class="small"
                  ${disabled ? "disabled" : ""}
                >
                  一键安装
                </button>
                <button data-bot-start type="button" class="ghost small">启动</button>
                <button data-bot-stop type="button" class="ghost danger small">停止</button>
                <button data-bot-copy type="button" class="ghost small">复制命令</button>
                <button data-bot-docs type="button" class="ghost small">打开文档</button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function collectSettings() {
    syncEnabledPresetIds();
    syncPresetConfigs();
    syncSecretValuesFromDom();

    return {
      installDir: getInstallDirValue(),
      commandPrefix: getCommandPrefixValue(),
      autoStart: Boolean(botAutoStartInput?.checked),
      progressUpdates: botProgressUpdatesInput?.checked !== false,
      customCommand: botCustomCommandInput?.value.trim() || "",
      enabledPresets: Array.from(state.enabledPresetIds),
      presetConfigs: Object.fromEntries(
        Array.from(state.presetConfigById.entries()).map(([presetId, value]) => [
          presetId,
          sanitizePresetConfig(presetId, value)
        ])
      )
    };
  }

  function applySettings(botSettings = {}, secrets = []) {
    state.secretValueByName = buildSecretValueMap(secrets);
    if (botInstallDirInput) {
      botInstallDirInput.value = botSettings.installDir || state.defaultInstallDir;
    }
    if (botCommandPrefixInput) {
      botCommandPrefixInput.value = botSettings.commandPrefix || "/agent";
    }
    if (botAutoStartInput) {
      botAutoStartInput.checked = Boolean(botSettings.autoStart);
    }
    if (botProgressUpdatesInput) {
      botProgressUpdatesInput.checked = botSettings.progressUpdates !== false;
    }
    if (botCustomCommandInput) {
      botCustomCommandInput.value = botSettings.customCommand || "";
    }

    renderPresetList(botSettings.enabledPresets || [], botSettings.presetConfigs || {});
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "readonly");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.append(scratch);
    scratch.select();
    document.execCommand("copy");
    scratch.remove();
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  function setRuntimeSnapshot(items = []) {
    state.runtimeById = new Map((items || []).map((item) => [item.id, item]));
  }

  async function loadPresets() {
    setConfigStatus("正在加载 Bot 预设...", "neutral");

    try {
      const payload = await fetchJson("/api/bot/presets");
      state.presets = Array.isArray(payload.presets) ? payload.presets : [];
      state.defaultInstallDir = state.presets[0]?.defaultInstallDir || state.defaultInstallDir;
      renderPresetList(Array.from(state.enabledPresetIds));
      setConfigStatus(`已加载 ${state.presets.length} 个 Bot 预设`, "ok");
    } catch (error) {
      state.presets = [];
      renderPresetList([]);
      setConfigStatus(`Bot 预设加载失败：${error.message}`, "error");
    }
  }

  async function loadRuntimeStatus() {
    try {
      const payload = await fetchJson("/api/bot/runtime");
      setRuntimeSnapshot(payload.runtime?.bots || []);
      const runningCount = (payload.runtime?.bots || []).filter((item) => item.status === "running").length;
      setConfigStatus(runningCount ? `已启动 ${runningCount} 个 Bot` : "Bot 连接器未启动", runningCount ? "ok" : "neutral");
      renderPresetList();
    } catch (error) {
      setConfigStatus(`读取 Bot 运行状态失败：${error.message}`, "error");
    }
  }

  async function ensureAutoStart() {
    try {
      const payload = await fetchJson("/api/bot/runtime/ensure-auto-start", {
        method: "POST"
      });
      setRuntimeSnapshot(payload.snapshot?.bots || []);
      renderPresetList();
    } catch (error) {
      setConfigStatus(`Bot 自动启动失败：${error.message}`, "error");
    }
  }

  async function copyCommand(commandText, label = "Bot 命令") {
    try {
      await copyTextToClipboard(commandText);
      setInstallOutput(commandText);
      setConfigStatus(`${label}已复制到剪贴板`, "ok");
    } catch (error) {
      setInstallOutput(commandText);
      setConfigStatus(`复制失败，请手动复制输出区内容：${error.message}`, "error");
    }
  }

  async function copySelectedCommands() {
    const enabledIds = Array.from(state.enabledPresetIds);
    const presets = (enabledIds.length
      ? enabledIds.map((presetId) => getPresetById(presetId)).filter(Boolean)
      : state.presets
    ).filter(Boolean);

    if (!presets.length) {
      setConfigStatus("没有可复制的 Bot 命令。", "error");
      return;
    }

    const joined = presets
      .map((preset) => `# ${preset.label}\n${preset.installCommand}`)
      .join("\n\n");
    await copyCommand(joined, `${presets.length} 条 Bot 命令`);
  }

  async function installPreset(presetId) {
    const preset = getPresetById(presetId);
    if (!preset) {
      setConfigStatus("未找到对应的 Bot 预设。", "error");
      return;
    }

    state.installingPresetId = presetId;
    state.installStatusById.set(presetId, {
      message: "安装中...",
      tone: "warning"
    });
    renderPresetList();
    setConfigStatus(`正在安装 ${preset.label}...`, "warning");
    setInstallOutput(`正在执行：${preset.installCommand}`);

    try {
      const payload = await fetchJson("/api/bot/install", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          workspaceDir: getWorkspaceDirValue(),
          installDir: getInstallDirValue(),
          presetId
        })
      });

      state.installStatusById.set(presetId, {
        message: "已安装",
        tone: "ok"
      });
      setInstallOutput(
        `目标目录：${payload.targetDir}\n命令：${payload.command}\n\n${payload.output || "(无输出)"}`
      );
      setConfigStatus(`${preset.label} 已安装到 ${payload.targetRelativeDir}`, "ok");
      await loadWorkspaceSummary();
      await loadRuntimeStatus();
    } catch (error) {
      state.installStatusById.set(presetId, {
        message: "安装失败",
        tone: "error"
      });
      setInstallOutput(`安装失败：${error.message}`);
      setConfigStatus(`${preset.label} 安装失败：${error.message}`, "error");
    } finally {
      state.installingPresetId = "";
      renderPresetList();
    }
  }

  async function runCustomInstall() {
    const command = botCustomCommandInput?.value.trim() || "";
    if (!command) {
      setConfigStatus("请先填写自定义安装命令。", "error");
      botCustomCommandInput?.focus();
      return;
    }

    if (runCustomBotInstallButton) {
      runCustomBotInstallButton.disabled = true;
    }
    setConfigStatus("正在执行自定义 Bot 命令...", "warning");
    setInstallOutput(`正在执行：${command}`);

    try {
      const payload = await fetchJson("/api/bot/install-custom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          workspaceDir: getWorkspaceDirValue(),
          installDir: getInstallDirValue(),
          command
        })
      });

      setInstallOutput(
        `目标目录：${payload.targetDir}\n命令：${payload.command}\n\n${payload.output || "(无输出)"}`
      );
      setConfigStatus(`自定义 Bot 命令已执行到 ${payload.targetRelativeDir}`, "ok");
      await loadWorkspaceSummary();
    } catch (error) {
      setInstallOutput(`自定义命令执行失败：${error.message}`);
      setConfigStatus(`自定义命令执行失败：${error.message}`, "error");
    } finally {
      if (runCustomBotInstallButton) {
        runCustomBotInstallButton.disabled = false;
      }
    }
  }

  async function startRuntime(botId = "") {
    const requestBody = botId ? { botId } : {};
    const button = botId ? null : startAllBotsButton;
    if (button) {
      button.disabled = true;
    }

    try {
      syncEnabledPresetIds();
      syncPresetConfigs();
      await saveSettings();

      const payload = await fetchJson("/api/bot/runtime/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      setRuntimeSnapshot(payload.snapshot?.bots || []);
      setConfigStatus(botId ? `${botId} 已启动` : "已启动默认 Bot 连接器", "ok");
      setInstallOutput(
        botId
          ? `已启动连接器：${botId}`
          : `已启动：${(payload.started || []).join(", ") || "默认 Bot 连接器"}`
      );
      renderPresetList();
    } catch (error) {
      setConfigStatus(`启动 Bot 失败：${error.message}`, "error");
      setInstallOutput(`启动 Bot 失败：${error.message}`);
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  async function stopRuntime(botId = "") {
    const requestBody = botId ? { botId } : {};
    const button = botId ? null : stopAllBotsButton;
    if (button) {
      button.disabled = true;
    }

    try {
      const payload = await fetchJson("/api/bot/runtime/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      setRuntimeSnapshot(payload.runtime?.bots || []);
      setConfigStatus(botId ? `${botId} 已停止` : "已停止全部 Bot", "ok");
      setInstallOutput(botId ? `已停止连接器：${botId}` : "已停止全部 Bot 连接器。");
      renderPresetList();
    } catch (error) {
      setConfigStatus(`停止 Bot 失败：${error.message}`, "error");
      setInstallOutput(`停止 Bot 失败：${error.message}`);
    } finally {
      if (button) {
        button.disabled = false;
      }
    }
  }

  function handlePresetListChange(event) {
    if (event.target.closest("[data-bot-enabled]")) {
      syncEnabledPresetIds();
      return;
    }
    if (event.target.closest("[data-bot-field]")) {
      syncSecretValuesFromDom(event.target);
      return;
    }
    if (event.target.closest("[data-bot-env]")) {
      syncPresetConfigs();
    }
  }

  function handlePresetListInput(event) {
    if (event.target.closest("[data-bot-field]")) {
      syncSecretValuesFromDom(event.target);
      return;
    }
    if (event.target.closest("[data-bot-env]")) {
      syncPresetConfigs();
    }
  }

  async function handlePresetListClick(event) {
    const installButton = event.target.closest("[data-bot-install]");
    if (installButton) {
      const presetId = installButton.closest("[data-preset-id]")?.dataset.presetId || "";
      await installPreset(presetId);
      return;
    }

    const startButton = event.target.closest("[data-bot-start]");
    if (startButton) {
      const presetId = startButton.closest("[data-preset-id]")?.dataset.presetId || "";
      await startRuntime(presetId);
      return;
    }

    const stopButton = event.target.closest("[data-bot-stop]");
    if (stopButton) {
      const presetId = stopButton.closest("[data-preset-id]")?.dataset.presetId || "";
      await stopRuntime(presetId);
      return;
    }

    const copyButton = event.target.closest("[data-bot-copy]");
    if (copyButton) {
      const presetId = copyButton.closest("[data-preset-id]")?.dataset.presetId || "";
      const preset = getPresetById(presetId);
      if (preset?.installCommand) {
        await copyCommand(preset.installCommand, `${preset.label} 命令`);
      }
      return;
    }

    const docsButton = event.target.closest("[data-bot-docs]");
    if (!docsButton) {
      return;
    }

    const presetId = docsButton.closest("[data-preset-id]")?.dataset.presetId || "";
    const preset = getPresetById(presetId);
    if (preset?.docsUrl) {
      window.open(preset.docsUrl, "_blank", "noopener,noreferrer");
    }
  }

  function bindEvents() {
    botPresetList?.addEventListener("change", handlePresetListChange);
    botPresetList?.addEventListener("input", handlePresetListInput);
    botPresetList?.addEventListener("click", handlePresetListClick);
    runCustomBotInstallButton?.addEventListener("click", runCustomInstall);
    copyBotCommandsButton?.addEventListener("click", copySelectedCommands);
    startAllBotsButton?.addEventListener("click", () => startRuntime());
    stopAllBotsButton?.addEventListener("click", () => stopRuntime());
    refreshBotRuntimeButton?.addEventListener("click", loadRuntimeStatus);
  }

  return {
    applySettings,
    bindEvents,
    collectSecretEntries,
    collectSettings,
    filterVisibleSharedSecrets,
    loadPresets,
    loadRuntimeStatus,
    ensureAutoStart,
    setConfigStatus
  };
}

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
      "settings.loading": "正在读取本地配置...",
      "settings.loaded": "本地配置已加载。",
      "settings.loadFailed": "加载配置失败：{error}",
      "settings.saving": "正在保存配置...",
      "settings.saved": "配置已保存，敏感字段会加密存储。",
      "settings.saveFailed": "保存配置失败：{error}",
      "settings.configPath": "配置文件：{path}",
      "settings.exiting": "正在退出程序并清理后台进程...",
      "settings.exitingBot": "正在退出程序...",
      "settings.runStateExiting": "退出中...",
      "settings.exitSuccess": "程序正在退出，后台连接器和本地服务会一并关闭。",
      "settings.exitFailed": "退出程序失败：{error}",
      "settings.runStateExitFailed": "退出失败"
    },
    "en-US": {
      "settings.loading": "Loading local settings...",
      "settings.loaded": "Local settings loaded.",
      "settings.loadFailed": "Failed to load settings: {error}",
      "settings.saving": "Saving settings...",
      "settings.saved": "Settings saved. Sensitive fields are stored encrypted.",
      "settings.saveFailed": "Failed to save settings: {error}",
      "settings.configPath": "Settings file: {path}",
      "settings.exiting": "Exiting the application and cleaning up background processes...",
      "settings.exitingBot": "Exiting application...",
      "settings.runStateExiting": "Exiting...",
      "settings.exitSuccess": "The application is exiting. Background connectors and the local service will close together.",
      "settings.exitFailed": "Failed to exit application: {error}",
      "settings.runStateExitFailed": "Exit failed"
    }
  };

  return (key, values = {}) =>
    interpolate(catalog[resolveRuntimeLocale()]?.[key] ?? catalog["zh-CN"]?.[key] ?? key, values);
}

export function createSettingsUi({
  elements,
  phaseParallelInputs,
  schemeUiState,
  workspaceUi,
  botUi,
  multiAgentUi,
  modelsSchemesUi,
  clusterRunUi,
  setSaveStatus,
  setBotConfigStatus,
  createSecretRow,
  collectSecrets,
  mergeSecretEntries,
  runCurrentSchemeConnectivityTests,
  translate = createFallbackTranslator()
}) {
  const {
    portInput,
    parallelInput,
    subordinateParallelInput,
    groupLeaderMaxDelegatesInput,
    delegateMaxDepthInput,
    subagentRetryFallbackThresholdInput,
    controllerSelect,
    secretList,
    configHint,
    saveButton,
    reloadButton,
    exitAppButton,
    runButton,
    cancelButton,
    runState
  } = elements;

  let lastSettingsPath = "";

  function syncLinkedConcurrencyControls() {
    if (subordinateParallelInput) {
      subordinateParallelInput.value = parallelInput.value;
    }
  }

  function hideDeprecatedSubordinateField() {
    const field = subordinateParallelInput?.closest(".field, .toggle-field");
    if (!field) {
      return;
    }

    field.hidden = true;
    field.setAttribute("aria-hidden", "true");
    syncLinkedConcurrencyControls();
  }

  function renderSettingsPath(path = lastSettingsPath) {
    lastSettingsPath = String(path || "");
    if (configHint && lastSettingsPath) {
      configHint.textContent = translate("settings.configPath", { path: lastSettingsPath });
    }
  }

  function collectPhaseParallelSettings() {
    const phaseParallel = {};

    for (const [phase, input] of Object.entries(phaseParallelInputs)) {
      const value = String(input?.value || "").trim();
      if (value) {
        phaseParallel[phase] = value;
      }
    }

    return phaseParallel;
  }

  function collectSettingsPayload() {
    const schemeState = modelsSchemesUi.collectState();
    const currentScheme = schemeState.currentScheme;
    const botSettings = botUi.collectSettings();
    syncLinkedConcurrencyControls();

    return {
      server: {
        port: portInput.value
      },
      cluster: {
        activeSchemeId: currentScheme?.id || schemeUiState.currentSchemeId || "",
        activeSchemeLabel: currentScheme?.label || "",
        controller: controllerSelect.value,
        maxParallel: parallelInput.value,
        subordinateMaxParallel: parallelInput.value,
        groupLeaderMaxDelegates: groupLeaderMaxDelegatesInput?.value,
        delegateMaxDepth: delegateMaxDepthInput?.value,
        subagentRetryFallbackThreshold: subagentRetryFallbackThresholdInput?.value,
        phaseParallel: collectPhaseParallelSettings()
      },
      workspace: workspaceUi.collectSettings(),
      bot: botSettings,
      multiAgent: multiAgentUi.collectSettings(),
      secrets: mergeSecretEntries(collectSecrets(), botUi.collectSecretEntries()),
      schemes: schemeState.schemes,
      models: schemeState.models
    };
  }

  function applySettings(settings) {
    portInput.value = settings.server?.port ?? 4040;
    parallelInput.value = settings.cluster?.maxParallel ?? 3;
    if (subordinateParallelInput) {
      subordinateParallelInput.value = settings.cluster?.maxParallel ?? settings.cluster?.subordinateMaxParallel ?? 3;
    }
    if (groupLeaderMaxDelegatesInput) {
      groupLeaderMaxDelegatesInput.value = settings.cluster?.groupLeaderMaxDelegates ?? 10;
    }
    if (delegateMaxDepthInput) {
      delegateMaxDepthInput.value = settings.cluster?.delegateMaxDepth ?? 1;
    }
    if (subagentRetryFallbackThresholdInput) {
      subagentRetryFallbackThresholdInput.value =
        settings.cluster?.subagentRetryFallbackThreshold ?? 5;
    }

    for (const [phase, input] of Object.entries(phaseParallelInputs)) {
      if (input) {
        input.value = settings.cluster?.phaseParallel?.[phase] ?? "";
      }
    }

    workspaceUi.applySettings(settings.workspace || {});
    botUi.applySettings(settings.bot || {}, settings.secrets || []);
    multiAgentUi.applySettings(settings.multiAgent || {});

    secretList.innerHTML = "";
    for (const secret of botUi.filterVisibleSharedSecrets(settings.secrets || [])) {
      secretList.append(createSecretRow(secret));
    }
    if (!secretList.children.length) {
      secretList.append(createSecretRow({ name: "OPENAI_API_KEY", value: "" }));
    }

    modelsSchemesUi.applySettings(settings);
    syncLinkedConcurrencyControls();
  }

  async function loadSettings() {
    setSaveStatus(translate("settings.loading"), "neutral");

    try {
      const response = await fetch("/api/settings");
      const payload = await response.json();
      if (!payload.ok) {
        throw new Error(payload.error);
      }

      applySettings(payload.settings);
      renderSettingsPath(payload.settingsPath);
      setSaveStatus(translate("settings.loaded"), "ok");
      await workspaceUi.loadSummary();
      await botUi.ensureAutoStart();
      await botUi.loadRuntimeStatus();
      await runCurrentSchemeConnectivityTests({ force: true });
    } catch (error) {
      setSaveStatus(translate("settings.loadFailed", { error: error.message }), "error");
    }
  }

  async function saveSettings() {
    if (saveButton) {
      saveButton.disabled = true;
    }
    setSaveStatus(translate("settings.saving"), "neutral");

    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(collectSettingsPayload())
      });

      const payload = await response.json();
      if (!payload.ok) {
        throw new Error(payload.error);
      }

      applySettings(payload.settings);
      renderSettingsPath(payload.settingsPath);
      setSaveStatus(translate("settings.saved"), "ok");
      await workspaceUi.loadSummary();
      await botUi.ensureAutoStart();
      await botUi.loadRuntimeStatus();
      await runCurrentSchemeConnectivityTests({ force: true });
    } catch (error) {
      setSaveStatus(translate("settings.saveFailed", { error: error.message }), "error");
    } finally {
      if (saveButton) {
        saveButton.disabled = false;
      }
    }
  }

  async function exitApplication() {
    if (exitAppButton) {
      exitAppButton.disabled = true;
    }
    if (saveButton) {
      saveButton.disabled = true;
    }
    if (reloadButton) {
      reloadButton.disabled = true;
    }
    if (runButton) {
      runButton.disabled = true;
    }
    if (cancelButton) {
      cancelButton.disabled = true;
    }

    clusterRunUi.abortActiveRequest(new Error("Application exit requested."));

    setSaveStatus(translate("settings.exiting"), "warning");
    setBotConfigStatus(translate("settings.exitingBot"), "warning");
    if (runState) {
      runState.textContent = translate("settings.runStateExiting");
    }

    try {
      const response = await fetch("/api/system/exit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          reason: "User requested application exit."
        })
      });

      if (response.ok) {
        setSaveStatus(translate("settings.exitSuccess"), "ok");
        setTimeout(() => {
          try {
            window.close();
          } catch {
            // Ignore browser close failures.
          }
        }, 250);
        return;
      }

      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      const message = translate("settings.exitFailed", { error: error.message });
      setSaveStatus(message, "error");
      setBotConfigStatus(message, "error");
      if (runState) {
        runState.textContent = translate("settings.runStateExitFailed");
      }

      if (exitAppButton) {
        exitAppButton.disabled = false;
      }
      if (saveButton) {
        saveButton.disabled = false;
      }
      if (reloadButton) {
        reloadButton.disabled = false;
      }
      if (runButton) {
        runButton.disabled = false;
      }
      if (cancelButton) {
        cancelButton.disabled = !clusterRunUi.getCurrentOperationId();
      }
    }
  }

  function refreshLocale() {
    renderSettingsPath();
  }

  function bindEvents() {
    hideDeprecatedSubordinateField();
    parallelInput?.addEventListener("input", syncLinkedConcurrencyControls);
    parallelInput?.addEventListener("change", syncLinkedConcurrencyControls);
    saveButton?.addEventListener("click", saveSettings);
    reloadButton?.addEventListener("click", loadSettings);
    exitAppButton?.addEventListener("click", exitApplication);
  }

  return {
    applySettings,
    bindEvents,
    collectSettingsPayload,
    exitApplication,
    loadSettings,
    refreshLocale,
    saveSettings
  };
}

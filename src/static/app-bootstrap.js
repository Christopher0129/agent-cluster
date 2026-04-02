import { createAgentVizUi } from "./agent-viz-ui.js";
import { queryAppElements } from "./app-elements.js";
import { createAppShellUi } from "./app-shell-ui.js";
import { createAppState } from "./app-state.js";
import { createBotUi } from "./bot-ui.js";
import { createClusterRunUi } from "./cluster-run-ui.js";
import { createConnectivityUi } from "./connectivity-ui.js";
import { createLocaleUi } from "./locale-ui.js";
import {
  createModelConnectivityService,
  formatModelTestRetryStatus
} from "./model-connectivity-service.js";
import { createModelsSchemesUi } from "./models-schemes-ui.js";
import { setModelTestStatus } from "./model-status-ui.js";
import { createRunConsoleUi } from "./run-console-ui.js";
import { createSecretsUi, mergeSecretEntries } from "./secrets-ui.js";
import { createSettingsUi } from "./settings-ui.js";
import {
  createOperationId,
  escapeAttribute,
  escapeHtml,
  formatDelay,
  formatTimestamp,
  normalizeStringList,
  openOperationStream,
  renderList
} from "./ui-core.js";
import { createWorkspaceUi } from "./workspace-ui.js";

function reportBootstrapError(shellUi, stepLabel, error) {
  const detail = error instanceof Error ? error.message : String(error || "Unknown error");
  console.error(`[app-bootstrap] ${stepLabel} failed:`, error);
  shellUi.setSaveStatus(`${stepLabel}失败: ${detail}`, "error");
}

async function runBootstrapStep(shellUi, stepLabel, task) {
  try {
    return await task();
  } catch (error) {
    reportBootstrapError(shellUi, stepLabel, error);
    return null;
  }
}

export function createAppBootstrap(root = document) {
  const elements = queryAppElements(root);
  const { knownModelConfigs, schemeUiState, botUiState, traceUiState } = createAppState();
  const shellUi = createAppShellUi({ elements });
  let runConsoleUi = null;
  let connectivityUi = null;
  let clusterRunUi = null;
  let settingsUi = null;
  let workspaceUi = null;
  const localeUi = createLocaleUi({
    root,
    elements,
    onChange() {
      shellUi.refreshActiveConsolePanel();
      runConsoleUi?.refreshLocale?.();
      connectivityUi?.refreshLocale?.();
      clusterRunUi?.refreshLocale?.();
      settingsUi?.refreshLocale?.();
      workspaceUi?.refreshLocale?.();
      modelsSchemesUi?.refreshLocale?.();
      botUi?.refreshLocale?.();
    }
  });
  const secretsUi = createSecretsUi({
    addSecretButton: elements.addSecretButton,
    secretList: elements.secretList,
    secretTemplate: elements.secretTemplate
  });

  runConsoleUi = createRunConsoleUi({
    workerOutput: elements.workerOutput,
    traceOutput: elements.traceOutput,
    sessionOutput: elements.sessionOutput,
    traceUiState,
    escapeHtml,
    escapeAttribute,
    renderList
  });

  workspaceUi = createWorkspaceUi({
    elements: {
      workspaceDirInput: elements.workspaceDirInput,
      pickWorkspaceButton: elements.pickWorkspaceButton,
      refreshWorkspaceButton: elements.refreshWorkspaceButton,
      clearWorkspaceCacheButton: elements.clearWorkspaceCacheButton,
      workspaceTreeOutput: elements.workspaceTreeOutput,
      importWorkspaceFilesInput: elements.importWorkspaceFilesInput,
      importWorkspaceFilesButton: elements.importWorkspaceFilesButton,
      workspaceImportTargetInput: elements.workspaceImportTargetInput,
      workspaceFilePathInput: elements.workspaceFilePathInput,
      readWorkspaceFileButton: elements.readWorkspaceFileButton,
      workspaceFileOutput: elements.workspaceFileOutput
    },
    setSaveStatus: shellUi.setSaveStatus,
    translate: (...args) => localeUi.t(...args)
  });

  const botUi = createBotUi({
    state: botUiState,
    elements: {
      botConfigStatus: elements.botConfigStatus,
      botInstallDirInput: elements.botInstallDirInput,
      botCommandPrefixInput: elements.botCommandPrefixInput,
      botAutoStartInput: elements.botAutoStartInput,
      botProgressUpdatesInput: elements.botProgressUpdatesInput,
      botCustomCommandInput: elements.botCustomCommandInput,
      botPresetList: elements.botPresetList,
      botInstallOutput: elements.botInstallOutput,
      startAllBotsButton: elements.startAllBotsButton,
      stopAllBotsButton: elements.stopAllBotsButton,
      refreshBotRuntimeButton: elements.refreshBotRuntimeButton,
      runCustomBotInstallButton: elements.runCustomBotInstallButton,
      copyBotCommandsButton: elements.copyBotCommandsButton
    },
    escapeHtml,
    escapeAttribute,
    normalizeStringList,
    formatTimestamp,
    getWorkspaceDirValue: workspaceUi.getDirValue,
    loadWorkspaceSummary: workspaceUi.loadSummary,
    saveSettings: (...args) => settingsUi?.saveSettings(...args)
  });

  const modelsSchemesUi = createModelsSchemesUi({
    state: schemeUiState,
    knownModelConfigs,
    elements: {
      modelList: elements.modelList,
      modelTemplate: elements.modelTemplate,
      schemeSelect: elements.schemeSelect,
      schemeNameInput: elements.schemeNameInput,
      addSchemeButton: elements.addSchemeButton,
      removeSchemeButton: elements.removeSchemeButton,
      schemeHint: elements.schemeHint,
      controllerSelect: elements.controllerSelect,
      addModelButton: elements.addModelButton,
      batchAddButton: elements.batchAddButton,
      batchIdPrefixInput: elements.batchIdPrefixInput,
      batchLabelPrefixInput: elements.batchLabelPrefixInput,
      batchEnvPrefixInput: elements.batchEnvPrefixInput,
      batchProviderSelect: elements.batchProviderSelect,
      batchProviderHint: elements.batchProviderHint,
      batchModelNameInput: elements.batchModelNameInput,
      batchBaseUrlInput: elements.batchBaseUrlInput,
      batchAuthStyleSelect: elements.batchAuthStyleSelect,
      batchApiKeyHeaderInput: elements.batchApiKeyHeaderInput,
      batchReasoningSelect: elements.batchReasoningSelect,
      batchWebSearchInput: elements.batchWebSearchInput,
      batchTemperatureInput: elements.batchTemperatureInput,
      batchCapabilityList: elements.batchCapabilityList,
      batchSpecialtiesCustomInput: elements.batchSpecialtiesCustomInput,
      batchKeysList: elements.batchKeysList
    },
    setSaveStatus: shellUi.setSaveStatus,
    setModelTestStatus
  });

  const modelConnectivityService = createModelConnectivityService({
    collectSecrets: secretsUi.collectSecrets,
    createOperationId,
    openOperationStream,
    getConnectivityUi: () => connectivityUi,
    captureCurrentSchemeDraft: () => modelsSchemesUi.captureCurrentSchemeDraft()
  });

  connectivityUi = createConnectivityUi({
    state: schemeUiState,
    elements: {
      schemeConnectivityStatus: elements.schemeConnectivityStatus,
      schemeConnectivityList: elements.schemeConnectivityList,
      schemeConnectivityRetestButton: elements.schemeConnectivityRetestButton,
      modelList: elements.modelList
    },
    escapeHtml,
    escapeAttribute,
    getCurrentScheme: () => modelsSchemesUi.getCurrentScheme(),
    setModelTestStatus,
    collectSecrets: secretsUi.collectSecrets,
    collectModelFromCard: (card) => modelsSchemesUi.collectModelFromCard(card),
    runModelConnectivityTest: modelConnectivityService.runModelConnectivityTest,
    formatModelTestRetryStatus
  });

  modelsSchemesUi.setCallbacks({
    renderConnectivityList: () => connectivityUi.renderList(),
    applyStoredConnectivityToVisibleCards: () => connectivityUi.applyStoredStatusesToVisibleCards(),
    markModelDirty: (modelId) => connectivityUi.markModelDirty(modelId),
    testSingleModel: (card) => connectivityUi.testSingleModel(card),
    runCurrentSchemeConnectivityTests: (options) =>
      modelConnectivityService.runCurrentSchemeConnectivityTests(options)
  });

  const agentVizUi = createAgentVizUi({
    elements: {
      agentVizSummary: elements.agentVizSummary,
      agentVizTimer: elements.agentVizTimer,
      agentVizStage: elements.agentVizStage,
      agentVizZoomLayer: elements.agentVizZoomLayer,
      agentVizSvg: elements.agentVizSvg,
      agentVizTooltip: elements.agentVizTooltip,
      agentVizInspector: elements.agentVizInspector,
      agentVizZoomLabel: elements.agentVizZoomLabel,
      agentVizZoomOutButton: elements.agentVizZoomOutButton,
      agentVizZoomInButton: elements.agentVizZoomInButton,
      agentVizResetButton: elements.agentVizResetButton
    },
    knownModelConfigs,
    escapeHtml,
    escapeAttribute,
    getSelectedControllerId: () => elements.controllerSelect?.value || "",
    formatDelay,
    formatTimestamp
  });

  clusterRunUi = createClusterRunUi({
    elements: {
      taskInput: elements.taskInput,
      runButton: elements.runButton,
      cancelButton: elements.cancelButton,
      runState: elements.runState,
      planOutput: elements.planOutput,
      workerOutput: elements.workerOutput,
      synthesisOutput: elements.synthesisOutput,
      liveOutput: elements.liveOutput
    },
    runConsoleUi,
    agentVizUi,
    escapeHtml,
    renderList,
    setActiveConsolePanel: shellUi.setActiveConsolePanel,
    setSaveStatus: shellUi.setSaveStatus,
    formatDelay,
    formatTimestamp,
    getCurrentScheme: () => modelsSchemesUi.getCurrentScheme(),
    captureCurrentSchemeDraft: () => modelsSchemesUi.captureCurrentSchemeDraft(),
    openOperationStream,
    createOperationId
  });

  settingsUi = createSettingsUi({
    elements: {
      portInput: elements.portInput,
      parallelInput: elements.parallelInput,
      subordinateParallelInput: elements.subordinateParallelInput,
      groupLeaderMaxDelegatesInput: elements.groupLeaderMaxDelegatesInput,
      delegateMaxDepthInput: elements.delegateMaxDepthInput,
      controllerSelect: elements.controllerSelect,
      secretList: elements.secretList,
      configHint: elements.configHint,
      saveButton: elements.saveButton,
      reloadButton: elements.reloadButton,
      exitAppButton: elements.exitAppButton,
      runButton: elements.runButton,
      cancelButton: elements.cancelButton,
      runState: elements.runState
    },
    phaseParallelInputs: elements.phaseParallelInputs,
    schemeUiState,
    workspaceUi,
    botUi,
    modelsSchemesUi,
    clusterRunUi,
    setSaveStatus: shellUi.setSaveStatus,
    setBotConfigStatus: (...args) => botUi.setConfigStatus(...args),
    createSecretRow: (secret) => secretsUi.createSecretRow(secret),
    collectSecrets: secretsUi.collectSecrets,
    mergeSecretEntries,
    runCurrentSchemeConnectivityTests: modelConnectivityService.runCurrentSchemeConnectivityTests
  });

  const bindingSteps = [
    ["语言切换接线", () => localeUi.bindEvents()],
    ["导航与保存提示接线", () => shellUi.bindEvents()],
    ["密钥区接线", () => secretsUi.bindEvents()],
    ["拓扑视图接线", () => agentVizUi.bindEvents()],
    ["集群运行接线", () => clusterRunUi.bindEvents()],
    ["设置区接线", () => settingsUi.bindEvents()],
    ["方案区接线", () => modelsSchemesUi.bindEvents()],
    ["工作区接线", () => workspaceUi.bindEvents()],
    ["Bot 区接线", () => botUi.bindEvents()]
  ];

  async function bindAppModules() {
    for (const [label, task] of bindingSteps) {
      await runBootstrapStep(shellUi, label, task);
    }
  }

  async function initializeApp() {
    await bindAppModules();
    await runBootstrapStep(shellUi, "语言偏好恢复", () => localeUi.restoreLocale());
    await runBootstrapStep(shellUi, "控制台视图恢复", () => shellUi.restoreConsolePanel());

    if (elements.cancelButton) {
      elements.cancelButton.disabled = true;
    }

    await runBootstrapStep(shellUi, "拓扑视图重置", () => agentVizUi.reset());
    await runBootstrapStep(shellUi, "方案区初始化", () => modelsSchemesUi.initialize());
    await runBootstrapStep(shellUi, "Bot 预设加载", () => botUi.loadPresets());
    await runBootstrapStep(shellUi, "本地设置加载", () => settingsUi.loadSettings());
  }

  return {
    elements,
    initializeApp,
    modules: {
      agentVizUi,
      botUi,
      clusterRunUi,
      connectivityUi,
      localeUi,
      modelsSchemesUi,
      runConsoleUi,
      secretsUi,
      settingsUi,
      shellUi,
      workspaceUi
    }
  };
}

export function startApp(root = document) {
  const run = () => {
    const app = createAppBootstrap(root);
    app.initializeApp().catch((error) => {
      reportBootstrapError(app.modules.shellUi, "应用初始化", error);
    });
    return app;
  };

  if (root.readyState === "loading") {
    root.addEventListener(
      "DOMContentLoaded",
      () => {
        run();
      },
      { once: true }
    );
    return null;
  }

  return run();
}

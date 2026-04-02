const DEFAULT_CONSOLE_PANEL_ID = "cluster";
const CONSOLE_PANEL_STORAGE_KEY = "agent-cluster:active-console-panel";
const SAVE_TOAST_AUTO_HIDE_MS = 2800;

export function createAppShellUi({
  elements,
  defaultConsolePanelId = DEFAULT_CONSOLE_PANEL_ID,
  consolePanelStorageKey = CONSOLE_PANEL_STORAGE_KEY
}) {
  const {
    consoleNav,
    consoleNavButtons = [],
    consolePanels = [],
    consolePanelKicker,
    consolePanelTitle,
    consolePanelDescription,
    saveStatus,
    saveToast,
    saveStatusClose
  } = elements;

  let saveToastTimer = null;

  function clearSaveToastTimer() {
    if (saveToastTimer) {
      clearTimeout(saveToastTimer);
      saveToastTimer = null;
    }
  }

  function hideSaveToast() {
    clearSaveToastTimer();
    if (saveToast) {
      saveToast.hidden = true;
    }
  }

  function setSaveStatus(message, tone = "neutral") {
    if (saveStatus) {
      saveStatus.textContent = String(message || "");
      saveStatus.dataset.tone = tone || "neutral";
    }
    if (saveToast) {
      saveToast.hidden = false;
      saveToast.dataset.tone = tone || "neutral";
    }

    clearSaveToastTimer();
    if (tone !== "error" && tone !== "warning") {
      saveToastTimer = setTimeout(hideSaveToast, SAVE_TOAST_AUTO_HIDE_MS);
    }
  }

  function updatePanelHeader(panel) {
    if (!panel) {
      return;
    }

    if (consolePanelKicker) {
      consolePanelKicker.textContent = panel.dataset.panelKicker || "";
    }
    if (consolePanelTitle) {
      consolePanelTitle.textContent = panel.dataset.panelTitle || "";
    }
    if (consolePanelDescription) {
      consolePanelDescription.textContent = panel.dataset.panelDescription || "";
    }
  }

  function getActiveConsolePanel() {
    return consolePanels.find((panel) => panel.classList.contains("is-active")) || null;
  }

  function setActiveConsolePanel(panelId = defaultConsolePanelId) {
    const normalizedId = String(panelId || "").trim() || defaultConsolePanelId;
    const fallbackPanel =
      consolePanels.find((panel) => panel.dataset.consolePanel === defaultConsolePanelId) ||
      consolePanels[0] ||
      null;
    const nextPanel =
      consolePanels.find((panel) => panel.dataset.consolePanel === normalizedId) || fallbackPanel;
    const nextPanelId = nextPanel?.dataset.consolePanel || defaultConsolePanelId;

    for (const button of consoleNavButtons) {
      button.classList.toggle("is-active", button.dataset.consoleNav === nextPanelId);
    }

    for (const panel of consolePanels) {
      const isActive = panel === nextPanel;
      panel.classList.toggle("is-active", isActive);
      panel.hidden = !isActive;
    }

    updatePanelHeader(nextPanel);

    try {
      localStorage.setItem(consolePanelStorageKey, nextPanelId);
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }

  function restoreConsolePanel() {
    let storedPanelId = "";

    try {
      storedPanelId = localStorage.getItem(consolePanelStorageKey) || "";
    } catch {
      // Ignore storage failures in restricted environments.
    }

    setActiveConsolePanel(storedPanelId || defaultConsolePanelId);
  }

  function refreshActiveConsolePanel() {
    updatePanelHeader(getActiveConsolePanel());
  }

  function handleConsoleNavClick(event) {
    const button = event.target.closest("[data-console-nav]");
    if (!button) {
      return;
    }

    setActiveConsolePanel(button.dataset.consoleNav || defaultConsolePanelId);
  }

  function bindEvents() {
    consoleNav?.addEventListener("click", handleConsoleNavClick);
    saveStatusClose?.addEventListener("click", hideSaveToast);
  }

  return {
    bindEvents,
    refreshActiveConsolePanel,
    hideSaveToast,
    restoreConsolePanel,
    setActiveConsolePanel,
    setSaveStatus
  };
}

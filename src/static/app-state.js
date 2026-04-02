export function createAppState() {
  return {
    knownModelConfigs: new Map(),
    schemeUiState: {
      schemes: [],
      currentSchemeId: "",
      connectivityBySchemeId: new Map(),
      connectivityRunToken: 0
    },
    botUiState: {
      defaultInstallDir: "bot-connectors",
      presets: [],
      enabledPresetIds: new Set(),
      presetConfigById: new Map(),
      runtimeById: new Map(),
      secretValueByName: new Map(),
      installStatusById: new Map(),
      installingPresetId: ""
    },
    traceUiState: {
      spans: new Map(),
      session: null
    }
  };
}

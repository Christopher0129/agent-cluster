import {
  getEditableSettings,
  loadRuntimeConfig,
  saveEditableSettings,
  summarizeConfig
} from "../config.mjs";
import { readRequestBody, sendJson } from "./common.mjs";

export async function handleConfigRequest(response, projectDir, runtimeConfigOptions) {
  try {
    const config = loadRuntimeConfig(projectDir, runtimeConfigOptions);
    sendJson(response, 200, {
      ok: true,
      config: summarizeConfig(config)
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleSettingsRequest(response, projectDir, runtimeConfigOptions) {
  try {
    const payload = getEditableSettings(projectDir, runtimeConfigOptions);
    sendJson(response, 200, {
      ok: true,
      ...payload
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

export async function handleSettingsSave(request, response, projectDir, runtimeConfigOptions) {
  try {
    const body = await readRequestBody(request);
    const saved = await saveEditableSettings(projectDir, body, runtimeConfigOptions);
    sendJson(response, 200, {
      ok: true,
      ...saved
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

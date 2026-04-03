import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractJsonCandidate, parseJsonFromText } from "../../src/utils/json-output.mjs";
import { createAppServer } from "../../src/app.mjs";
import { runClusterAnalysis } from "../../src/cluster/orchestrator.mjs";
import {
  getEditableSettings,
  loadRuntimeConfig,
  saveEditableSettings
} from "../../src/config.mjs";
import { createSessionRuntime } from "../../src/session/runtime.mjs";
import { postJson } from "../../src/providers/http-client.mjs";
import { testModelConnectivity } from "../../src/providers/connectivity-test.mjs";
import { createProviderForModel } from "../../src/providers/factory.mjs";
import { AnthropicMessagesProvider } from "../../src/providers/anthropic-messages.mjs";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.mjs";
import { providerSupportsCapability } from "../../src/static/provider-catalog.js";
import {
  buildAgentLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "../../src/static/agent-graph-layout.js";
import { runWorkspaceToolLoop } from "../../src/workspace/agent-loop.mjs";
import { DelayedJsonProvider, FakeProvider, waitForDelay } from "../helpers/providers.mjs";

async function runSettingsTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 2 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      server: { port: 5050 },
      cluster: {
        controller: "worker",
        maxParallel: 0,
        subordinateMaxParallel: 0,
        groupLeaderMaxDelegates: 0,
        delegateMaxDepth: 2,
        phaseParallel: {
          research: "0",
          validation: "1"
        }
      },
      workspace: { dir: "./project-workspace" },
      bot: {
        installDir: "custom-bot-connectors",
        customCommand: "npm install some-bot-plugin",
        enabledPresets: ["feishu", "dingtalk"],
        commandPrefix: "/agent",
        autoStart: true,
        progressUpdates: false,
        presetConfigs: {
          feishu: {
            envText: "HTTP_PROXY=http://127.0.0.1:7890"
          }
        }
      },
      secrets: [
        { name: "OPENAI_API_KEY", value: "sk-test" },
        { name: "MOONSHOT_API_KEY", value: "moonshot-test" },
        { name: "FEISHU_APP_ID", value: "feishu-app-id" },
        { name: "FEISHU_APP_SECRET", value: "feishu-app-secret" }
      ],
      models: [
        {
          id: "worker",
          label: "Worker Controller",
          provider: "openai-chat",
          model: "kimi-2.5",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKeyEnv: "MOONSHOT_API_KEY",
          apiKeyValue: "moonshot-model-key",
          authStyle: "bearer",
          specialties: ["analysis", "long context reading"],
          temperature: "0.2"
        },
        {
          id: "coder",
          label: "Codex Worker",
          provider: "openai-responses",
          model: "gpt-5.3-codex",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          apiKeyValue: "openai-model-key",
          authStyle: "bearer",
          reasoningEffort: "medium",
          webSearch: true,
          specialties: "coding, debugging"
        }
      ]
    });

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settings.cluster.activeSchemeId, "gpt_scheme");
    assert.equal(editable.settings.cluster.controller, "worker");
    assert.equal(editable.settings.schemes.length, 1);
    assert.equal(editable.settings.schemes[0].label, "gpt方案");
    assert.equal(editable.settings.server.port, 5050);
    assert.equal(editable.providerDefinitions.some((definition) => definition.id === "kimi-coding"), true);
    assert.equal(editable.settings.cluster.maxParallel, 0);
    assert.equal(editable.settings.cluster.subordinateMaxParallel, 0);
    assert.equal(editable.settings.cluster.groupLeaderMaxDelegates, 0);
    assert.equal(editable.settings.cluster.delegateMaxDepth, 2);
    assert.equal(editable.settings.cluster.phaseParallel.research, 0);
    assert.equal(editable.settings.cluster.phaseParallel.validation, 1);
    assert.equal(editable.settings.workspace.dir, "./project-workspace");
    assert.equal(editable.settings.bot.installDir, "custom-bot-connectors");
    assert.equal(editable.settings.bot.customCommand, "npm install some-bot-plugin");
    assert.deepEqual(editable.settings.bot.enabledPresets, ["feishu", "dingtalk"]);
    assert.equal(editable.settings.bot.commandPrefix, "/agent");
    assert.equal(editable.settings.bot.autoStart, true);
    assert.equal(editable.settings.bot.progressUpdates, false);
    assert.equal(editable.settings.bot.presetConfigs.feishu.envText, "HTTP_PROXY=http://127.0.0.1:7890");
    assert.equal(editable.settings.models.length, 2);
    assert.equal(editable.settings.models[0].apiKeyValue, "moonshot-model-key");
    assert.equal(editable.settings.models[1].apiKeyValue, "openai-model-key");
    assert.equal(editable.settings.models[1].webSearch, true);
    assert.equal(
      editable.settings.secrets.some((entry) => entry.name === "FEISHU_APP_ID" && entry.value === "feishu-app-id"),
      true
    );

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.server.port, 5050);
    assert.equal(runtime.cluster.activeSchemeId, "gpt_scheme");
    assert.equal(runtime.cluster.activeSchemeLabel, "gpt方案");
    assert.equal(runtime.cluster.controller, "worker");
    assert.equal(runtime.cluster.maxParallel, 0);
    assert.equal(runtime.cluster.subordinateMaxParallel, 0);
    assert.equal(runtime.cluster.groupLeaderMaxDelegates, 0);
    assert.equal(runtime.cluster.delegateMaxDepth, 2);
    assert.equal(runtime.cluster.phaseParallel.research, 0);
    assert.equal(runtime.cluster.phaseParallel.validation, 1);
    assert.equal(runtime.workspace.dir, "./project-workspace");
    assert.equal(runtime.workspace.resolvedDir, join(projectDir, "project-workspace"));
    assert.equal(runtime.bot.installDir, "custom-bot-connectors");
    assert.deepEqual(runtime.bot.enabledPresets, ["feishu", "dingtalk"]);
    assert.equal(runtime.bot.commandPrefix, "/agent");
    assert.equal(runtime.bot.autoStart, true);
    assert.equal(runtime.bot.progressUpdates, false);
    assert.equal(runtime.bot.presetConfigs.feishu.envText, "HTTP_PROXY=http://127.0.0.1:7890");
    assert.equal(runtime.models.worker.role, "controller");
    assert.deepEqual(runtime.models.worker.specialties, ["analysis", "long context reading"]);
    assert.equal(runtime.models.coder.reasoning.effort, "medium");
    assert.equal(runtime.models.coder.webSearch, true);
    assert.equal(runtime.models.worker.temperature, 0.2);
    assert.equal(process.env.MOONSHOT_API_KEY, "moonshot-model-key");
    assert.equal(process.env.OPENAI_API_KEY, "openai-model-key");
    assert.equal(process.env.FEISHU_APP_ID, "feishu-app-id");
    assert.equal(process.env.FEISHU_APP_SECRET, "feishu-app-secret");

    const persistedRaw = await readFile(join(projectDir, "runtime.settings.json"), "utf8");
    const persisted = JSON.parse(persistedRaw);
    assert.equal(Boolean(persisted.secretsEncrypted), true);
    assert.equal("secrets" in persisted, false);
    assert.equal(persistedRaw.includes("moonshot-model-key"), false);
    assert.equal(persistedRaw.includes("openai-model-key"), false);
    assert.equal(persistedRaw.includes("feishu-app-id"), false);
    assert.equal(persistedRaw.includes("feishu-app-secret"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runLegacyDistSettingsFallbackTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-legacy-dist-"));
  const legacySettingsDir = join(projectDir, "dist");

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 2 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await mkdir(legacySettingsDir, { recursive: true });
    await writeFile(
      join(legacySettingsDir, "runtime.settings.json"),
      `${JSON.stringify(
        {
          server: { port: 5151 },
          cluster: {
            activeSchemeId: "legacy_scheme",
            activeSchemeLabel: "Legacy Scheme",
            controller: "legacy_controller",
            maxParallel: 7,
            subordinateMaxParallel: 4,
            groupLeaderMaxDelegates: 2,
            delegateMaxDepth: 3
          },
          workspace: {
            dir: "./legacy-workspace"
          },
          bot: {
            installDir: "legacy-bots",
            customCommand: "",
            enabledPresets: ["feishu"],
            commandPrefix: "/agent",
            autoStart: false,
            progressUpdates: true,
            presetConfigs: {}
          },
          models: {
            legacy_controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              authStyle: "bearer",
              label: "Legacy Controller",
              specialties: ["controller"]
            },
            legacy_worker: {
              provider: "openai-chat",
              model: "kimi-k2.5",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              authStyle: "bearer",
              label: "Legacy Worker",
              specialties: ["research"]
            }
          },
          schemes: {
            legacy_scheme: {
              label: "Legacy Scheme",
              controller: "legacy_controller",
              models: {
                legacy_controller: {
                  provider: "openai-responses",
                  model: "gpt-5.4",
                  baseUrl: "https://api.openai.com/v1",
                  apiKeyEnv: "OPENAI_API_KEY",
                  authStyle: "bearer",
                  label: "Legacy Controller",
                  specialties: ["controller"]
                },
                legacy_worker: {
                  provider: "openai-chat",
                  model: "kimi-k2.5",
                  baseUrl: "https://api.moonshot.cn/v1",
                  apiKeyEnv: "MOONSHOT_API_KEY",
                  authStyle: "bearer",
                  label: "Legacy Worker",
                  specialties: ["research"]
                }
              }
            }
          },
          secrets: {
            OPENAI_API_KEY: "legacy-openai-key",
            MOONSHOT_API_KEY: "legacy-moonshot-key"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settingsPath, join(projectDir, "dist", "runtime.settings.json"));
    assert.equal(editable.settings.server.port, 5151);
    assert.equal(editable.settings.cluster.activeSchemeId, "legacy_scheme");
    assert.equal(editable.settings.cluster.controller, "legacy_controller");
    assert.equal(editable.settings.workspace.dir, "./legacy-workspace");
    assert.equal(editable.settings.models.length, 2);
    assert.equal(editable.settings.models[0].apiKeyValue, "legacy-openai-key");
    assert.equal(editable.settings.models[1].apiKeyValue, "legacy-moonshot-key");

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.settingsPath, join(projectDir, "dist", "runtime.settings.json"));
    assert.equal(runtime.server.port, 5151);
    assert.equal(runtime.cluster.activeSchemeId, "legacy_scheme");
    assert.equal(runtime.cluster.controller, "legacy_controller");
    assert.equal(runtime.cluster.maxParallel, 7);
    assert.equal(runtime.workspace.dir, "./legacy-workspace");
    assert.equal(runtime.models.legacy_controller.role, "controller");
    assert.equal(process.env.OPENAI_API_KEY, "legacy-openai-key");
    assert.equal(process.env.MOONSHOT_API_KEY, "legacy-moonshot-key");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runBlankClusterSettingFallbackTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-blank-fallback-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: {
            controller: "controller",
            maxParallel: 9,
            subordinateMaxParallel: 4,
            groupLeaderMaxDelegates: 6,
            delegateMaxDepth: 2
          },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "worker",
        maxParallel: "",
        subordinateMaxParallel: "",
        groupLeaderMaxDelegates: "",
        delegateMaxDepth: ""
      },
      workspace: { dir: "./workspace" },
      bot: {},
      secrets: [],
      models: [
        {
          id: "worker",
          label: "Worker",
          provider: "kimi-chat",
          model: "kimi-k2.5",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKeyEnv: "MOONSHOT_API_KEY",
          authStyle: "bearer",
          specialties: ["research"]
        },
        {
          id: "controller",
          label: "Controller",
          provider: "openai-responses",
          model: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          authStyle: "bearer",
          specialties: ["controller"]
        }
      ]
    });

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.cluster.maxParallel, 9);
    assert.equal(runtime.cluster.subordinateMaxParallel, 4);
    assert.equal(runtime.cluster.groupLeaderMaxDelegates, 6);
    assert.equal(runtime.cluster.delegateMaxDepth, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runSchemeSettingsTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-schemes-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 2 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      server: { port: 6060 },
      cluster: {
        activeSchemeId: "gpt_plan",
        controller: "gpt_controller",
        maxParallel: 3,
        subordinateMaxParallel: 2,
        groupLeaderMaxDelegates: 4
      },
      workspace: { dir: "./scheme-workspace" },
      schemes: [
        {
          id: "gpt_plan",
          label: "gpt方案",
          controller: "gpt_controller",
          models: [
            {
              id: "gpt_controller",
              label: "GPT Controller",
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY_GPT",
              apiKeyValue: "gpt-controller-key",
              authStyle: "bearer",
              reasoningEffort: "xhigh",
              webSearch: true,
              specialties: ["task planning", "delegation", "synthesis"]
            },
            {
              id: "gpt_coder",
              label: "GPT Codex",
              provider: "openai-responses",
              model: "gpt-5.3-codex",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY_CODEX",
              apiKeyValue: "gpt-codex-key",
              authStyle: "bearer",
              reasoningEffort: "high",
              specialties: ["coding", "debugging"]
            }
          ]
        },
        {
          id: "kimi_plan",
          label: "Kimi方案",
          controller: "kimi_controller",
          models: [
            {
              id: "kimi_controller",
              label: "Kimi Controller",
              provider: "openai-chat",
              model: "kimi-2.5",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "KIMI_PLAN_KEY_1",
              apiKeyValue: "kimi-controller-key",
              authStyle: "bearer",
              temperature: "0.2",
              specialties: ["analysis", "long context reading"]
            },
            {
              id: "kimi_worker_1",
              label: "Kimi Worker 1",
              provider: "openai-chat",
              model: "kimi-2.5",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "KIMI_PLAN_KEY_2",
              apiKeyValue: "kimi-worker-key",
              authStyle: "bearer",
              temperature: "0.3",
              specialties: ["analysis", "chat"]
            }
          ]
        }
      ],
      secrets: [],
      bot: {}
    });

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settings.cluster.activeSchemeId, "gpt_plan");
    assert.equal(editable.settings.cluster.controller, "gpt_controller");
    assert.equal(editable.settings.schemes.length, 2);
    assert.equal(editable.settings.schemes[0].label, "gpt方案");
    assert.equal(editable.settings.schemes[1].label, "Kimi方案");
    assert.equal(editable.settings.models.length, 2);
    assert.equal(editable.settings.models[0].id, "gpt_controller");

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.server.port, 6060);
    assert.equal(runtime.cluster.activeSchemeId, "gpt_plan");
    assert.equal(runtime.cluster.activeSchemeLabel, "gpt方案");
    assert.equal(runtime.cluster.controller, "gpt_controller");
    assert.equal(Boolean(runtime.models.gpt_controller), true);
    assert.equal(Boolean(runtime.models.kimi_controller), false);

    const kimiRuntime = loadRuntimeConfig(projectDir, { schemeId: "kimi_plan" });
    assert.equal(kimiRuntime.cluster.activeSchemeId, "kimi_plan");
    assert.equal(kimiRuntime.cluster.activeSchemeLabel, "Kimi方案");
    assert.equal(kimiRuntime.cluster.controller, "kimi_controller");
    assert.equal(Boolean(kimiRuntime.models.kimi_controller), true);
    assert.equal(Boolean(kimiRuntime.models.gpt_controller), false);
    assert.equal(process.env.OPENAI_API_KEY_GPT, "gpt-controller-key");
    assert.equal(process.env.OPENAI_API_KEY_CODEX, "gpt-codex-key");
    assert.equal(process.env.KIMI_PLAN_KEY_1, "kimi-controller-key");
    assert.equal(process.env.KIMI_PLAN_KEY_2, "kimi-worker-key");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

export async function runConfigSmokeTests() {
  await runSettingsTests();
  await runLegacyDistSettingsFallbackTests();
  await runBlankClusterSettingFallbackTests();
  await runSchemeSettingsTests();
}

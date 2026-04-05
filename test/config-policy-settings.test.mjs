import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getEditableSettings,
  loadRuntimeConfig,
  saveEditableSettings
} from "../src/config.mjs";

function buildBaseConfig() {
  return {
    server: { port: 4040 },
    cluster: {
      controller: "controller",
      maxParallel: 2,
      subordinateMaxParallel: 2,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1
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
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "WORKER_API_KEY",
        label: "Worker"
      }
    }
  };
}

function buildModelsPayload() {
  return [
    {
      id: "controller",
      label: "Controller",
      provider: "openai-responses",
      model: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "controller-key",
      authStyle: "bearer",
      thinkingEnabled: true,
      reasoningEffort: "medium",
      webSearch: true,
      specialties: ["controller", "planning"]
    },
    {
      id: "worker",
      label: "Worker",
      provider: "openai-chat",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "WORKER_API_KEY",
      apiKeyValue: "worker-key",
      authStyle: "bearer",
      specialties: ["implementation"]
    }
  ];
}

test("saveEditableSettings round-trips advanced cluster policies from JSON strings", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-policy-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(buildBaseConfig(), null, 2)}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "controller",
        maxParallel: 2,
        subordinateMaxParallel: 2,
        groupLeaderMaxDelegates: 3,
        delegateMaxDepth: 1,
        agentBudgetProfiles: JSON.stringify({
          moderate: {
            maxTopLevelTasks: 2,
            maxChildrenPerLeader: 1,
            maxTotalAgents: 4
          },
          complex: {
            maxTopLevelTasks: 3,
            maxChildrenPerLeader: 2,
            maxTotalAgents: 6
          },
          veryComplex: {
            maxTopLevelTasks: 4,
            maxChildrenPerLeader: 2,
            maxTotalAgents: 7
          }
        }),
        capabilityRoutingPolicy: JSON.stringify({
          requireWebSearchForFreshFacts: false,
          preferWebSearchForResearch: false,
          requireValidationSpecialistForValidation: false,
          requireCodingManagerForCodeReview: false,
          preferCodexForImplementation: true,
          requirePhaseSpecialistForHandoff: true
        })
      },
      workspace: { dir: "./workspace" },
      bot: {},
      secrets: [],
      models: buildModelsPayload()
    });

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settings.cluster.agentBudgetProfiles.moderate.maxChildrenPerLeader, 1);
    assert.equal(editable.settings.cluster.agentBudgetProfiles.complex.maxTotalAgents, 6);
    assert.equal(editable.settings.cluster.agentBudgetProfiles.moderate.maxScore, 4);
    assert.equal(editable.settings.cluster.capabilityRoutingPolicy.requireWebSearchForFreshFacts, false);
    assert.equal(editable.settings.cluster.capabilityRoutingPolicy.requirePhaseSpecialistForHandoff, true);

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.cluster.agentBudgetProfiles.veryComplex.maxTotalAgents, 7);
    assert.equal(runtime.cluster.agentBudgetProfiles.complex.maxDelegationDepth, 2);
    assert.equal(runtime.cluster.capabilityRoutingPolicy.preferWebSearchForResearch, false);
    assert.equal(runtime.cluster.capabilityRoutingPolicy.preferCodexForImplementation, true);
    assert.equal(editable.settings.models[0].thinkingEnabled, true);
    assert.equal(runtime.models.controller.thinkingEnabled, true);

    const persisted = JSON.parse(await readFile(join(projectDir, "runtime.settings.json"), "utf8"));
    assert.equal(persisted.cluster.agentBudgetProfiles.moderate.maxChildrenPerLeader, 1);
    assert.equal(persisted.cluster.capabilityRoutingPolicy.requireCodingManagerForCodeReview, false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("saveEditableSettings accepts object policy payloads and fills default values", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-policy-object-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(buildBaseConfig(), null, 2)}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "controller",
        maxParallel: 2,
        subordinateMaxParallel: 2,
        groupLeaderMaxDelegates: 3,
        delegateMaxDepth: 1,
        agentBudgetProfiles: {
          simple: {
            maxTotalAgents: 3
          }
        },
        capabilityRoutingPolicy: {
          requireWebSearchForFreshFacts: false
        }
      },
      workspace: { dir: "./workspace" },
      bot: {},
      secrets: [],
      models: buildModelsPayload()
    });

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.cluster.agentBudgetProfiles.simple.maxTotalAgents, 3);
    assert.equal(runtime.cluster.agentBudgetProfiles.moderate.maxTotalAgents, 5);
    assert.equal(runtime.cluster.capabilityRoutingPolicy.requireWebSearchForFreshFacts, false);
    assert.equal(runtime.cluster.capabilityRoutingPolicy.requireValidationSpecialistForValidation, true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("saveEditableSettings links subordinateMaxParallel to maxParallel", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-linked-concurrency-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(buildBaseConfig(), null, 2)}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "controller",
        maxParallel: 5,
        subordinateMaxParallel: 1,
        groupLeaderMaxDelegates: 3,
        delegateMaxDepth: 1
      },
      workspace: { dir: "./workspace" },
      bot: {},
      secrets: [],
      models: buildModelsPayload()
    });

    const editable = getEditableSettings(projectDir);
    const runtime = loadRuntimeConfig(projectDir);

    assert.equal(editable.settings.cluster.maxParallel, 5);
    assert.equal(editable.settings.cluster.subordinateMaxParallel, 5);
    assert.equal(runtime.cluster.maxParallel, 5);
    assert.equal(runtime.cluster.subordinateMaxParallel, 5);

    const persisted = JSON.parse(await readFile(join(projectDir, "runtime.settings.json"), "utf8"));
    assert.equal(persisted.cluster.maxParallel, 5);
    assert.equal(persisted.cluster.subordinateMaxParallel, 5);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("saveEditableSettings migrates legacy kimi-coding base URLs to the anthropic route", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-kimi-coding-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(buildBaseConfig(), null, 2)}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "controller",
        maxParallel: 2,
        subordinateMaxParallel: 2,
        groupLeaderMaxDelegates: 3,
        delegateMaxDepth: 1
      },
      workspace: { dir: "./workspace" },
      bot: {},
      secrets: [],
      models: [
        {
          id: "controller",
          label: "Controller",
          provider: "openai-responses",
          model: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          apiKeyValue: "controller-key",
          authStyle: "bearer",
          specialties: ["controller"]
        },
        {
          id: "kimi_coding_worker",
          label: "Kimi Coding Worker",
          provider: "kimi-coding",
          model: "kimi-k2.5",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKeyEnv: "KIMI_CODING_KEY",
          apiKeyValue: "kimi-key",
          authStyle: "api-key",
          apiKeyHeader: "x-api-key",
          webSearch: true,
          specialties: ["implementation"]
        }
      ]
    });

    const editable = getEditableSettings(projectDir);
    const runtime = loadRuntimeConfig(projectDir);

    const editableKimi = editable.settings.models.find((model) => model.id === "kimi_coding_worker");
    assert.equal(editableKimi?.baseUrl, "https://api.moonshot.cn/anthropic");
    assert.equal(editableKimi?.webSearch, true);
    assert.equal(runtime.models.kimi_coding_worker.baseUrl, "https://api.moonshot.cn/anthropic");
    assert.equal(runtime.models.kimi_coding_worker.webSearch, true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("saveEditableSettings persists multi-agent framework settings", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-multi-agent-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(buildBaseConfig(), null, 2)}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "controller",
        maxParallel: 4,
        subordinateMaxParallel: 4,
        groupLeaderMaxDelegates: 3,
        delegateMaxDepth: 2
      },
      workspace: { dir: "./workspace" },
      bot: {},
      multiAgent: {
        enabled: true,
        mode: "workflow",
        speakerStrategy: "round_robin",
        maxRounds: 12,
        terminationKeyword: "DONE",
        messageWindow: 18,
        summarizeLongMessages: false,
        includeSystemMessages: false
      },
      secrets: [],
      models: buildModelsPayload()
    });

    const editable = getEditableSettings(projectDir);
    const runtime = loadRuntimeConfig(projectDir);

    assert.equal(editable.settings.multiAgent.enabled, true);
    assert.equal(editable.settings.multiAgent.mode, "workflow");
    assert.equal(editable.settings.multiAgent.speakerStrategy, "round_robin");
    assert.equal(editable.settings.multiAgent.maxRounds, 12);
    assert.equal(editable.settings.multiAgent.terminationKeyword, "DONE");
    assert.equal(editable.settings.multiAgent.messageWindow, 18);
    assert.equal(editable.settings.multiAgent.summarizeLongMessages, false);
    assert.equal(editable.settings.multiAgent.includeSystemMessages, false);

    assert.equal(runtime.multiAgent.enabled, true);
    assert.equal(runtime.multiAgent.mode, "workflow");
    assert.equal(runtime.multiAgent.speakerStrategy, "round_robin");
    assert.equal(runtime.multiAgent.maxRounds, 12);

    const persisted = JSON.parse(await readFile(join(projectDir, "runtime.settings.json"), "utf8"));
    assert.equal(persisted.multiAgent.enabled, true);
    assert.equal(persisted.multiAgent.mode, "workflow");
    assert.equal(persisted.multiAgent.messageWindow, 18);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

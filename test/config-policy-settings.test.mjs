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

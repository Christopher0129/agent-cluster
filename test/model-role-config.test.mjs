import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  getEditableSettings,
  loadRuntimeConfig,
  saveEditableSettings
} from "../src/config.mjs";

const BASE_CONFIG = {
  server: {
    port: 4040
  },
  cluster: {
    controller: "controller_template",
    maxParallel: 3,
    subordinateMaxParallel: 3,
    groupLeaderMaxDelegates: 10,
    delegateMaxDepth: 1
  },
  workspace: {
    dir: "./workspace"
  },
  models: {
    controller_template: {
      provider: "openai-responses",
      model: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "YOUR_CONTROLLER_API_KEY",
      role: "controller",
      label: "Controller Template",
      specialties: ["controller", "task planning", "delegation", "synthesis"]
    },
    worker_template: {
      provider: "openai-chat",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "YOUR_WORKER_API_KEY",
      role: "worker",
      label: "Worker Template",
      specialties: ["general"]
    }
  }
};

function buildPayload(models, controller = "controller_primary") {
  return {
    server: {
      port: 4040
    },
    cluster: {
      activeSchemeId: "explicit_roles",
      activeSchemeLabel: "Explicit Roles",
      controller,
      maxParallel: 3,
      subordinateMaxParallel: 3,
      groupLeaderMaxDelegates: 10,
      delegateMaxDepth: 1
    },
    workspace: {
      dir: "./workspace"
    },
    schemes: [
      {
        id: "explicit_roles",
        label: "Explicit Roles",
        controller,
        models
      }
    ],
    models
  };
}

test("config save and load preserve explicit controller-only and worker-only roles", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-model-role-config-"));

  try {
    const models = [
      {
        id: "controller_primary",
        label: "Primary Controller",
        provider: "openai-responses",
        model: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "PRIMARY_KEY",
        apiKeyValue: "primary-secret",
        authStyle: "bearer",
        role: "controller",
        specialties: ["research", "handoff"]
      },
      {
        id: "controller_backup",
        label: "Backup Controller",
        provider: "openai-chat",
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "BACKUP_KEY",
        apiKeyValue: "backup-secret",
        authStyle: "bearer",
        role: "controller",
        specialties: ["validation"]
      },
      {
        id: "worker_impl",
        label: "Implementation Worker",
        provider: "openai-chat",
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "WORKER_KEY",
        apiKeyValue: "worker-secret",
        authStyle: "bearer",
        role: "worker",
        specialties: ["implementation"]
      }
    ];

    await saveEditableSettings(projectDir, buildPayload(models), {
      baseConfig: BASE_CONFIG
    });

    const editable = getEditableSettings(projectDir, { baseConfig: BASE_CONFIG });
    assert.equal(
      editable.settings.schemes[0].models.find((model) => model.id === "controller_backup")?.role,
      "controller"
    );
    assert.equal(
      editable.settings.schemes[0].models.find((model) => model.id === "worker_impl")?.role,
      "worker"
    );

    const runtime = loadRuntimeConfig(projectDir, { baseConfig: BASE_CONFIG });
    assert.equal(runtime.cluster.controller, "controller_primary");
    assert.equal(runtime.models.controller_primary.role, "controller");
    assert.equal(runtime.models.controller_backup.role, "controller");
    assert.equal(runtime.models.worker_impl.role, "worker");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("config save rejects selecting a worker-only model as the scheme controller", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-model-role-invalid-controller-"));

  try {
    const models = [
      {
        id: "controller_primary",
        label: "Primary Controller",
        provider: "openai-responses",
        model: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "PRIMARY_KEY",
        apiKeyValue: "primary-secret",
        authStyle: "bearer",
        role: "worker",
        specialties: ["research"]
      },
      {
        id: "worker_impl",
        label: "Implementation Worker",
        provider: "openai-chat",
        model: "gpt-4.1-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "WORKER_KEY",
        apiKeyValue: "worker-secret",
        authStyle: "bearer",
        role: "worker",
        specialties: ["implementation"]
      }
    ];

    await assert.rejects(
      () =>
        saveEditableSettings(projectDir, buildPayload(models, "controller_primary"), {
          baseConfig: BASE_CONFIG
        }),
      /not allowed to act as a controller/
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

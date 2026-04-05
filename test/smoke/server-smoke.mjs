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

async function runWorkspaceServerRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-workspace-server-"));
  const workspaceDir = join(projectDir, "route-workspace");
  await writeFile(
    join(projectDir, "cluster.config.json"),
    `${JSON.stringify(
      {
        server: { port: 4040 },
        cluster: { controller: "controller", maxParallel: 1 },
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
            apiKeyEnv: "OPENAI_API_KEY",
            label: "Worker"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const server = createAppServer({
    projectDir,
    staticAssetLoader: async (assetPath) => {
      if (assetPath === "index.html") {
        return "<!doctype html><html><body>ok</body></html>";
      }
      return "";
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    let response = await fetch(
      `http://127.0.0.1:${port}/api/workspace?workspaceDir=${encodeURIComponent(workspaceDir)}`
    );
    let payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.workspace.resolvedDir, workspaceDir);

    response = await fetch(`http://127.0.0.1:${port}/api/workspace/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceDir,
        files: [
          {
            path: "docs/note.txt",
            contentBase64: Buffer.from("hello workspace", "utf8").toString("base64")
          }
        ]
      })
    });
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.written.length, 1);
    assert.equal(payload.written[0].path, "docs/note.txt");

    response = await fetch(
      `http://127.0.0.1:${port}/api/workspace/file?workspaceDir=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("docs/note.txt")}`
    );
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.file.path, "docs/note.txt");
    assert.equal(payload.file.content, "hello workspace");

    response = await fetch(`http://127.0.0.1:${port}/api/bot/presets`);
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(Array.isArray(payload.presets), true);
    assert.equal(payload.presets.some((preset) => preset.id === "feishu"), true);
    assert.equal(
      payload.presets.some(
        (preset) =>
          preset.id === "feishu" &&
          Array.isArray(preset.fields) &&
          preset.fields.some((field) => field.envName === "FEISHU_APP_SECRET" && field.type === "password")
      ),
      true
    );

    response = await fetch(`http://127.0.0.1:${port}/api/bot/runtime`);
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.runtime.installDir, "string");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runStaticAssetRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-static-assets-"));
  const requestedAssets = [];

  try {
    const server = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) => {
        requestedAssets.push(assetPath);
        return `asset:${assetPath}`;
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      let response = await fetch(`http://127.0.0.1:${port}/assets/agent-graph-layout.js`);
      let body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body, "asset:agent-graph-layout.js");

      response = await fetch(`http://127.0.0.1:${port}/assets/nested/panel.js`);
      body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body, "asset:nested/panel.js");

      response = await fetch(`http://127.0.0.1:${port}/assets/%2e%2e/package.json`);
      const payload = await response.json();
      assert.equal(response.status, 404);
      assert.equal(payload.ok, false);

      assert.deepEqual(requestedAssets, ["agent-graph-layout.js", "nested/panel.js"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runClusterCancelRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-cluster-cancel-"));
  const modelServer = createServer(async (request, response) => {
    await waitForDelay(1000);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          objective: "Delayed plan",
          strategy: "This should be cancelled first.",
          tasks: []
        })
      })
    );
  });

  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = modelServer.address().port;

  try {
    process.env.TEST_CANCEL_KEY = "cancel-key";
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 1 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_CANCEL_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-responses",
              model: "gpt-5.4-mini",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_CANCEL_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const appServer = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) =>
        assetPath === "index.html" ? "<!doctype html><html><body>ok</body></html>" : ""
    });
    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    const appPort = appServer.address().port;

    try {
      const operationId = "cluster_cancel_route_test";
      const runPromise = fetch(`http://127.0.0.1:${appPort}/api/cluster/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task: "Cancel this run before planning finishes.",
          operationId
        })
      }).then((response) => response.json());

      await waitForDelay(80);

      const cancelResponse = await fetch(
        `http://127.0.0.1:${appPort}/api/operations/${operationId}/cancel`,
        {
          method: "POST"
        }
      );
      const cancelPayload = await cancelResponse.json();
      const runPayload = await runPromise;

      assert.equal(cancelPayload.ok, true);
      assert.equal(cancelPayload.cancellationRequested, true);
      assert.equal(runPayload.ok, false);
      assert.equal(runPayload.cancelled, true);
    } finally {
      await new Promise((resolve) => appServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runClusterRouteLogPersistenceTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-cluster-log-route-"));
  const workspaceDir = join(projectDir, "workspace");
  let requestCount = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (requestCount === 1) {
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            objective: "Create a note",
            strategy: "Use one worker to write the note, then synthesize the result.",
            tasks: [
              {
                id: "task_1",
                phase: "implementation",
                title: "Write note",
                assignedWorker: "worker",
                instructions: "Create notes/hello.txt in the workspace.",
                expectedOutput: "A concrete notes/hello.txt artifact.",
                dependsOn: []
              }
            ]
          })
        })
      );
      return;
    }

    if (requestCount === 2) {
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            action: "write_files",
            reason: "Create the requested note.",
            files: [
              {
                path: "notes/hello.txt",
                content: "hello from route log test\n"
              }
            ]
          })
        })
      );
      return;
    }

    if (requestCount === 3) {
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            action: "final",
            summary: "The note was written.",
            keyFindings: ["notes/hello.txt now exists in the workspace."],
            risks: [],
            deliverables: ["notes/hello.txt"],
            generatedFiles: ["notes/hello.txt"],
            confidence: "high",
            followUps: [],
            verificationStatus: "passed"
          })
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          finalAnswer: "Route log persistence completed.",
          executiveSummary: ["The run finished and its log was persisted automatically."],
          consensus: ["Automatic task logging works for cluster runs."],
          disagreements: [],
          nextActions: []
        })
      })
    );
  });

  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = modelServer.address().port;

  try {
    process.env.TEST_ROUTE_LOG_KEY = "route-log-key";
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 1 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_ROUTE_LOG_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-responses",
              model: "gpt-5.4-mini",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_ROUTE_LOG_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const appServer = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) =>
        assetPath === "index.html" ? "<!doctype html><html><body>ok</body></html>" : ""
    });
    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    const appPort = appServer.address().port;

    try {
      const operationId = "cluster_route_log_test";
      const response = await fetch(`http://127.0.0.1:${appPort}/api/cluster/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task: "Create a note and persist the run log.",
          operationId
        })
      });
      const payload = await response.json();
      const logJsonPath = join(projectDir, "task-logs", `${operationId}.json`);
      const logTextPath = join(projectDir, "task-logs", `${operationId}.log`);
      const logJson = JSON.parse(await readFile(logJsonPath, "utf8"));
      const logText = await readFile(logTextPath, "utf8");
      const noteText = await readFile(join(workspaceDir, "notes", "hello.txt"), "utf8");

      assert.equal(payload.ok, true);
      assert.equal(payload.log.textPath, `task-logs/${operationId}.log`);
      assert.equal(logJson.status, "completed");
      assert.equal(logJson.operationId, operationId);
      assert.match(logText, /Agent Cluster Task Log/);
      assert.match(logText, /cluster_done/);
      assert.match(logText, /Create a note and persist the run log/);
      assert.equal(noteText, "hello from route log test\n");
    } finally {
      await new Promise((resolve) => appServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runSystemExitRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-system-exit-"));
  let exitCode = null;

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 1 },
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
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const appServer = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) =>
        assetPath === "index.html" ? "<!doctype html><html><body>ok</body></html>" : "",
      exitProcess(code) {
        exitCode = code;
      }
    });

    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    const appPort = appServer.address().port;

    const response = await fetch(`http://127.0.0.1:${appPort}/api/system/exit`, {
      method: "POST"
    });
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.shuttingDown, true);

    await waitForDelay(250);
    assert.equal(exitCode, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

export async function runServerSmokeTests() {
  await runWorkspaceServerRouteTests();
  await runStaticAssetRouteTests();
  await runClusterRouteLogPersistenceTests();
  await runClusterCancelRouteTests();
  await runSystemExitRouteTests();
}

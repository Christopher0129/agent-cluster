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
import { OpenAIChatProvider } from "../../src/providers/openai-chat.mjs";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.mjs";
import {
  getProviderDefinition,
  providerSupportsCapability
} from "../../src/static/provider-catalog.js";
import {
  buildAgentLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "../../src/static/agent-graph-layout.js";
import { runWorkspaceToolLoop } from "../../src/workspace/agent-loop.mjs";
import { DelayedJsonProvider, FakeProvider, waitForDelay } from "../helpers/providers.mjs";

async function runResearchConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };

  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 6
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_a: {
        id: "research_a",
        label: "Research A",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research"]
      },
      research_b: {
        id: "research_b",
        label: "Research B",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research"]
      },
      research_c: {
        id: "research_c",
        label: "Research C",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect verified cases",
          strategy: "Run three research batches, then synthesize.",
          tasks: [
            {
              id: "research_a_batch",
              phase: "research",
              title: "Research batch A",
              assignedWorker: "research_a",
              instructions: "Collect a small verified case batch.",
              dependsOn: []
            },
            {
              id: "research_b_batch",
              phase: "research",
              title: "Research batch B",
              assignedWorker: "research_b",
              instructions: "Collect a small verified case batch.",
              dependsOn: []
            },
            {
              id: "research_c_batch",
              phase: "research",
              title: "Research batch C",
              assignedWorker: "research_c",
              instructions: "Collect a small verified case batch.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Research completed.",
          executiveSummary: ["All research batches completed."],
          consensus: ["Gateway throttling was respected."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_a",
      new DelayedJsonProvider(
        {
          summary: "Batch A done.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "research_b",
      new DelayedJsonProvider(
        {
          summary: "Batch B done.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "research_c",
      new DelayedJsonProvider(
        {
          summary: "Batch C done.",
          keyFindings: ["C"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect verified public cases.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 3);
  assert.equal(concurrency.max, 3);
}

async function runCustomPhaseConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };

  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4,
      phaseParallel: {
        implementation: 1
      }
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      coder_a: {
        id: "coder_a",
        label: "Coder A",
        model: "implementation-worker-a",
        provider: "mock",
        specialties: ["coding"]
      },
      coder_b: {
        id: "coder_b",
        label: "Coder B",
        model: "implementation-worker-b",
        provider: "mock",
        specialties: ["coding"]
      },
      coder_c: {
        id: "coder_c",
        label: "Coder C",
        model: "implementation-worker-c",
        provider: "mock",
        specialties: ["coding"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Implement three changes",
          strategy: "Run implementation tasks.",
          tasks: [
            {
              id: "impl_a",
              phase: "implementation",
              title: "Implement A",
              assignedWorker: "coder_a",
              instructions: "Implement item A.",
              dependsOn: []
            },
            {
              id: "impl_b",
              phase: "implementation",
              title: "Implement B",
              assignedWorker: "coder_b",
              instructions: "Implement item B.",
              dependsOn: []
            },
            {
              id: "impl_c",
              phase: "implementation",
              title: "Implement C",
              assignedWorker: "coder_c",
              instructions: "Implement item C.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Implementation completed.",
          executiveSummary: ["All implementation tasks completed."],
          consensus: ["Custom phase concurrency was enforced."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "coder_a",
      new DelayedJsonProvider(
        {
          summary: "A done.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "coder_b",
      new DelayedJsonProvider(
        {
          summary: "B done.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "coder_c",
      new DelayedJsonProvider(
        {
          summary: "C done.",
          keyFindings: ["C"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Implement three independent changes.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 3);
  assert.equal(concurrency.max, 1);
}

async function runHttpRetryTests() {
  let attempts = 0;
  const retryEvents = [];
  const server = createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>aixj.vip | 502: Bad gateway</title></head><body>bad gateway</body></html>");
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, attempts }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    const result = await postJson(
      `http://127.0.0.1:${port}/responses`,
      { hello: "world" },
      {
        id: "retry_model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_API_KEY",
        authStyle: "bearer",
        retryAttempts: 2,
        retryBaseMs: 10,
        retryMaxMs: 20
      },
      {
        onRetry(event) {
          retryEvents.push(event);
        }
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].maxRetries, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpHtmlGatewaySummaryTests() {
  const server = createServer((request, response) => {
    response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>aixj.vip | 502: Bad gateway</title></head><body>bad gateway</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "html_gateway_model",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /upstream gateway returned 502/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpHtmlNonApiSummaryTests() {
  const server = createServer((request, response) => {
    response.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Just a moment...</title></head><body>challenge</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "html_non_api_model",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /returned an HTML page instead of API JSON/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpHtml200SummaryTests() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Gateway Home</title></head><body>home</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "html_200_model",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /returned an HTML page instead of API JSON/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runMoonshotResponsesHintTests() {
  const server = createServer((request, response) => {
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ message: "没找到对象" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "moonshot_responses_model",
            baseUrl: "https://api.moonshot.cn/v1",
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /provider 改成 "openai-chat"/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpNetworkRetryTests() {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, attempts }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    const result = await postJson(
      `http://127.0.0.1:${port}/responses`,
      { hello: "world" },
      {
        id: "network_retry_model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_API_KEY",
        authStyle: "bearer",
        retryAttempts: 1,
        retryBaseMs: 10,
        retryMaxMs: 20
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpAbortTests() {
  const server = createServer(async (request, response) => {
    await waitForDelay(1000);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    const controller = new AbortController();
    const promise = postJson(
      `http://127.0.0.1:${port}/responses`,
      { hello: "world" },
      {
        id: "abort_model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_API_KEY",
        authStyle: "bearer",
        retryAttempts: 2,
        retryBaseMs: 10,
        retryMaxMs: 20
      },
      {
        signal: controller.signal
      }
    );

    setTimeout(() => controller.abort(new Error("Cancelled in test.")), 30);

    await assert.rejects(promise, /Cancelled in test/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityTestTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(raw);
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                attempt === 1
                  ? `OK:${parsed.model}`
                  : JSON.stringify({
                      status: "ok",
                      usedWebSearch: false,
                      checks: [`structured:${parsed.model}`],
                      note: "workflow probe ok"
                    })
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "worker_test",
        label: "Worker Test",
        provider: "openai-chat",
        model: "kimi-test",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.model.id, "worker_test");
    assert.equal(result.reply.startsWith("OK:kimi-test"), true);
    assert.equal(result.summary.includes("workflow probe passed"), true);
    assert.deepEqual(result.diagnostics.workflowProbe.checks, ["structured:kimi-test"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runAnthropicConnectivityWebSearchTests() {
  const capturedBodies = [];
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          id: "msg_test_1",
          type: "message",
          role: "assistant",
          content: []
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        id: "msg_test_2",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              usedWebSearch: true,
              checks: ["anthropic-structured:kimi-k2.5", "web-search:kimi-k2.5"],
              note: "workflow probe ok"
            })
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "KIMI_CODING_KEY", value: "kimi-coding-secret" }],
      model: {
        id: "kimi_coding_test",
        label: "Kimi Coding Test",
        provider: "kimi-coding",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "KIMI_CODING_KEY",
        authStyle: "api-key",
        apiKeyHeader: "x-api-key",
        webSearch: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.reply.startsWith("[empty text response;"), true);
    assert.equal(result.degraded, false);
    assert.equal(result.diagnostics.workflowProbe.usedWebSearch, true);
    assert.equal(result.diagnostics.webSearch.verified, true);
    assert.deepEqual(result.diagnostics.workflowProbe.checks, [
      "anthropic-structured:kimi-k2.5",
      "web-search:kimi-k2.5"
    ]);
    assert.deepEqual(capturedBodies[0].tools, [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3
      }
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityThinkingTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `OK:${raw.model}`
              }
            }
          ]
        })
      );
      return;
    }

    if (attempt === 2) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "ok",
                  usedWebSearch: false,
                  checks: [`structured:${raw.model}`],
                  note: "workflow probe ok"
                })
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "THINKING_OK",
              reasoning_content: "Verified with an internal reasoning trace."
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "kimi_thinking_test",
        label: "Kimi Thinking Test",
        provider: "kimi-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer",
        thinkingEnabled: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, false);
    assert.equal(result.diagnostics.thinking.enabled, true);
    assert.equal(result.diagnostics.thinking.verified, true);
    assert.match(result.summary, /thinking mode/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityWebSearchProbeDegradedTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `OK:${raw.model}`
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "ok",
                usedWebSearch: false,
                checks: [`structured:${raw.model}`],
                note: "workflow probe could not confirm search"
              })
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "kimi_chat_search_probe_test",
        label: "Kimi Chat Search Probe Test",
        provider: "kimi-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer",
        webSearch: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(result.diagnostics.webSearch.enabled, true);
    assert.equal(result.diagnostics.webSearch.used, false);
    assert.match(result.summary, /did not confirm that web search executed successfully/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityWorkflowDegradedTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `OK:${raw.model}`
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: []
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "kimi_like_chat_test",
        label: "Kimi-like Chat Test",
        provider: "openai-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(result.reply.startsWith("OK:kimi-k2.5"), true);
    assert.equal(result.summary.includes("downgraded"), true);
    assert.equal(result.diagnostics.workflowProbe.mode, "degraded");
    assert.deepEqual(result.diagnostics.workflowProbe.checks, ["basic:kimi-k2.5"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runResponsesProviderCompatibilityTests() {
  let capturedBody = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        output_text: "OK"
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_RESPONSES_KEY = "responses-key";
    const provider = new OpenAIResponsesProvider({
      id: "responses_worker",
      provider: "openai-responses",
      model: "gpt-5.3-codex",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_RESPONSES_KEY",
      authStyle: "bearer",
      thinkingEnabled: true,
      reasoning: { effort: "high" },
      webSearch: true,
      maxOutputTokens: 32,
      retryAttempts: 0
    });

    const result = await provider.invoke({
      instructions: "Reply with exactly OK.",
      input: "Connectivity test.",
      purpose: "compatibility_test"
    });

    assert.equal(result.text, "OK");
    assert.deepEqual(capturedBody.input, [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "Reply with exactly OK."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Connectivity test."
          }
        ]
      }
    ]);
    assert.deepEqual(capturedBody.tools, [{ type: "web_search" }]);
    assert.deepEqual(capturedBody.reasoning, { effort: "high" });
    assert.equal("metadata" in capturedBody, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runOpenAIChatWebSearchProviderCompatibilityTests() {
  const capturedBodies = [];
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    capturedBodies.push(parsed);
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_web_1",
                    type: "function",
                    function: {
                      name: "$web_search",
                      arguments: '{"query":"Moonshot Kimi web search compatibility"}'
                    }
                  }
                ]
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                status: "ok",
                usedWebSearch: true,
                checks: ["structured:kimi-k2.5", "web-search:kimi-k2.5"],
                note: "workflow probe ok"
              })
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_KIMI_CHAT_KEY = "kimi-chat-key";
    const provider = new OpenAIChatProvider({
      id: "kimi_chat_worker",
      provider: "kimi-chat",
      model: "kimi-k2.5",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_KIMI_CHAT_KEY",
      authStyle: "bearer",
      thinkingEnabled: true,
      webSearch: true,
      maxOutputTokens: 96,
      retryAttempts: 0
    });

    const result = await provider.invoke({
      instructions: "Use web search once, then return JSON only.",
      input: "Verify Kimi web search wiring.",
      purpose: "compatibility_test"
    });

    assert.equal(result.text.includes('"usedWebSearch":true'), true);
    assert.deepEqual(capturedBodies[0].tools, [
      {
        type: "builtin_function",
        function: {
          name: "$web_search"
        }
      }
    ]);
    assert.deepEqual(capturedBodies[0].thinking, { type: "disabled" });
    assert.equal(
      capturedBodies[1].messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "call_web_1" &&
          message.name === "$web_search"
      ),
      true
    );
  } finally {
    delete process.env.TEST_KIMI_CHAT_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runAnthropicThinkingProviderCompatibilityTests() {
  let capturedBody = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        id: "msg_thinking_test",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Short internal reasoning summary."
          },
          {
            type: "text",
            text: "THINKING_OK"
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_ANTHROPIC_THINKING_KEY = "anthropic-thinking-key";
    const provider = new AnthropicMessagesProvider({
      id: "claude_thinking_worker",
      provider: "claude-chat",
      model: "claude-sonnet-4-5",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_ANTHROPIC_THINKING_KEY",
      authStyle: "api-key",
      apiKeyHeader: "x-api-key",
      thinkingEnabled: true,
      reasoning: { effort: "high" },
      retryAttempts: 0
    });

    const result = await provider.invoke({
      instructions: "Think first, then reply with THINKING_OK.",
      input: "Compatibility probe.",
      purpose: "compatibility_test"
    });

    assert.equal(result.text, "THINKING_OK");
    assert.deepEqual(capturedBody.thinking, {
      type: "enabled",
      budget_tokens: 3072
    });
    assert.equal(capturedBody.max_tokens >= 3584, true);
  } finally {
    delete process.env.TEST_ANTHROPIC_THINKING_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function runNetworkSmokeTests() {
  await runResearchConcurrencyTests();
  await runCustomPhaseConcurrencyTests();
  await runHttpRetryTests();
  await runHttpHtmlGatewaySummaryTests();
  await runHttpHtmlNonApiSummaryTests();
  await runHttpHtml200SummaryTests();
  await runMoonshotResponsesHintTests();
  await runHttpNetworkRetryTests();
  await runHttpAbortTests();
  await runConnectivityTestTests();
  await runConnectivityThinkingTests();
  await runAnthropicConnectivityWebSearchTests();
  await runConnectivityWebSearchProbeDegradedTests();
  await runConnectivityWorkflowDegradedTests();
  await runResponsesProviderCompatibilityTests();
  await runOpenAIChatWebSearchProviderCompatibilityTests();
  await runAnthropicThinkingProviderCompatibilityTests();
}

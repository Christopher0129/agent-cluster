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

function runJsonTests() {
  const parsed = parseJsonFromText('{"hello":"world","items":[1,2]}');
  assert.equal(parsed.hello, "world");
  assert.deepEqual(parsed.items, [1, 2]);

  const fenced = extractJsonCandidate("```json\n{\"a\":1,\"b\":2}\n```");
  assert.equal(fenced, '{"a":1,"b":2}');

  const embedded = parseJsonFromText('Result:\n{"summary":"ok","items":["a"]}\nDone.');
  assert.equal(embedded.summary, "ok");
  assert.deepEqual(embedded.items, ["a"]);

  const trailing = parseJsonFromText('{"summary":"ok"}\nExplanation: verified with sources.');
  assert.equal(trailing.summary, "ok");
}

function runAccessPolicyTests() {
  assert.doesNotThrow(() =>
    createProviderForModel({
      id: "kimi_code_allowed",
      provider: "openai-chat",
      model: "kimi-for-coding",
      baseUrl: "https://api.kimi.com/coding/v1"
    })
  );
}

function runProviderCatalogSupportTests() {
  const claudeProvider = createProviderForModel({
    id: "claude_worker",
    provider: "claude-chat",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com/v1"
  });
  const kimiCodingProvider = createProviderForModel({
    id: "kimi_coding_worker",
    provider: "kimi-coding",
    model: "k2p5",
    baseUrl: "https://api.moonshot.cn/anthropic"
  });

  assert.equal(claudeProvider instanceof AnthropicMessagesProvider, true);
  assert.equal(kimiCodingProvider instanceof AnthropicMessagesProvider, true);
  assert.equal(providerSupportsCapability("openai-responses", "thinking"), true);
  assert.equal(providerSupportsCapability("claude-chat", "thinking"), true);
  assert.equal(providerSupportsCapability("kimi-chat", "thinking"), true);
  assert.equal(providerSupportsCapability("kimi-coding", "thinking"), true);
  assert.equal(providerSupportsCapability("kimi-chat", "webSearch"), true);
  assert.equal(providerSupportsCapability("kimi-coding", "webSearch"), true);
  assert.equal(
    getProviderDefinition("kimi-coding")?.defaultBaseUrl,
    "https://api.moonshot.cn/anthropic"
  );
}

function runAgentGraphLayoutTests() {
  const controller = {
    id: "controller",
    kind: "controller",
    label: "Controller",
    status: "delegating"
  };
  const leader = {
    id: "leader:research_leader",
    kind: "leader",
    label: "Research Leader",
    phase: "research",
    status: "running"
  };
  const subordinate = {
    id: "leader:research_leader::batch_a:01",
    kind: "subordinate",
    label: "Research Subordinate 01",
    parentId: leader.id,
    phase: "research",
    status: "running"
  };
  const nestedSubordinate = {
    id: "leader:research_leader::batch_a:01::fact_check:01",
    kind: "subordinate",
    label: "Research Subordinate 02",
    parentId: subordinate.id,
    phase: "research",
    status: "spawning"
  };

  const layout = buildAgentLayout([controller, leader, subordinate, nestedSubordinate], {
    controllerId: controller.id
  });
  const nodeIds = new Set(layout.nodes.map((node) => node.agent.id));
  const edgeIds = new Set(layout.edges.map((edge) => `${edge.from}->${edge.to}`));
  const group = layout.groups.find((entry) => entry.leader.id === leader.id);

  assert.equal(nodeIds.has(subordinate.id), true);
  assert.equal(nodeIds.has(nestedSubordinate.id), true);
  assert.equal(edgeIds.has(`${leader.id}->${subordinate.id}`), true);
  assert.equal(edgeIds.has(`${subordinate.id}->${nestedSubordinate.id}`), true);
  assert.equal(Boolean(group), true);
  assert.equal(group.subordinates.some((agent) => agent.id === nestedSubordinate.id), true);

  const inferredParentId = resolveAgentGraphParentId(
    {
      agentId: nestedSubordinate.id,
      modelId: "research_leader"
    },
    "subordinate"
  );
  assert.equal(inferredParentId, subordinate.id);

  const retainedParentId = resolveAgentGraphParentId(
    {
      modelId: "research_leader"
    },
    "subordinate",
    { parentId: subordinate.id }
  );
  assert.equal(retainedParentId, subordinate.id);

  const activity = summarizeAgentActivity([controller, leader, subordinate, nestedSubordinate]);
  assert.deepEqual(activity, {
    totalCount: 4,
    activeCount: 4
  });

  const settledActivity = summarizeAgentActivity([
    controller,
    { ...leader, status: "done" },
    { ...subordinate, status: "done" },
    { ...nestedSubordinate, status: "failed" }
  ]);
  assert.deepEqual(settledActivity, {
    totalCount: 4,
    activeCount: 1
  });
}

function runSessionRuntimeTests() {
  const events = [];
  const session = createSessionRuntime({
    emitEvent(event) {
      events.push(event);
    }
  });
  const model = {
    id: "session_worker",
    label: "Session Worker",
    provider: "openai-responses",
    model: "gpt-5.4-mini",
    pricing: {
      inputPer1kUsd: 0.01,
      outputPer1kUsd: 0.02
    }
  };

  const call = session.beginProviderCall(model, {
    agentId: "leader:session_worker",
    agentLabel: "Session Worker",
    agentKind: "leader",
    taskId: "task_session",
    taskTitle: "Session Test",
    purpose: "worker_execution"
  });
  session.recordRetry(
    model,
    {
      attempt: 1,
      maxRetries: 3,
      nextDelayMs: 500,
      status: 502,
      message: "temporary upstream failure"
    },
    {
      agentId: "leader:session_worker",
      agentLabel: "Session Worker",
      taskId: "task_session",
      taskTitle: "Session Test",
      parentSpanId: call.spanId
    }
  );
  session.completeProviderCall(
    model,
    call.spanId,
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140
      }
    },
    {
      detail: "Session provider call completed."
    }
  );

  session.remember(
    {
      title: "Important note",
      content: "Remember the counterexample in the second dependency output.",
      tags: ["research", "counterexample"]
    },
    {
      agentId: "leader:session_worker",
      agentLabel: "Session Worker",
      taskId: "task_session",
      taskTitle: "Session Test"
    }
  );
  const recalled = session.recall(
    {
      query: "counterexample",
      limit: 2
    },
    {
      agentId: "leader:session_worker",
      agentLabel: "Session Worker",
      taskId: "task_session",
      taskTitle: "Session Test"
    }
  );
  const snapshot = session.buildSnapshot();

  assert.equal(snapshot.totals.providerCalls, 1);
  assert.equal(snapshot.totals.retries, 1);
  assert.equal(snapshot.totals.inputTokens, 100);
  assert.equal(snapshot.totals.outputTokens, 40);
  assert.equal(snapshot.totals.totalTokens, 140);
  assert.equal(snapshot.totals.estimatedCostUsd, 0.0018);
  assert.equal(snapshot.totals.memoryWrites, 1);
  assert.equal(snapshot.totals.memoryReads, 1);
  assert.equal(snapshot.memory.count, 1);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].title, "Important note");
  assert.equal(events.some((event) => event.stage === "trace_span_start"), true);
  assert.equal(events.some((event) => event.stage === "memory_write"), true);
}

function runSessionCircuitBreakerTests() {
  const session = createSessionRuntime();
  const model = {
    id: "flaky_worker",
    label: "Flaky Worker",
    provider: "openai-chat",
    model: "kimi-test",
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownMs: 50
  };

  const firstCall = session.beginProviderCall(model, {
    purpose: "worker_execution"
  });
  session.failProviderCall(model, firstCall.spanId, new Error("first failure"));

  const secondCall = session.beginProviderCall(model, {
    purpose: "worker_execution"
  });
  session.failProviderCall(model, secondCall.spanId, new Error("second failure"));

  assert.equal(session.getCircuitState(model.id).state, "open");
  assert.throws(
    () =>
      session.beginProviderCall(model, {
        purpose: "worker_execution"
      }),
    /circuit breaker/
  );
}

export async function runBasicSmokeTests() {
  runJsonTests();
  runAccessPolicyTests();
  runProviderCatalogSupportTests();
  runAgentGraphLayoutTests();
  runSessionRuntimeTests();
  runSessionCircuitBreakerTests();
}

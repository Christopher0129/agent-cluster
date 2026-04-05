import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { postJson, resolveRequestPolicy } from "../src/providers/http-client.mjs";

test("resolveRequestPolicy keeps explicit timeout and retry settings", () => {
  const policy = resolveRequestPolicy(
    {
      id: "kimi_explicit",
      provider: "kimi-chat",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.5",
      timeoutMs: 12345,
      retryAttempts: 7,
      retryBaseMs: 222,
      retryMaxMs: 999
    },
    {
      purpose: "leader_delegation"
    }
  );

  assert.equal(policy.timeoutMs, 12345);
  assert.equal(policy.retryAttempts, 7);
  assert.equal(policy.retryBaseMs, 222);
  assert.equal(policy.retryMaxMs, 999);
});

test("resolveRequestPolicy lowers Moonshot orchestration budgets by purpose", () => {
  const shortPolicy = resolveRequestPolicy(
    {
      id: "kimi_short",
      provider: "kimi-chat",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.5"
    },
    {
      purpose: "leader_delegation"
    }
  );
  const planningPolicy = resolveRequestPolicy(
    {
      id: "kimi_planning",
      provider: "kimi-coding",
      baseUrl: "https://api.moonshot.cn/anthropic",
      model: "kimi-k2.5"
    },
    {
      purpose: "planning"
    }
  );
  const genericPolicy = resolveRequestPolicy(
    {
      id: "generic_model",
      provider: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4"
    },
    {
      purpose: "leader_delegation"
    }
  );

  assert.equal(shortPolicy.timeoutMs, 75000);
  assert.equal(shortPolicy.retryAttempts, 1);
  assert.equal(shortPolicy.retryBaseMs, 600);
  assert.equal(shortPolicy.retryMaxMs, 2500);

  assert.equal(planningPolicy.timeoutMs, 90000);
  assert.equal(planningPolicy.retryAttempts, 2);
  assert.equal(planningPolicy.retryBaseMs, 900);
  assert.equal(planningPolicy.retryMaxMs, 4000);

  assert.equal(genericPolicy.timeoutMs, 210000);
  assert.equal(genericPolicy.retryAttempts, 10);
});

test("postJson applies the reduced Moonshot delegation retry budget", async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    response.writeHead(524, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ message: "upstream timeout" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "moonshot-test";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/chat/completions`,
          { hello: "world" },
          {
            id: "kimi_delegate_default",
            provider: "kimi-chat",
            baseUrl: "https://api.moonshot.cn/v1",
            model: "kimi-k2.5",
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer"
          },
          {
            purpose: "leader_delegation"
          }
        ),
      /Retried 1 time/
    );

    assert.equal(attempts, 2);
  } finally {
    delete process.env.TEST_API_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});

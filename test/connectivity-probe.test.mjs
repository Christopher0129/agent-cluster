import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { testModelConnectivity } from "../src/providers/connectivity-test.mjs";

test("testModelConnectivity confirms web search from chat tool traces with a compact probe", async () => {
  const capturedBodies = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    capturedBodies.push(body);
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (requestCount === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "OK"
              }
            }
          ]
        })
      );
      return;
    }

    if (requestCount === 2) {
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
                      arguments: '{"query":"OpenAI API"}'
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
            message: {
              content: JSON.stringify({
                status: "ok",
                usedWebSearch: false,
                checks: ["structured:kimi-k2.5", "web-search"],
                query: "OpenAI API",
                marker: "openai.com",
                note: "ok"
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
      secrets: [{ name: "TEST_KIMI_CHAT_KEY", value: "secret-value" }],
      model: {
        id: "kimi_chat_probe_test",
        label: "Kimi Chat Probe Test",
        provider: "kimi-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_KIMI_CHAT_KEY",
        authStyle: "bearer",
        webSearch: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, false);
    assert.equal(result.diagnostics.webSearch.verified, true);
    assert.equal(result.diagnostics.webSearch.confirmationMethod, "tool_trace");
    assert.equal(result.diagnostics.workflowProbe.usedWebSearch, true);
    assert.equal(result.diagnostics.workflowProbe.reportedWebSearch, false);
    assert.equal(result.diagnostics.webSearch.query, "OpenAI API");
    assert.equal(result.diagnostics.webSearch.marker, "openai.com");
    assert.match(capturedBodies[1].messages[0].content, /compact workflow connectivity probe/i);
    assert.match(capturedBodies[1].messages[1].content, /OpenAI API/);
    assert.match(capturedBodies[1].messages[1].content, /exactly once/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("testModelConnectivity confirms web search from anthropic server-tool traces", async () => {
  const capturedBodies = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    capturedBodies.push(body);
    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (requestCount === 1) {
      response.end(
        JSON.stringify({
          id: "msg_basic",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "OK"
            }
          ]
        })
      );
      return;
    }

    if (requestCount === 2) {
      response.end(
        JSON.stringify({
          id: "msg_pause",
          type: "message",
          role: "assistant",
          stop_reason: "pause_turn",
          content: [
            {
              type: "server_tool_use",
              id: "toolu_web_1",
              name: "web_search"
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        id: "msg_done",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              usedWebSearch: false,
              checks: ["structured:kimi-k2.5", "web-search"],
              query: "OpenAI API",
              marker: "openai.com",
              note: "ok"
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
        id: "kimi_coding_probe_test",
        label: "Kimi Coding Probe Test",
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
    assert.equal(result.degraded, false);
    assert.equal(result.diagnostics.webSearch.verified, true);
    assert.equal(result.diagnostics.webSearch.confirmationMethod, "tool_trace");
    assert.equal(result.diagnostics.workflowProbe.usedWebSearch, true);
    assert.equal(result.diagnostics.workflowProbe.reportedWebSearch, false);
    assert.match(capturedBodies[1].system, /compact workflow connectivity probe/i);
    assert.deepEqual(capturedBodies[1].tools, [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3
      }
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

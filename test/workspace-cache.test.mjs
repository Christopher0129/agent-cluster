import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearClusterRunCache, writeClusterRunCache } from "../src/workspace/cache.mjs";
import { writeClusterRunLog } from "../src/run-log-store.mjs";

test("workspace cluster cache can be written and cleared", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-cluster-cache-"));

  try {
    const written = await writeClusterRunCache(workspaceRoot, "operation_123", {
      operationId: "operation_123",
      task: "demo"
    });
    const writtenPath = join(workspaceRoot, ...written.path.split("/"));
    const payload = JSON.parse(await readFile(writtenPath, "utf8"));

    assert.equal(payload.operationId, "operation_123");
    assert.match(written.path, /\.agent-cluster-cache\/runs\/operation_123\.json$/);

    const cleared = await clearClusterRunCache(workspaceRoot);
    assert.equal(cleared.existed, true);
    assert.equal(cleared.removedFiles >= 1, true);

    const emptyClear = await clearClusterRunCache(workspaceRoot);
    assert.equal(emptyClear.existed, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace cluster log writes both json payload and readable text log", async () => {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-cluster-log-"));

  try {
    const written = await writeClusterRunLog(projectDir, "operation_456", {
      operationId: "operation_456",
      status: "completed",
      savedAt: "2026-04-04T12:00:00.000Z",
      task: "Generate a maintenance log.",
      schemeId: "default",
      workspace: {
        resolvedDir: join(projectDir, "workspace")
      },
      operation: {
        events: [
          {
            timestamp: "2026-04-04T12:00:01.000Z",
            stage: "submitted",
            detail: "Request submitted."
          },
          {
            timestamp: "2026-04-04T12:00:02.000Z",
            stage: "cluster_done",
            detail: "Run completed."
          }
        ]
      },
      result: {
        synthesis: {
          finalAnswer: "The run completed successfully."
        },
        timings: {
          totalMs: 1234
        },
        plan: {
          tasks: [{ id: "task_1" }]
        },
        executions: [{ taskId: "task_1" }]
      }
    });

    const jsonPath = join(projectDir, ...written.jsonPath.split("/"));
    const textPath = join(projectDir, ...written.textPath.split("/"));
    const jsonPayload = JSON.parse(await readFile(jsonPath, "utf8"));
    const textPayload = await readFile(textPath, "utf8");

    assert.equal(jsonPayload.operationId, "operation_456");
    assert.match(written.jsonPath, /^task-logs\/operation_456\.json$/);
    assert.match(written.textPath, /^task-logs\/operation_456\.log$/);
    assert.match(textPayload, /Agent Cluster Task Log/);
    assert.match(textPayload, /Generate a maintenance log/);
    assert.match(textPayload, /cluster_done/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

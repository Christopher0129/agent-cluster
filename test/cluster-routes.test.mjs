import test from "node:test";
import assert from "node:assert/strict";
import { handleOperationCancel } from "../src/http/cluster-routes.mjs";
import { createOperationTracker } from "../src/operations.mjs";

function createMockResponse() {
  let statusCode = 0;
  let payload = null;

  return {
    writeHead(nextStatusCode) {
      statusCode = nextStatusCode;
    },
    end(body = "") {
      payload = body ? JSON.parse(String(body)) : null;
    },
    snapshot() {
      return {
        statusCode,
        payload
      };
    }
  };
}

test("handleOperationCancel treats missing operations as already stopped", async () => {
  const tracker = createOperationTracker();
  const response = createMockResponse();

  await handleOperationCancel(response, "missing_operation", tracker, process.cwd());

  const snapshot = response.snapshot();
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.payload.ok, true);
  assert.equal(snapshot.payload.alreadyStopped, true);
  assert.equal(snapshot.payload.notFound, true);
});

test("handleOperationCancel treats finished operations as already stopped", async () => {
  const tracker = createOperationTracker();
  tracker.ensureOperation("finished_operation", {
    task: "Done task",
    locale: "zh-CN"
  });
  tracker.publish("finished_operation", {
    type: "complete",
    stage: "cluster_done",
    tone: "ok"
  });

  const response = createMockResponse();
  await handleOperationCancel(response, "finished_operation", tracker, process.cwd());

  const snapshot = response.snapshot();
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.payload.ok, true);
  assert.equal(snapshot.payload.alreadyStopped, true);
  assert.equal(snapshot.payload.alreadyFinished, true);
});

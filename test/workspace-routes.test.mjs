import assert from "node:assert/strict";
import test from "node:test";
import { createFolderPickJobStore } from "../src/http/workspace-routes.mjs";

function flushAsyncWork() {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

test("createFolderPickJobStore exposes pending status before the dialog completes", async () => {
  let resolvePick = null;
  let currentTime = 100;
  const store = createFolderPickJobStore({
    createId: () => "job_1",
    now: () => currentTime,
    ttlMs: 1000,
    pickFolder: () =>
      new Promise((resolve) => {
        resolvePick = resolve;
      })
  });

  const started = store.start("C:/workspace");
  assert.equal(started.jobId, "job_1");
  assert.equal(started.status, "pending");
  assert.equal(store.get("job_1")?.status, "pending");

  await flushAsyncWork();
  resolvePick?.("C:/workspace/selected");
  let completed = store.get("job_1");
  for (let attempt = 0; attempt < 10 && completed?.status === "pending"; attempt += 1) {
    await flushAsyncWork();
    completed = store.get("job_1");
  }
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.path, "C:/workspace/selected");

  currentTime += 1001;
  store.cleanup();
  assert.equal(store.get("job_1"), null);
});

test("createFolderPickJobStore records cancelled and failed picker runs", async () => {
  const store = createFolderPickJobStore({
    createId: (() => {
      let count = 0;
      return () => `job_${++count}`;
    })(),
    pickFolder: async (initialDir) => {
      if (initialDir === "cancel") {
        return "";
      }
      throw new Error("Dialog failed.");
    }
  });

  const cancelled = store.start("cancel");
  const failed = store.start("fail");

  assert.equal(cancelled.status, "pending");
  assert.equal(failed.status, "pending");

  await flushAsyncWork();

  assert.equal(store.get("job_1")?.status, "cancelled");
  assert.equal(store.get("job_2")?.status, "failed");
  assert.match(store.get("job_2")?.error || "", /Dialog failed/);
});

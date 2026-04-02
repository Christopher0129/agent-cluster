import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearClusterRunCache, writeClusterRunCache } from "../src/workspace/cache.mjs";

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

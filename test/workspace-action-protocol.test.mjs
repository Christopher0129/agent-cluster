import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolAction,
  normalizeWorkspaceFinalResult,
  validateWorkspaceActionPayload,
  WORKSPACE_ACTIONS
} from "../src/workspace/action-protocol.mjs";

test("normalizeToolAction falls back to final for structured result payloads", () => {
  assert.equal(
    normalizeToolAction({
      summary: "done",
      keyFindings: ["one"]
    }),
    WORKSPACE_ACTIONS.FINAL
  );
});

test("validateWorkspaceActionPayload rejects malformed workspace tool payloads", () => {
  assert.throws(
    () => validateWorkspaceActionPayload(null, WORKSPACE_ACTIONS.LIST_FILES),
    /JSON object/
  );
  assert.throws(
    () => validateWorkspaceActionPayload({ paths: [] }, WORKSPACE_ACTIONS.READ_FILES),
    /requires at least one/
  );
  assert.throws(
    () =>
      validateWorkspaceActionPayload(
        {
          files: [{ path: "notes.md" }]
        },
        WORKSPACE_ACTIONS.WRITE_FILES
      ),
    /string content/
  );
  assert.throws(
    () => validateWorkspaceActionPayload({ summary: "" }, WORKSPACE_ACTIONS.FINAL),
    /structured result field/
  );
});

test("normalizeWorkspaceFinalResult deduplicates files and records command history", () => {
  const result = normalizeWorkspaceFinalResult(
    {
      summary: "Workspace run completed.",
      generatedFiles: ["reports/final.md", "reports/final.md"],
      toolUsage: ["write_files", "write_files"],
      memoryReads: "2",
      memoryWrites: "1",
      verificationStatus: "passed"
    },
    "",
    ["reports/final.md", "logs/output.txt"],
    [
      {
        action: WORKSPACE_ACTIONS.RUN_COMMAND,
        request: {
          command: "npm",
          args: ["test"]
        }
      },
      {
        action: WORKSPACE_ACTIONS.WRITE_FILES,
        request: {
          files: [{ path: "reports/final.md" }]
        }
      }
    ],
    {
      memoryReads: 0,
      memoryWrites: 0
    }
  );

  assert.deepEqual(result.generatedFiles, ["reports/final.md", "logs/output.txt"]);
  assert.deepEqual(result.verifiedGeneratedFiles, ["reports/final.md", "logs/output.txt"]);
  assert.deepEqual(result.toolUsage, ["write_files", "run_command"]);
  assert.deepEqual(result.workspaceActions, ["run_command", "write_files"]);
  assert.deepEqual(result.executedCommands, ["npm test"]);
  assert.equal(result.memoryReads, 2);
  assert.equal(result.memoryWrites, 1);
  assert.equal(result.verificationStatus, "passed");
});

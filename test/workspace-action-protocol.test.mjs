import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkspaceToolSchemaLines,
  canonicalizeWorkspaceActionPayload,
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

test("canonicalizeWorkspaceActionPayload normalizes wrapped action aliases", () => {
  const wrappedWrite = canonicalizeWorkspaceActionPayload({
    function: {
      name: "writeFile",
      arguments: JSON.stringify({
        path: "docs/alias.txt",
        content: "alias output\n"
      })
    }
  });

  assert.equal(wrappedWrite.action, WORKSPACE_ACTIONS.WRITE_FILES);
  assert.deepEqual(wrappedWrite.files, [
    {
      path: "docs/alias.txt",
      content: "alias output\n",
      encoding: "utf8"
    }
  ]);
  assert.equal(
    normalizeToolAction({
      tool: "web-search",
      query: "2026-04-03 A-share market statistics"
    }),
    WORKSPACE_ACTIONS.WEB_SEARCH
  );
  assert.equal(
    normalizeToolAction({
      function: {
        name: "writeDocx",
        arguments: JSON.stringify({
          path: "reports/report.docx",
          content: "中文内容"
        })
      }
    }),
    WORKSPACE_ACTIONS.WRITE_DOCX
  );
  assert.equal(
    normalizeToolAction([
      {
        action: "list_files",
        path: "."
      },
      {
        action: "read_files",
        paths: ["README.md"]
      }
    ]),
    WORKSPACE_ACTIONS.LIST_FILES
  );
  assert.deepEqual(
    canonicalizeWorkspaceActionPayload({
      actions: [
        {
          tool: "web-search",
          query: "latest A-share turnover"
        }
      ],
      reason: "Need live verification."
    }),
    {
      tool: "web-search",
      query: "latest A-share turnover",
      reason: "Need live verification.",
      action: WORKSPACE_ACTIONS.WEB_SEARCH
    }
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
  assert.throws(
    () =>
      validateWorkspaceActionPayload(
        {
          files: [{ path: "report.docx", content: "abc", encoding: "hex" }]
        },
        WORKSPACE_ACTIONS.WRITE_FILES
      ),
    /utf8|base64/
  );
  assert.throws(
    () => validateWorkspaceActionPayload({ query: "", domains: "example.com" }, WORKSPACE_ACTIONS.WEB_SEARCH),
    /requires a query/
  );
  assert.throws(
    () => validateWorkspaceActionPayload({ path: "reports/report.txt", content: "abc" }, WORKSPACE_ACTIONS.WRITE_DOCX),
    /\.docx/
  );
});

test("buildWorkspaceToolSchemaLines hides unavailable workspace tools", () => {
  const lines = buildWorkspaceToolSchemaLines({
    webSearchAvailable: false,
    workspaceWriteAvailable: false,
    workspaceCommandAvailable: true,
    workspaceCommandScopeDescription: "read-only inspection commands"
  }).join("\n");

  assert.doesNotMatch(lines, /"action":"write_files"/);
  assert.doesNotMatch(lines, /"action":"write_docx"/);
  assert.doesNotMatch(lines, /"action":"web_search"/);
  assert.match(lines, /"action":"run_command"/);
  assert.match(lines, /run_command scope: read-only inspection commands\./);
  assert.match(lines, /Unavailable tool: write_files\/write_docx/);
  assert.match(lines, /Unavailable tool: web_search/);
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
    ["reports/final.md"],
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
  assert.deepEqual(result.verifiedGeneratedFiles, ["reports/final.md"]);
  assert.deepEqual(result.toolUsage, ["write_files", "run_command"]);
  assert.deepEqual(result.workspaceActions, ["run_command", "write_files"]);
  assert.deepEqual(result.executedCommands, ["npm test"]);
  assert.equal(result.memoryReads, 2);
  assert.equal(result.memoryWrites, 1);
  assert.equal(result.verificationStatus, "passed");
});

test("normalizeWorkspaceFinalResult strips commentary from generated artifact names", () => {
  const result = normalizeWorkspaceFinalResult(
    {
      summary: "Artifact path was reported with extra commentary.",
      generatedFiles: ["报告/最终报告.docx（存在，但内容待复核）"],
      verificationStatus: "failed"
    },
    "",
    [],
    ["报告/最终报告.docx（已核验）"],
    [],
    {}
  );

  assert.deepEqual(result.generatedFiles, ["报告/最终报告.docx"]);
  assert.deepEqual(result.verifiedGeneratedFiles, ["报告/最终报告.docx"]);
});

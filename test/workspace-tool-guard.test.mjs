import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runWorkspaceToolLoop } from "../src/workspace/agent-loop.mjs";
import { FakeProvider } from "./helpers/providers.mjs";

test("runWorkspaceToolLoop blocks workspace writes outside task scope", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-guard-"));

  try {
    const provider = new FakeProvider([
      JSON.stringify({
        action: "write_files",
        reason: "Try to write a validation report into the workspace.",
        files: [
          {
            path: "reports/review.md",
            content: "# review\n"
          }
        ]
      }),
      JSON.stringify({
        action: "final",
        summary: "Validation completed without workspace writes.",
        keyFindings: ["The write attempt was blocked by task scope."],
        risks: ["No validation artifact was written because writes are not allowed for this task."],
        deliverables: [],
        confidence: "medium",
        followUps: ["Return the review as structured output instead of writing files."],
        generatedFiles: [],
        verificationStatus: "failed"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "validator",
        label: "Validator",
        model: "model-v",
        webSearch: false
      },
      task: {
        id: "validate_patch",
        phase: "validation",
        title: "Validate the generated patch",
        instructions: "Review the code changes and report findings without modifying workspace files.",
        expectedOutput: "Validation findings only.",
        requirements: {
          phase: "validation",
          requiresWorkspaceWrite: false,
          requiresWorkspaceCommand: true,
          requiresConcreteArtifact: false,
          allowsWorkspaceWrite: false,
          allowsWorkspaceCommand: true
        }
      },
      originalTask: "Validate the generated patch.",
      clusterPlan: {
        strategy: "Validation only."
      },
      dependencyOutputs: [],
      workspaceRoot
    });

    assert.equal(existsSync(join(workspaceRoot, "reports", "review.md")), false);
    assert.deepEqual(result.verifiedGeneratedFiles, []);
    assert.deepEqual(result.generatedFiles, []);
    assert.equal(result.toolUsage.includes("write_files"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

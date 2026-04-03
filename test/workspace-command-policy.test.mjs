import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSPACE_COMMAND_SCOPES,
  WorkspaceCommandScopeError,
  assertWorkspaceCommandAllowedForScope,
  resolveRequiredWorkspaceCommandScope
} from "../src/workspace/command-policy.mjs";
import { deriveTaskRequirements } from "../src/workspace/task-requirements.mjs";

test("resolveRequiredWorkspaceCommandScope classifies command tiers", () => {
  assert.equal(
    resolveRequiredWorkspaceCommandScope("git", ["status"]),
    WORKSPACE_COMMAND_SCOPES.READ_ONLY
  );
  assert.equal(
    resolveRequiredWorkspaceCommandScope("node", ["scripts/verify.js"]),
    WORKSPACE_COMMAND_SCOPES.VERIFY
  );
  assert.equal(
    resolveRequiredWorkspaceCommandScope("npm", ["install"]),
    WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
  );
});

test("assertWorkspaceCommandAllowedForScope rejects commands above the task tier", () => {
  assert.throws(
    () => assertWorkspaceCommandAllowedForScope("npm", ["install"], WORKSPACE_COMMAND_SCOPES.VERIFY),
    (error) =>
      error instanceof WorkspaceCommandScopeError &&
      error.allowedScope === WORKSPACE_COMMAND_SCOPES.VERIFY &&
      error.requiredScope === WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
  );
});

test("deriveTaskRequirements grants read-only commands for workspace-aware research tasks", () => {
  const requirements = deriveTaskRequirements({
    phase: "research",
    title: "Inspect repository status",
    instructions: "Review the git diff and repository history before summarizing findings.",
    expectedOutput: "A read-only repo inspection summary."
  });

  assert.equal(requirements.allowsWorkspaceWrite, false);
  assert.equal(requirements.allowsWorkspaceCommand, true);
  assert.equal(requirements.workspaceCommandScope, WORKSPACE_COMMAND_SCOPES.READ_ONLY);
});

test("deriveTaskRequirements clamps child task authority to its parent", () => {
  const parentRequirements = deriveTaskRequirements({
    phase: "validation",
    title: "Validate generated output",
    instructions: "Run verification commands only.",
    expectedOutput: "Validation report."
  });

  const childRequirements = deriveTaskRequirements(
    {
      phase: "validation",
      title: "Try to install missing dependencies",
      instructions: "Run npm install and then validate.",
      expectedOutput: "Updated dependency tree.",
      requirements: {
        allowsWorkspaceCommand: true,
        workspaceCommandScope: WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
      }
    },
    {
      parentRequirements
    }
  );

  assert.equal(childRequirements.workspaceCommandScope, WORKSPACE_COMMAND_SCOPES.VERIFY);
  assert.equal(childRequirements.allowsWorkspaceWrite, false);
});

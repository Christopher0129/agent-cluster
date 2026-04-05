import test from "node:test";
import assert from "node:assert/strict";
import {
  buildComplexityBudget,
  parseExplicitTotalAgentRequest
} from "../src/cluster/policies.mjs";

function buildConfig(overrides = {}) {
  return {
    cluster: {
      controller: "controller",
      maxParallel: 200,
      groupLeaderMaxDelegates: 4,
      delegateMaxDepth: 4,
      ...(overrides.cluster || {})
    }
  };
}

test("parseExplicitTotalAgentRequest recognizes Chinese and English total-agent requests", () => {
  assert.equal(
    parseExplicitTotalAgentRequest("调用50个agent分析今天的国际局势。"),
    50
  );
  assert.equal(
    parseExplicitTotalAgentRequest("Use 24 agents in total to research and verify the report."),
    24
  );
  assert.equal(parseExplicitTotalAgentRequest("Write one short summary directly."), null);
});

test("buildComplexityBudget lets an explicit total-agent request override automatic profile caps", () => {
  const budget = buildComplexityBudget({
    originalTask: "调用50个agent深度分析今天的国际局势，并形成报告。",
    workers: [{ id: "research_leader" }],
    config: buildConfig()
  });

  assert.equal(budget.requestedTotalAgents, 50);
  assert.equal(Number.isFinite(budget.autoBudgetMaxTotalAgents), true);
  assert.equal(budget.autoBudgetMaxTotalAgents < budget.requestedTotalAgents, true);
  assert.equal(budget.maxTotalAgents, 50);
  assert.equal(budget.maxTopLevelTasks >= 1, true);
  assert.equal(budget.maxTopLevelTasks <= budget.requestedTotalAgents, true);
  assert.equal(budget.maxChildrenPerLeader, 4);
  assert.equal(budget.maxDelegationDepth, 4);
  assert.equal(budget.budgetSource, "user_request");
});

test("buildComplexityBudget reports when runtime settings still cap an explicit total-agent request", () => {
  const budget = buildComplexityBudget({
    originalTask: "调用50个agent做多层并行分析。",
    workers: [{ id: "research_leader" }],
    config: buildConfig({
      cluster: {
        maxParallel: 1,
        groupLeaderMaxDelegates: 1,
        delegateMaxDepth: 1
      }
    })
  });

  assert.equal(budget.requestedTotalAgents, 50);
  assert.equal(budget.maxTotalAgents, 2);
  assert.equal(budget.maxTopLevelTasks, 1);
  assert.equal(budget.maxChildrenPerLeader, 1);
  assert.equal(budget.maxDelegationDepth, 1);
  assert.equal(budget.budgetSource, "user_request_capped_by_runtime");
});

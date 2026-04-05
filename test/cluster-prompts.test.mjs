import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLeaderDelegationRequest,
  buildPlanningRequest
} from "../src/cluster/prompts.mjs";

test("buildPlanningRequest states that an explicit total-agent request is run-wide", () => {
  const prompt = buildPlanningRequest({
    task: "调用50个agent深度分析今天的国际局势。",
    workers: [
      {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    ],
    maxParallel: 4,
    delegateMaxDepth: 4,
    delegateBranchFactor: 4,
    complexityBudget: {
      level: "very_complex",
      maxTopLevelTasks: 4,
      maxChildrenPerLeader: 4,
      maxDelegationDepth: 4,
      maxTotalAgents: 50,
      requestedTotalAgents: 50,
      autoBudgetMaxTotalAgents: 12,
      budgetSource: "user_request"
    }
  });

  assert.match(prompt.instructions, /50 total agents for the whole run/i);
  assert.match(prompt.instructions, /global cluster-wide total/i);
  assert.match(prompt.input, /Automatic complexity budgeting would have suggested 12/i);
});

test("buildLeaderDelegationRequest distinguishes global agent total from local child allocation", () => {
  const prompt = buildLeaderDelegationRequest({
    originalTask: "调用50个agent深度分析今天的国际局势。",
    clusterPlan: {
      strategy: "Split the work into regional and thematic streams."
    },
    leader: {
      label: "Research Leader",
      webSearch: true
    },
    task: {
      id: "task_1",
      phase: "research",
      title: "Research current geopolitics"
    },
    dependencyOutputs: [],
    delegateCount: 2,
    depthRemaining: 3,
    runAgentBudget: {
      requestedTotalAgents: 50,
      maxTotalAgents: 50,
      remainingChildAgents: 44,
      budgetSource: "user_request"
    }
  });

  assert.match(prompt.instructions, /50 total agents for the whole cluster run/i);
  assert.match(prompt.instructions, /not to this single parent task/i);
  assert.match(prompt.instructions, /Do not complain that your local child-agent allocation is smaller/i);
  assert.match(prompt.input, /"localChildAgentAllocation": 2/);
  assert.match(prompt.input, /"requestedTotalAgents": 50/);
  assert.match(prompt.input, /"remainingRunWideChildBudget": 44/);
});

test("cluster prompts include the requested output language policy", () => {
  const planningPrompt = buildPlanningRequest({
    task: "分析当前国际局势",
    workers: [
      {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    ],
    maxParallel: 2,
    outputLocale: "zh-CN"
  });
  const delegationPrompt = buildLeaderDelegationRequest({
    originalTask: "分析当前国际局势",
    clusterPlan: {
      strategy: "Split the work into regional streams."
    },
    leader: {
      label: "Research Leader",
      webSearch: true
    },
    task: {
      id: "task_1",
      phase: "research",
      title: "Research current geopolitics"
    },
    dependencyOutputs: [],
    delegateCount: 2,
    depthRemaining: 2,
    outputLocale: "zh-CN"
  });

  assert.match(planningPrompt.instructions, /always respond in Simplified Chinese/i);
  assert.match(planningPrompt.input, /Requested response language:\s+Simplified Chinese/i);
  assert.match(delegationPrompt.instructions, /JSON keys exactly as specified in English/i);
});

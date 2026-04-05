import test from "node:test";
import assert from "node:assert/strict";
import { runClusterAnalysis } from "../src/cluster/orchestrator.mjs";
import { FakeProvider } from "./helpers/providers.mjs";

function buildWorkerOutput(summary) {
  return JSON.stringify({
    summary,
    keyFindings: [summary],
    risks: [],
    deliverables: [],
    confidence: "high",
    followUps: []
  });
}

function buildLeaderSynthesis(summary) {
  return JSON.stringify({
    thinkingSummary: summary,
    summary,
    keyFindings: [summary],
    risks: [],
    deliverables: [],
    confidence: "high",
    followUps: [],
    verificationStatus: "not_applicable"
  });
}

test("runClusterAnalysis keeps simple tasks on a minimal agent budget", async () => {
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 2
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_leader: {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Fix one typo",
          strategy: "Split the tiny task into several batches anyway.",
          tasks: [
            {
              id: "batch_a",
              phase: "research",
              title: "Typos batch A",
              assignedWorker: "research_leader",
              delegateCount: 3,
              instructions: "Check the first third of the typo list.",
              dependsOn: []
            },
            {
              id: "batch_b",
              phase: "research",
              title: "Typos batch B",
              assignedWorker: "research_leader",
              delegateCount: 3,
              instructions: "Check the second third of the typo list.",
              dependsOn: []
            },
            {
              id: "batch_c",
              phase: "research",
              title: "Typos batch C",
              assignedWorker: "research_leader",
              delegateCount: 3,
              instructions: "Check the final third of the typo list.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "The typo was fixed directly.",
          executiveSummary: ["Simple work stayed centralized."],
          consensus: ["No extra child agents were created."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["research_leader", new FakeProvider([buildWorkerOutput("Handled directly without delegation.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Fix one typo in one file directly.",
    config,
    providerRegistry
  });

  assert.equal(result.budget.level, "simple");
  assert.equal(result.budget.maxTopLevelTasks, 1);
  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.plan.tasks[0].delegateCount, 0);
  assert.equal(result.executions[0].output.subordinateCount, 0);
});

test("runClusterAnalysis keeps direct single-topic research centralized when delegateCount is omitted", async () => {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 3,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_leader: {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Verify one latest topic directly",
          strategy: "Keep the task centralized because it is a single-topic direct verification request.",
          tasks: [
            {
              id: "verify_topic",
              phase: "research",
              title: "Verify one latest topic",
              assignedWorker: "research_leader",
              instructions:
                "Verify the latest market facts for one topic, check the source, keep the work centralized, and return a concise summary for the user.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Direct research verification completed.",
          executiveSummary: ["The task stayed on one research leader."],
          consensus: ["Single-topic direct verification should not spawn child agents."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["research_leader", new FakeProvider([buildWorkerOutput("Verified the latest topic directly.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Verify the latest facts for one topic and return a concise summary.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.plan.tasks[0].delegateCount, 0);
  assert.equal(result.executions[0].output.subordinateCount, 0);
  assert.equal(events.some((event) => event.stage === "subagent_created"), false);
});

test("runClusterAnalysis still infers delegation for broad multi-batch research when delegateCount is omitted", async () => {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 3,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_leader: {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect broad evidence across multiple source buckets",
          strategy: "Delegate the work because it spans multiple evidence batches.",
          tasks: [
            {
              id: "broad_research",
              phase: "research",
              title: "Collect broad evidence",
              assignedWorker: "research_leader",
              instructions:
                "Collect multiple evidence batches across two source buckets, compare the findings, and summarize the result.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Broad research delegation completed.",
          executiveSummary: ["The leader inferred delegation even without an explicit delegateCount."],
          consensus: ["Broad multi-batch research still fans out."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Split this broad research into two evidence buckets.",
          delegationSummary: "Bucket A and bucket B cover separate source clusters.",
          subtasks: [
            {
              id: "bucket_a",
              title: "Evidence bucket A",
              instructions: "Collect source bucket A.",
              expectedOutput: "Bucket A evidence."
            },
            {
              id: "bucket_b",
              title: "Evidence bucket B",
              instructions: "Collect source bucket B.",
              expectedOutput: "Bucket B evidence."
            }
          ]
        }),
        buildWorkerOutput("Bucket A completed."),
        buildWorkerOutput("Bucket B completed."),
        buildLeaderSynthesis("Merged both evidence buckets.")
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect broad evidence across multiple source buckets and compare the results.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.plan.tasks[0].delegateCount, 2);
  assert.equal(result.executions[0].output.subordinateCount, 2);
  assert.equal(events.some((event) => event.stage === "subagent_created"), true);
});

test("runClusterAnalysis collapses an over-broadened planning result back to one direct research task", async () => {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_leader: {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Verify one latest topic directly",
          strategy: "Incorrectly broaden the task into several research streams.",
          tasks: [
            {
              id: "topic_sources",
              phase: "research",
              title: "Topic source stream",
              assignedWorker: "research_leader",
              delegateCount: 2,
              instructions: "Collect source batch A for the topic.",
              dependsOn: []
            },
            {
              id: "topic_checks",
              phase: "research",
              title: "Topic verification stream",
              assignedWorker: "research_leader",
              delegateCount: 2,
              instructions: "Collect source batch B for the topic.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Centralized direct research completed.",
          executiveSummary: ["The planning result was normalized back to one direct research task."],
          consensus: ["Single-topic direct research should stay centralized even if the raw plan broadens it."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["research_leader", new FakeProvider([buildWorkerOutput("Handled the direct topic verification centrally.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Verify the latest facts for one topic and return a concise summary directly.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.plan.tasks[0].phase, "research");
  assert.equal(result.plan.tasks[0].delegateCount, 0);
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output.subordinateCount, 0);
  assert.equal(events.some((event) => event.stage === "subagent_created"), false);
});

test("runClusterAnalysis allows larger delegation budgets for complex work", async () => {
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 3,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      implementation_leader: {
        id: "implementation_leader",
        label: "Implementation Leader",
        model: "gpt-5.4",
        provider: "mock",
        specialties: ["implementation"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Implement multiple independent workspace changes",
          strategy: "Split the implementation into several disjoint workstreams, then synthesize the result.",
          tasks: [
            {
              id: "implementation_batch",
              phase: "implementation",
              title: "Implementation batch",
              assignedWorker: "implementation_leader",
              delegateCount: 4,
              instructions:
                "Implement multiple independent workspace changes across the repository, validate the result, and keep the work coordinated.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Complex implementation completed.",
          executiveSummary: ["The controller allowed a larger child-agent budget."],
          consensus: ["Complex work can still be split effectively."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "implementation_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "This needs three independent implementation slices.",
          delegationSummary: "Split by file set to avoid overlap.",
          subtasks: [
            {
              id: "slice_a",
              title: "Implementation slice A",
              instructions: "Handle slice A.",
              expectedOutput: "Slice A output."
            },
            {
              id: "slice_b",
              title: "Implementation slice B",
              instructions: "Handle slice B.",
              expectedOutput: "Slice B output."
            },
            {
              id: "slice_c",
              title: "Implementation slice C",
              instructions: "Handle slice C.",
              expectedOutput: "Slice C output."
            }
          ]
        }),
        buildWorkerOutput("Slice A completed."),
        buildWorkerOutput("Slice B completed."),
        buildWorkerOutput("Slice C completed."),
        buildLeaderSynthesis("Merged all implementation slices.")
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task:
      "Implement multiple independent workspace changes across the repository, validate the result, and keep recursive branches coordinated.",
    config,
    providerRegistry
  });

  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.plan.tasks[0].delegateCount, 3);
  assert.equal(result.executions[0].output.subordinateCount, 3);
  assert.equal(result.budget.maxChildrenPerLeader, 3);
  assert.equal(["complex", "very_complex"].includes(result.budget.level), true);
});

test("runClusterAnalysis enforces a run-wide child-agent budget across multiple leaders", async () => {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      leader_a: {
        id: "leader_a",
        label: "Leader A",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      },
      leader_b: {
        id: "leader_b",
        label: "Leader B",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      },
      leader_c: {
        id: "leader_c",
        label: "Leader C",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      },
      leader_d: {
        id: "leader_d",
        label: "Leader D",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  function buildDelegatingLeaderProvider(name, childCount) {
    return new FakeProvider([
      JSON.stringify({
        thinkingSummary: `${name} splits its evidence stream into child batches.`,
        delegationSummary: `${name} will split into source buckets.`,
        subtasks: [
          {
            id: `${name}_sub_1`,
            title: `${name} child 1`,
            instructions: `Handle ${name} child 1.`,
            expectedOutput: `${name} child 1 output.`
          },
          {
            id: `${name}_sub_2`,
            title: `${name} child 2`,
            instructions: `Handle ${name} child 2.`,
            expectedOutput: `${name} child 2 output.`
          },
          {
            id: `${name}_sub_3`,
            title: `${name} child 3`,
            instructions: `Handle ${name} child 3.`,
            expectedOutput: `${name} child 3 output.`
          }
        ]
      }),
      ...Array.from({ length: childCount }, (_, index) =>
        buildWorkerOutput(`${name} child ${index + 1} completed.`)
      ),
      buildLeaderSynthesis(`${name} merged its child evidence.`)
    ]);
  }

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect multiple evidence groups",
          strategy: "Use several research leaders, each with multiple delegated source buckets.",
          tasks: [
            {
              id: "stream_a",
              phase: "research",
              title: "Evidence stream A",
              assignedWorker: "leader_a",
              delegateCount: 3,
              instructions: "Collect evidence stream A from multiple source buckets.",
              dependsOn: []
            },
            {
              id: "stream_b",
              phase: "research",
              title: "Evidence stream B",
              assignedWorker: "leader_b",
              delegateCount: 3,
              instructions: "Collect evidence stream B from multiple source buckets.",
              dependsOn: []
            },
            {
              id: "stream_c",
              phase: "research",
              title: "Evidence stream C",
              assignedWorker: "leader_c",
              delegateCount: 3,
              instructions: "Collect evidence stream C from multiple source buckets.",
              dependsOn: []
            },
            {
              id: "stream_d",
              phase: "research",
              title: "Evidence stream D",
              assignedWorker: "leader_d",
              delegateCount: 3,
              instructions: "Collect evidence stream D from multiple source buckets.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Evidence collection completed under a shared run budget.",
          executiveSummary: ["The runtime enforced a total child-agent ceiling."],
          consensus: ["Not every leader received its full requested child-agent count."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["leader_a", buildDelegatingLeaderProvider("leader_a", 3)],
    ["leader_b", buildDelegatingLeaderProvider("leader_b", 3)],
    ["leader_c", buildDelegatingLeaderProvider("leader_c", 2)],
    ["leader_d", new FakeProvider([buildWorkerOutput("Leader D handled its stream directly.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect evidence from multiple source groups, compare the results, and keep the overall coordination tight.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  const childAgentsCreated = events.filter((event) => event.stage === "subagent_created").length;
  const delegatedChildren = result.executions.reduce(
    (sum, execution) => sum + Number(execution.output?.subordinateCount || 0),
    0
  );
  const availableChildBudget = result.budget.maxTotalAgents - result.plan.tasks.length;

  assert.equal(result.plan.tasks.length, 4);
  assert.equal(childAgentsCreated, availableChildBudget);
  assert.equal(delegatedChildren, availableChildBudget);
  assert.equal(availableChildBudget < 12, true);
});

test("runClusterAnalysis honors an explicit user-requested total agent count for the whole run", async () => {
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 200,
      groupLeaderMaxDelegates: 4,
      delegateMaxDepth: 4
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_leader: {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Analyze current geopolitics",
          strategy: "Use one research leader and preserve enough global budget for delegation.",
          tasks: [
            {
              id: "task_1",
              phase: "research",
              title: "Research current geopolitics",
              assignedWorker: "research_leader",
              delegateCount: 4,
              instructions: "Research the current geopolitical picture and summarize it.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Explicit total-agent request honored.",
          executiveSummary: ["The run budget respected the user's requested total."],
          consensus: ["The automatic profile cap was overridden by the user's explicit request."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["research_leader", new FakeProvider([buildWorkerOutput("Research completed directly.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "调用50个agent深度分析今天的国际局势，并形成报告。",
    config,
    providerRegistry
  });

  assert.equal(result.budget.requestedTotalAgents, 50);
  assert.equal(Number.isFinite(result.budget.autoBudgetMaxTotalAgents), true);
  assert.equal(result.budget.autoBudgetMaxTotalAgents < result.budget.requestedTotalAgents, true);
  assert.equal(result.budget.maxTotalAgents, 50);
  assert.equal(result.budget.budgetSource, "user_request");
});

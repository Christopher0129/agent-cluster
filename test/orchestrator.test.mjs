import test from "node:test";
import assert from "node:assert/strict";
import { runClusterAnalysis } from "../src/cluster/orchestrator.mjs";
import { DelayedJsonProvider, FakeProvider, waitForDelay } from "./helpers/providers.mjs";

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

test("runClusterAnalysis plans, executes workers, and synthesizes", async () => {
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4"
      },
      worker_a: {
        id: "worker_a",
        label: "Worker A",
        model: "model-a",
        provider: "mock",
        specialties: ["architecture"]
      },
      worker_b: {
        id: "worker_b",
        label: "Worker B",
        model: "model-b",
        provider: "mock",
        specialties: ["risk"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Assess the platform",
          strategy: "Split architecture and risk, then synthesize.",
          tasks: [
            {
              id: "architecture",
              title: "Architecture review",
              assignedWorker: "worker_a",
              instructions: "Review architecture",
              dependsOn: []
            },
            {
              id: "risk",
              title: "Risk review",
              assignedWorker: "worker_b",
              instructions: "Review risk",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "The cluster is feasible if provider adapters and traceability are added.",
          executiveSummary: ["Architecture and risk were reviewed."],
          consensus: ["A mixed-provider adapter layer is necessary."],
          disagreements: [],
          nextActions: ["Add tracing."]
        })
      ])
    ],
    [
      "worker_a",
      new FakeProvider([
        JSON.stringify({
          summary: "Architecture is workable.",
          keyFindings: ["Controller/worker split is clear."],
          risks: ["Need retries."],
          deliverables: ["Architecture notes"],
          confidence: "high",
          followUps: ["Add persistent runs."]
        })
      ])
    ],
    [
      "worker_b",
      new FakeProvider([
        JSON.stringify({
          summary: "Risk is manageable.",
          keyFindings: ["Provider outages need fallback."],
          risks: ["Missing audit logs."],
          deliverables: ["Risk notes"],
          confidence: "medium",
          followUps: ["Add cost controls."]
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Assess the platform",
    config,
    providerRegistry
  });

  assert.equal(result.plan.tasks.length, 2);
  assert.equal(result.executions.length, 2);
  assert.equal(result.synthesis.finalAnswer.includes("feasible"), true);
  assert.deepEqual(result.synthesis.nextActions, ["Add tracing."]);
});

test("runClusterAnalysis returns a multi-agent session snapshot when the framework is enabled", async () => {
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2
    },
    multiAgent: {
      enabled: true,
      mode: "group_chat",
      speakerStrategy: "phase_priority",
      maxRounds: 10,
      messageWindow: 20,
      summarizeLongMessages: true,
      includeSystemMessages: true
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4"
      },
      research_worker: {
        id: "research_worker",
        label: "Research Worker",
        model: "model-r",
        provider: "mock",
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Inspect the collaboration session",
          strategy: "Run one research task and then synthesize.",
          tasks: [
            {
              id: "task_1",
              phase: "research",
              title: "Research one focused question",
              assignedWorker: "research_worker",
              instructions: "Research one focused question.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "The collaboration session completed.",
          executiveSummary: ["One worker executed and returned a result."],
          consensus: ["The chat snapshot should be available."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_worker",
      new FakeProvider([
        buildWorkerOutput("Research worker completed the focused question.")
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Inspect the collaboration session",
    config,
    providerRegistry
  });

  assert.equal(result.multiAgentSession.enabled, true);
  assert.equal(result.multiAgentSession.settings.mode, "group_chat");
  assert.equal(result.multiAgentSession.status, "completed");
  assert.equal(result.multiAgentSession.totalMessageCount > 0, true);
  assert.equal(result.multiAgentSession.participantCount >= 1, true);
  assert.equal(
    result.multiAgentSession.messages.some((message) => /planning|research|completed/i.test(message.content)),
    true
  );
});

test("runClusterAnalysis applies maxParallel as a shared gate across workers and subagents", async () => {
  const concurrency = {
    current: 0,
    max: 0
  };
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2,
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
      direct_worker: {
        id: "direct_worker",
        label: "Direct Worker",
        model: "model-direct",
        provider: "mock",
        specialties: ["implementation"]
      },
      implementation_leader: {
        id: "implementation_leader",
        label: "Implementation Leader",
        model: "gpt-5.3-codex",
        provider: "mock",
        specialties: ["implementation", "coding"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Exercise one direct worker and one delegating leader together",
          strategy: "Run a direct worker while the leader fans out into three child tasks.",
          tasks: [
            {
              id: "direct_task",
              phase: "implementation",
              title: "Direct implementation task",
              assignedWorker: "direct_worker",
              instructions: "Handle the direct implementation task.",
              dependsOn: []
            },
            {
              id: "delegated_task",
              phase: "implementation",
              title: "Delegated implementation task",
              assignedWorker: "implementation_leader",
              delegateCount: 3,
              instructions: "Split the implementation work into three independent child tasks.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "The shared execution gate held.",
          executiveSummary: ["Workers and subagents shared one concurrency cap."],
          consensus: ["The run-wide limit applied to top-level and child execution."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "direct_worker",
      new DelayedJsonProvider(
        {
          summary: "Direct work completed.",
          keyFindings: ["Direct worker finished its slice."],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        },
        120,
        concurrency
      )
    ],
    [
      "implementation_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Split into three independent child slices.",
          delegationSummary: "Each child covers a disjoint implementation slice.",
          subtasks: [
            {
              id: "slice_a",
              title: "Implementation slice A",
              instructions: "Handle slice A.",
              expectedOutput: "Slice A result."
            },
            {
              id: "slice_b",
              title: "Implementation slice B",
              instructions: "Handle slice B.",
              expectedOutput: "Slice B result."
            },
            {
              id: "slice_c",
              title: "Implementation slice C",
              instructions: "Handle slice C.",
              expectedOutput: "Slice C result."
            }
          ]
        }),
        async ({ signal }) => {
          concurrency.current += 1;
          concurrency.max = Math.max(concurrency.max, concurrency.current);
          try {
            await waitForDelay(40, signal);
            return {
              text: JSON.stringify({
                summary: "Slice A done.",
                keyFindings: ["A"],
                risks: [],
                deliverables: [],
                confidence: "high",
                followUps: []
              })
            };
          } finally {
            concurrency.current -= 1;
          }
        },
        async ({ signal }) => {
          concurrency.current += 1;
          concurrency.max = Math.max(concurrency.max, concurrency.current);
          try {
            await waitForDelay(40, signal);
            return {
              text: JSON.stringify({
                summary: "Slice B done.",
                keyFindings: ["B"],
                risks: [],
                deliverables: [],
                confidence: "high",
                followUps: []
              })
            };
          } finally {
            concurrency.current -= 1;
          }
        },
        async ({ signal }) => {
          concurrency.current += 1;
          concurrency.max = Math.max(concurrency.max, concurrency.current);
          try {
            await waitForDelay(40, signal);
            return {
              text: JSON.stringify({
                summary: "Slice C done.",
                keyFindings: ["C"],
                risks: [],
                deliverables: [],
                confidence: "high",
                followUps: []
              })
            };
          } finally {
            concurrency.current -= 1;
          }
        },
        JSON.stringify({
          thinkingSummary: "Merged the delegated slices under the shared run cap.",
          summary: "Delegated work completed.",
          keyFindings: ["All three child slices completed."],
          risks: [],
          deliverables: ["Merged implementation summary"],
          confidence: "high",
          followUps: [],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Run one direct worker and one delegating leader under a shared concurrency cap.",
    config,
    providerRegistry
  });

  const implementationExecutions = result.executions.filter((execution) => execution.phase === "implementation");
  assert.equal(implementationExecutions.length, 2);
  assert.equal(implementationExecutions.find((execution) => execution.workerId === "direct_worker")?.status, "completed");
  assert.equal(
    implementationExecutions.find((execution) => execution.workerId === "implementation_leader")?.output.subordinateCount,
    3
  );
  assert.equal(concurrency.max, 2);
});

test("runClusterAnalysis falls back to a compatible worker after a retryable provider failure", async () => {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_primary: {
        id: "research_primary",
        label: "Research Primary",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://primary.example/v1",
        webSearch: true,
        specialties: ["research"]
      },
      research_backup: {
        id: "research_backup",
        label: "Research Backup",
        model: "gpt-5.4-mini",
        provider: "mock",
        baseUrl: "https://backup.example/v1",
        webSearch: true,
        specialties: ["research"]
      },
      implementation_only: {
        id: "implementation_only",
        label: "Implementation Only",
        model: "gpt-5.3-codex",
        provider: "mock",
        specialties: ["implementation"]
      }
    }
  };

  const retryableProviderError = new Error(
    "Request to https://primary.example/v1 failed: upstream gateway returned 524."
  );
  retryableProviderError.status = 524;

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect fresh market facts",
          strategy: "Use the assigned research worker, but allow a compatible backup if the provider is unavailable.",
          tasks: [
            {
              id: "task_1",
              phase: "research",
              title: "Collect fresh market facts across two source buckets",
              assignedWorker: "research_primary",
              delegateCount: 2,
              instructions:
                "Use web search to collect the latest market facts across two independent source buckets and summarize them.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Fallback completed successfully.",
          executiveSummary: ["A compatible backup worker completed the task after the primary provider failed."],
          consensus: ["Fresh-fact routing stayed on web-search-capable workers."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_primary",
      new FakeProvider([
        async () => {
          throw retryableProviderError;
        }
      ])
    ],
    [
      "research_backup",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Split the fresh-fact work into two buckets.",
          delegationSummary: "Bucket A and bucket B are independent.",
          subtasks: [
            {
              id: "bucket_a",
              title: "Fresh facts bucket A",
              instructions: "Collect bucket A.",
              expectedOutput: "Bucket A findings."
            },
            {
              id: "bucket_b",
              title: "Fresh facts bucket B",
              instructions: "Collect bucket B.",
              expectedOutput: "Bucket B findings."
            }
          ]
        }),
        buildWorkerOutput("Backup bucket A completed."),
        buildWorkerOutput("Backup bucket B completed."),
        buildLeaderSynthesis("Backup research worker completed the task.")
      ])
    ],
    ["implementation_only", new FakeProvider([buildWorkerOutput("This worker should never be selected.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Use web search to collect the latest market facts and summarize them.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].workerId, "research_backup");
  assert.equal(result.executions[0].status, "completed");
  assert.equal(events.some((event) => event.stage === "worker_fallback"), true);
  assert.equal(
    events.some(
      (event) =>
        event.stage === "worker_fallback" &&
        event.previousWorkerId === "research_primary" &&
        event.fallbackWorkerId === "research_backup"
    ),
    true
  );
});

test("runClusterAnalysis releases child-agent budget before retrying a failed delegated task on a fallback worker", async () => {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 6,
      groupLeaderMaxDelegates: 2,
      delegateMaxDepth: 1
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      leader_primary: {
        id: "leader_primary",
        label: "Leader Primary",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://primary.example/v1",
        webSearch: true,
        specialties: ["research"]
      },
      leader_backup: {
        id: "leader_backup",
        label: "Leader Backup",
        model: "gpt-5.4-mini",
        provider: "mock",
        baseUrl: "https://backup.example/v1",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const childProviderError = new Error(
    "Request to https://primary.example/v1 failed: upstream gateway returned 524."
  );
  childProviderError.status = 524;

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Split one fresh-fact task across two children",
          strategy: "Use one delegating leader and preserve the run-wide total agent limit.",
          tasks: [
            {
              id: "task_1",
              phase: "research",
              title: "Collect two fresh fact buckets",
              assignedWorker: "leader_primary",
              delegateCount: 2,
              instructions: "Use web search to collect the latest facts from two non-overlapping source buckets.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Delegated fallback completed successfully.",
          executiveSummary: ["The fallback leader still received enough child-agent budget to delegate."],
          consensus: ["Reserved child budget was released before the retry."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "leader_primary",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Split into two fresh-fact buckets.",
          delegationSummary: "Bucket A and bucket B are independent.",
          subtasks: [
            {
              id: "bucket_a",
              title: "Bucket A",
              instructions: "Collect bucket A.",
              expectedOutput: "Bucket A findings."
            },
            {
              id: "bucket_b",
              title: "Bucket B",
              instructions: "Collect bucket B.",
              expectedOutput: "Bucket B findings."
            }
          ]
        }),
        buildWorkerOutput("Primary child A completed."),
        async () => {
          throw childProviderError;
        },
        buildLeaderSynthesis("Primary leader merged one success and one provider failure.")
      ])
    ],
    [
      "leader_backup",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Retry with the same two-way split.",
          delegationSummary: "Bucket A and bucket B are independent.",
          subtasks: [
            {
              id: "bucket_a",
              title: "Bucket A",
              instructions: "Collect bucket A.",
              expectedOutput: "Bucket A findings."
            },
            {
              id: "bucket_b",
              title: "Bucket B",
              instructions: "Collect bucket B.",
              expectedOutput: "Bucket B findings."
            }
          ]
        }),
        buildWorkerOutput("Backup child A completed."),
        buildWorkerOutput("Backup child B completed."),
        buildLeaderSynthesis("Backup leader merged both delegated buckets.")
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "调用3个agent使用 web search 采集最新事实并汇总成结论。",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.budget.maxTotalAgents, 3);
  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].workerId, "leader_backup");
  assert.equal(result.executions[0].status, "completed");
  assert.equal(result.executions[0].output.subordinateCount, 2);
  assert.equal(events.filter((event) => event.stage === "worker_fallback").length, 1);
});

test("runClusterAnalysis falls back to a backup controller during planning after a retryable provider failure", async () => {
  const events = [];
  const planningProviderError = new Error(
    "Request to https://primary-controller.example/v1 failed: upstream gateway returned 524."
  );
  planningProviderError.status = 524;

  const config = {
    cluster: {
      controller: "controller_primary",
      maxParallel: 2
    },
    models: {
      controller_primary: {
        id: "controller_primary",
        label: "Primary Controller",
        model: "gpt-5.4",
        provider: "mock",
        role: "controller",
        baseUrl: "https://primary-controller.example/v1",
        specialties: ["research", "handoff"]
      },
      controller_backup: {
        id: "controller_backup",
        label: "Backup Controller",
        model: "gpt-5.4-mini",
        provider: "mock",
        role: "controller",
        baseUrl: "https://backup-controller.example/v1",
        specialties: ["research", "handoff"]
      },
      worker_a: {
        id: "worker_a",
        label: "Worker A",
        model: "model-a",
        provider: "mock",
        role: "worker",
        specialties: ["implementation"]
      },
      validation_worker: {
        id: "validation_worker",
        label: "Validation Worker",
        model: "model-v",
        provider: "mock",
        role: "worker",
        specialties: ["validation", "coding_manager", "qa"]
      },
      handoff_worker: {
        id: "handoff_worker",
        label: "Handoff Worker",
        model: "model-h",
        provider: "mock",
        role: "worker",
        specialties: ["handoff", "document writing", "synthesis"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller_primary",
      new FakeProvider([
        async () => {
          throw planningProviderError;
        }
      ])
    ],
    [
      "controller_backup",
      new FakeProvider([
        JSON.stringify({
          objective: "Use the backup controller for planning",
          strategy: "Fallback planning should continue on the backup controller.",
          tasks: [
            {
              id: "task_1",
              phase: "implementation",
              title: "Implement the requested change",
              assignedWorker: "worker_a",
              instructions: "Implement the requested change directly.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Planning fallback completed successfully.",
          executiveSummary: ["The backup controller completed planning and synthesis."],
          consensus: ["Controller fallback recovered a retryable planning outage."],
          disagreements: [],
          nextActions: []
        }),
        JSON.stringify({
          finalAnswer: "Planning fallback completed successfully.",
          executiveSummary: ["The backup controller completed planning and synthesis."],
          consensus: ["Controller fallback recovered a retryable planning outage."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["worker_a", new FakeProvider([buildWorkerOutput("Worker A completed the implementation task.")])],
    [
      "validation_worker",
      new FakeProvider([buildWorkerOutput("Validation worker completed the validation pass.")])
    ],
    ["handoff_worker", new FakeProvider([buildWorkerOutput("Handoff worker prepared the final handoff.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Implement the requested change end-to-end.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.plan.tasks.some((taskItem) => taskItem.assignedWorker === "worker_a"), true);
  assert.equal(
    result.executions.some((execution) => execution.workerId === "worker_a"),
    true
  );
  assert.equal(
    result.executions.some((execution) => execution.workerId === "controller_backup"),
    false
  );
  assert.equal(result.controller.id, "controller_backup");
  assert.equal(
    events.some(
      (event) =>
        event.stage === "controller_fallback" &&
        event.purpose === "planning" &&
        event.previousControllerId === "controller_primary" &&
        event.fallbackControllerId === "controller_backup"
    ),
    true
  );
  assert.equal(
    events.some(
      (event) => event.stage === "planning_done" && event.modelId === "controller_backup"
    ),
    true
  );
});

test("runClusterAnalysis falls back to a backup controller during synthesis after a retryable provider failure", async () => {
  const events = [];
  const synthesisProviderError = new Error(
    "Request to https://primary-controller.example/v1 failed: upstream gateway returned 524."
  );
  synthesisProviderError.status = 524;

  const config = {
    cluster: {
      controller: "controller_primary",
      maxParallel: 2
    },
    models: {
      controller_primary: {
        id: "controller_primary",
        label: "Primary Controller",
        model: "gpt-5.4",
        provider: "mock",
        role: "controller",
        baseUrl: "https://primary-controller.example/v1",
        specialties: ["research", "handoff"]
      },
      controller_backup: {
        id: "controller_backup",
        label: "Backup Controller",
        model: "gpt-5.4-mini",
        provider: "mock",
        role: "controller",
        baseUrl: "https://backup-controller.example/v1",
        specialties: ["research", "handoff"]
      },
      worker_a: {
        id: "worker_a",
        label: "Worker A",
        model: "model-a",
        provider: "mock",
        role: "worker",
        specialties: ["implementation"]
      },
      validation_worker: {
        id: "validation_worker",
        label: "Validation Worker",
        model: "model-v",
        provider: "mock",
        role: "worker",
        specialties: ["validation", "coding_manager", "qa"]
      },
      handoff_worker: {
        id: "handoff_worker",
        label: "Handoff Worker",
        model: "model-h",
        provider: "mock",
        role: "worker",
        specialties: ["handoff", "document writing", "synthesis"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller_primary",
      new FakeProvider([
        JSON.stringify({
          objective: "Plan on the primary controller",
          strategy: "Use the primary controller unless synthesis needs fallback.",
          tasks: [
            {
              id: "task_1",
              phase: "implementation",
              title: "Implement the requested change",
              assignedWorker: "worker_a",
              instructions: "Implement the requested change directly.",
              dependsOn: []
            }
          ]
        }),
        async () => {
          throw synthesisProviderError;
        }
      ])
    ],
    [
      "controller_backup",
      new FakeProvider([
        JSON.stringify({
          finalAnswer: "Synthesis fallback completed successfully.",
          executiveSummary: ["The backup controller completed the final synthesis."],
          consensus: ["Controller fallback recovered a retryable synthesis outage."],
          disagreements: [],
          nextActions: []
        }),
        JSON.stringify({
          finalAnswer: "Synthesis fallback completed successfully.",
          executiveSummary: ["The backup controller completed the final synthesis."],
          consensus: ["Controller fallback recovered a retryable synthesis outage."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    ["worker_a", new FakeProvider([buildWorkerOutput("Worker A completed the implementation task.")])],
    [
      "validation_worker",
      new FakeProvider([buildWorkerOutput("Validation worker completed the validation pass.")])
    ],
    ["handoff_worker", new FakeProvider([buildWorkerOutput("Handoff worker prepared the final handoff.")])]
  ]);

  const result = await runClusterAnalysis({
    task: "Implement the requested change end-to-end.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(
    result.executions.some((execution) => execution.workerId === "worker_a"),
    true
  );
  assert.equal(
    result.executions.some((execution) => execution.workerId === "controller_backup"),
    false
  );
  assert.equal(result.controller.id, "controller_backup");
  assert.equal(
    events.some(
      (event) => event.stage === "planning_done" && event.modelId === "controller_primary"
    ),
    true
  );
  assert.equal(
    events.some(
      (event) =>
        event.stage === "controller_fallback" &&
        event.purpose === "synthesis" &&
        event.previousControllerId === "controller_primary" &&
        event.fallbackControllerId === "controller_backup"
    ),
    true
  );
  assert.equal(
    events.some(
      (event) => event.stage === "cluster_done" && event.modelId === "controller_backup"
    ),
    true
  );
});

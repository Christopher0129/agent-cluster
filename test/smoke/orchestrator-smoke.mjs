import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractJsonCandidate, parseJsonFromText } from "../../src/utils/json-output.mjs";
import { createAppServer } from "../../src/app.mjs";
import { runClusterAnalysis } from "../../src/cluster/orchestrator.mjs";
import {
  getEditableSettings,
  loadRuntimeConfig,
  saveEditableSettings
} from "../../src/config.mjs";
import { createSessionRuntime } from "../../src/session/runtime.mjs";
import { postJson } from "../../src/providers/http-client.mjs";
import { testModelConnectivity } from "../../src/providers/connectivity-test.mjs";
import { createProviderForModel } from "../../src/providers/factory.mjs";
import { AnthropicMessagesProvider } from "../../src/providers/anthropic-messages.mjs";
import { OpenAIResponsesProvider } from "../../src/providers/openai-responses.mjs";
import { providerSupportsCapability } from "../../src/static/provider-catalog.js";
import {
  buildAgentLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "../../src/static/agent-graph-layout.js";
import { runWorkspaceToolLoop } from "../../src/workspace/agent-loop.mjs";
import { DelayedJsonProvider, FakeProvider, waitForDelay } from "../helpers/providers.mjs";

async function runOrchestratorTests() {
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
}

async function runCodingManagerWorkflowTests() {
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
      implementation_worker: {
        id: "implementation_worker",
        label: "Implementation Worker",
        model: "gpt-5.3-codex",
        provider: "mock",
        specialties: ["implementation"]
      },
      qa_worker: {
        id: "qa_worker",
        label: "QA Worker",
        model: "model-qa",
        provider: "mock",
        specialties: ["validation"]
      },
      coding_manager: {
        id: "coding_manager",
        label: "Coding Manager",
        model: "model-review",
        provider: "mock",
        specialties: ["coding_manager"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Implement and review the requested changes",
          strategy: "Implement first, run a validation pass, then require a final coding-manager review.",
          tasks: [
            {
              id: "implementation_batch",
              phase: "implementation",
              title: "Implementation batch",
              assignedWorker: "implementation_worker",
              instructions: "Implement the requested code changes in the workspace.",
              dependsOn: []
            },
            {
              id: "validation_precheck",
              phase: "validation",
              title: "Validation precheck",
              assignedWorker: "qa_worker",
              instructions: "Run a preliminary validation pass on the generated code.",
              dependsOn: ["implementation_batch"]
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Implementation and coding-manager review completed.",
          executiveSummary: ["Implementation finished and the coding manager performed the final review."],
          consensus: ["Code outputs were reviewed before handoff."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "implementation_worker",
      new FakeProvider([
        JSON.stringify({
          summary: "Implementation completed.",
          keyFindings: ["Requested code changes were applied."],
          risks: [],
          deliverables: ["workspace patch"],
          confidence: "high",
          followUps: []
        })
      ])
    ],
    [
      "qa_worker",
      new FakeProvider([
        JSON.stringify({
          summary: "Precheck completed.",
          keyFindings: ["Smoke validation passed."],
          risks: [],
          deliverables: ["validation notes"],
          confidence: "high",
          followUps: [],
          verificationStatus: "passed"
        })
      ])
    ],
    [
      "coding_manager",
      new FakeProvider([
        JSON.stringify({
          summary: "Final coding-manager review completed.",
          keyFindings: ["Code outputs are coherent and ready for handoff."],
          risks: [],
          deliverables: ["final review notes"],
          confidence: "high",
          followUps: [],
          verificationStatus: "passed"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Implement the requested feature and review all generated code.",
    config,
    providerRegistry
  });

  const finalReviewTask = result.plan.tasks.find((task) => task.id === "coding_management_review");
  assert.equal(Boolean(finalReviewTask), true);
  assert.equal(finalReviewTask.phase, "validation");
  assert.equal(finalReviewTask.assignedWorker, "coding_manager");
  assert.deepEqual(
    [...finalReviewTask.dependsOn].sort(),
    ["implementation_batch", "validation_precheck"].sort()
  );

  const finalReviewExecution = result.executions.find(
    (execution) => execution.taskId === "coding_management_review"
  );
  assert.equal(Boolean(finalReviewExecution), true);
  assert.equal(finalReviewExecution.workerId, "coding_manager");
  assert.equal(finalReviewExecution.output.verificationStatus, "passed");
}

async function runHierarchicalDelegationTests() {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2
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
        specialties: ["web research", "analysis"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect and summarize evidence",
          strategy: "Let the research leader split the task into two smaller evidence batches.",
          tasks: [
            {
              id: "evidence_batch",
              phase: "research",
              title: "Collect evidence batch",
              assignedWorker: "research_leader",
              delegateCount: 2,
              instructions: "Collect verified evidence and summarize it.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Delegated evidence collection completed.",
          executiveSummary: ["The leader split work across two subordinate agents."],
          consensus: ["Hierarchical delegation is working."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "I will split the research into two non-overlapping case batches.",
          delegationSummary: "Batch A covers sources 1-2, batch B covers sources 3-4.",
          subtasks: [
            {
              id: "batch_a",
              title: "Evidence batch A",
              instructions: "Collect evidence from sources 1 and 2.",
              expectedOutput: "Verified findings from batch A."
            },
            {
              id: "batch_b",
              title: "Evidence batch B",
              instructions: "Collect evidence from sources 3 and 4.",
              expectedOutput: "Verified findings from batch B."
            }
          ]
        }),
        JSON.stringify({
          thinkingSummary: "Focusing on the first source cluster.",
          summary: "Batch A completed.",
          keyFindings: ["Source 1 validated.", "Source 2 validated."],
          risks: [],
          deliverables: ["batch A notes"],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          thinkingSummary: "Focusing on the second source cluster.",
          summary: "Batch B completed.",
          keyFindings: ["Source 3 validated.", "Source 4 validated."],
          risks: [],
          deliverables: ["batch B notes"],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          thinkingSummary: "I merged both subordinate evidence batches into one conclusion.",
          summary: "The leader consolidated both evidence batches.",
          keyFindings: ["All four sources were covered."],
          risks: [],
          deliverables: ["Merged evidence summary"],
          confidence: "high",
          followUps: [],
          delegationNotes: ["Batch split avoided overlap."],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect evidence with hierarchical delegation.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output.subordinateCount, 2);
  assert.equal(result.executions[0].output.subordinateResults.length, 2);
  assert.equal(result.executions[0].output.thinkingSummary.includes("merged"), true);
  assert.equal(events.some((event) => event.stage === "subagent_created"), true);
  assert.equal(events.some((event) => event.stage === "leader_delegate_done"), true);
}

async function runHierarchicalDelegationConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };
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
      research_leader: {
        id: "research_leader",
        label: "Research Leader",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research", "analysis"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect cases",
          strategy: "Use one research leader with three delegated evidence batches.",
          tasks: [
            {
              id: "evidence_batch",
              phase: "research",
              title: "Collect evidence batch",
              assignedWorker: "research_leader",
              delegateCount: 3,
              instructions: "Collect verified evidence and summarize it.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Delegated evidence collection completed.",
          executiveSummary: ["The leader delegated and throttled subordinate work."],
          consensus: ["Shared-gateway subordinate concurrency was limited."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "I will split the research into three non-overlapping case batches.",
          delegationSummary: "Batch A/B/C each cover a distinct source bucket.",
          subtasks: [
            {
              id: "batch_a",
              title: "Evidence batch A",
              instructions: "Collect evidence from source bucket A.",
              expectedOutput: "Verified findings from batch A."
            },
            {
              id: "batch_b",
              title: "Evidence batch B",
              instructions: "Collect evidence from source bucket B.",
              expectedOutput: "Verified findings from batch B."
            },
            {
              id: "batch_c",
              title: "Evidence batch C",
              instructions: "Collect evidence from source bucket C.",
              expectedOutput: "Verified findings from batch C."
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
                summary: "Batch A completed.",
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
                summary: "Batch B completed.",
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
                summary: "Batch C completed.",
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
          thinkingSummary: "I merged the three subordinate batches into one conclusion.",
          summary: "The leader consolidated all subordinate evidence batches.",
          keyFindings: ["All three batches were completed."],
          risks: [],
          deliverables: ["Merged evidence summary"],
          confidence: "high",
          followUps: [],
          delegationNotes: ["Shared-gateway concurrency was throttled."],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect evidence with a shared research gateway.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output.subordinateCount, 3);
  assert.equal(concurrency.max, 1);
}

async function runConfigurableHierarchicalDelegationTests() {
  const concurrency = {
    current: 0,
    max: 0
  };
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4,
      subordinateMaxParallel: 2,
      groupLeaderMaxDelegates: 2
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
        model: "gpt-5.3-codex",
        provider: "mock",
        specialties: ["coding", "debugging"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Implement the requested changes",
          strategy: "Use one implementation leader with delegated coding subtasks.",
          tasks: [
            {
              id: "implementation_batch",
              phase: "implementation",
              title: "Implementation batch",
              assignedWorker: "implementation_leader",
              delegateCount: 4,
              instructions: "Split the coding work and complete it.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Implementation completed.",
          executiveSummary: ["The leader respected configurable delegation limits."],
          consensus: ["Leader delegation cap and subordinate concurrency cap both applied."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "implementation_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "I can split this into four coding chunks.",
          delegationSummary: "Split into four subtasks, but runtime should cap execution.",
          subtasks: [
            {
              id: "impl_a",
              title: "Implement part A",
              instructions: "Handle part A.",
              expectedOutput: "Part A result."
            },
            {
              id: "impl_b",
              title: "Implement part B",
              instructions: "Handle part B.",
              expectedOutput: "Part B result."
            },
            {
              id: "impl_c",
              title: "Implement part C",
              instructions: "Handle part C.",
              expectedOutput: "Part C result."
            },
            {
              id: "impl_d",
              title: "Implement part D",
              instructions: "Handle part D.",
              expectedOutput: "Part D result."
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
                summary: "Part A done.",
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
                summary: "Part B done.",
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
                summary: "Part C done.",
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
        async ({ signal }) => {
          concurrency.current += 1;
          concurrency.max = Math.max(concurrency.max, concurrency.current);
          try {
            await waitForDelay(40, signal);
            return {
              text: JSON.stringify({
                summary: "Part D done.",
                keyFindings: ["D"],
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
          thinkingSummary: "I merged the completed subordinate work.",
          summary: "The leader consolidated the capped subordinate results.",
          keyFindings: ["Only the configured number of subordinate tasks ran."],
          risks: [],
          deliverables: ["Merged implementation summary"],
          confidence: "high",
          followUps: [],
          delegationNotes: ["Runtime delegation cap was applied."],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Implement the requested changes with one leader.",
    config,
    providerRegistry
  });

  const implementationExecution = result.executions.find((execution) => execution.phase === "implementation");
  assert.equal(Boolean(implementationExecution), true);
  assert.equal(implementationExecution.output.subordinateCount, 2);
  assert.equal(concurrency.max, 2);
}

async function runDeepHierarchicalDelegationTests() {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2,
      subordinateMaxParallel: 1,
      groupLeaderMaxDelegates: 2,
      delegateMaxDepth: 2
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      recursive_leader: {
        id: "recursive_leader",
        label: "Recursive Leader",
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
          objective: "Build a recursive delegation tree",
          strategy: "Allow the leader to split once, then let one child split again.",
          tasks: [
            {
              id: "recursive_task",
              phase: "implementation",
              title: "Recursive implementation task",
              assignedWorker: "recursive_leader",
              delegateCount: 2,
              instructions: "Delegate recursively where useful, then synthesize the result.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Recursive delegation completed.",
          executiveSummary: ["A child agent created its own child agents."],
          consensus: ["Recursive delegation depth was honored."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "recursive_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Split into two high-level child tasks first.",
          delegationSummary: "Child A handles the complex branch, child B handles a direct branch.",
          subtasks: [
            {
              id: "child_a",
              title: "Child branch A",
              instructions: "Further split this branch and complete it.",
              expectedOutput: "Branch A result."
            },
            {
              id: "child_b",
              title: "Child branch B",
              instructions: "Handle this branch directly if possible.",
              expectedOutput: "Branch B result."
            }
          ]
        }),
        JSON.stringify({
          thinkingSummary: "Child A needs two narrower grandchild tasks.",
          delegationSummary: "Grandchild tasks cover two disjoint implementation slices.",
          subtasks: [
            {
              id: "grand_1",
              title: "Grandchild 1",
              instructions: "Handle slice 1.",
              expectedOutput: "Slice 1 result."
            },
            {
              id: "grand_2",
              title: "Grandchild 2",
              instructions: "Handle slice 2.",
              expectedOutput: "Slice 2 result."
            }
          ]
        }),
        JSON.stringify({
          summary: "Grandchild 1 done.",
          keyFindings: ["Slice 1 finished."],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          summary: "Grandchild 2 done.",
          keyFindings: ["Slice 2 finished."],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          thinkingSummary: "Child A merged both grandchild outputs.",
          summary: "Child A completed.",
          keyFindings: ["Two grandchild slices were merged."],
          risks: [],
          deliverables: ["Child A summary"],
          confidence: "high",
          followUps: [],
          verificationStatus: "not_applicable"
        }),
        JSON.stringify({
          thinkingSummary: "Child B does not need more delegation.",
          delegationSummary: "Direct execution is sufficient.",
          delegateCount: 0,
          subtasks: []
        }),
        JSON.stringify({
          summary: "Child B done.",
          keyFindings: ["Direct branch completed."],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          thinkingSummary: "Top-level leader merged the recursive tree.",
          summary: "Recursive synthesis completed.",
          keyFindings: ["A nested child tree completed successfully."],
          risks: [],
          deliverables: ["Top-level summary"],
          confidence: "high",
          followUps: [],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Run recursive delegation.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output.subordinateCount, 4);
  assert.equal(result.executions[0].output.subordinateResults.length, 2);
  assert.equal(events.filter((event) => event.stage === "subagent_created").length, 4);
}

async function runUnlimitedSubordinateConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 0,
      subordinateMaxParallel: 0,
      groupLeaderMaxDelegates: 3,
      delegateMaxDepth: 1,
      phaseParallel: {
        implementation: 0
      }
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
          objective: "Run all child tasks without subordinate limits",
          strategy: "Use one implementation leader and allow all three child tasks to run together.",
          tasks: [
            {
              id: "implementation_batch",
              phase: "implementation",
              title: "Implementation batch",
              assignedWorker: "implementation_leader",
              delegateCount: 3,
              instructions: "Split into three independent child tasks and finish them.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Unlimited subordinate concurrency completed.",
          executiveSummary: ["All child tasks ran without a subordinate cap."],
          consensus: ["Zero subordinateMaxParallel is treated as unlimited."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "implementation_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Create three independent child tasks.",
          delegationSummary: "Each child can run in parallel.",
          subtasks: [
            {
              id: "impl_a",
              title: "Implement A",
              instructions: "Handle A.",
              expectedOutput: "A result."
            },
            {
              id: "impl_b",
              title: "Implement B",
              instructions: "Handle B.",
              expectedOutput: "B result."
            },
            {
              id: "impl_c",
              title: "Implement C",
              instructions: "Handle C.",
              expectedOutput: "C result."
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
                summary: "A done.",
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
                summary: "B done.",
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
                summary: "C done.",
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
          thinkingSummary: "Merged all three child results.",
          summary: "Unlimited child concurrency completed.",
          keyFindings: ["All three child tasks completed."],
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
    task: "Run three child tasks without subordinate concurrency caps.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output.subordinateCount, 3);
  assert.equal(concurrency.max, 3);
}

async function runUnlimitedClusterConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 0,
      phaseParallel: {
        implementation: 0
      }
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      worker_a: {
        id: "worker_a",
        label: "Worker A",
        model: "model-a",
        provider: "mock",
        specialties: ["implementation"]
      },
      worker_b: {
        id: "worker_b",
        label: "Worker B",
        model: "model-b",
        provider: "mock",
        specialties: ["implementation"]
      },
      worker_c: {
        id: "worker_c",
        label: "Worker C",
        model: "model-c",
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
          objective: "Run all implementation tasks together",
          strategy: "Start three implementation workers in parallel.",
          tasks: [
            {
              id: "impl_a",
              phase: "implementation",
              title: "Implementation A",
              assignedWorker: "worker_a",
              instructions: "Handle task A.",
              dependsOn: []
            },
            {
              id: "impl_b",
              phase: "implementation",
              title: "Implementation B",
              assignedWorker: "worker_b",
              instructions: "Handle task B.",
              dependsOn: []
            },
            {
              id: "impl_c",
              phase: "implementation",
              title: "Implementation C",
              assignedWorker: "worker_c",
              instructions: "Handle task C.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Unlimited top-level concurrency completed.",
          executiveSummary: ["All three workers ran together."],
          consensus: ["Zero maxParallel is treated as unlimited."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "worker_a",
      new DelayedJsonProvider(
        {
          summary: "A done.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "worker_b",
      new DelayedJsonProvider(
        {
          summary: "B done.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "worker_c",
      new DelayedJsonProvider(
        {
          summary: "C done.",
          keyFindings: ["C"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        },
        40,
        concurrency
      )
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Run three implementation tasks without a top-level concurrency cap.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 3);
  assert.equal(concurrency.max, 3);
}

async function runImplicitDelegateCountInferenceTests() {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2,
      subordinateMaxParallel: 2,
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
        specialties: ["research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect multiple evidence batches",
          strategy: "Use one research leader to split the work, even if delegateCount is omitted.",
          tasks: [
            {
              id: "research_batch",
              phase: "research",
              title: "Collect multiple evidence batches",
              assignedWorker: "research_leader",
              instructions: "Collect multiple evidence batches and compare the results.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Implicit delegation completed.",
          executiveSummary: ["The leader still delegated work even without an explicit delegateCount."],
          consensus: ["Missing delegateCount is now inferred from the task and settings."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "This task should be split into two evidence batches.",
          delegationSummary: "Batch A and batch B cover different source clusters.",
          subtasks: [
            {
              id: "batch_a",
              title: "Evidence batch A",
              instructions: "Collect source cluster A.",
              expectedOutput: "Batch A evidence."
            },
            {
              id: "batch_b",
              title: "Evidence batch B",
              instructions: "Collect source cluster B.",
              expectedOutput: "Batch B evidence."
            }
          ]
        }),
        JSON.stringify({
          summary: "Batch A completed.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          summary: "Batch B completed.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          thinkingSummary: "Merged both evidence batches.",
          summary: "Implicit delegation synthesis completed.",
          keyFindings: ["Two subordinate batches completed."],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: [],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect evidence with implied delegation.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  const researchExecution = result.executions.find((execution) => execution.taskId === "research_batch");
  assert.equal(Boolean(researchExecution), true);
  assert.equal(researchExecution.output.subordinateCount, 2);
  assert.equal(events.some((event) => event.stage === "subagent_created"), true);
}

async function runExplicitZeroDelegateRecoveryTests() {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2,
      subordinateMaxParallel: 2,
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
          objective: "Split implementation work despite explicit zero delegate count",
          strategy: "The leader should still delegate because the task is not atomic.",
          tasks: [
            {
              id: "implementation_batch",
              phase: "implementation",
              title: "Implement multiple independent changes",
              assignedWorker: "implementation_leader",
              delegateCount: 0,
              instructions: "Implement multiple independent changes across the codebase in parallel.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Explicit zero delegate count was recovered.",
          executiveSummary: ["The leader still created child agents."],
          consensus: ["Settings can recover from an over-conservative delegateCount=0."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "implementation_leader",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "This should be split into two implementation slices.",
          delegationSummary: "Slice A and slice B can be done independently.",
          delegateCount: 0,
          subtasks: []
        }),
        JSON.stringify({
          summary: "Slice A completed.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          summary: "Slice B completed.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: []
        }),
        JSON.stringify({
          thinkingSummary: "Merged both implementation slices.",
          summary: "Recovered delegation synthesis completed.",
          keyFindings: ["Two subordinate slices completed."],
          risks: [],
          deliverables: [],
          confidence: "high",
          followUps: [],
          verificationStatus: "not_applicable"
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Recover from explicit zero delegation.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  const implementationExecution = result.executions.find((execution) => execution.taskId === "implementation_batch");
  assert.equal(Boolean(implementationExecution), true);
  assert.equal(implementationExecution.output.subordinateCount, 2);
  assert.equal(events.some((event) => event.stage === "subagent_created"), true);
}

async function runZeroDelegateLeaderExecutionTests() {
  const events = [];
  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 2,
      groupLeaderMaxDelegates: 0
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      leader_only: {
        id: "leader_only",
        label: "Leader Only",
        model: "gpt-5.4",
        provider: "mock",
        specialties: ["analysis"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Handle the task directly",
          strategy: "Assign one leader-marked task without subordinate creation.",
          tasks: [
            {
              id: "direct_task",
              phase: "implementation",
              title: "Direct analysis task",
              assignedWorker: "leader_only",
              delegateCount: 3,
              instructions: "Analyze directly and return the result.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Leader completed the task directly.",
          executiveSummary: ["No subordinate agents were created."],
          consensus: ["Delegate cap 0 forced direct execution."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "leader_only",
      new FakeProvider([
        JSON.stringify({
          thinkingSummary: "Handled the task directly as the leader.",
          summary: "Direct execution completed.",
          keyFindings: ["No subordinate split occurred."],
          risks: [],
          deliverables: ["Direct result"],
          confidence: "high",
          followUps: []
        })
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Run the task without creating subordinates.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].output.summary, "Direct execution completed.");
  assert.equal(result.executions[0].output.subordinateCount, 0);
  assert.equal(events.some((event) => event.stage === "subagent_created"), false);
  assert.equal(events.some((event) => event.stage === "leader_delegate_start"), false);
}

export async function runOrchestratorSmokeTests() {
  await runOrchestratorTests();
  await runCodingManagerWorkflowTests();
  await runHierarchicalDelegationTests();
  await runHierarchicalDelegationConcurrencyTests();
  await runConfigurableHierarchicalDelegationTests();
  await runDeepHierarchicalDelegationTests();
  await runUnlimitedSubordinateConcurrencyTests();
  await runUnlimitedClusterConcurrencyTests();
  await runImplicitDelegateCountInferenceTests();
  await runExplicitZeroDelegateRecoveryTests();
  await runZeroDelegateLeaderExecutionTests();
}

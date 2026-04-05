import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractJsonCandidate, parseJsonFromText } from "../src/utils/json-output.mjs";
import { createAppServer } from "../src/app.mjs";
import { runClusterAnalysis } from "../src/cluster/orchestrator.mjs";
import {
  getEditableSettings,
  loadRuntimeConfig,
  saveEditableSettings
} from "../src/config.mjs";
import { createSessionRuntime } from "../src/session/runtime.mjs";
import { postJson } from "../src/providers/http-client.mjs";
import { testModelConnectivity } from "../src/providers/connectivity-test.mjs";
import { createProviderForModel } from "../src/providers/factory.mjs";
import { AnthropicMessagesProvider } from "../src/providers/anthropic-messages.mjs";
import { OpenAIChatProvider } from "../src/providers/openai-chat.mjs";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.mjs";
import {
  getProviderDefinition,
  providerSupportsCapability
} from "../src/static/provider-catalog.js";
import {
  buildAgentLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "../src/static/agent-graph-layout.js";
import { runWorkspaceToolLoop } from "../src/workspace/agent-loop.mjs";
import { readDocumentText } from "../src/workspace/document-reader.mjs";
import { DelayedJsonProvider, FakeProvider, waitForDelay } from "./helpers/providers.mjs";

function runJsonTests() {
  const parsed = parseJsonFromText('{"hello":"world","items":[1,2]}');
  assert.equal(parsed.hello, "world");
  assert.deepEqual(parsed.items, [1, 2]);

  const fenced = extractJsonCandidate("```json\n{\"a\":1,\"b\":2}\n```");
  assert.equal(fenced, '{"a":1,"b":2}');

  const embedded = parseJsonFromText('Result:\n{"summary":"ok","items":["a"]}\nDone.');
  assert.equal(embedded.summary, "ok");
  assert.deepEqual(embedded.items, ["a"]);

  const trailing = parseJsonFromText('{"summary":"ok"}\nExplanation: verified with sources.');
  assert.equal(trailing.summary, "ok");
}

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
  assert.equal(concurrency.max, 3);
}

async function runGlobalExecutionGateTests() {
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
          finalAnswer: "The global execution gate capped direct and delegated work together.",
          executiveSummary: ["One direct worker and a delegating leader shared the same concurrency cap."],
          consensus: ["Top-level and child executions never exceeded the run-wide limit."],
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

async function runSettingsTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 2 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      server: { port: 5050 },
      cluster: {
        controller: "worker",
        maxParallel: 0,
        subordinateMaxParallel: 0,
        groupLeaderMaxDelegates: 0,
        delegateMaxDepth: 2,
        phaseParallel: {
          research: "0",
          validation: "1"
        }
      },
      workspace: { dir: "./project-workspace" },
      bot: {
        installDir: "custom-bot-connectors",
        customCommand: "npm install some-bot-plugin",
        enabledPresets: ["feishu", "dingtalk"],
        commandPrefix: "/agent",
        autoStart: true,
        progressUpdates: false,
        presetConfigs: {
          feishu: {
            envText: "HTTP_PROXY=http://127.0.0.1:7890"
          }
        }
      },
      secrets: [
        { name: "OPENAI_API_KEY", value: "sk-test" },
        { name: "MOONSHOT_API_KEY", value: "moonshot-test" },
        { name: "FEISHU_APP_ID", value: "feishu-app-id" },
        { name: "FEISHU_APP_SECRET", value: "feishu-app-secret" }
      ],
      models: [
        {
          id: "worker",
          label: "Worker Controller",
          provider: "openai-chat",
          model: "kimi-2.5",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKeyEnv: "MOONSHOT_API_KEY",
          apiKeyValue: "moonshot-model-key",
          authStyle: "bearer",
          specialties: ["analysis", "long context reading"],
          temperature: "0.2"
        },
        {
          id: "coder",
          label: "Codex Worker",
          provider: "openai-responses",
          model: "gpt-5.3-codex",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          apiKeyValue: "openai-model-key",
          authStyle: "bearer",
          thinkingEnabled: true,
          reasoningEffort: "medium",
          webSearch: true,
          specialties: "coding, debugging"
        }
      ]
    });

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settings.cluster.activeSchemeId, "gpt_scheme");
    assert.equal(editable.settings.cluster.controller, "worker");
    assert.equal(editable.settings.schemes.length, 1);
    assert.equal(editable.settings.schemes[0].label, "gpt方案");
    assert.equal(editable.settings.server.port, 5050);
    assert.equal(editable.providerDefinitions.some((definition) => definition.id === "kimi-coding"), true);
    assert.equal(editable.settings.cluster.maxParallel, 0);
    assert.equal(editable.settings.cluster.subordinateMaxParallel, 0);
    assert.equal(editable.settings.cluster.groupLeaderMaxDelegates, 0);
    assert.equal(editable.settings.cluster.delegateMaxDepth, 2);
    assert.equal(editable.settings.cluster.phaseParallel.research, 0);
    assert.equal(editable.settings.cluster.phaseParallel.validation, 1);
    assert.equal(editable.settings.workspace.dir, "./project-workspace");
    assert.equal(editable.settings.bot.installDir, "custom-bot-connectors");
    assert.equal(editable.settings.bot.customCommand, "npm install some-bot-plugin");
    assert.deepEqual(editable.settings.bot.enabledPresets, ["feishu", "dingtalk"]);
    assert.equal(editable.settings.bot.commandPrefix, "/agent");
    assert.equal(editable.settings.bot.autoStart, true);
    assert.equal(editable.settings.bot.progressUpdates, false);
    assert.equal(editable.settings.bot.presetConfigs.feishu.envText, "HTTP_PROXY=http://127.0.0.1:7890");
    assert.equal(editable.settings.models.length, 2);
    assert.equal(editable.settings.models[0].apiKeyValue, "moonshot-model-key");
    assert.equal(editable.settings.models[1].apiKeyValue, "openai-model-key");
    assert.equal(editable.settings.models[1].thinkingEnabled, true);
    assert.equal(editable.settings.models[1].webSearch, true);
    assert.equal(
      editable.settings.secrets.some((entry) => entry.name === "FEISHU_APP_ID" && entry.value === "feishu-app-id"),
      true
    );

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.server.port, 5050);
    assert.equal(runtime.cluster.activeSchemeId, "gpt_scheme");
    assert.equal(runtime.cluster.activeSchemeLabel, "gpt方案");
    assert.equal(runtime.cluster.controller, "worker");
    assert.equal(runtime.cluster.maxParallel, 0);
    assert.equal(runtime.cluster.subordinateMaxParallel, 0);
    assert.equal(runtime.cluster.groupLeaderMaxDelegates, 0);
    assert.equal(runtime.cluster.delegateMaxDepth, 2);
    assert.equal(runtime.cluster.phaseParallel.research, 0);
    assert.equal(runtime.cluster.phaseParallel.validation, 1);
    assert.equal(runtime.workspace.dir, "./project-workspace");
    assert.equal(runtime.workspace.resolvedDir, join(projectDir, "project-workspace"));
    assert.equal(runtime.bot.installDir, "custom-bot-connectors");
    assert.deepEqual(runtime.bot.enabledPresets, ["feishu", "dingtalk"]);
    assert.equal(runtime.bot.commandPrefix, "/agent");
    assert.equal(runtime.bot.autoStart, true);
    assert.equal(runtime.bot.progressUpdates, false);
    assert.equal(runtime.bot.presetConfigs.feishu.envText, "HTTP_PROXY=http://127.0.0.1:7890");
    assert.equal(runtime.models.worker.role, "controller");
    assert.deepEqual(runtime.models.worker.specialties, ["analysis", "long context reading"]);
    assert.equal(runtime.models.coder.thinkingEnabled, true);
    assert.equal(runtime.models.coder.reasoning.effort, "medium");
    assert.equal(runtime.models.coder.webSearch, true);
    assert.equal(runtime.models.worker.temperature, 0.2);
    assert.equal(process.env.MOONSHOT_API_KEY, "moonshot-model-key");
    assert.equal(process.env.OPENAI_API_KEY, "openai-model-key");
    assert.equal(process.env.FEISHU_APP_ID, "feishu-app-id");
    assert.equal(process.env.FEISHU_APP_SECRET, "feishu-app-secret");

    const persistedRaw = await readFile(join(projectDir, "runtime.settings.json"), "utf8");
    const persisted = JSON.parse(persistedRaw);
    assert.equal(Boolean(persisted.secretsEncrypted), true);
    assert.equal("secrets" in persisted, false);
    assert.equal(persistedRaw.includes("moonshot-model-key"), false);
    assert.equal(persistedRaw.includes("openai-model-key"), false);
    assert.equal(persistedRaw.includes("feishu-app-id"), false);
    assert.equal(persistedRaw.includes("feishu-app-secret"), false);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function runSessionRuntimeTests() {
  const events = [];
  const session = createSessionRuntime({
    emitEvent(event) {
      events.push(event);
    }
  });
  const model = {
    id: "session_worker",
    label: "Session Worker",
    provider: "openai-responses",
    model: "gpt-5.4-mini",
    pricing: {
      inputPer1kUsd: 0.01,
      outputPer1kUsd: 0.02
    }
  };

  const call = session.beginProviderCall(model, {
    agentId: "leader:session_worker",
    agentLabel: "Session Worker",
    agentKind: "leader",
    taskId: "task_session",
    taskTitle: "Session Test",
    purpose: "worker_execution"
  });
  session.recordRetry(
    model,
    {
      attempt: 1,
      maxRetries: 3,
      nextDelayMs: 500,
      status: 502,
      message: "temporary upstream failure"
    },
    {
      agentId: "leader:session_worker",
      agentLabel: "Session Worker",
      taskId: "task_session",
      taskTitle: "Session Test",
      parentSpanId: call.spanId
    }
  );
  session.completeProviderCall(
    model,
    call.spanId,
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140
      }
    },
    {
      detail: "Session provider call completed."
    }
  );

  session.remember(
    {
      title: "Important note",
      content: "Remember the counterexample in the second dependency output.",
      tags: ["research", "counterexample"]
    },
    {
      agentId: "leader:session_worker",
      agentLabel: "Session Worker",
      taskId: "task_session",
      taskTitle: "Session Test"
    }
  );
  const recalled = session.recall(
    {
      query: "counterexample",
      limit: 2
    },
    {
      agentId: "leader:session_worker",
      agentLabel: "Session Worker",
      taskId: "task_session",
      taskTitle: "Session Test"
    }
  );
  const snapshot = session.buildSnapshot();

  assert.equal(snapshot.totals.providerCalls, 1);
  assert.equal(snapshot.totals.retries, 1);
  assert.equal(snapshot.totals.inputTokens, 100);
  assert.equal(snapshot.totals.outputTokens, 40);
  assert.equal(snapshot.totals.totalTokens, 140);
  assert.equal(snapshot.totals.estimatedCostUsd, 0.0018);
  assert.equal(snapshot.totals.memoryWrites, 1);
  assert.equal(snapshot.totals.memoryReads, 1);
  assert.equal(snapshot.memory.count, 1);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].title, "Important note");
  assert.equal(events.some((event) => event.stage === "trace_span_start"), true);
  assert.equal(events.some((event) => event.stage === "memory_write"), true);
}

function runSessionCircuitBreakerTests() {
  const session = createSessionRuntime();
  const model = {
    id: "flaky_worker",
    label: "Flaky Worker",
    provider: "openai-chat",
    model: "kimi-test",
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownMs: 50
  };

  const firstCall = session.beginProviderCall(model, {
    purpose: "worker_execution"
  });
  session.failProviderCall(model, firstCall.spanId, new Error("first failure"));

  const secondCall = session.beginProviderCall(model, {
    purpose: "worker_execution"
  });
  session.failProviderCall(model, secondCall.spanId, new Error("second failure"));

  assert.equal(session.getCircuitState(model.id).state, "open");
  assert.throws(
    () =>
      session.beginProviderCall(model, {
        purpose: "worker_execution"
      }),
    /circuit breaker/
  );
}

async function runWorkspaceToolLayerMemoryTests() {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-layer-"));
  const session = createSessionRuntime();
  const provider = new FakeProvider([
    JSON.stringify({
      action: "remember",
      title: "Shared note",
      content: "Remember the counterexample from the dependency output.",
      tags: ["shared", "research"]
    }),
    JSON.stringify({
      action: "recall_memory",
      query: "counterexample",
      limit: 2
    }),
    JSON.stringify({
      action: "final",
      thinkingSummary: "Used session memory tools.",
      summary: "Memory tool layer completed successfully.",
      keyFindings: ["Stored and recalled a session note."],
      risks: [],
      deliverables: [],
      confidence: "high",
      followUps: [],
      toolUsage: ["remember", "recall_memory"],
      memoryReads: 1,
      memoryWrites: 1,
      verificationStatus: "not_applicable"
    })
  ]);

  try {
    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "worker_memory",
        label: "Worker Memory",
        provider: "mock",
        model: "mock-model",
        agentKind: "leader"
      },
      task: {
        id: "task_memory",
        title: "Use session memory",
        phase: "research"
      },
      originalTask: "Use session memory inside the worker tool layer.",
      clusterPlan: {
        strategy: "Exercise the remember and recall tools."
      },
      dependencyOutputs: [],
      workspaceRoot,
      sessionRuntime: session
    });

    assert.equal(result.summary, "Memory tool layer completed successfully.");
    assert.equal(result.memoryReads, 1);
    assert.equal(result.memoryWrites, 1);
    assert.deepEqual(result.toolUsage, ["remember", "recall_memory"]);
    assert.equal(session.buildSnapshot().memory.count, 1);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function runLegacyDistSettingsFallbackTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-legacy-dist-"));
  const legacySettingsDir = join(projectDir, "dist");

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 2 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await mkdir(legacySettingsDir, { recursive: true });
    await writeFile(
      join(legacySettingsDir, "runtime.settings.json"),
      `${JSON.stringify(
        {
          server: { port: 5151 },
          cluster: {
            activeSchemeId: "legacy_scheme",
            activeSchemeLabel: "Legacy Scheme",
            controller: "legacy_controller",
            maxParallel: 7,
            subordinateMaxParallel: 4,
            groupLeaderMaxDelegates: 2,
            delegateMaxDepth: 3
          },
          workspace: {
            dir: "./legacy-workspace"
          },
          bot: {
            installDir: "legacy-bots",
            customCommand: "",
            enabledPresets: ["feishu"],
            commandPrefix: "/agent",
            autoStart: false,
            progressUpdates: true,
            presetConfigs: {}
          },
          models: {
            legacy_controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              authStyle: "bearer",
              label: "Legacy Controller",
              specialties: ["controller"]
            },
            legacy_worker: {
              provider: "openai-chat",
              model: "kimi-k2.5",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              authStyle: "bearer",
              label: "Legacy Worker",
              specialties: ["research"]
            }
          },
          schemes: {
            legacy_scheme: {
              label: "Legacy Scheme",
              controller: "legacy_controller",
              models: {
                legacy_controller: {
                  provider: "openai-responses",
                  model: "gpt-5.4",
                  baseUrl: "https://api.openai.com/v1",
                  apiKeyEnv: "OPENAI_API_KEY",
                  authStyle: "bearer",
                  label: "Legacy Controller",
                  specialties: ["controller"]
                },
                legacy_worker: {
                  provider: "openai-chat",
                  model: "kimi-k2.5",
                  baseUrl: "https://api.moonshot.cn/v1",
                  apiKeyEnv: "MOONSHOT_API_KEY",
                  authStyle: "bearer",
                  label: "Legacy Worker",
                  specialties: ["research"]
                }
              }
            }
          },
          secrets: {
            OPENAI_API_KEY: "legacy-openai-key",
            MOONSHOT_API_KEY: "legacy-moonshot-key"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settingsPath, join(projectDir, "dist", "runtime.settings.json"));
    assert.equal(editable.settings.server.port, 5151);
    assert.equal(editable.settings.cluster.activeSchemeId, "legacy_scheme");
    assert.equal(editable.settings.cluster.controller, "legacy_controller");
    assert.equal(editable.settings.workspace.dir, "./legacy-workspace");
    assert.equal(editable.settings.models.length, 2);
    assert.equal(editable.settings.models[0].apiKeyValue, "legacy-openai-key");
    assert.equal(editable.settings.models[1].apiKeyValue, "legacy-moonshot-key");

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.settingsPath, join(projectDir, "dist", "runtime.settings.json"));
    assert.equal(runtime.server.port, 5151);
    assert.equal(runtime.cluster.activeSchemeId, "legacy_scheme");
    assert.equal(runtime.cluster.controller, "legacy_controller");
    assert.equal(runtime.cluster.maxParallel, 7);
    assert.equal(runtime.workspace.dir, "./legacy-workspace");
    assert.equal(runtime.models.legacy_controller.role, "controller");
    assert.equal(process.env.OPENAI_API_KEY, "legacy-openai-key");
    assert.equal(process.env.MOONSHOT_API_KEY, "legacy-moonshot-key");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runBlankClusterSettingFallbackTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-config-blank-fallback-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: {
            controller: "controller",
            maxParallel: 9,
            subordinateMaxParallel: 4,
            groupLeaderMaxDelegates: 6,
            delegateMaxDepth: 2
          },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      cluster: {
        controller: "worker",
        maxParallel: "",
        subordinateMaxParallel: "",
        groupLeaderMaxDelegates: "",
        delegateMaxDepth: ""
      },
      workspace: { dir: "./workspace" },
      bot: {},
      secrets: [],
      models: [
        {
          id: "worker",
          label: "Worker",
          provider: "kimi-chat",
          model: "kimi-k2.5",
          baseUrl: "https://api.moonshot.cn/v1",
          apiKeyEnv: "MOONSHOT_API_KEY",
          authStyle: "bearer",
          specialties: ["research"]
        },
        {
          id: "controller",
          label: "Controller",
          provider: "openai-responses",
          model: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_API_KEY",
          authStyle: "bearer",
          specialties: ["controller"]
        }
      ]
    });

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.cluster.maxParallel, 9);
    assert.equal(runtime.cluster.subordinateMaxParallel, 9);
    assert.equal(runtime.cluster.groupLeaderMaxDelegates, 6);
    assert.equal(runtime.cluster.delegateMaxDepth, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runSchemeSettingsTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-schemes-"));

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 2 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "kimi",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "MOONSHOT_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await saveEditableSettings(projectDir, {
      server: { port: 6060 },
      cluster: {
        activeSchemeId: "gpt_plan",
        controller: "gpt_controller",
        maxParallel: 3,
        subordinateMaxParallel: 2,
        groupLeaderMaxDelegates: 4
      },
      workspace: { dir: "./scheme-workspace" },
      schemes: [
        {
          id: "gpt_plan",
          label: "gpt方案",
          controller: "gpt_controller",
          models: [
            {
              id: "gpt_controller",
              label: "GPT Controller",
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY_GPT",
              apiKeyValue: "gpt-controller-key",
              authStyle: "bearer",
              reasoningEffort: "xhigh",
              webSearch: true,
              specialties: ["task planning", "delegation", "synthesis"]
            },
            {
              id: "gpt_coder",
              label: "GPT Codex",
              provider: "openai-responses",
              model: "gpt-5.3-codex",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY_CODEX",
              apiKeyValue: "gpt-codex-key",
              authStyle: "bearer",
              reasoningEffort: "high",
              specialties: ["coding", "debugging"]
            }
          ]
        },
        {
          id: "kimi_plan",
          label: "Kimi方案",
          controller: "kimi_controller",
          models: [
            {
              id: "kimi_controller",
              label: "Kimi Controller",
              provider: "openai-chat",
              model: "kimi-2.5",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "KIMI_PLAN_KEY_1",
              apiKeyValue: "kimi-controller-key",
              authStyle: "bearer",
              temperature: "0.2",
              specialties: ["analysis", "long context reading"]
            },
            {
              id: "kimi_worker_1",
              label: "Kimi Worker 1",
              provider: "openai-chat",
              model: "kimi-2.5",
              baseUrl: "https://api.moonshot.cn/v1",
              apiKeyEnv: "KIMI_PLAN_KEY_2",
              apiKeyValue: "kimi-worker-key",
              authStyle: "bearer",
              temperature: "0.3",
              specialties: ["analysis", "chat"]
            }
          ]
        }
      ],
      secrets: [],
      bot: {}
    });

    const editable = getEditableSettings(projectDir);
    assert.equal(editable.settings.cluster.activeSchemeId, "gpt_plan");
    assert.equal(editable.settings.cluster.controller, "gpt_controller");
    assert.equal(editable.settings.schemes.length, 2);
    assert.equal(editable.settings.schemes[0].label, "gpt方案");
    assert.equal(editable.settings.schemes[1].label, "Kimi方案");
    assert.equal(editable.settings.models.length, 2);
    assert.equal(editable.settings.models[0].id, "gpt_controller");

    const runtime = loadRuntimeConfig(projectDir);
    assert.equal(runtime.server.port, 6060);
    assert.equal(runtime.cluster.activeSchemeId, "gpt_plan");
    assert.equal(runtime.cluster.activeSchemeLabel, "gpt方案");
    assert.equal(runtime.cluster.controller, "gpt_controller");
    assert.equal(Boolean(runtime.models.gpt_controller), true);
    assert.equal(Boolean(runtime.models.kimi_controller), false);

    const kimiRuntime = loadRuntimeConfig(projectDir, { schemeId: "kimi_plan" });
    assert.equal(kimiRuntime.cluster.activeSchemeId, "kimi_plan");
    assert.equal(kimiRuntime.cluster.activeSchemeLabel, "Kimi方案");
    assert.equal(kimiRuntime.cluster.controller, "kimi_controller");
    assert.equal(Boolean(kimiRuntime.models.kimi_controller), true);
    assert.equal(Boolean(kimiRuntime.models.gpt_controller), false);
    assert.equal(process.env.OPENAI_API_KEY_GPT, "gpt-controller-key");
    assert.equal(process.env.OPENAI_API_KEY_CODEX, "gpt-codex-key");
    assert.equal(process.env.KIMI_PLAN_KEY_1, "kimi-controller-key");
    assert.equal(process.env.KIMI_PLAN_KEY_2, "kimi-worker-key");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runWorkspaceToolLoopTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-workspace-"));
  const workspaceDir = join(projectDir, "workspace-root");

  try {
    await writeFile(join(projectDir, "README.md"), "base", "utf8");

    const config = {
      projectDir,
      workspace: {
        dir: "./workspace-root",
        resolvedDir: workspaceDir
      },
      cluster: {
        controller: "controller",
        maxParallel: 1
      },
      models: {
        controller: {
          id: "controller",
          label: "Controller",
          model: "gpt-5.4"
        },
        worker_writer: {
          id: "worker_writer",
          label: "Writer Worker",
          model: "gpt-5.3-codex",
          provider: "mock",
          specialties: ["coding"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Generate a script",
            strategy: "Inspect the workspace, then write the requested file.",
            tasks: [
              {
                id: "write_script",
                title: "Write script",
                assignedWorker: "worker_writer",
                instructions: "Inspect the workspace and create scripts/hello.ps1",
                dependsOn: []
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "The file was written into the workspace.",
            executiveSummary: ["A script was generated."],
            consensus: ["Workspace writes are working."],
            disagreements: [],
            nextActions: ["Review the generated script."]
          })
        ])
      ],
      [
        "worker_writer",
        new FakeProvider([
          JSON.stringify({
            action: "list_files",
            path: ".",
            reason: "Inspect current workspace."
          }),
          JSON.stringify({
            action: "write_files",
            reason: "Create the requested PowerShell script.",
            files: [
              {
                path: "scripts/hello.ps1",
                content: "Write-Output \"hello from workspace\"\n"
              }
            ]
          }),
          JSON.stringify({
            action: "final",
            summary: "Script created successfully.",
            keyFindings: ["scripts/hello.ps1 was created in the workspace."],
            risks: [],
            deliverables: ["scripts/hello.ps1"],
            confidence: "high",
            followUps: ["Run the script to verify output."],
            generatedFiles: ["scripts/hello.ps1"]
          })
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Create a hello script inside the workspace.",
      config,
      providerRegistry
    });

    const generated = await readFile(join(workspaceDir, "scripts", "hello.ps1"), "utf8");
    assert.equal(generated, 'Write-Output "hello from workspace"\n');
    assert.deepEqual(result.executions[0].output.generatedFiles, ["scripts/hello.ps1"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runWorkspaceJsonRepairTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-workspace-json-repair-"));
  const workspaceDir = join(projectDir, "workspace-root");
  const events = [];

  try {
    const config = {
      projectDir,
      workspace: {
        dir: "./workspace-root",
        resolvedDir: workspaceDir
      },
      cluster: {
        controller: "controller",
        maxParallel: 1
      },
      models: {
        controller: {
          id: "controller",
          label: "Controller",
          model: "gpt-5.4",
          provider: "mock"
        },
        worker_writer: {
          id: "worker_writer",
          label: "Writer Worker",
          model: "gpt-5.3-codex",
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
            objective: "Repair malformed workspace JSON and finish the write",
            strategy: "Let the worker repair its tool payload, write the file, then finalize.",
            tasks: [
              {
                id: "repair_write",
                phase: "implementation",
                title: "Repair and write file",
                assignedWorker: "worker_writer",
                instructions: "Create docs/repaired.txt in the workspace.",
                dependsOn: []
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "Malformed workspace JSON was repaired and completed.",
            executiveSummary: ["The worker repaired its tool payload before continuing."],
            consensus: ["Workspace JSON repair path is working."],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      [
        "worker_writer",
        new FakeProvider([
          '{"action":"write_files","reason":"Write the repaired file.","files":[{"path":"docs/repaired.txt","content":"repaired output\\n"}],}',
          JSON.stringify({
            action: "write_files",
            reason: "Write the repaired file.",
            files: [
              {
                path: "docs/repaired.txt",
                content: "repaired output\n"
              }
            ]
          }),
          JSON.stringify({
            action: "final",
            summary: "Repair succeeded.",
            keyFindings: ["Malformed JSON was repaired before the file write completed."],
            risks: [],
            deliverables: ["docs/repaired.txt"],
            confidence: "high",
            followUps: [],
            generatedFiles: ["docs/repaired.txt"],
            verificationStatus: "not_applicable"
          })
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Repair malformed workspace JSON and write the file.",
      config,
      providerRegistry,
      onEvent(event) {
        events.push(event);
      }
    });

    const generated = await readFile(join(workspaceDir, "docs", "repaired.txt"), "utf8");
    assert.equal(generated, "repaired output\n");
    assert.equal(events.some((event) => event.stage === "workspace_json_repair"), true);
    assert.deepEqual(result.executions[0].output.verifiedGeneratedFiles, ["docs/repaired.txt"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runArtifactVerificationGuardTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-artifact-guard-"));
  const workspaceDir = join(projectDir, "workspace-root");

  try {
    const config = {
      projectDir,
      workspace: {
        dir: "./workspace-root",
        resolvedDir: workspaceDir
      },
      cluster: {
        controller: "controller",
        maxParallel: 1
      },
      models: {
        controller: {
          id: "controller",
          label: "Controller",
          model: "gpt-5.4",
          provider: "mock"
        },
        handoff_worker: {
          id: "handoff_worker",
          label: "Handoff Worker",
          model: "gpt-5.4",
          provider: "mock",
          specialties: ["handoff"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Produce a handoff report",
            strategy: "Ask the worker to generate a concrete file artifact.",
            tasks: [
              {
                id: "write_report",
                phase: "handoff",
                title: "Generate delivery report.docx",
                assignedWorker: "handoff_worker",
                instructions: "Create and deliver report.docx in the workspace.",
                expectedOutput: "A concrete report.docx artifact.",
                dependsOn: []
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "The delivery attempt finished with artifact verification feedback.",
            executiveSummary: ["Artifact verification rejected an unverified file claim."],
            consensus: ["Concrete artifact tasks need verified workspace writes."],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      [
        "handoff_worker",
        new FakeProvider([
          JSON.stringify({
            action: "final",
            summary: "The report is ready.",
            keyFindings: ["A report was prepared conceptually."],
            risks: [],
            deliverables: ["report.docx"],
            confidence: "medium",
            followUps: [],
            generatedFiles: ["report.docx"],
            verificationStatus: "not_applicable"
          })
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Generate a concrete report.docx artifact.",
      config,
      providerRegistry
    });

    const reportPath = join(workspaceDir, "report.docx");
    const reportText = await readDocumentText(reportPath);
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].output.verificationStatus, "passed");
    assert.deepEqual(result.executions[0].output.verifiedGeneratedFiles, ["report.docx"]);
    assert.equal(reportText.includes("The report is ready."), true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runWorkspaceCommandLoopTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-workspace-command-"));
  const workspaceDir = join(projectDir, "workspace-root");

  try {
    await mkdir(join(workspaceDir, "scripts"), { recursive: true });
    await writeFile(join(workspaceDir, "scripts", "verify.js"), 'console.log("verification ok")\n', "utf8");

    const config = {
      projectDir,
      workspace: {
        dir: "./workspace-root",
        resolvedDir: workspaceDir
      },
      cluster: {
        controller: "controller",
        maxParallel: 1
      },
      models: {
        controller: {
          id: "controller",
          label: "Controller",
          model: "gpt-5.4"
        },
        validator: {
          id: "validator",
          label: "Validator",
          model: "gpt-5.4",
          provider: "mock",
          specialties: ["test planning", "code review"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Validate the generated script",
            strategy: "Run a workspace command and report the verification result.",
            tasks: [
              {
                id: "validate_script",
                phase: "validation",
                title: "Validate script",
                assignedWorker: "validator",
                instructions: "Run the verification script inside the workspace and report whether it passes.",
                dependsOn: []
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "Validation completed.",
            executiveSummary: ["Validation passed."],
            consensus: ["Workspace command execution is working."],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      [
        "validator",
        new FakeProvider([
          JSON.stringify({
            action: "run_command",
            command: "node",
            args: ["scripts/verify.js"],
            cwd: ".",
            reason: "Verify the workspace artifact."
          }),
          JSON.stringify({
            action: "final",
            summary: "Verification succeeded.",
            keyFindings: ["The script executed and printed the expected output."],
            risks: [],
            deliverables: ["verification log"],
            confidence: "high",
            followUps: [],
            verificationStatus: "passed"
          })
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Validate the workspace script.",
      config,
      providerRegistry
    });

    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].output.verificationStatus, "passed");
    assert.deepEqual(result.executions[0].output.executedCommands, ["node scripts/verify.js"]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runResearchConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };

  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 6
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      research_a: {
        id: "research_a",
        label: "Research A",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research"]
      },
      research_b: {
        id: "research_b",
        label: "Research B",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research"]
      },
      research_c: {
        id: "research_c",
        label: "Research C",
        model: "gpt-5.4",
        provider: "mock",
        baseUrl: "https://shared-gateway.example/v1",
        webSearch: true,
        specialties: ["web research"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect verified cases",
          strategy: "Run three research batches, then synthesize.",
          tasks: [
            {
              id: "research_a_batch",
              phase: "research",
              title: "Research batch A",
              assignedWorker: "research_a",
              instructions: "Collect a small verified case batch.",
              dependsOn: []
            },
            {
              id: "research_b_batch",
              phase: "research",
              title: "Research batch B",
              assignedWorker: "research_b",
              instructions: "Collect a small verified case batch.",
              dependsOn: []
            },
            {
              id: "research_c_batch",
              phase: "research",
              title: "Research batch C",
              assignedWorker: "research_c",
              instructions: "Collect a small verified case batch.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Research completed.",
          executiveSummary: ["All research batches completed."],
          consensus: ["Gateway throttling was respected."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_a",
      new DelayedJsonProvider(
        {
          summary: "Batch A done.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "research_b",
      new DelayedJsonProvider(
        {
          summary: "Batch B done.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "research_c",
      new DelayedJsonProvider(
        {
          summary: "Batch C done.",
          keyFindings: ["C"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Collect verified public cases.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 3);
  assert.equal(concurrency.max, 3);
}

async function runCustomPhaseConcurrencyTests() {
  const concurrency = {
    current: 0,
    max: 0
  };

  const config = {
    cluster: {
      controller: "controller",
      maxParallel: 4,
      phaseParallel: {
        implementation: 1
      }
    },
    models: {
      controller: {
        id: "controller",
        label: "Controller",
        model: "gpt-5.4",
        provider: "mock"
      },
      coder_a: {
        id: "coder_a",
        label: "Coder A",
        model: "implementation-worker-a",
        provider: "mock",
        specialties: ["coding"]
      },
      coder_b: {
        id: "coder_b",
        label: "Coder B",
        model: "implementation-worker-b",
        provider: "mock",
        specialties: ["coding"]
      },
      coder_c: {
        id: "coder_c",
        label: "Coder C",
        model: "implementation-worker-c",
        provider: "mock",
        specialties: ["coding"]
      }
    }
  };

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Implement three changes",
          strategy: "Run implementation tasks.",
          tasks: [
            {
              id: "impl_a",
              phase: "implementation",
              title: "Implement A",
              assignedWorker: "coder_a",
              instructions: "Implement item A.",
              dependsOn: []
            },
            {
              id: "impl_b",
              phase: "implementation",
              title: "Implement B",
              assignedWorker: "coder_b",
              instructions: "Implement item B.",
              dependsOn: []
            },
            {
              id: "impl_c",
              phase: "implementation",
              title: "Implement C",
              assignedWorker: "coder_c",
              instructions: "Implement item C.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Implementation completed.",
          executiveSummary: ["All implementation tasks completed."],
          consensus: ["Custom phase concurrency was enforced."],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "coder_a",
      new DelayedJsonProvider(
        {
          summary: "A done.",
          keyFindings: ["A"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "coder_b",
      new DelayedJsonProvider(
        {
          summary: "B done.",
          keyFindings: ["B"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ],
    [
      "coder_c",
      new DelayedJsonProvider(
        {
          summary: "C done.",
          keyFindings: ["C"],
          risks: [],
          deliverables: [],
          confidence: "medium",
          followUps: []
        },
        40,
        concurrency
      )
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Implement three independent changes.",
    config,
    providerRegistry
  });

  assert.equal(result.executions.length, 3);
  assert.equal(concurrency.max, 1);
}

async function runWorkspaceServerRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-workspace-server-"));
  const workspaceDir = join(projectDir, "route-workspace");
  await writeFile(
    join(projectDir, "cluster.config.json"),
    `${JSON.stringify(
      {
        server: { port: 4040 },
        cluster: { controller: "controller", maxParallel: 1 },
        workspace: { dir: "./workspace" },
        models: {
          controller: {
            provider: "openai-responses",
            model: "gpt-5.4",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            label: "Controller"
          },
          worker: {
            provider: "openai-chat",
            model: "gpt-4.1-mini",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            label: "Worker"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const server = createAppServer({
    projectDir,
    staticAssetLoader: async (assetPath) => {
      if (assetPath === "index.html") {
        return "<!doctype html><html><body>ok</body></html>";
      }
      return "";
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    let response = await fetch(
      `http://127.0.0.1:${port}/api/workspace?workspaceDir=${encodeURIComponent(workspaceDir)}`
    );
    let payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.workspace.resolvedDir, workspaceDir);

    response = await fetch(`http://127.0.0.1:${port}/api/workspace/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        workspaceDir,
        files: [
          {
            path: "docs/note.txt",
            contentBase64: Buffer.from("hello workspace", "utf8").toString("base64")
          }
        ]
      })
    });
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.written.length, 1);
    assert.equal(payload.written[0].path, "docs/note.txt");

    response = await fetch(
      `http://127.0.0.1:${port}/api/workspace/file?workspaceDir=${encodeURIComponent(workspaceDir)}&path=${encodeURIComponent("docs/note.txt")}`
    );
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.file.path, "docs/note.txt");
    assert.equal(payload.file.content, "hello workspace");

    response = await fetch(`http://127.0.0.1:${port}/api/bot/presets`);
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(Array.isArray(payload.presets), true);
    assert.equal(payload.presets.some((preset) => preset.id === "feishu"), true);
    assert.equal(
      payload.presets.some(
        (preset) =>
          preset.id === "feishu" &&
          Array.isArray(preset.fields) &&
          preset.fields.some((field) => field.envName === "FEISHU_APP_SECRET" && field.type === "password")
      ),
      true
    );

    response = await fetch(`http://127.0.0.1:${port}/api/bot/runtime`);
    payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.runtime.installDir, "string");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runStaticAssetRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-static-assets-"));
  const requestedAssets = [];

  try {
    const server = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) => {
        requestedAssets.push(assetPath);
        return `asset:${assetPath}`;
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      let response = await fetch(`http://127.0.0.1:${port}/assets/agent-graph-layout.js`);
      let body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body, "asset:agent-graph-layout.js");

      response = await fetch(`http://127.0.0.1:${port}/assets/nested/panel.js`);
      body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(body, "asset:nested/panel.js");

      response = await fetch(`http://127.0.0.1:${port}/assets/%2e%2e/package.json`);
      const payload = await response.json();
      assert.equal(response.status, 404);
      assert.equal(payload.ok, false);

      assert.deepEqual(requestedAssets, ["agent-graph-layout.js", "nested/panel.js"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runHttpRetryTests() {
  let attempts = 0;
  const retryEvents = [];
  const server = createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>aixj.vip | 502: Bad gateway</title></head><body>bad gateway</body></html>");
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, attempts }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    const result = await postJson(
      `http://127.0.0.1:${port}/responses`,
      { hello: "world" },
      {
        id: "retry_model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_API_KEY",
        authStyle: "bearer",
        retryAttempts: 2,
        retryBaseMs: 10,
        retryMaxMs: 20
      },
      {
        onRetry(event) {
          retryEvents.push(event);
        }
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].maxRetries, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpHtmlGatewaySummaryTests() {
  const server = createServer((request, response) => {
    response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>aixj.vip | 502: Bad gateway</title></head><body>bad gateway</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "html_gateway_model",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /upstream gateway returned 502/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpHtmlNonApiSummaryTests() {
  const server = createServer((request, response) => {
    response.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Just a moment...</title></head><body>challenge</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "html_non_api_model",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /returned an HTML page instead of API JSON/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpHtml200SummaryTests() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Gateway Home</title></head><body>home</body></html>");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "html_200_model",
            baseUrl: `http://127.0.0.1:${port}`,
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /returned an HTML page instead of API JSON/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runMoonshotResponsesHintTests() {
  const server = createServer((request, response) => {
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ message: "没找到对象" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    await assert.rejects(
      () =>
        postJson(
          `http://127.0.0.1:${port}/responses`,
          { hello: "world" },
          {
            id: "moonshot_responses_model",
            baseUrl: "https://api.moonshot.cn/v1",
            apiKeyEnv: "TEST_API_KEY",
            authStyle: "bearer",
            retryAttempts: 0
          }
        ),
      /provider 改成 "openai-chat"/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpNetworkRetryTests() {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, attempts }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    const result = await postJson(
      `http://127.0.0.1:${port}/responses`,
      { hello: "world" },
      {
        id: "network_retry_model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_API_KEY",
        authStyle: "bearer",
        retryAttempts: 1,
        retryBaseMs: 10,
        retryMaxMs: 20
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runHttpAbortTests() {
  const server = createServer(async (request, response) => {
    await waitForDelay(1000);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_API_KEY = "retry-key";
    const controller = new AbortController();
    const promise = postJson(
      `http://127.0.0.1:${port}/responses`,
      { hello: "world" },
      {
        id: "abort_model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_API_KEY",
        authStyle: "bearer",
        retryAttempts: 2,
        retryBaseMs: 10,
        retryMaxMs: 20
      },
      {
        signal: controller.signal
      }
    );

    setTimeout(() => controller.abort(new Error("Cancelled in test.")), 30);

    await assert.rejects(promise, /Cancelled in test/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityTestTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(raw);
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                attempt === 1
                  ? `OK:${parsed.model}`
                  : JSON.stringify({
                      status: "ok",
                      usedWebSearch: false,
                      checks: [`structured:${parsed.model}`],
                      note: "workflow probe ok"
                    })
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "worker_test",
        label: "Worker Test",
        provider: "openai-chat",
        model: "kimi-test",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.model.id, "worker_test");
    assert.equal(result.reply.startsWith("OK:kimi-test"), true);
    assert.equal(result.summary.includes("workflow probe passed"), true);
    assert.deepEqual(result.diagnostics.workflowProbe.checks, ["structured:kimi-test"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityThinkingTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `OK:${raw.model}`
              }
            }
          ]
        })
      );
      return;
    }

    if (attempt === 2) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "ok",
                  usedWebSearch: false,
                  checks: [`structured:${raw.model}`],
                  note: "workflow probe ok"
                })
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "THINKING_OK",
              reasoning_content: "Verified with an internal reasoning trace."
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "kimi_thinking_test",
        label: "Kimi Thinking Test",
        provider: "kimi-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer",
        thinkingEnabled: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, false);
    assert.equal(result.diagnostics.thinking.enabled, true);
    assert.equal(result.diagnostics.thinking.verified, true);
    assert.match(result.summary, /thinking mode/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runResponsesProviderCompatibilityTests() {
  let capturedBody = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        output_text: "OK"
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_RESPONSES_KEY = "responses-key";
    const provider = new OpenAIResponsesProvider({
      id: "responses_worker",
      provider: "openai-responses",
      model: "gpt-5.3-codex",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_RESPONSES_KEY",
      authStyle: "bearer",
      thinkingEnabled: true,
      reasoning: { effort: "high" },
      webSearch: true,
      maxOutputTokens: 32,
      retryAttempts: 0
    });

    const result = await provider.invoke({
      instructions: "Reply with exactly OK.",
      input: "Connectivity test.",
      purpose: "compatibility_test"
    });

    assert.equal(result.text, "OK");
    assert.deepEqual(capturedBody.input, [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "Reply with exactly OK."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Connectivity test."
          }
        ]
      }
    ]);
    assert.deepEqual(capturedBody.tools, [{ type: "web_search" }]);
    assert.deepEqual(capturedBody.reasoning, { effort: "high" });
    assert.equal("metadata" in capturedBody, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runOpenAIChatWebSearchProviderCompatibilityTests() {
  const capturedBodies = [];
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    capturedBodies.push(parsed);
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_web_1",
                    type: "function",
                    function: {
                      name: "$web_search",
                      arguments: '{"query":"Moonshot Kimi web search compatibility"}'
                    }
                  }
                ]
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                status: "ok",
                usedWebSearch: true,
                checks: ["structured:kimi-k2.5", "web-search:kimi-k2.5"],
                note: "workflow probe ok"
              })
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_KIMI_CHAT_KEY = "kimi-chat-key";
    const provider = new OpenAIChatProvider({
      id: "kimi_chat_worker",
      provider: "kimi-chat",
      model: "kimi-k2.5",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_KIMI_CHAT_KEY",
      authStyle: "bearer",
      thinkingEnabled: true,
      webSearch: true,
      maxOutputTokens: 96,
      retryAttempts: 0
    });

    const result = await provider.invoke({
      instructions: "Use web search once, then return JSON only.",
      input: "Verify Kimi web search wiring.",
      purpose: "compatibility_test"
    });

    assert.equal(result.text.includes('"usedWebSearch":true'), true);
    assert.deepEqual(capturedBodies[0].tools, [
      {
        type: "builtin_function",
        function: {
          name: "$web_search"
        }
      }
    ]);
    assert.deepEqual(capturedBodies[0].thinking, { type: "disabled" });
    assert.equal(
      capturedBodies[1].messages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "call_web_1" &&
          message.name === "$web_search"
      ),
      true
    );
  } finally {
    delete process.env.TEST_KIMI_CHAT_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runAnthropicThinkingProviderCompatibilityTests() {
  let capturedBody = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        id: "msg_thinking_test",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Short internal reasoning summary."
          },
          {
            type: "text",
            text: "THINKING_OK"
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    process.env.TEST_ANTHROPIC_THINKING_KEY = "anthropic-thinking-key";
    const provider = new AnthropicMessagesProvider({
      id: "claude_thinking_worker",
      provider: "claude-chat",
      model: "claude-sonnet-4-5",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_ANTHROPIC_THINKING_KEY",
      authStyle: "api-key",
      apiKeyHeader: "x-api-key",
      thinkingEnabled: true,
      reasoning: { effort: "high" },
      retryAttempts: 0
    });

    const result = await provider.invoke({
      instructions: "Think first, then reply with THINKING_OK.",
      input: "Compatibility probe.",
      purpose: "compatibility_test"
    });

    assert.equal(result.text, "THINKING_OK");
    assert.deepEqual(capturedBody.thinking, {
      type: "enabled",
      budget_tokens: 3072
    });
    assert.equal(capturedBody.max_tokens >= 3584, true);
  } finally {
    delete process.env.TEST_ANTHROPIC_THINKING_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runClusterCancelRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-cluster-cancel-"));
  const modelServer = createServer(async (request, response) => {
    await waitForDelay(1000);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          objective: "Delayed plan",
          strategy: "This should be cancelled first.",
          tasks: []
        })
      })
    );
  });

  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = modelServer.address().port;

  try {
    process.env.TEST_CANCEL_KEY = "cancel-key";
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 1 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_CANCEL_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-responses",
              model: "gpt-5.4-mini",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_CANCEL_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const appServer = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) =>
        assetPath === "index.html" ? "<!doctype html><html><body>ok</body></html>" : ""
    });
    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    const appPort = appServer.address().port;

    try {
      const operationId = "cluster_cancel_route_test";
      const runPromise = fetch(`http://127.0.0.1:${appPort}/api/cluster/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task: "Cancel this run before planning finishes.",
          operationId
        })
      }).then((response) => response.json());

      await waitForDelay(80);

      const cancelResponse = await fetch(
        `http://127.0.0.1:${appPort}/api/operations/${operationId}/cancel`,
        {
          method: "POST"
        }
      );
      const cancelPayload = await cancelResponse.json();
      const runPayload = await runPromise;

      assert.equal(cancelPayload.ok, true);
      assert.equal(cancelPayload.cancellationRequested, true);
      assert.equal(runPayload.ok, false);
      assert.equal(runPayload.cancelled, true);
    } finally {
      await new Promise((resolve) => appServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runClusterRouteLogPersistenceTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-cluster-log-route-"));
  const workspaceDir = join(projectDir, "workspace");
  let requestCount = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    requestCount += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (requestCount === 1) {
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            objective: "Create a note",
            strategy: "Use one worker to write the note, then synthesize the result.",
            tasks: [
              {
                id: "task_1",
                phase: "implementation",
                title: "Write note",
                assignedWorker: "worker",
                instructions: "Create notes/hello.txt in the workspace.",
                expectedOutput: "A concrete notes/hello.txt artifact.",
                dependsOn: []
              }
            ]
          })
        })
      );
      return;
    }

    if (requestCount === 2) {
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            action: "write_files",
            reason: "Create the requested note.",
            files: [
              {
                path: "notes/hello.txt",
                content: "hello from route log test\n"
              }
            ]
          })
        })
      );
      return;
    }

    if (requestCount === 3) {
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            action: "final",
            summary: "The note was written.",
            keyFindings: ["notes/hello.txt now exists in the workspace."],
            risks: [],
            deliverables: ["notes/hello.txt"],
            generatedFiles: ["notes/hello.txt"],
            confidence: "high",
            followUps: [],
            verificationStatus: "passed"
          })
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          finalAnswer: "Route log persistence completed.",
          executiveSummary: ["The run finished and its log was persisted automatically."],
          consensus: ["Automatic task logging works for cluster runs."],
          disagreements: [],
          nextActions: []
        })
      })
    );
  });

  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const modelPort = modelServer.address().port;

  try {
    process.env.TEST_ROUTE_LOG_KEY = "route-log-key";
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 1 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_ROUTE_LOG_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-responses",
              model: "gpt-5.4-mini",
              baseUrl: `http://127.0.0.1:${modelPort}`,
              apiKeyEnv: "TEST_ROUTE_LOG_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const appServer = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) =>
        assetPath === "index.html" ? "<!doctype html><html><body>ok</body></html>" : ""
    });
    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    const appPort = appServer.address().port;

    try {
      const operationId = "cluster_route_log_test";
      const response = await fetch(`http://127.0.0.1:${appPort}/api/cluster/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          task: "Create a note and persist the run log.",
          operationId
        })
      });
      const payload = await response.json();
      const logJsonPath = join(projectDir, "task-logs", `${operationId}.json`);
      const logTextPath = join(projectDir, "task-logs", `${operationId}.log`);
      const logJson = JSON.parse(await readFile(logJsonPath, "utf8"));
      const logText = await readFile(logTextPath, "utf8");
      const noteText = await readFile(join(workspaceDir, "notes", "hello.txt"), "utf8");

      assert.equal(payload.ok, true);
      assert.equal(payload.log.textPath, `task-logs/${operationId}.log`);
      assert.equal(logJson.status, "completed");
      assert.equal(logJson.operationId, operationId);
      assert.match(logText, /Agent Cluster Task Log/);
      assert.match(logText, /cluster_done/);
      assert.match(logText, /Create a note and persist the run log/);
      assert.equal(noteText, "hello from route log test\n");
    } finally {
      await new Promise((resolve) => appServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function runSystemExitRouteTests() {
  const projectDir = await mkdtemp(join(process.cwd(), ".tmp-system-exit-"));
  let exitCode = null;

  try {
    await writeFile(
      join(projectDir, "cluster.config.json"),
      `${JSON.stringify(
        {
          server: { port: 4040 },
          cluster: { controller: "controller", maxParallel: 1 },
          workspace: { dir: "./workspace" },
          models: {
            controller: {
              provider: "openai-responses",
              model: "gpt-5.4",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Controller"
            },
            worker: {
              provider: "openai-chat",
              model: "gpt-4.1-mini",
              baseUrl: "https://api.openai.com/v1",
              apiKeyEnv: "OPENAI_API_KEY",
              label: "Worker"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const appServer = createAppServer({
      projectDir,
      staticAssetLoader: async (assetPath) =>
        assetPath === "index.html" ? "<!doctype html><html><body>ok</body></html>" : "",
      exitProcess(code) {
        exitCode = code;
      }
    });

    await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
    const appPort = appServer.address().port;

    const response = await fetch(`http://127.0.0.1:${appPort}/api/system/exit`, {
      method: "POST"
    });
    const payload = await response.json();

    assert.equal(payload.ok, true);
    assert.equal(payload.shuttingDown, true);

    await waitForDelay(250);
    assert.equal(exitCode, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

function runAccessPolicyTests() {
  assert.doesNotThrow(() =>
    createProviderForModel({
      id: "kimi_code_allowed",
      provider: "openai-chat",
      model: "kimi-for-coding",
      baseUrl: "https://api.kimi.com/coding/v1"
    })
  );
}

function runProviderCatalogSupportTests() {
  const claudeProvider = createProviderForModel({
    id: "claude_worker",
    provider: "claude-chat",
    model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com/v1"
  });
  const kimiCodingProvider = createProviderForModel({
    id: "kimi_coding_worker",
    provider: "kimi-coding",
    model: "k2p5",
    baseUrl: "https://api.moonshot.cn/anthropic"
  });

  assert.equal(claudeProvider instanceof AnthropicMessagesProvider, true);
  assert.equal(kimiCodingProvider instanceof AnthropicMessagesProvider, true);
  assert.equal(providerSupportsCapability("openai-responses", "thinking"), true);
  assert.equal(providerSupportsCapability("claude-chat", "thinking"), true);
  assert.equal(providerSupportsCapability("kimi-chat", "thinking"), true);
  assert.equal(providerSupportsCapability("kimi-coding", "thinking"), true);
  assert.equal(providerSupportsCapability("kimi-chat", "webSearch"), true);
  assert.equal(providerSupportsCapability("kimi-coding", "webSearch"), true);
  assert.equal(
    getProviderDefinition("kimi-coding")?.defaultBaseUrl,
    "https://api.moonshot.cn/anthropic"
  );
}

function runAgentGraphLayoutTests() {
  const controller = {
    id: "controller",
    kind: "controller",
    label: "Controller",
    status: "delegating"
  };
  const leader = {
    id: "leader:research_leader",
    kind: "leader",
    label: "Research Leader",
    phase: "research",
    status: "running"
  };
  const subordinate = {
    id: "leader:research_leader::batch_a:01",
    kind: "subordinate",
    label: "Research Subordinate 01",
    parentId: leader.id,
    phase: "research",
    status: "running"
  };
  const nestedSubordinate = {
    id: "leader:research_leader::batch_a:01::fact_check:01",
    kind: "subordinate",
    label: "Research Subordinate 02",
    parentId: subordinate.id,
    phase: "research",
    status: "spawning"
  };

  const layout = buildAgentLayout([controller, leader, subordinate, nestedSubordinate], {
    controllerId: controller.id
  });
  const nodeIds = new Set(layout.nodes.map((node) => node.agent.id));
  const edgeIds = new Set(layout.edges.map((edge) => `${edge.from}->${edge.to}`));
  const group = layout.groups.find((entry) => entry.leader.id === leader.id);

  assert.equal(nodeIds.has(subordinate.id), true);
  assert.equal(nodeIds.has(nestedSubordinate.id), true);
  assert.equal(edgeIds.has(`${leader.id}->${subordinate.id}`), true);
  assert.equal(edgeIds.has(`${subordinate.id}->${nestedSubordinate.id}`), true);
  assert.equal(Boolean(group), true);
  assert.equal(group.subordinates.some((agent) => agent.id === nestedSubordinate.id), true);

  const inferredParentId = resolveAgentGraphParentId(
    {
      agentId: nestedSubordinate.id,
      modelId: "research_leader"
    },
    "subordinate"
  );
  assert.equal(inferredParentId, subordinate.id);

  const retainedParentId = resolveAgentGraphParentId(
    {
      modelId: "research_leader"
    },
    "subordinate",
    { parentId: subordinate.id }
  );
  assert.equal(retainedParentId, subordinate.id);

  const activity = summarizeAgentActivity([controller, leader, subordinate, nestedSubordinate]);
  assert.deepEqual(activity, {
    totalCount: 4,
    activeCount: 4
  });

  const settledActivity = summarizeAgentActivity([
    controller,
    { ...leader, status: "done" },
    { ...subordinate, status: "done" },
    { ...nestedSubordinate, status: "failed" }
  ]);
  assert.deepEqual(settledActivity, {
    totalCount: 4,
    activeCount: 1
  });
}

async function runAnthropicConnectivityWebSearchTests() {
  const capturedBodies = [];
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          id: "msg_test_1",
          type: "message",
          role: "assistant",
          content: []
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        id: "msg_test_2",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              usedWebSearch: true,
              checks: ["anthropic-structured:kimi-k2.5", "web-search:kimi-k2.5"],
              note: "workflow probe ok"
            })
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "KIMI_CODING_KEY", value: "kimi-coding-secret" }],
      model: {
        id: "kimi_coding_test",
        label: "Kimi Coding Test",
        provider: "kimi-coding",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "KIMI_CODING_KEY",
        authStyle: "api-key",
        apiKeyHeader: "x-api-key",
        webSearch: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.reply.startsWith("[empty text response;"), true);
    assert.equal(result.degraded, false);
    assert.equal(result.diagnostics.workflowProbe.usedWebSearch, true);
    assert.equal(result.diagnostics.webSearch.verified, true);
    assert.deepEqual(result.diagnostics.workflowProbe.checks, [
      "anthropic-structured:kimi-k2.5",
      "web-search:kimi-k2.5"
    ]);
    assert.deepEqual(capturedBodies[0].tools, [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3
      }
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityWebSearchProbeDegradedTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `OK:${raw.model}`
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "ok",
                usedWebSearch: false,
                checks: [`structured:${raw.model}`],
                note: "workflow probe could not confirm search"
              })
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "kimi_chat_search_probe_test",
        label: "Kimi Chat Search Probe Test",
        provider: "kimi-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer",
        webSearch: true
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(result.diagnostics.webSearch.enabled, true);
    assert.equal(result.diagnostics.webSearch.used, false);
    assert.match(result.summary, /did not confirm that web search executed successfully/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runConnectivityWorkflowDegradedTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    attempt += 1;
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });

    if (attempt === 1) {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `OK:${raw.model}`
              }
            }
          ]
        })
      );
      return;
    }

    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: []
            }
          }
        ]
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await testModelConnectivity({
      secrets: [{ name: "TEST_GATEWAY_KEY", value: "secret-value" }],
      model: {
        id: "kimi_like_chat_test",
        label: "Kimi-like Chat Test",
        provider: "openai-chat",
        model: "kimi-k2.5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "TEST_GATEWAY_KEY",
        authStyle: "bearer"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(result.reply.startsWith("OK:kimi-k2.5"), true);
    assert.equal(result.summary.includes("downgraded"), true);
    assert.equal(result.diagnostics.workflowProbe.mode, "degraded");
    assert.deepEqual(result.diagnostics.workflowProbe.checks, ["basic:kimi-k2.5"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  runJsonTests();
  runAccessPolicyTests();
  runProviderCatalogSupportTests();
  runAgentGraphLayoutTests();
  runSessionRuntimeTests();
  runSessionCircuitBreakerTests();
  await runOrchestratorTests();
  await runCodingManagerWorkflowTests();
  await runHierarchicalDelegationTests();
  await runHierarchicalDelegationConcurrencyTests();
  await runGlobalExecutionGateTests();
  await runConfigurableHierarchicalDelegationTests();
  await runDeepHierarchicalDelegationTests();
  await runUnlimitedSubordinateConcurrencyTests();
  await runUnlimitedClusterConcurrencyTests();
  await runImplicitDelegateCountInferenceTests();
  await runExplicitZeroDelegateRecoveryTests();
  await runZeroDelegateLeaderExecutionTests();
  await runWorkspaceToolLayerMemoryTests();
  await runSettingsTests();
  await runLegacyDistSettingsFallbackTests();
  await runBlankClusterSettingFallbackTests();
  await runSchemeSettingsTests();
  await runWorkspaceToolLoopTests();
  await runWorkspaceJsonRepairTests();
  await runArtifactVerificationGuardTests();
  await runWorkspaceCommandLoopTests();
  await runResearchConcurrencyTests();
  await runCustomPhaseConcurrencyTests();
  await runWorkspaceServerRouteTests();
  await runStaticAssetRouteTests();
  await runHttpRetryTests();
  await runHttpHtmlGatewaySummaryTests();
  await runHttpHtmlNonApiSummaryTests();
  await runHttpHtml200SummaryTests();
  await runMoonshotResponsesHintTests();
  await runHttpNetworkRetryTests();
  await runHttpAbortTests();
  await runConnectivityTestTests();
  await runConnectivityThinkingTests();
  await runAnthropicConnectivityWebSearchTests();
  await runConnectivityWebSearchProbeDegradedTests();
  await runConnectivityWorkflowDegradedTests();
  await runResponsesProviderCompatibilityTests();
  await runOpenAIChatWebSearchProviderCompatibilityTests();
  await runAnthropicThinkingProviderCompatibilityTests();
  await runClusterRouteLogPersistenceTests();
  await runClusterCancelRouteTests();
  await runSystemExitRouteTests();
  console.log("All smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

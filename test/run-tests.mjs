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
import { postJson } from "../src/providers/http-client.mjs";
import { testModelConnectivity } from "../src/providers/connectivity-test.mjs";
import { createProviderForModel } from "../src/providers/factory.mjs";
import { AnthropicMessagesProvider } from "../src/providers/anthropic-messages.mjs";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.mjs";
import { providerSupportsCapability } from "../src/static/provider-catalog.js";
import {
  buildAgentLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "../src/static/agent-graph-layout.js";

class FakeProvider {
  constructor(queue) {
    this.queue = [...queue];
  }

  async invoke(options = {}) {
    if (!this.queue.length) {
      throw new Error("No more fake responses available.");
    }
    const next = this.queue.shift();
    if (typeof next === "function") {
      return next(options);
    }
    return { text: next };
  }
}

function waitForDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      const error = new Error("aborted");
      error.name = "AbortError";
      error.cancelled = true;
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class DelayedJsonProvider {
  constructor(payload, delayMs, tracker = null) {
    this.payload = payload;
    this.delayMs = delayMs;
    this.tracker = tracker;
  }

  async invoke({ signal } = {}) {
    if (this.tracker) {
      this.tracker.current += 1;
      this.tracker.max = Math.max(this.tracker.max, this.tracker.current);
    }

    try {
      await waitForDelay(this.delayMs, signal);
      return {
        text: JSON.stringify(this.payload)
      };
    } finally {
      if (this.tracker) {
        this.tracker.current -= 1;
      }
    }
  }
}

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
    assert.equal(runtime.cluster.subordinateMaxParallel, 4);
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

    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].output.verificationStatus, "failed");
    assert.deepEqual(result.executions[0].output.verifiedGeneratedFiles, []);
    assert.equal(
      result.executions[0].output.risks.includes(
        "Task expected a concrete file artifact, but no generated file was verified in the workspace."
      ),
      true
    );
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
  assert.equal(concurrency.max, 1);
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
    assert.equal("metadata" in capturedBody, false);
  } finally {
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
    baseUrl: "https://api.moonshot.cn/v1"
  });

  assert.equal(claudeProvider instanceof AnthropicMessagesProvider, true);
  assert.equal(kimiCodingProvider instanceof AnthropicMessagesProvider, true);
  assert.equal(providerSupportsCapability("kimi-chat", "webSearch"), true);
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

async function runConnectivityEmptyTextTests() {
  let attempt = 0;
  const server = createServer(async (request, response) => {
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
              usedWebSearch: false,
              checks: ["anthropic-structured:k2p5"],
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
        model: "k2p5",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "KIMI_CODING_KEY",
        authStyle: "api-key",
        apiKeyHeader: "x-api-key"
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.reply.startsWith("[empty text response;"), true);
    assert.deepEqual(result.diagnostics.workflowProbe.checks, ["anthropic-structured:k2p5"]);
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
  await runSettingsTests();
  await runBlankClusterSettingFallbackTests();
  await runSchemeSettingsTests();
  await runWorkspaceToolLoopTests();
  await runWorkspaceJsonRepairTests();
  await runArtifactVerificationGuardTests();
  await runWorkspaceCommandLoopTests();
  await runResearchConcurrencyTests();
  await runCustomPhaseConcurrencyTests();
  await runWorkspaceServerRouteTests();
  await runHttpRetryTests();
  await runHttpHtmlGatewaySummaryTests();
  await runHttpHtmlNonApiSummaryTests();
  await runHttpHtml200SummaryTests();
  await runMoonshotResponsesHintTests();
  await runHttpNetworkRetryTests();
  await runHttpAbortTests();
  await runConnectivityTestTests();
  await runConnectivityEmptyTextTests();
  await runConnectivityWorkflowDegradedTests();
  await runResponsesProviderCompatibilityTests();
  await runClusterCancelRouteTests();
  await runSystemExitRouteTests();
  console.log("All smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

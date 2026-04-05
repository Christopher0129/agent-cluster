import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runClusterAnalysis } from "../src/cluster/orchestrator.mjs";
import { readDocumentText } from "../src/workspace/document-reader.mjs";
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

function parseAssignedSubtaskFromPrompt(input) {
  const source = Array.isArray(input) ? input.join("\n\n") : String(input || "");
  const match = source.match(/Assigned subtask:\n([\s\S]*?)\n\nTask execution policy:/);
  return match ? JSON.parse(match[1]) : null;
}

class DependentWorkspaceLeaderProvider {
  constructor() {
    this.turns = new Map();
  }

  async invoke({ input, purpose, signal } = {}) {
    if (purpose === "leader_delegation") {
      return {
        text: JSON.stringify({
          thinkingSummary: "First create the shared research JSON, then turn it into the requested report.",
          delegationSummary: "Child 2 depends on the JSON created by child 1.",
          subtasks: [
            {
              id: "research_json",
              title: "Write the structured research JSON",
              instructions:
                "Create `research/source.json` in the workspace with the structured report source content.",
              expectedOutput: "A written `research/source.json` workspace artifact."
            },
            {
              id: "report_docx",
              title: "Build the final report docx",
              instructions:
                "Read `research/source.json` and use it to generate `reports/report.docx` in the workspace.",
              expectedOutput: "A verified `reports/report.docx` workspace artifact."
            }
          ]
        })
      };
    }

    if (purpose === "leader_synthesis") {
      return {
        text: buildLeaderSynthesis("Leader merged the dependency-ordered child outputs.")
      };
    }

    const assignedSubtask = parseAssignedSubtaskFromPrompt(input);
    const taskId = assignedSubtask?.id || "";
    const turn = this.turns.get(taskId) || 0;
    this.turns.set(taskId, turn + 1);

    if (taskId.endsWith("__research_json")) {
      if (turn === 0) {
        await waitForDelay(50, signal);
        return {
          text: JSON.stringify({
            action: "write_files",
            reason: "Write the upstream research JSON before the downstream report step starts.",
            files: [
              {
                path: "research/source.json",
                content: JSON.stringify(
                  {
                    title: "International situation and China trade cooperation",
                    sections: ["Macro overview", "China outlook", "Trade cooperation"]
                  },
                  null,
                  2
                )
              }
            ]
          })
        };
      }

      return {
        text: JSON.stringify({
          action: "final",
          summary: "Research JSON written.",
          keyFindings: ["The structured source JSON is ready for the downstream report builder."],
          risks: [],
          deliverables: ["research/source.json"],
          confidence: "high",
          followUps: [],
          generatedFiles: ["research/source.json"],
          verificationStatus: "passed"
        })
      };
    }

    if (taskId.endsWith("__report_docx")) {
      if (turn === 0) {
        return {
          text: JSON.stringify({
            action: "read_files",
            reason: "Load the research JSON before generating the requested report.",
            paths: ["research/source.json"]
          })
        };
      }

      if (turn === 1) {
        assert.match(String(input), /research\/source\.json/i);
        assert.match(String(input), /International situation and China trade cooperation/i);
        return {
          text: JSON.stringify({
            action: "write_files",
            reason: "Write the final report after reading the upstream JSON.",
            files: [
              {
                path: "reports/report.docx",
                content:
                  "International situation and China trade cooperation analysis\n\nMacro overview\nChina outlook\nTrade cooperation\n"
              }
            ]
          })
        };
      }

      return {
        text: JSON.stringify({
          action: "final",
          summary: "Report docx written from the upstream JSON.",
          keyFindings: ["The report builder consumed the JSON produced by the sibling child task."],
          risks: [],
          deliverables: ["reports/report.docx"],
          confidence: "high",
          followUps: [],
          generatedFiles: ["reports/report.docx"],
          verificationStatus: "passed"
        })
      };
    }

    throw new Error(`Unexpected provider call for purpose=${purpose} taskId=${taskId}`);
  }
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
    result.multiAgentSession.messages.some((message) => /I'm taking|Finished "Research one focused question"/i.test(message.content)),
    true
  );
});

test("runClusterAnalysis localizes multi-agent session messages when outputLocale is zh-CN", async () => {
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
          finalAnswer: "协作会话已完成。",
          executiveSummary: ["一个工作模型完成了任务。"],
          consensus: ["会话快照应该可用。"],
          disagreements: [],
          nextActions: []
        })
      ])
    ],
    [
      "research_worker",
      new FakeProvider([
        buildWorkerOutput("研究任务已完成。")
      ])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Inspect the collaboration session",
    config,
    providerRegistry,
    outputLocale: "zh-CN"
  });

  assert.equal(
    result.multiAgentSession.messages.some((message) => /我来处理|已完成/.test(message.content)),
    true
  );
});

test("runClusterAnalysis auto-materializes a requested docx artifact from leader synthesis", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-orchestrator-leader-docx-"));

  try {
    const config = {
      cluster: {
        controller: "controller",
        maxParallel: 2,
        groupLeaderMaxDelegates: 1,
        delegateMaxDepth: 1
      },
      workspace: {
        resolvedDir: workspaceRoot
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
          specialties: ["implementation", "coding"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Deliver the requested report artifact",
            strategy: "Delegate source gathering, then synthesize the final deliverable.",
            tasks: [
              {
                id: "task_1",
                phase: "implementation",
                title: "Generate reports/report.docx",
                assignedWorker: "implementation_leader",
                delegateCount: 1,
                instructions: "Generate `reports/report.docx` in the workspace using the collected report content.",
                dependsOn: [],
                expectedOutput: "A concrete reports/report.docx artifact."
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "The requested report artifact was delivered.",
            executiveSummary: ["Leader synthesis auto-materialized the report into the workspace."],
            consensus: ["Structured child content was enough to build the final document."],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      [
        "implementation_leader",
        new FakeProvider([
          JSON.stringify({
            thinkingSummary: "Collect source material before assembling the final report.",
            delegationSummary: "One child gathers the structured report content.",
            subtasks: [
              {
                id: "source_content",
                title: "Collect report source material",
                instructions: "Provide structured Chinese report content only. Do not write files.",
                expectedOutput: "Structured source content for the final report."
              }
            ]
          }),
          JSON.stringify({
            action: "final",
            summary: "Collected the structured source content for the requested report.",
            keyFindings: [
              "国际局势部分已整理。",
              "中国国情与对外贸易合作分析已整理。"
            ],
            risks: [],
            deliverables: ["报告正文素材"],
            confidence: "high",
            followUps: ["目标文档：reports/report.docx"],
            verificationStatus: "not_applicable"
          }),
          JSON.stringify({
            thinkingSummary: "Merged the child source material into the requested deliverable.",
            summary: "Structured report content is ready for delivery.",
            keyFindings: ["The child produced the report outline and the core findings."],
            risks: [],
            deliverables: ["reports/report.docx"],
            confidence: "high",
            followUps: ["Use the merged content to create reports/report.docx."],
            verificationStatus: "not_applicable"
          })
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Generate reports/report.docx in the workspace.",
      config,
      providerRegistry
    });

    const reportPath = join(workspaceRoot, "reports", "report.docx");
    const reportText = await readDocumentText(reportPath);
    const implementationExecution = result.executions.find((execution) => execution.taskId === "task_1");

    assert.equal(existsSync(reportPath), true);
    assert.equal(reportText.includes("国际局势部分已整理"), true);
    assert.equal(reportText.includes("中国国情与对外贸易合作分析已整理"), true);
    assert.deepEqual(implementationExecution?.output.verifiedGeneratedFiles, ["reports/report.docx"]);
    assert.equal(implementationExecution?.output.workspaceActions.includes("write_docx"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runClusterAnalysis ignores unverified claimed artifacts and still auto-materializes the requested leader docx", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-orchestrator-leader-claimed-docx-"));

  try {
    const config = {
      cluster: {
        controller: "controller",
        maxParallel: 2,
        groupLeaderMaxDelegates: 1,
        delegateMaxDepth: 1
      },
      workspace: {
        resolvedDir: workspaceRoot
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
          specialties: ["implementation", "coding"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Deliver the requested report artifact",
            strategy: "Delegate source gathering, then synthesize the final deliverable.",
            tasks: [
              {
                id: "task_1",
                phase: "implementation",
                title: "Generate reports/report.docx",
                assignedWorker: "implementation_leader",
                delegateCount: 1,
                instructions: "Generate `reports/report.docx` in the workspace using the collected report content.",
                dependsOn: [],
                expectedOutput: "A concrete reports/report.docx artifact."
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "The requested report artifact was delivered.",
            executiveSummary: ["Leader synthesis no longer trusts claimed files that do not exist."],
            consensus: ["The runtime materialized the requested docx after verifying the claim was false."],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      [
        "implementation_leader",
        new FakeProvider([
          JSON.stringify({
            thinkingSummary: "Collect source material before assembling the final report.",
            delegationSummary: "One child gathers the structured report content.",
            subtasks: [
              {
                id: "source_content",
                title: "Collect report source material",
                instructions: "Provide structured Chinese report content only. Do not write files.",
                expectedOutput: "Structured source content for the final report."
              }
            ]
          }),
          JSON.stringify({
            action: "final",
            summary: "Collected the structured source content for the requested report.",
            keyFindings: [
              "国际局势部分已整理。",
              "中国国情与对外贸易合作分析已整理。"
            ],
            risks: [],
            deliverables: ["报告正文素材"],
            confidence: "high",
            followUps: ["目标文档：reports/report.docx"],
            verificationStatus: "not_applicable"
          }),
          JSON.stringify({
            thinkingSummary: "Merged the child source material into the requested deliverable.",
            summary: "Structured report content is ready for delivery.",
            keyFindings: [
              "国际局势部分已整理。",
              "中国国情与对外贸易合作分析已整理。"
            ],
            risks: [],
            deliverables: ["reports/report.docx"],
            generatedFiles: [
              "reports/report.docx（需根据上文内容生成）"
            ],
            confidence: "high",
            followUps: ["Use the merged content to create reports/report.docx."],
            verificationStatus: "failed"
          })
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Generate reports/report.docx in the workspace.",
      config,
      providerRegistry
    });

    const reportPath = join(workspaceRoot, "reports", "report.docx");
    const reportText = await readDocumentText(reportPath);
    const implementationExecution = result.executions.find((execution) => execution.taskId === "task_1");

    assert.equal(existsSync(reportPath), true);
    assert.equal(reportText.includes("国际局势部分已整理"), true);
    assert.deepEqual(implementationExecution?.output.verifiedGeneratedFiles, ["reports/report.docx"]);
    assert.equal(implementationExecution?.output.generatedFiles.includes("reports/report.docx"), true);
    assert.equal(
      implementationExecution?.output.risks.some((risk) => /reported artifact/i.test(String(risk))),
      false
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runClusterAnalysis does not auto-materialize an artifact from malformed leader synthesis output", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-orchestrator-malformed-leader-"));

  try {
    const config = {
      cluster: {
        controller: "controller",
        maxParallel: 2,
        groupLeaderMaxDelegates: 1,
        delegateMaxDepth: 1
      },
      workspace: {
        resolvedDir: workspaceRoot
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
          specialties: ["implementation", "coding"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Attempt to deliver a report artifact",
            strategy: "Delegate source collection and then synthesize.",
            tasks: [
              {
                id: "task_1",
                phase: "implementation",
                title: "Generate reports/report.docx",
                assignedWorker: "implementation_leader",
                delegateCount: 1,
                instructions: "Generate `reports/report.docx` in the workspace.",
                dependsOn: [],
                expectedOutput: "A concrete reports/report.docx artifact."
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "The run finished.",
            executiveSummary: [],
            consensus: [],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      [
        "implementation_leader",
        new FakeProvider([
          JSON.stringify({
            thinkingSummary: "Delegate one child to collect source material.",
            delegationSummary: "One child collects the source material.",
            subtasks: [
              {
                id: "source_content",
                title: "Collect report source material",
                instructions: "Return structured source content only.",
                expectedOutput: "Source content."
              }
            ]
          }),
          JSON.stringify({
            action: "final",
            summary: "Collected the source content.",
            keyFindings: ["Do not use stale_report.docx as the final artifact."],
            risks: [],
            deliverables: ["Source content"],
            confidence: "high",
            followUps: [],
            verificationStatus: "not_applicable"
          }),
          "```json\n{\"summary\":\"broken synthesis\",\"keyFindings\":[\"stale_report.docx should be ignored\"]"
        ])
      ]
    ]);

    const result = await runClusterAnalysis({
      task: "Generate reports/report.docx in the workspace.",
      config,
      providerRegistry
    });

    const implementationExecution = result.executions.find((execution) => execution.taskId === "task_1");
    assert.equal(existsSync(join(workspaceRoot, "stale_report.docx")), false);
    assert.equal(existsSync(join(workspaceRoot, "reports", "report.docx")), false);
    assert.equal(implementationExecution?.output.generatedFiles.length, 0);
    assert.equal(implementationExecution?.output.verifiedGeneratedFiles.length, 0);
    assert.equal(implementationExecution?.output.verificationStatus, "failed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runClusterAnalysis infers dependent delegated child tasks from shared workspace artifacts", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-orchestrator-dependent-children-"));

  try {
    const config = {
      cluster: {
        controller: "controller",
        maxParallel: 4,
        groupLeaderMaxDelegates: 2,
        delegateMaxDepth: 1
      },
      multiAgent: {
        enabled: true,
        mode: "group_chat",
        speakerStrategy: "phase_priority",
        maxRounds: 12,
        messageWindow: 20,
        summarizeLongMessages: true,
        includeSystemMessages: true
      },
      workspace: {
        resolvedDir: workspaceRoot
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
          specialties: ["implementation", "coding"]
        }
      }
    };

    const providerRegistry = new Map([
      [
        "controller",
        new FakeProvider([
          JSON.stringify({
            objective: "Generate the requested report artifact",
            strategy: "Delegate source JSON creation first and then assemble the report.",
            tasks: [
              {
                id: "task_1",
                phase: "implementation",
                title: "Generate reports/report.docx",
                assignedWorker: "implementation_leader",
                delegateCount: 2,
                instructions:
                  "Generate `reports/report.docx` in the workspace using intermediate structured research output.",
                dependsOn: [],
                expectedOutput: "A concrete reports/report.docx artifact."
              }
            ]
          }),
          JSON.stringify({
            finalAnswer: "The dependency-ordered report workflow completed successfully.",
            executiveSummary: ["Delegated child dependencies were inferred and respected."],
            consensus: ["The downstream child waited for the upstream JSON artifact."],
            disagreements: [],
            nextActions: []
          })
        ])
      ],
      ["implementation_leader", new DependentWorkspaceLeaderProvider()]
    ]);

    const result = await runClusterAnalysis({
      task: "Generate reports/report.docx in the workspace from delegated child work.",
      config,
      providerRegistry
    });

    const sourcePath = join(workspaceRoot, "research", "source.json");
    const reportPath = join(workspaceRoot, "reports", "report.docx");
    const reportText = await readDocumentText(reportPath);
    const implementationExecution = result.executions.find((execution) => execution.taskId === "task_1");

    assert.equal(existsSync(sourcePath), true);
    assert.equal(existsSync(reportPath), true);
    assert.equal(reportText.includes("International situation and China trade cooperation analysis"), true);
    assert.equal(implementationExecution?.status, "completed");
    assert.equal(implementationExecution?.output.subordinateCount, 2);
    assert.deepEqual(implementationExecution?.output.verifiedGeneratedFiles, [
      "research/source.json",
      "reports/report.docx"
    ]);
    assert.equal(
      result.multiAgentSession.messages.some((message) => /Please take "Write the structured research JSON"/.test(message.content)),
      true
    );
    assert.equal(
      result.multiAgentSession.messages.some((message) => /Acknowledged "Write the structured research JSON"/.test(message.content)),
      true
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
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

test("runClusterAnalysis prefers an isolated fallback worker over a stronger same-gateway candidate", async () => {
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
        model: "kimi-k2.5",
        provider: "kimi-chat",
        baseUrl: "https://api.moonshot.cn/v1",
        webSearch: true,
        specialties: ["research"]
      },
      research_same_gateway: {
        id: "research_same_gateway",
        label: "Research Same Gateway",
        model: "kimi-k2.5",
        provider: "kimi-chat",
        baseUrl: "https://api.moonshot.cn/v1",
        webSearch: true,
        specialties: [
          "research",
          "web research",
          "data extraction",
          "cross-checking",
          "analysis",
          "long context reading"
        ]
      },
      research_isolated: {
        id: "research_isolated",
        label: "Research Isolated",
        model: "gpt-5.4-mini",
        provider: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        webSearch: true,
        specialties: ["research"]
      }
    }
  };

  const retryableProviderError = new Error(
    "Request to https://api.moonshot.cn/v1/chat/completions timed out after 90000 ms"
  );
  retryableProviderError.status = 408;
  retryableProviderError.retryable = true;

  const providerRegistry = new Map([
    [
      "controller",
      new FakeProvider([
        JSON.stringify({
          objective: "Collect fresh market facts",
          strategy: "Prefer a failure-isolated backup if the primary provider stalls.",
          tasks: [
            {
              id: "task_1",
              phase: "research",
              title: "Latest market facts",
              assignedWorker: "research_primary",
              instructions: "Directly verify the latest market facts and summarize them.",
              dependsOn: []
            }
          ]
        }),
        JSON.stringify({
          finalAnswer: "Failure-isolated fallback completed successfully.",
          executiveSummary: ["The run switched to a different provider and gateway after the primary Moonshot path stalled."],
          consensus: ["Failure-domain isolation takes priority over same-gateway specialization."],
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
      "research_same_gateway",
      new FakeProvider([buildWorkerOutput("Same-gateway fallback should not be selected first.")])
    ],
    [
      "research_isolated",
      new FakeProvider([buildWorkerOutput("Isolated fallback completed the research task.")])
    ]
  ]);

  const result = await runClusterAnalysis({
    task: "Directly verify the latest market facts and summarize them.",
    config,
    providerRegistry,
    onEvent(event) {
      events.push(event);
    }
  });

  assert.equal(result.executions.length, 1);
  assert.equal(result.executions[0].workerId, "research_isolated");
  assert.equal(result.executions[0].status, "completed");
  assert.equal(
    events.some(
      (event) =>
        event.stage === "worker_fallback" &&
        event.previousWorkerId === "research_primary" &&
        event.fallbackWorkerId === "research_isolated"
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

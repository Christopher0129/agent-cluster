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
import { readDocumentText } from "../../src/workspace/document-reader.mjs";
import { DelayedJsonProvider, FakeProvider, waitForDelay } from "../helpers/providers.mjs";

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
          '{"action":"write_files","reason":"Write the repaired file.","files":[{"path":"docs/repaired.txt","content":"repaired output\\n"}],"oops":}',
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

export async function runWorkspaceSmokeTests() {
  await runWorkspaceToolLayerMemoryTests();
  await runWorkspaceToolLoopTests();
  await runWorkspaceJsonRepairTests();
  await runArtifactVerificationGuardTests();
  await runWorkspaceCommandLoopTests();
}

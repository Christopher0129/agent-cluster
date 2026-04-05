import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runWorkspaceToolLoop } from "../src/workspace/agent-loop.mjs";
import { readDocumentText } from "../src/workspace/document-reader.mjs";
import { FakeProvider } from "./helpers/providers.mjs";

test("runWorkspaceToolLoop blocks workspace writes outside task scope", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-guard-"));

  try {
    const provider = new FakeProvider([
      JSON.stringify({
        action: "write_files",
        reason: "Try to write a validation report into the workspace.",
        files: [
          {
            path: "reports/review.md",
            content: "# review\n"
          }
        ]
      }),
      JSON.stringify({
        action: "final",
        summary: "Validation completed without workspace writes.",
        keyFindings: ["The write attempt was blocked by task scope."],
        risks: ["No validation artifact was written because writes are not allowed for this task."],
        deliverables: [],
        confidence: "medium",
        followUps: ["Return the review as structured output instead of writing files."],
        generatedFiles: [],
        verificationStatus: "failed"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "validator",
        label: "Validator",
        model: "model-v",
        webSearch: false
      },
      task: {
        id: "validate_patch",
        phase: "validation",
        title: "Validate the generated patch",
        instructions: "Review the code changes and report findings without modifying workspace files.",
        expectedOutput: "Validation findings only.",
        requirements: {
          phase: "validation",
          requiresWorkspaceWrite: false,
          requiresWorkspaceCommand: true,
          requiresConcreteArtifact: false,
          allowsWorkspaceWrite: false,
          allowsWorkspaceCommand: true
        }
      },
      originalTask: "Validate the generated patch.",
      clusterPlan: {
        strategy: "Validation only."
      },
      dependencyOutputs: [],
      workspaceRoot
    });

    assert.equal(existsSync(join(workspaceRoot, "reports", "review.md")), false);
    assert.deepEqual(result.verifiedGeneratedFiles, []);
    assert.deepEqual(result.generatedFiles, []);
    assert.equal(result.toolUsage.includes("write_files"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop allows artifact-producing handoff tasks to write workspace files", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-artifact-"));

  try {
    const provider = new FakeProvider([
      JSON.stringify({
        action: "write_files",
        reason: "Create the requested delivery artifact in the workspace.",
        files: [
          {
            path: "reports/report.docx",
            content: "placeholder artifact"
          }
        ]
      }),
      JSON.stringify({
        action: "final",
        summary: "The delivery artifact was written.",
        keyFindings: ["The report file exists in the workspace."],
        risks: [],
        deliverables: ["reports/report.docx"],
        confidence: "high",
        followUps: [],
        generatedFiles: ["reports/report.docx"],
        verificationStatus: "passed"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "handoff_worker",
        label: "Handoff Worker",
        model: "model-h",
        webSearch: false
      },
      task: {
        id: "write_report",
        phase: "handoff",
        title: "Generate delivery report.docx",
        instructions: "Create and deliver report.docx in the workspace.",
        expectedOutput: "A concrete report.docx artifact."
      },
      originalTask: "Generate a concrete report.docx artifact.",
      clusterPlan: {
        strategy: "Write the requested file into the workspace."
      },
      dependencyOutputs: [],
      workspaceRoot
    });

    assert.equal(existsSync(join(workspaceRoot, "reports", "report.docx")), true);
    const reportPath = join(workspaceRoot, "reports", "report.docx");
    const reportBinary = await readFile(reportPath);
    const reportText = await readDocumentText(reportPath);
    assert.equal(reportBinary.subarray(0, 2).toString("utf8"), "PK");
    assert.equal(reportText.includes("placeholder artifact"), true);
    assert.equal(result.verificationStatus, "passed");
    assert.deepEqual(result.verifiedGeneratedFiles, ["reports/report.docx"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop exposes web_search only for web-search-capable workers", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-web-search-"));
  const events = [];

  try {
    const provider = new FakeProvider([
      JSON.stringify({
        action: "web_search",
        query: "2026-04-03 A-share market statistics",
        reason: "Verify the latest trading-day market snapshot."
      }),
      ({ purpose, instructions }) => {
        assert.equal(purpose, "worker_web_search");
        assert.match(instructions, /Authoritative runtime clock:/);
        return {
          text: JSON.stringify({
            summary: "Found a verified market snapshot.",
            keyFindings: ["The recent trading day was verified from searched public sources."],
            sources: ["https://example.com/a-share-snapshot"],
            confidence: "high"
          })
        };
      },
      JSON.stringify({
        action: "final",
        summary: "Web verification completed.",
        keyFindings: ["Used workspace web search successfully."],
        risks: [],
        deliverables: [],
        confidence: "high",
        followUps: [],
        toolUsage: ["web_search"],
        verificationStatus: "passed"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "research_worker",
        label: "Research Worker",
        model: "model-r",
        webSearch: true
      },
      task: {
        id: "verify_market",
        phase: "research",
        title: "Verify recent A-share market statistics",
        instructions: "Use web search to verify the most recent trading-day snapshot.",
        expectedOutput: "Verified market statistics with source-backed notes."
      },
      originalTask: "Verify recent A-share market statistics.",
      clusterPlan: {
        strategy: "Use live source verification."
      },
      dependencyOutputs: [],
      workspaceRoot,
      onEvent(event) {
        events.push(event);
      }
    });

    assert.equal(result.toolUsage.includes("web_search"), true);
    assert.equal(events.some((event) => event.stage === "workspace_web_search"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop does not advertise blocked workspace tools in the prompt", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-schema-"));

  try {
    const provider = new FakeProvider([
      ({ instructions }) => {
        assert.doesNotMatch(instructions, /"action":"write_files"/);
        assert.doesNotMatch(instructions, /"action":"write_docx"/);
        assert.doesNotMatch(instructions, /"action":"run_command"/);
        assert.match(instructions, /Workspace writes are not available for this task\./);
        assert.match(instructions, /Workspace commands are not available for this task\./);
        return {
          text: JSON.stringify({
            action: "final",
            summary: "Prompt advertised only the allowed tools.",
            keyFindings: ["Blocked workspace tools were omitted from the schema."],
            risks: [],
            deliverables: [],
            confidence: "high",
            followUps: [],
            verificationStatus: "passed"
          })
        };
      }
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "reader_only",
        label: "Reader Only",
        model: "model-ro",
        webSearch: false
      },
      task: {
        id: "inspect_only",
        phase: "validation",
        title: "Inspect generated outputs only",
        instructions: "Read the generated files and return a verdict without writing files or running commands.",
        expectedOutput: "A structured validation summary.",
        requirements: {
          phase: "validation",
          requiresWorkspaceWrite: false,
          requiresWorkspaceCommand: false,
          requiresConcreteArtifact: false,
          allowsWorkspaceWrite: false,
          allowsWorkspaceCommand: false
        }
      },
      originalTask: "Inspect generated outputs only.",
      clusterPlan: {
        strategy: "Use read-only file tools and structured output."
      },
      dependencyOutputs: [],
      workspaceRoot
    });

    assert.equal(result.summary, "Prompt advertised only the allowed tools.");
    assert.equal(result.verificationStatus, "passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop accepts wrapped alias workspace actions", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-alias-"));

  try {
    const provider = new FakeProvider([
      JSON.stringify({
        function: {
          name: "writeFile",
          arguments: JSON.stringify({
            path: "notes/alias.txt",
            content: "alias-compatible output\n"
          })
        }
      }),
      JSON.stringify({
        action: "final",
        summary: "Wrapped alias action completed.",
        keyFindings: ["The wrapped writeFile alias was normalized into write_files."],
        risks: [],
        deliverables: ["notes/alias.txt"],
        confidence: "high",
        followUps: [],
        generatedFiles: ["notes/alias.txt"],
        verificationStatus: "passed"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "alias_writer",
        label: "Alias Writer",
        model: "model-a",
        webSearch: false
      },
      task: {
        id: "alias_write",
        phase: "handoff",
        title: "Write alias-compatible artifact",
        instructions: "Create notes/alias.txt in the workspace.",
        expectedOutput: "A concrete alias.txt artifact."
      },
      originalTask: "Create notes/alias.txt in the workspace.",
      clusterPlan: {
        strategy: "Write the requested file through the workspace tool layer."
      },
      dependencyOutputs: [],
      workspaceRoot
    });

    assert.equal(await readFile(join(workspaceRoot, "notes", "alias.txt"), "utf8"), "alias-compatible output\n");
    assert.deepEqual(result.verifiedGeneratedFiles, ["notes/alias.txt"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop accepts batched action arrays by executing the first action", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-batch-"));

  try {
    const provider = new FakeProvider([
      '先看一下工作区，再读取目标文件。[{"action":"list_files","path":".","reason":"Inspect the workspace root first."},{"action":"read_files","paths":["notes/existing.txt"],"reason":"Read the existing note next."}]',
      JSON.stringify({
        action: "read_files",
        paths: ["notes/existing.txt"],
        reason: "Read the requested note after listing the workspace."
      }),
      JSON.stringify({
        action: "final",
        summary: "Batched action array was tolerated.",
        keyFindings: ["The first list_files action in the batch was executed successfully."],
        risks: [],
        deliverables: [],
        confidence: "high",
        followUps: [],
        verificationStatus: "passed"
      })
    ]);

    const notesDir = join(workspaceRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "existing.txt"), "hello\n", "utf8");

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "batch_reader",
        label: "Batch Reader",
        model: "model-b",
        webSearch: false
      },
      task: {
        id: "batch_read",
        phase: "validation",
        title: "Inspect and read an existing note",
        instructions: "Inspect the workspace and then read notes/existing.txt.",
        expectedOutput: "A structured validation summary."
      },
      originalTask: "Inspect the workspace and read an existing note.",
      clusterPlan: {
        strategy: "Allow the worker to inspect first and then read."
      },
      dependencyOutputs: [],
      workspaceRoot
    });

    assert.equal(result.summary, "Batched action array was tolerated.");
    assert.deepEqual(result.workspaceActions.slice(0, 2), ["list_files", "read_files"]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop auto-materializes a requested docx artifact from dependency outputs", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-docx-fallback-"));

  try {
    const provider = new FakeProvider([
      JSON.stringify({
        action: "final",
        summary: "已整理可成文内容，准备交付职业分析文档。",
        keyFindings: ["包含四个职业方向的中文分析要点。"],
        deliverables: ["未来有前景的职业分析报告.docx"],
        confidence: "high",
        followUps: [],
        verificationStatus: "not_applicable"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "handoff_worker",
        label: "Handoff Worker",
        model: "model-h",
        webSearch: false
      },
      task: {
        id: "write_report_fallback",
        phase: "handoff",
        title: "生成并校验职业前景 Word 文档",
        instructions: "在 workspace 中生成 `未来有前景的职业分析报告.docx`。",
        expectedOutput: "A concrete 未来有前景的职业分析报告.docx artifact."
      },
      originalTask: "生成并校验职业前景 Word 文档。",
      clusterPlan: {
        strategy: "Use upstream research outputs to deliver the requested document."
      },
      dependencyOutputs: [
        {
          taskId: "task_1",
          workerId: "research_leader",
          status: "completed",
          output: {
            summary: "筛选出四个未来高前景职业方向并形成详细中文报告内容。",
            keyFindings: [
              "AI大模型应用工程师需求持续增长。",
              "新能源储能系统工程师受益于能源转型。",
              "健康管理与老年照护专家受益于老龄化。",
              "网络安全与数据合规岗位刚性需求强。"
            ],
            deliverables: ["职业分析中文素材"]
          }
        }
      ],
      workspaceRoot
    });

    const reportPath = join(workspaceRoot, "未来有前景的职业分析报告.docx");
    const reportText = await readDocumentText(reportPath);
    assert.equal(existsSync(reportPath), true);
    assert.equal(reportText.includes("AI大模型应用工程师"), true);
    assert.equal(reportText.includes("网络安全与数据合规岗位刚性需求强"), true);
    assert.deepEqual(result.verifiedGeneratedFiles, ["未来有前景的职业分析报告.docx"]);
    assert.equal(result.verificationStatus, "passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop locally salvages yaml-like workspace actions without invoking JSON repair", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-local-salvage-"));
  const events = [];

  try {
    const provider = new FakeProvider([
      [
        "action: write_docx",
        "path: reports/salvaged.docx",
        "title: Salvaged Report",
        "reason: Write the requested report artifact.",
        "content: |",
        "  这是通过本地容错解析恢复出来的 Word 文档内容。",
        "  第二段也应该被保留下来。"
      ].join("\n"),
      JSON.stringify({
        action: "final",
        summary: "The salvaged report was written.",
        keyFindings: ["The malformed YAML-like tool output was handled locally."],
        risks: [],
        deliverables: ["reports/salvaged.docx"],
        confidence: "high",
        followUps: [],
        generatedFiles: ["reports/salvaged.docx"],
        verificationStatus: "passed"
      })
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "salvage_worker",
        label: "Salvage Worker",
        model: "model-s",
        webSearch: false
      },
      task: {
        id: "salvage_docx",
        phase: "handoff",
        title: "Write salvaged report",
        instructions: "Create reports/salvaged.docx in the workspace.",
        expectedOutput: "A concrete salvaged.docx artifact."
      },
      originalTask: "Create reports/salvaged.docx in the workspace.",
      clusterPlan: {
        strategy: "Write the requested Word report."
      },
      dependencyOutputs: [],
      workspaceRoot,
      onEvent(event) {
        events.push(event);
      }
    });

    const reportPath = join(workspaceRoot, "reports", "salvaged.docx");
    const reportText = await readDocumentText(reportPath);

    assert.equal(existsSync(reportPath), true);
    assert.equal(reportText.includes("这是通过本地容错解析恢复出来的 Word 文档内容。"), true);
    assert.equal(result.verifiedGeneratedFiles.includes("reports/salvaged.docx"), true);
    assert.equal(events.some((event) => event.stage === "workspace_json_repair"), false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("runWorkspaceToolLoop forces a final summary after the tool-turn budget is exhausted", async () => {
  const workspaceRoot = await mkdtemp(join(process.cwd(), ".tmp-workspace-tool-budget-"));
  const events = [];

  try {
    const provider = new FakeProvider([
      ...Array.from({ length: 6 }, () =>
        JSON.stringify({
          action: "list_files",
          path: ".",
          reason: "Inspect the workspace before finalizing."
        })
      ),
      ({ purpose }) => {
        assert.equal(purpose, "worker_forced_final");
        return {
          text: JSON.stringify({
            action: "final",
            summary: "Forced final summary completed.",
            keyFindings: ["The tool-turn budget was reached, so the runtime requested a final summary."],
            risks: ["No concrete artifact was generated."],
            deliverables: [],
            confidence: "medium",
            followUps: ["Reduce the tool loop scope or write the requested artifact earlier."],
            verificationStatus: "failed"
          })
        };
      }
    ]);

    const result = await runWorkspaceToolLoop({
      provider,
      worker: {
        id: "validator",
        label: "Validator",
        model: "model-v",
        webSearch: false
      },
      task: {
        id: "budget_finalize",
        phase: "validation",
        title: "Inspect repeatedly until the runtime forces a final answer",
        instructions: "Keep inspecting the workspace and then summarize findings.",
        expectedOutput: "A validation summary."
      },
      originalTask: "Inspect repeatedly and then summarize findings.",
      clusterPlan: {
        strategy: "Use the workspace tool loop until the runtime needs to force a final answer."
      },
      dependencyOutputs: [],
      workspaceRoot,
      onEvent(event) {
        events.push(event);
      }
    });

    assert.equal(result.summary, "Forced final summary completed.");
    assert.equal(result.verificationStatus, "failed");
    assert.equal(result.workspaceActions.filter((action) => action === "list_files").length, 6);
    assert.equal(events.some((event) => event.stage === "workspace_list"), true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

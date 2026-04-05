import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createDocxBuffer } from "../src/workspace/docx.mjs";
import { readDocumentText } from "../src/workspace/document-reader.mjs";

test("createDocxBuffer generates a readable Chinese Word document", async () => {
  const tempRoot = await mkdtemp(join(process.cwd(), ".tmp-docx-buffer-"));
  const filePath = join(tempRoot, "report.docx");

  try {
    const buffer = createDocxBuffer({
      title: "未来职业分析报告",
      content: [
        "## 方法说明",
        "本报告用于验证中文内容不会乱码。",
        "",
        "- 第一条：AI大模型应用工程师",
        "- 第二条：新能源储能系统工程师"
      ].join("\n")
    });

    await writeFile(filePath, buffer);

    const binary = await readFile(filePath);
    const text = await readDocumentText(filePath);

    assert.equal(binary.subarray(0, 2).toString("utf8"), "PK");
    assert.equal(text.includes("未来职业分析报告"), true);
    assert.equal(text.includes("本报告用于验证中文内容不会乱码"), true);
    assert.equal(text.includes("AI大模型应用工程师"), true);
    assert.equal(text.includes("新能源储能系统工程师"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

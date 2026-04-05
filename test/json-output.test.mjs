import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonCandidate, parseJsonFromText } from "../src/utils/json-output.mjs";

test("parseJsonFromText handles raw JSON", () => {
  const value = parseJsonFromText('{"hello":"world","items":[1,2]}');
  assert.equal(value.hello, "world");
  assert.deepEqual(value.items, [1, 2]);
});

test("extractJsonCandidate handles fenced JSON blocks", () => {
  const candidate = extractJsonCandidate("```json\n{\"a\":1,\"b\":2}\n```");
  assert.equal(candidate, '{"a":1,"b":2}');
});

test("extractJsonCandidate keeps the outer fenced JSON block when strings contain inner code fences", () => {
  const candidate = extractJsonCandidate(
    "```json\n{\"summary\":\"ok\",\"content\":\"before\\n```python\\nprint(1)\\n```\\nafter\"}\n```"
  );
  const parsed = JSON.parse(candidate);
  assert.equal(parsed.summary, "ok");
  assert.equal(parsed.content.includes("```python"), true);
});

test("parseJsonFromText extracts JSON from explanatory text", () => {
  const value = parseJsonFromText('Result follows:\n{"summary":"ok","items":["a"]}\nThanks.');
  assert.equal(value.summary, "ok");
  assert.deepEqual(value.items, ["a"]);
});

test("parseJsonFromText falls back to the first balanced JSON object when trailing text breaks raw parse", () => {
  const value = parseJsonFromText('{"summary":"ok"}\nExplanation: verified with sources.');
  assert.equal(value.summary, "ok");
});

test("parseJsonFromText repairs JSON-like object literals with bare keys, single quotes, comments, and trailing commas", () => {
  const value = parseJsonFromText(`{
    // report action
    action: 'write_files',
    reason: 'Create the requested report',
    files: [
      {
        path: 'reports/report.docx',
        content: '# Report

Line 1
Line 2',
      },
    ],
  }`);
  assert.equal(value.action, "write_files");
  assert.equal(value.files[0].path, "reports/report.docx");
  assert.equal(value.files[0].content.includes("Line 2"), true);
});

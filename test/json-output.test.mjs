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

test("parseJsonFromText extracts JSON from explanatory text", () => {
  const value = parseJsonFromText('Result follows:\n{"summary":"ok","items":["a"]}\nThanks.');
  assert.equal(value.summary, "ok");
  assert.deepEqual(value.items, ["a"]);
});

test("parseJsonFromText falls back to the first balanced JSON object when trailing text breaks raw parse", () => {
  const value = parseJsonFromText('{"summary":"ok"}\nExplanation: verified with sources.');
  assert.equal(value.summary, "ok");
});

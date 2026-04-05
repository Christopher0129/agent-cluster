import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describeOperationEvent } from "./static/operation-events.js";

export const RUN_LOG_DIR = "task-logs";

function sanitizeRunId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");

  return normalized || `run_${Date.now()}`;
}

function formatLogValue(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function formatEventLine(event) {
  const timestamp = formatLogValue(event?.timestamp, "unknown-time");
  const stage = formatLogValue(event?.stage, "unknown-stage");
  const tone = formatLogValue(event?.tone);
  const actor = formatLogValue(event?.agentLabel || event?.modelLabel || event?.modelId);
  const detail = formatLogValue(
    describeOperationEvent(event, {
      formatDelay(value) {
        const amount = Number(value);
        return Number.isFinite(amount) ? `${amount} ms` : "n/a";
      }
    }),
    formatLogValue(event?.detail || event?.message)
  );
  return [
    `[${timestamp}]`,
    stage,
    tone ? `tone=${tone}` : "",
    actor ? `actor=${actor}` : "",
    detail ? `detail=${detail}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function renderClusterRunLogText(payload) {
  const summary = payload?.result?.synthesis || {};
  const timings = payload?.result?.timings || {};
  const eventLines = Array.isArray(payload?.operation?.events)
    ? payload.operation.events
        .filter((event) => {
          const stage = String(event?.stage || "").trim();
          return stage !== "session_update" && !stage.startsWith("trace_span_");
        })
        .map((event) => formatEventLine(event))
    : [];

  return [
    "# Agent Cluster Task Log",
    `Operation ID: ${formatLogValue(payload?.operationId, "unknown")}`,
    `Status: ${formatLogValue(payload?.status, "unknown")}`,
    `Saved At: ${formatLogValue(payload?.savedAt, "unknown")}`,
    `Task: ${formatLogValue(payload?.task, "unknown")}`,
    `Scheme: ${formatLogValue(payload?.schemeId, "default")}`,
    `Workspace: ${formatLogValue(payload?.workspace?.resolvedDir, "unknown")}`,
    "",
    "## Summary",
    `Final Answer: ${formatLogValue(summary?.finalAnswer, formatLogValue(payload?.error?.message, "n/a"))}`,
    `Total Time (ms): ${formatLogValue(timings?.totalMs, "n/a")}`,
    `Task Count: ${formatLogValue(payload?.result?.plan?.tasks?.length, "0")}`,
    `Execution Count: ${formatLogValue(payload?.result?.executions?.length, "0")}`,
    "",
    "## Status Timeline",
    ...(eventLines.length ? eventLines : ["(no events captured)"]),
    "",
    "Detailed low-level traces remain in the JSON log.",
    ""
  ].join("\n");
}

export async function writeClusterRunLog(projectDir, runId, payload) {
  const safeRunId = sanitizeRunId(runId);
  const jsonPath = `${RUN_LOG_DIR}/${safeRunId}.json`;
  const textPath = `${RUN_LOG_DIR}/${safeRunId}.log`;
  const jsonAbsolutePath = resolve(projectDir, jsonPath);
  const textAbsolutePath = resolve(projectDir, textPath);
  const jsonContent = `${JSON.stringify(payload, null, 2)}\n`;
  const textContent = `${renderClusterRunLogText(payload)}\n`;

  await mkdir(dirname(jsonAbsolutePath), { recursive: true });
  await mkdir(dirname(textAbsolutePath), { recursive: true });
  await writeFile(jsonAbsolutePath, jsonContent, "utf8");
  await writeFile(textAbsolutePath, textContent, "utf8");

  return {
    jsonPath,
    jsonBytes: Buffer.byteLength(jsonContent, "utf8"),
    textPath,
    textBytes: Buffer.byteLength(textContent, "utf8")
  };
}

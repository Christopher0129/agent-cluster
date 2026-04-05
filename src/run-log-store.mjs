import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createOperationEventTranslator,
  describeOperationEvent
} from "./static/operation-events.js";

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

function normalizeLogLocale(value) {
  return String(value || "").trim() === "zh-CN" ? "zh-CN" : "en-US";
}

function localizeLogText(locale, englishText, chineseText) {
  return normalizeLogLocale(locale) === "zh-CN" ? chineseText : englishText;
}

function formatEventLine(event, locale = "en-US") {
  const timestamp = formatLogValue(event?.timestamp, "unknown-time");
  const stage = formatLogValue(event?.stage, "unknown-stage");
  const tone = formatLogValue(event?.tone);
  const actor = formatLogValue(event?.agentLabel || event?.modelLabel || event?.modelId);
  const translate = createOperationEventTranslator(locale);
  const detail = formatLogValue(
    describeOperationEvent(event, {
      locale,
      translate,
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
  const locale = normalizeLogLocale(payload?.locale || payload?.operation?.meta?.locale);
  const summary = payload?.result?.synthesis || {};
  const timings = payload?.result?.timings || {};
  const eventLines = Array.isArray(payload?.operation?.events)
    ? payload.operation.events
        .filter((event) => {
          const stage = String(event?.stage || "").trim();
          return stage !== "session_update" && !stage.startsWith("trace_span_");
        })
        .map((event) => formatEventLine(event, locale))
    : [];

  return [
    localizeLogText(locale, "# Agent Cluster Task Log", "# Agent 集群任务日志"),
    `Operation ID: ${formatLogValue(payload?.operationId, "unknown")}`,
    `Status: ${formatLogValue(payload?.status, "unknown")}`,
    `Saved At: ${formatLogValue(payload?.savedAt, "unknown")}`,
    `Task: ${formatLogValue(payload?.task, "unknown")}`,
    `Scheme: ${formatLogValue(payload?.schemeId, "default")}`,
    `Workspace: ${formatLogValue(payload?.workspace?.resolvedDir, "unknown")}`,
    "",
    localizeLogText(locale, "## Summary", "## 摘要"),
    `${localizeLogText(locale, "Final Answer", "最终答复")}: ${formatLogValue(summary?.finalAnswer, formatLogValue(payload?.error?.message, "n/a"))}`,
    `${localizeLogText(locale, "Total Time (ms)", "总耗时（ms）")}: ${formatLogValue(timings?.totalMs, "n/a")}`,
    `${localizeLogText(locale, "Task Count", "任务数量")}: ${formatLogValue(payload?.result?.plan?.tasks?.length, "0")}`,
    `${localizeLogText(locale, "Execution Count", "执行数量")}: ${formatLogValue(payload?.result?.executions?.length, "0")}`,
    "",
    localizeLogText(locale, "## Status Timeline", "## 状态时间线"),
    ...(eventLines.length ? eventLines : [localizeLogText(locale, "(no events captured)", "（未捕获到事件）")]),
    "",
    localizeLogText(
      locale,
      "Detailed low-level traces remain in the JSON log.",
      "更详细的底层追踪已保存在 JSON 日志中。"
    ),
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

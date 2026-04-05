import { basename, extname, relative, resolve } from "node:path";

const ARTIFACT_EXTENSION_PATTERN = /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/i;
const WINDOWS_INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;
const QUOTED_ARTIFACT_PATTERN = /[`"'“”]([^`"'“”\r\n]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json))[`"'“”]/gi;
const ABSOLUTE_WINDOWS_ARTIFACT_PATTERN = /[a-z]:\\[^\r\n]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/gi;
const BARE_FILENAME_PATTERN =
  /(?:^|[\s(（:：])([^\s"'“”`<>|?*\r\n\\/:]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json))\b/gi;

function safeString(value) {
  return String(value || "").trim();
}

function uniqueStrings(items) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => safeString(item))
        .filter(Boolean)
    )
  );
}

function normalizeArtifactCandidateValue(value) {
  if (typeof value === "string") {
    return safeString(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  return safeString(
    value.path ??
      value.filePath ??
      value.file_path ??
      value.filename ??
      value.fileName ??
      value.targetPath ??
      value.target_path
  );
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").trim().replaceAll("\\", "/");
}

function normalizeCandidatePath(candidatePath, workspaceRoot) {
  const normalized = normalizeRelativePath(candidatePath);
  if (!normalized) {
    return "";
  }

  const normalizedWorkspaceRoot = normalizeRelativePath(resolve(workspaceRoot));
  const lowerWorkspaceRoot = normalizedWorkspaceRoot.toLowerCase();
  const lowerCandidate = normalized.toLowerCase();

  if (lowerCandidate.startsWith(lowerWorkspaceRoot)) {
    const absoluteCandidate = resolve(candidatePath);
    const relativePath = normalizeRelativePath(relative(resolve(workspaceRoot), absoluteCandidate));
    if (relativePath && !relativePath.startsWith("../")) {
      return relativePath;
    }
  }

  if (/^[a-z]:\//i.test(normalized)) {
    return basename(normalized);
  }

  return normalized.replace(/^\/+/, "");
}

function collectQuotedArtifactCandidates(text) {
  const value = safeString(text);
  if (!value) {
    return [];
  }

  const matches = [];
  for (const match of value.matchAll(QUOTED_ARTIFACT_PATTERN)) {
    matches.push(match[1]);
  }
  for (const match of value.matchAll(ABSOLUTE_WINDOWS_ARTIFACT_PATTERN)) {
    matches.push(match[0]);
  }
  for (const match of value.matchAll(BARE_FILENAME_PATTERN)) {
    matches.push(match[1]);
  }

  return matches;
}

function sanitizeFilename(value) {
  const normalized = safeString(value)
    .replace(WINDOWS_INVALID_FILENAME, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();

  return normalized || "generated-artifact";
}

function deriveFallbackFilename(task) {
  const source = safeString(task?.title || task?.expectedOutput || task?.instructions);
  if (!source) {
    return "generated-report";
  }

  return sanitizeFilename(source).slice(0, 80);
}

function appendBulletSection(lines, heading, items) {
  const normalizedItems = uniqueStrings(items);
  if (!normalizedItems.length) {
    return;
  }

  lines.push(`## ${heading}`);
  lines.push(...normalizedItems.map((item) => `- ${item}`));
}

function renderOutputSection(result) {
  const output = result?.output && typeof result.output === "object" ? result.output : {};
  const lines = [];

  if (safeString(output.summary)) {
    lines.push(output.summary);
  }

  appendBulletSection(lines, "关键要点", output.keyFindings || []);
  appendBulletSection(lines, "相关交付", output.deliverables || []);
  appendBulletSection(lines, "风险与注意事项", output.risks || []);
  appendBulletSection(lines, "后续建议", output.followUps || []);

  return lines.join("\n");
}

function collectExplicitArtifactCandidates(parsed) {
  return uniqueStrings([
    ...(Array.isArray(parsed?.generatedFiles) ? parsed.generatedFiles : []),
    ...(Array.isArray(parsed?.verifiedGeneratedFiles) ? parsed.verifiedGeneratedFiles : []),
    ...(Array.isArray(parsed?.deliverables) ? parsed.deliverables : [])
  ].map((item) => normalizeArtifactCandidateValue(item)).filter(Boolean));
}

function collectArtifactPathHints(parsed) {
  return uniqueStrings([
    ...(Array.isArray(parsed?.generatedFiles) ? parsed.generatedFiles : []),
    ...(Array.isArray(parsed?.verifiedGeneratedFiles) ? parsed.verifiedGeneratedFiles : [])
  ].map((item) => normalizeArtifactCandidateValue(item)).filter(Boolean));
}

function collectDeliverableTexts(parsed) {
  return uniqueStrings([
    ...(Array.isArray(parsed?.deliverables) ? parsed.deliverables : [])
  ]);
}

function collectArtifactHintTexts(task, parsed, originalTask) {
  return [
    task?.title,
    task?.instructions,
    task?.expectedOutput,
    originalTask,
    parsed?.summary,
    ...(Array.isArray(parsed?.followUps) ? parsed.followUps : []),
    ...collectDeliverableTexts(parsed),
    ...collectArtifactPathHints(parsed),
    ...(Array.isArray(parsed?.keyFindings) ? parsed.keyFindings : [])
  ]
    .map((value) => safeString(value))
    .filter(Boolean);
}

export function inferRequestedArtifact(task, parsed, workspaceRoot, originalTask = "") {
  for (const candidate of collectExplicitArtifactCandidates(parsed)) {
    const normalized = normalizeCandidatePath(candidate, workspaceRoot);
    if (ARTIFACT_EXTENSION_PATTERN.test(normalized)) {
      return normalized;
    }
  }

  for (const source of collectArtifactHintTexts(task, parsed, originalTask)) {
    for (const candidate of collectQuotedArtifactCandidates(source)) {
      const normalized = normalizeCandidatePath(candidate, workspaceRoot);
      if (ARTIFACT_EXTENSION_PATTERN.test(normalized)) {
        return normalized;
      }
    }
  }

  const extensionMatch = collectArtifactHintTexts(task, parsed, originalTask)
    .map((source) => source.match(ARTIFACT_EXTENSION_PATTERN))
    .find(Boolean);
  const extension = extensionMatch ? extensionMatch[0].toLowerCase() : ".docx";

  return `${deriveFallbackFilename(task)}${extension.startsWith(".") ? extension : `.${extension}`}`;
}

export function buildDocxFallbackContent({
  task,
  parsed,
  dependencyOutputs,
  originalTask
}) {
  const sections = [];
  const title = safeString(task?.title) || "交付文档";
  sections.push(`# ${title}`);

  if (safeString(originalTask)) {
    sections.push("## 原始目标");
    sections.push(originalTask);
  }

  if (safeString(parsed?.summary)) {
    sections.push("## 当前任务总结");
    sections.push(parsed.summary);
  }

  appendBulletSection(sections, "当前任务要点", parsed?.keyFindings || []);
  appendBulletSection(sections, "当前任务交付", parsed?.deliverables || []);
  appendBulletSection(sections, "风险与限制", parsed?.risks || []);
  appendBulletSection(sections, "后续建议", parsed?.followUps || []);

  const outputs = Array.isArray(dependencyOutputs) ? dependencyOutputs : [];
  for (const dependency of outputs) {
    const body = renderOutputSection(dependency);
    if (!safeString(body)) {
      continue;
    }

    const heading =
      safeString(dependency?.title) ||
      safeString(dependency?.taskId) ||
      "依赖输出";
    sections.push(`## 依赖输出：${heading}`);
    sections.push(body);
  }

  return sections.join("\n\n").trim();
}

export function shouldAutoMaterializeDocx(task, parsed, dependencyOutputs) {
  const explicitPath = inferRequestedArtifact(task, parsed, ".", "");
  if (!/\.docx$/i.test(explicitPath)) {
    return false;
  }

  const content = buildDocxFallbackContent({
    task,
    parsed,
    dependencyOutputs,
    originalTask: ""
  });

  return safeString(content).length >= 24;
}

export function getArtifactTitleFromPath(artifactPath) {
  const fileName = basename(String(artifactPath || ""));
  const extension = extname(fileName);
  return fileName.slice(0, extension ? -extension.length : undefined) || "Generated Report";
}

import { basename, extname, relative, resolve } from "node:path";

const ARTIFACT_EXTENSION_PATTERN = /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/i;
const WINDOWS_INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

function safeString(value) {
  return String(value || "").trim();
}

function uniqueStrings(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => safeString(item)).filter(Boolean)));
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
  const quotedPattern = /[`"'“”]([^`"'“”\r\n]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json))[`"'“”]/gi;
  for (const match of value.matchAll(quotedPattern)) {
    matches.push(match[1]);
  }

  const absoluteWindowsPattern = /[a-z]:\\[^\r\n]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/gi;
  for (const match of value.matchAll(absoluteWindowsPattern)) {
    matches.push(match[0]);
  }

  const bareFilenamePattern = /(?:^|[\s(（:：])([^\s"'“”`<>|?*\r\n\\/:]+?\.(?:docx?|pptx?|xlsx?|pdf|md|txt|csv|json))\b/gi;
  for (const match of value.matchAll(bareFilenamePattern)) {
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

function renderOutputSection(result) {
  const output = result?.output && typeof result.output === "object" ? result.output : {};
  const lines = [];

  if (safeString(output.summary)) {
    lines.push(output.summary);
  }

  const keyFindings = uniqueStrings(output.keyFindings || []);
  if (keyFindings.length) {
    lines.push("## 关键要点");
    lines.push(...keyFindings.map((item) => `- ${item}`));
  }

  const deliverables = uniqueStrings(output.deliverables || []);
  if (deliverables.length) {
    lines.push("## 相关交付");
    lines.push(...deliverables.map((item) => `- ${item}`));
  }

  const risks = uniqueStrings(output.risks || []);
  if (risks.length) {
    lines.push("## 风险与注意事项");
    lines.push(...risks.map((item) => `- ${item}`));
  }

  const followUps = uniqueStrings(output.followUps || []);
  if (followUps.length) {
    lines.push("## 后续建议");
    lines.push(...followUps.map((item) => `- ${item}`));
  }

  return lines.join("\n");
}

export function inferRequestedArtifact(task, parsed, workspaceRoot, originalTask = "") {
  const explicitCandidates = uniqueStrings([
    ...(Array.isArray(parsed?.generatedFiles) ? parsed.generatedFiles : []),
    ...(Array.isArray(parsed?.deliverables) ? parsed.deliverables : [])
  ]);

  for (const candidate of explicitCandidates) {
    const normalized = normalizeCandidatePath(candidate, workspaceRoot);
    if (ARTIFACT_EXTENSION_PATTERN.test(normalized)) {
      return normalized;
    }
  }

  const textSources = [
    task?.title,
    task?.instructions,
    task?.expectedOutput,
    originalTask,
    safeString(parsed?.summary)
  ];

  for (const source of textSources) {
    for (const candidate of collectQuotedArtifactCandidates(source)) {
      const normalized = normalizeCandidatePath(candidate, workspaceRoot);
      if (ARTIFACT_EXTENSION_PATTERN.test(normalized)) {
        return normalized;
      }
    }
  }

  const extensionMatch = textSources
    .map((source) => safeString(source).match(ARTIFACT_EXTENSION_PATTERN))
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

  const parsedFindings = uniqueStrings(parsed?.keyFindings || []);
  if (parsedFindings.length) {
    sections.push("## 当前任务要点");
    sections.push(...parsedFindings.map((item) => `- ${item}`));
  }

  const outputs = Array.isArray(dependencyOutputs) ? dependencyOutputs : [];
  for (const dependency of outputs) {
    const body = renderOutputSection(dependency);
    if (!safeString(body)) {
      continue;
    }

    const heading = safeString(dependency?.output?.deliverables?.[0]) ||
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

export const WORKSPACE_ACTIONS = Object.freeze({
  LIST_FILES: "list_files",
  READ_FILES: "read_files",
  WRITE_FILES: "write_files",
  WRITE_DOCX: "write_docx",
  WEB_SEARCH: "web_search",
  RUN_COMMAND: "run_command",
  RECALL_MEMORY: "recall_memory",
  REMEMBER: "remember",
  FINAL: "final"
});

export function buildWorkspaceToolSchemaLines(options = {}) {
  const webSearchAvailable = Boolean(options.webSearchAvailable);
  const workspaceWriteAvailable = options.workspaceWriteAvailable !== false;
  const workspaceCommandAvailable = options.workspaceCommandAvailable !== false;
  const workspaceCommandScopeDescription = String(
    options.workspaceCommandScopeDescription || ""
  ).trim();
  const schemas = [
    '{"action":"list_files","path":"relative/path","reason":"string"}',
    '{"action":"read_files","paths":["relative/path"],"reason":"string"}'
  ];

  if (workspaceWriteAvailable) {
    schemas.push(
      '{"action":"write_files","files":[{"path":"relative/path","content":"string","encoding":"utf8|base64"}],"reason":"string"}',
      '{"action":"write_docx","path":"relative/path.docx","content":"string","title":"string","reason":"string"}'
    );
  }

  if (webSearchAvailable) {
    schemas.push(
      '{"action":"web_search","query":"string","domains":["example.com"],"recencyDays":30,"reason":"string"}'
    );
  }

  if (workspaceCommandAvailable) {
    schemas.push(
      '{"action":"run_command","command":"string","args":["string"],"cwd":"relative/path","reason":"string"}'
    );
  }

  schemas.push(
    '{"action":"recall_memory","query":"string","limit":3,"tags":["string"],"reason":"string"}',
    '{"action":"remember","title":"string","content":"string","tags":["string"],"reason":"string"}'
  );

  const lines = schemas.map(
    (schema, index) => `Tool schema ${index + 1}: ${schema}`
  );

  if (!workspaceWriteAvailable) {
    lines.push("Unavailable tool: write_files/write_docx. Do not attempt workspace writes for this task.");
  }
  if (!webSearchAvailable) {
    lines.push("Unavailable tool: web_search. Do not claim live web verification for this task.");
  }
  if (!workspaceCommandAvailable) {
    lines.push("Unavailable tool: run_command. Do not attempt workspace commands for this task.");
  } else if (workspaceCommandScopeDescription) {
    lines.push(`run_command scope: ${workspaceCommandScopeDescription}.`);
  }

  lines.push(
    'Final schema: {"action":"final","thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"confidence":"low|medium|high","followUps":["string"],"generatedFiles":["relative/path"],"verificationStatus":"not_applicable|passed|failed","toolUsage":["string"],"memoryReads":0,"memoryWrites":0}'
  );

  return lines;
}

export const WORKSPACE_TOOL_SCHEMA_LINES = buildWorkspaceToolSchemaLines({
  webSearchAvailable: true
});

const ACTION_BATCH_KEYS = Object.freeze([
  "actions",
  "steps",
  "toolCalls",
  "tool_calls",
  "operations",
  "calls",
  "requests"
]);

const ACTION_NAME_KEYS = Object.freeze([
  "action",
  "toolAction",
  "tool_action",
  "tool",
  "toolName",
  "tool_name",
  "name",
  "type",
  "method",
  "operation",
  "op",
  "intent",
  "functionName",
  "function_name",
  "call"
]);

const ACTION_WRAPPER_KEYS = Object.freeze([
  "workspaceAction",
  "workspace_action",
  "toolCall",
  "tool_call",
  "functionCall",
  "function_call",
  "request",
  "toolRequest",
  "tool_request",
  "operation",
  "step"
]);

const ACTION_PAYLOAD_KEYS = Object.freeze([
  "payload",
  "params",
  "parameters",
  "arguments",
  "input",
  "toolInput",
  "tool_input",
  "data",
  "body"
]);

const ACTION_ALIASES = new Map([
  ["list", WORKSPACE_ACTIONS.LIST_FILES],
  ["ls", WORKSPACE_ACTIONS.LIST_FILES],
  ["list_files", WORKSPACE_ACTIONS.LIST_FILES],
  ["listfiles", WORKSPACE_ACTIONS.LIST_FILES],
  ["list_file", WORKSPACE_ACTIONS.LIST_FILES],
  ["list_workspace", WORKSPACE_ACTIONS.LIST_FILES],
  ["read", WORKSPACE_ACTIONS.READ_FILES],
  ["read_file", WORKSPACE_ACTIONS.READ_FILES],
  ["read_files", WORKSPACE_ACTIONS.READ_FILES],
  ["readfiles", WORKSPACE_ACTIONS.READ_FILES],
  ["open_file", WORKSPACE_ACTIONS.READ_FILES],
  ["write", WORKSPACE_ACTIONS.WRITE_FILES],
  ["write_file", WORKSPACE_ACTIONS.WRITE_FILES],
  ["write_files", WORKSPACE_ACTIONS.WRITE_FILES],
  ["writefiles", WORKSPACE_ACTIONS.WRITE_FILES],
  ["save_file", WORKSPACE_ACTIONS.WRITE_FILES],
  ["save_files", WORKSPACE_ACTIONS.WRITE_FILES],
  ["create_file", WORKSPACE_ACTIONS.WRITE_FILES],
  ["write_docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["writedocx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["write-docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["create_docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["createdocx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["generate_docx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["generatedocx", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["word_document", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["write_word_document", WORKSPACE_ACTIONS.WRITE_DOCX],
  ["web_search", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["websearch", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_search_tool", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_searches", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["search_web", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_search_query", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web_search_request", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["web-search", WORKSPACE_ACTIONS.WEB_SEARCH],
  ["run_command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["runcommand", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["run-command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["shell", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["execute_command", WORKSPACE_ACTIONS.RUN_COMMAND],
  ["recall", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["recall_memory", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["recallmemory", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["memory_search", WORKSPACE_ACTIONS.RECALL_MEMORY],
  ["remember", WORKSPACE_ACTIONS.REMEMBER],
  ["remember_memory", WORKSPACE_ACTIONS.REMEMBER],
  ["store_memory", WORKSPACE_ACTIONS.REMEMBER],
  ["write_memory", WORKSPACE_ACTIONS.REMEMBER],
  ["final", WORKSPACE_ACTIONS.FINAL],
  ["done", WORKSPACE_ACTIONS.FINAL],
  ["finish", WORKSPACE_ACTIONS.FINAL],
  ["complete", WORKSPACE_ACTIONS.FINAL],
  ["result", WORKSPACE_ACTIONS.FINAL],
  ["final_result", WORKSPACE_ACTIONS.FINAL],
  ["finalresult", WORKSPACE_ACTIONS.FINAL]
]);

function safeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean).map((item) => String(item))));
}

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function toSnakeCase(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function parseMaybeJsonValue(value) {
  if (value && typeof value === "object") {
    return value;
  }

  const normalized = String(value || "").trim();
  if (!normalized || !/^[\[{]/.test(normalized)) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function parseMaybeJsonObject(value) {
  const parsed = parseMaybeJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function normalizeActionName(value) {
  const normalized = toSnakeCase(value);
  if (!normalized) {
    return "";
  }

  if (Object.values(WORKSPACE_ACTIONS).includes(normalized)) {
    return normalized;
  }

  return ACTION_ALIASES.get(normalized) || "";
}

function getFirstObjectValue(candidate, keys) {
  for (const key of keys) {
    const value = candidate?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }

    const parsed = parseMaybeJsonObject(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function getFirstDefinedValue(candidate, keys) {
  for (const key of keys) {
    if (candidate?.[key] != null) {
      return candidate[key];
    }
  }

  return undefined;
}

function resolveRawActionName(candidate) {
  return getFirstDefinedValue(candidate, ACTION_NAME_KEYS);
}

function maybeUnwrapFunctionCall(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }

  if (candidate.function && typeof candidate.function === "object" && !Array.isArray(candidate.function)) {
    const functionArgs = parseMaybeJsonObject(candidate.function.arguments) || {};
    return {
      ...functionArgs,
      ...candidate,
      action:
        candidate.action ??
        candidate.function.name ??
        functionArgs.action
    };
  }

  const nestedArguments = parseMaybeJsonObject(candidate.arguments);
  if (nestedArguments) {
    return {
      ...nestedArguments,
      ...candidate
    };
  }

  return candidate;
}

function maybeUnwrapWorkspaceAction(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }

  let current = maybeUnwrapFunctionCall(candidate);

  for (let depth = 0; depth < 4; depth += 1) {
    let changed = false;

    const wrappedAction = getFirstObjectValue(current, ACTION_WRAPPER_KEYS);
    if (wrappedAction) {
      const rawActionName = resolveRawActionName(current);
      current = {
        ...wrappedAction,
        ...current,
        action:
          rawActionName ??
          resolveRawActionName(wrappedAction)
      };
      current = maybeUnwrapFunctionCall(current);
      changed = true;
    }

    const wrappedPayload = getFirstObjectValue(current, ACTION_PAYLOAD_KEYS);
    if (wrappedPayload) {
      const rawActionName = resolveRawActionName(current);
      current = {
        ...wrappedPayload,
        ...current,
        action:
          rawActionName ??
          resolveRawActionName(wrappedPayload)
      };
      current = maybeUnwrapFunctionCall(current);
      changed = true;
    }

    if (!changed) {
      break;
    }
  }

  return current;
}

function extractFirstActionCandidate(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) || parsed[0];
  }

  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  for (const key of ACTION_BATCH_KEYS) {
    const directEntries = Array.isArray(parsed[key]) ? parsed[key] : null;
    const parsedEntries = directEntries || parseMaybeJsonValue(parsed[key]);
    if (!Array.isArray(parsedEntries) || !parsedEntries.length) {
      continue;
    }

    const firstEntry = extractFirstActionCandidate(parsedEntries);
    if (!firstEntry || typeof firstEntry !== "object" || Array.isArray(firstEntry)) {
      continue;
    }

    return {
      ...firstEntry,
      reason: firstEntry.reason ?? parsed.reason,
      action:
        resolveRawActionName(firstEntry) ??
        resolveRawActionName(parsed)
    };
  }

  return parsed;
}

function getPathAlias(candidate) {
  return getFirstDefinedValue(candidate, [
    "path",
    "filePath",
    "file_path",
    "filename",
    "fileName",
    "targetPath",
    "target_path",
    "artifactPath",
    "artifact_path"
  ]);
}

function getContentAlias(candidate) {
  return getFirstDefinedValue(candidate, [
    "content",
    "text",
    "body",
    "markdown",
    "document",
    "doc",
    "contents",
    "data"
  ]);
}

function normalizeFileLikeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const path = getPathAlias(entry);
  const content = getContentAlias(entry);
  if (!hasNonEmptyString(path) || typeof content !== "string") {
    return null;
  }

  const normalized = {
    path: String(path),
    content: String(content)
  };

  if (entry.encoding != null) {
    normalized.encoding = String(entry.encoding).trim().toLowerCase() || "utf8";
  }
  if (entry.title != null) {
    normalized.title = String(entry.title);
  }

  return normalized;
}

export function canonicalizeWorkspaceActionPayload(parsed) {
  const firstCandidate = extractFirstActionCandidate(parsed);
  if (!firstCandidate || typeof firstCandidate !== "object" || Array.isArray(firstCandidate)) {
    return parsed;
  }

  const candidate = maybeUnwrapWorkspaceAction(firstCandidate);
  const action = normalizeActionName(resolveRawActionName(candidate));

  const normalized = {
    ...candidate
  };

  if (!Array.isArray(normalized.files)) {
    const parsedFiles = parseMaybeJsonValue(normalized.files);
    if (Array.isArray(parsedFiles)) {
      normalized.files = parsedFiles;
    }
  }

  if (Array.isArray(normalized.files)) {
    normalized.files = normalized.files
      .map((entry) => normalizeFileLikeEntry(entry))
      .filter(Boolean);
  }

  if (!hasNonEmptyString(normalized.path)) {
    const pathAlias = getPathAlias(normalized);
    if (hasNonEmptyString(pathAlias)) {
      normalized.path = String(pathAlias);
    }
  }

  if (typeof normalized.content !== "string") {
    const contentAlias = getContentAlias(normalized);
    if (typeof contentAlias === "string") {
      normalized.content = String(contentAlias);
    }
  }

  if (!hasNonEmptyString(normalized.command)) {
    const commandAlias = getFirstDefinedValue(normalized, ["command", "cmd", "shellCommand", "shell_command"]);
    if (hasNonEmptyString(commandAlias)) {
      normalized.command = String(commandAlias);
    }
  }

  if (!hasNonEmptyString(normalized.query)) {
    const queryAlias = getFirstDefinedValue(normalized, ["query", "searchQuery", "search_query", "prompt"]);
    if (hasNonEmptyString(queryAlias)) {
      normalized.query = String(queryAlias);
    }
  }

  if (!Array.isArray(normalized.paths)) {
    const parsedPaths = parseMaybeJsonValue(normalized.paths);
    if (Array.isArray(parsedPaths)) {
      normalized.paths = parsedPaths;
    }
  }

  if (!normalized.action && action) {
    normalized.action = action;
  }

  if (!normalized.action) {
    if (
      hasNonEmptyString(normalized.path) &&
      /\.docx$/i.test(String(normalized.path || "")) &&
      typeof normalized.content === "string"
    ) {
      normalized.action = WORKSPACE_ACTIONS.WRITE_DOCX;
    } else if (
      Array.isArray(normalized.files) ||
      (hasNonEmptyString(normalized.path) && typeof normalized.content === "string")
    ) {
      normalized.action = WORKSPACE_ACTIONS.WRITE_FILES;
    } else if (Array.isArray(normalized.paths)) {
      normalized.action = WORKSPACE_ACTIONS.READ_FILES;
    } else if (hasNonEmptyString(normalized.command)) {
      normalized.action = WORKSPACE_ACTIONS.RUN_COMMAND;
    } else if (hasNonEmptyString(normalized.title) && hasNonEmptyString(normalized.content)) {
      normalized.action = WORKSPACE_ACTIONS.REMEMBER;
    } else if (parsed?.summary || parsed?.keyFindings || parsed?.followUps) {
      normalized.action = WORKSPACE_ACTIONS.FINAL;
    }
  }

  normalized.action = normalizeActionName(normalized.action) || normalized.action || "";

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_FILES &&
    !Array.isArray(normalized.files) &&
    hasNonEmptyString(normalized.path) &&
    typeof normalized.content === "string"
  ) {
    normalized.files = [
      {
        path: String(normalized.path),
        content: normalized.content,
        encoding: String(normalized.encoding || "utf8").trim().toLowerCase() || "utf8"
      }
    ];
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_FILES &&
    (!Array.isArray(normalized.files) || !normalized.files.length)
  ) {
    const singleFileEntry =
      normalizeFileLikeEntry(getFirstObjectValue(normalized, ["file", "artifact", "document"])) ||
      normalizeFileLikeEntry(normalized);
    if (singleFileEntry) {
      normalized.files = [
        {
          ...singleFileEntry,
          encoding: String(singleFileEntry.encoding || normalized.encoding || "utf8").trim().toLowerCase() || "utf8"
        }
      ];
    }
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_DOCX &&
    !hasNonEmptyString(normalized.path)
  ) {
    const docxEntry =
      normalizeFileLikeEntry(getFirstObjectValue(normalized, ["file", "artifact", "document"])) ||
      normalizeFileLikeEntry(normalized);
    if (docxEntry) {
      normalized.path = docxEntry.path;
      normalized.content = docxEntry.content;
      if (docxEntry.title != null && normalized.title == null) {
        normalized.title = docxEntry.title;
      }
    }
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.WRITE_DOCX &&
    hasNonEmptyString(normalized.path) &&
    typeof normalized.content === "string"
  ) {
    normalized.path = String(normalized.path);
    normalized.content = String(normalized.content);
    if (normalized.title != null) {
      normalized.title = String(normalized.title);
    }
  }

  if (
    normalized.action === WORKSPACE_ACTIONS.READ_FILES &&
    !Array.isArray(normalized.paths) &&
    hasNonEmptyString(normalized.path)
  ) {
    normalized.paths = [String(normalized.path)];
  }

  if (normalized.action === WORKSPACE_ACTIONS.RUN_COMMAND) {
    if (Array.isArray(normalized.arguments) && !Array.isArray(normalized.args)) {
      normalized.args = normalized.arguments;
    } else if (typeof normalized.arguments === "string" && !Array.isArray(normalized.args)) {
      const parsedArguments = parseMaybeJsonValue(normalized.arguments);
      if (Array.isArray(parsedArguments)) {
        normalized.args = parsedArguments;
      }
    }

    if (typeof normalized.args === "string") {
      normalized.args = [normalized.args];
    }
  }

  if (normalized.action === WORKSPACE_ACTIONS.WEB_SEARCH) {
    if (typeof normalized.domains === "string") {
      normalized.domains = [normalized.domains];
    }
    if (normalized.recencyDays == null && normalized.recency != null) {
      normalized.recencyDays = normalized.recency;
    }
  }

  if (normalized.action === WORKSPACE_ACTIONS.FINAL) {
    if (!Array.isArray(normalized.generatedFiles) && hasNonEmptyString(normalized.generatedFile)) {
      normalized.generatedFiles = [String(normalized.generatedFile)];
    }
    if (
      !Array.isArray(normalized.verifiedGeneratedFiles) &&
      hasNonEmptyString(normalized.verifiedGeneratedFile)
    ) {
      normalized.verifiedGeneratedFiles = [String(normalized.verifiedGeneratedFile)];
    }
  }

  return normalized;
}

export function normalizeVerificationStatus(value, fallback = "not_applicable") {
  const normalized = String(value || "").trim();
  if (["not_applicable", "passed", "failed"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

export function normalizeToolAction(parsed) {
  const normalized = canonicalizeWorkspaceActionPayload(parsed);
  const action = normalizeActionName(resolveRawActionName(normalized));
  if (action) {
    return action;
  }

  if (normalized?.summary || normalized?.keyFindings || normalized?.followUps) {
    return WORKSPACE_ACTIONS.FINAL;
  }

  return "";
}

function hasNonEmptyString(value) {
  return String(value || "").trim().length > 0;
}

const ARTIFACT_EXTENSIONS = [
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".pdf",
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".ps1",
  ".cmd",
  ".bat",
  ".sh",
  ".log"
];

function normalizeArtifactReference(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const lowerText = text.toLowerCase();
  let bestEnd = -1;
  for (const extension of ARTIFACT_EXTENSIONS) {
    const index = lowerText.indexOf(extension);
    if (index === -1) {
      continue;
    }
    const end = index + extension.length;
    if (end > bestEnd) {
      bestEnd = end;
    }
  }

  if (bestEnd > 0) {
    return text.slice(0, bestEnd).trim();
  }

  return text;
}

export function normalizeWorkspaceArtifactReferences(values) {
  return uniqueStrings(safeArray(values).map(normalizeArtifactReference).filter(Boolean));
}

export function validateWorkspaceActionPayload(parsed, action) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workspace action payload must be a JSON object.");
  }

  switch (action) {
    case WORKSPACE_ACTIONS.LIST_FILES:
      if (!hasNonEmptyString(parsed.path || ".")) {
        throw new Error("list_files requires a workspace-relative path.");
      }
      return;
    case WORKSPACE_ACTIONS.READ_FILES: {
      const paths = safeArray(parsed.paths).filter(Boolean);
      if (!paths.length) {
        throw new Error("read_files requires at least one workspace-relative path.");
      }
      return;
    }
    case WORKSPACE_ACTIONS.WRITE_FILES: {
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      if (!files.length) {
        throw new Error("write_files requires at least one file payload.");
      }
      for (const file of files) {
        if (!hasNonEmptyString(file?.path)) {
          throw new Error("write_files requires every file entry to include a relative path.");
        }
        if (typeof file?.content !== "string") {
          throw new Error("write_files requires every file entry to include string content.");
        }
        if (
          file?.encoding != null &&
          !["utf8", "base64"].includes(String(file.encoding).trim().toLowerCase())
        ) {
          throw new Error('write_files encoding must be either "utf8" or "base64".');
        }
      }
      return;
    }
    case WORKSPACE_ACTIONS.WRITE_DOCX:
      if (!hasNonEmptyString(parsed.path) || !/\.docx$/i.test(String(parsed.path))) {
        throw new Error("write_docx requires a workspace-relative .docx path.");
      }
      if (typeof parsed.content !== "string") {
        throw new Error("write_docx requires string content.");
      }
      return;
    case WORKSPACE_ACTIONS.WEB_SEARCH:
      if (!hasNonEmptyString(parsed.query)) {
        throw new Error("web_search requires a query.");
      }
      if (parsed.domains != null && !Array.isArray(parsed.domains)) {
        throw new Error("web_search domains must be an array of strings.");
      }
      if (parsed.recencyDays != null) {
        const recencyDays = Number(parsed.recencyDays);
        if (!Number.isFinite(recencyDays) || recencyDays < 0) {
          throw new Error("web_search recencyDays must be a non-negative number.");
        }
      }
      return;
    case WORKSPACE_ACTIONS.RUN_COMMAND:
      if (!hasNonEmptyString(parsed.command)) {
        throw new Error("run_command requires a command.");
      }
      if (parsed.args != null && !Array.isArray(parsed.args)) {
        throw new Error("run_command args must be an array of strings.");
      }
      return;
    case WORKSPACE_ACTIONS.RECALL_MEMORY:
      if (!hasNonEmptyString(parsed.query)) {
        throw new Error("recall_memory requires a query.");
      }
      return;
    case WORKSPACE_ACTIONS.REMEMBER:
      if (!hasNonEmptyString(parsed.content)) {
        throw new Error("remember requires content.");
      }
      return;
    case WORKSPACE_ACTIONS.FINAL:
      if (
        !hasNonEmptyString(parsed.summary) &&
        !safeArray(parsed.keyFindings).length &&
        !safeArray(parsed.risks).length &&
        !safeArray(parsed.deliverables).length
      ) {
        throw new Error("final requires a summary or at least one structured result field.");
      }
      return;
    default:
      throw new Error(`Unsupported workspace action "${action || "unknown"}".`);
  }
}

export function normalizeWorkspaceFinalResult(
  parsed,
  rawText,
  generatedFiles,
  verifiedGeneratedFiles,
  history,
  counters = {}
) {
  const commandHistory = history.filter(
    (entry) => entry.action === WORKSPACE_ACTIONS.RUN_COMMAND && !entry.blocked
  );
  return {
    thinkingSummary: String(parsed?.thinkingSummary || ""),
    summary: String(parsed?.summary || rawText || "No summary returned."),
    keyFindings: safeArray(parsed?.keyFindings),
    risks: safeArray(parsed?.risks),
    deliverables: safeArray(parsed?.deliverables),
    confidence: ["low", "medium", "high"].includes(parsed?.confidence)
      ? parsed.confidence
      : "medium",
    followUps: safeArray(parsed?.followUps),
    generatedFiles: normalizeWorkspaceArtifactReferences([
      ...(parsed?.generatedFiles || []),
      ...(generatedFiles || [])
    ]),
    verifiedGeneratedFiles: normalizeWorkspaceArtifactReferences(verifiedGeneratedFiles || []),
    workspaceActions: history.map((entry) => entry.action),
    toolUsage: uniqueStrings([...(parsed?.toolUsage || []), ...history.map((entry) => entry.action)]),
    memoryReads: normalizeInteger(parsed?.memoryReads, normalizeInteger(counters.memoryReads)),
    memoryWrites: normalizeInteger(parsed?.memoryWrites, normalizeInteger(counters.memoryWrites)),
    verificationStatus: normalizeVerificationStatus(parsed?.verificationStatus),
    executedCommands: commandHistory.map((entry) =>
      [entry.request.command, ...(entry.request.args || [])].join(" ").trim()
    )
  };
}

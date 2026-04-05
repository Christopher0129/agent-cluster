export const WORKSPACE_COMMAND_SCOPES = Object.freeze({
  NONE: "none",
  READ_ONLY: "read_only",
  VERIFY: "verify",
  SAFE_EXECUTION: "safe_execution"
});

const SCOPE_RANK = Object.freeze({
  [WORKSPACE_COMMAND_SCOPES.NONE]: 0,
  [WORKSPACE_COMMAND_SCOPES.READ_ONLY]: 1,
  [WORKSPACE_COMMAND_SCOPES.VERIFY]: 2,
  [WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION]: 3
});

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "show",
  "log",
  "rev-parse",
  "ls-files"
]);
const READ_ONLY_EXECUTABLES = new Set(["rg", "rg.exe"]);

const VERIFY_KEYWORD_PATTERN =
  /\b(test|tests|spec|verify|verification|check|lint|build|validate|validation|smoke|typecheck|compile|coverage|vet|clippy|assemble|audit|ci)\b/i;
const VERIFY_TOOL_PATTERN =
  /^(vitest|jest|mocha|ava|tap|eslint|tsc|tsx|vite|webpack|rollup|tsup|playwright|cypress|ruff|mypy|pytest|coverage|nyc|turbo|prettier)$/i;

function safeString(value) {
  return String(value || "").trim();
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((item) => String(item ?? "")) : [];
}

function findFirstNonFlag(args, startIndex = 0) {
  for (let index = Math.max(0, startIndex); index < args.length; index += 1) {
    const value = safeString(args[index]);
    if (!value || value.startsWith("-")) {
      continue;
    }
    return value;
  }

  return "";
}

function looksLikeVerificationToken(value) {
  const normalized = safeString(value);
  if (!normalized) {
    return false;
  }

  const tail = normalized.split(/[\\/]/).pop() || normalized;
  return VERIFY_KEYWORD_PATTERN.test(normalized) || VERIFY_TOOL_PATTERN.test(tail);
}

function normalizeScope(value) {
  const normalized = safeString(value).toLowerCase();
  return Object.values(WORKSPACE_COMMAND_SCOPES).includes(normalized)
    ? normalized
    : WORKSPACE_COMMAND_SCOPES.NONE;
}

function isKnownScope(value) {
  return Object.values(WORKSPACE_COMMAND_SCOPES).includes(safeString(value).toLowerCase());
}

function resolveScriptTarget(executable, args) {
  if (["node", "java", "javac"].includes(executable)) {
    return findFirstNonFlag(args);
  }

  if (["python", "py"].includes(executable)) {
    if (safeString(args[0]).toLowerCase() === "-m") {
      return safeString(args[1]);
    }
    return findFirstNonFlag(args);
  }

  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) {
    return safeString(args[1]);
  }

  if (["cmd", "cmd.exe"].includes(executable)) {
    return safeString(args[1]);
  }

  return "";
}

function classifyPackageManagerScope(executable, args) {
  const primary = safeString(args[0]).toLowerCase();
  const secondary = safeString(args[1]).toLowerCase();

  if (["npm", "pnpm"].includes(executable)) {
    if (["test", "lint", "build"].includes(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (["run", "exec"].includes(primary) && looksLikeVerificationToken(secondary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "dlx" && looksLikeVerificationToken(secondary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "yarn") {
    if (["test", "lint", "build"].includes(primary) || looksLikeVerificationToken(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "run" && looksLikeVerificationToken(secondary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "npx") {
    const tool = findFirstNonFlag(args);
    return looksLikeVerificationToken(tool)
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

function classifyScriptExecutionScope(executable, args) {
  if (["python", "py"].includes(executable) && safeString(args[0]).toLowerCase() === "-m") {
    return looksLikeVerificationToken(args[1])
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  const target = resolveScriptTarget(executable, args);
  return looksLikeVerificationToken(target)
    ? WORKSPACE_COMMAND_SCOPES.VERIFY
    : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

function classifyJvmOrBuildScope(executable, args) {
  const primary = safeString(args[0]).toLowerCase();
  const remaining = args.map((item) => safeString(item).toLowerCase());

  if (executable === "dotnet") {
    if (["test", "build", "restore"].includes(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "format" && remaining.includes("--verify-no-changes")) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "cargo") {
    if (["test", "check", "build", "clippy"].includes(primary)) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    if (primary === "fmt" && remaining.includes("--check")) {
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    }
    return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "go") {
    return ["test", "build", "vet"].includes(primary)
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "mvn") {
    return remaining.some((item) => looksLikeVerificationToken(item))
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (["gradle", "gradlew"].includes(executable)) {
    return remaining.some((item) => looksLikeVerificationToken(item))
      ? WORKSPACE_COMMAND_SCOPES.VERIFY
      : WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }

  if (executable === "pytest" || executable === "javac") {
    return WORKSPACE_COMMAND_SCOPES.VERIFY;
  }

  return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

export function normalizeWorkspaceCommandScope(value, fallback = WORKSPACE_COMMAND_SCOPES.NONE) {
  if (isKnownScope(value)) {
    return normalizeScope(value);
  }
  return normalizeScope(fallback);
}

export function getWorkspaceCommandScopeRank(value) {
  return SCOPE_RANK[normalizeWorkspaceCommandScope(value)] ?? 0;
}

export function clampWorkspaceCommandScope(value, ceiling = WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION) {
  const normalizedValue = normalizeWorkspaceCommandScope(value);
  const normalizedCeiling = normalizeWorkspaceCommandScope(
    ceiling,
    WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
  );
  return getWorkspaceCommandScopeRank(normalizedValue) <= getWorkspaceCommandScopeRank(normalizedCeiling)
    ? normalizedValue
    : normalizedCeiling;
}

export function describeWorkspaceCommandScope(value) {
  switch (normalizeWorkspaceCommandScope(value)) {
    case WORKSPACE_COMMAND_SCOPES.READ_ONLY:
      return "read-only workspace inspection commands";
    case WORKSPACE_COMMAND_SCOPES.VERIFY:
      return "read-only inspection plus verification, test, lint, and build commands";
    case WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION:
      return "the full safe workspace command set";
    default:
      return "no workspace commands";
  }
}

export function formatWorkspaceCommand(command, args = []) {
  return [safeString(command), ...normalizeArgs(args)].filter(Boolean).join(" ").trim();
}

export function resolveRequiredWorkspaceCommandScope(command, args = []) {
  const executable = safeString(command).toLowerCase();
  const normalizedArgs = normalizeArgs(args);

  if (!executable) {
    return WORKSPACE_COMMAND_SCOPES.NONE;
  }

  if (executable === "git" && READ_ONLY_GIT_SUBCOMMANDS.has(safeString(normalizedArgs[0]).toLowerCase())) {
    return WORKSPACE_COMMAND_SCOPES.READ_ONLY;
  }

  if (READ_ONLY_EXECUTABLES.has(executable)) {
    return WORKSPACE_COMMAND_SCOPES.READ_ONLY;
  }

  if (["npm", "npx", "pnpm", "yarn"].includes(executable)) {
    return classifyPackageManagerScope(executable, normalizedArgs);
  }

  if (
    ["node", "python", "py", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe"].includes(
      executable
    )
  ) {
    return classifyScriptExecutionScope(executable, normalizedArgs);
  }

  if (["pytest", "dotnet", "cargo", "go", "javac", "mvn", "gradle", "gradlew"].includes(executable)) {
    return classifyJvmOrBuildScope(executable, normalizedArgs);
  }

  return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
}

export class WorkspaceCommandScopeError extends Error {
  constructor(command, args, allowedScope, requiredScope) {
    const commandText = formatWorkspaceCommand(command, args) || safeString(command) || "(empty command)";
    const normalizedAllowedScope = normalizeWorkspaceCommandScope(allowedScope);
    const normalizedRequiredScope = normalizeWorkspaceCommandScope(requiredScope);
    super(
      `Blocked run_command "${commandText}" because this task only allows ${describeWorkspaceCommandScope(
        normalizedAllowedScope
      )}.`
    );
    this.name = "WorkspaceCommandScopeError";
    this.code = "WORKSPACE_COMMAND_SCOPE_BLOCKED";
    this.command = safeString(command);
    this.args = normalizeArgs(args);
    this.commandText = commandText;
    this.allowedScope = normalizedAllowedScope;
    this.requiredScope = normalizedRequiredScope;
  }
}

export function assertWorkspaceCommandAllowedForScope(command, args = [], allowedScope) {
  const normalizedAllowedScope = normalizeWorkspaceCommandScope(allowedScope);
  const requiredScope = resolveRequiredWorkspaceCommandScope(command, args);
  if (getWorkspaceCommandScopeRank(requiredScope) > getWorkspaceCommandScopeRank(normalizedAllowedScope)) {
    throw new WorkspaceCommandScopeError(command, args, normalizedAllowedScope, requiredScope);
  }

  return {
    allowedScope: normalizedAllowedScope,
    requiredScope
  };
}

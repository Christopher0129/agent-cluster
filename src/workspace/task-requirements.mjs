import {
  WORKSPACE_COMMAND_SCOPES,
  clampWorkspaceCommandScope,
  describeWorkspaceCommandScope,
  normalizeWorkspaceCommandScope
} from "./command-policy.mjs";

const WORKSPACE_INSPECTION_PATTERN =
  /\b(workspace|repo|repository|codebase|git|commit|branch|diff|status|history|tree|file tree|changed files|patch|review)\b|(?:\u5de5\u4f5c\u533a|\u4ed3\u5e93|\u4ee3\u7801\u5e93|git|\u63d0\u4ea4|\u5206\u652f|\u5dee\u5f02|\u53d8\u66f4|\u72b6\u6001|\u6587\u4ef6\u6811|\u8865\u4e01|\u8bc4\u5ba1)/i;

function safeString(value) {
  return String(value || "").trim();
}

function textBlob(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => safeString(value).toLowerCase())
    .join(" ");
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizePhase(value) {
  const normalized = safeString(value).toLowerCase();
  return normalized || "implementation";
}

function taskRequiresConcreteArtifact(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return (
    /\.(docx?|pptx?|xlsx?|pdf|md|txt|csv|json)\b/.test(text) ||
    /(write|create|generate|save|export|deliver).{0,40}(file|document|report|artifact)/.test(text) ||
    /(\u6587\u4ef6|\u6587\u6863|\u62a5\u544a|\u4ea4\u4ed8\u7269|\u751f\u6210doc|\u751f\u6210docx)/.test(text)
  );
}

function taskNeedsWorkspaceInspection(task) {
  const text = textBlob(task?.title, task?.instructions, task?.expectedOutput);
  return WORKSPACE_INSPECTION_PATTERN.test(text);
}

function defaultCommandScopeForTask(task, phase) {
  const needsConcreteArtifact = taskRequiresConcreteArtifact(task);

  switch (phase) {
    case "implementation":
      return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
    case "validation":
      return WORKSPACE_COMMAND_SCOPES.VERIFY;
    case "handoff":
      if (needsConcreteArtifact) {
        return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
      }
      return taskNeedsWorkspaceInspection(task)
        ? WORKSPACE_COMMAND_SCOPES.READ_ONLY
        : WORKSPACE_COMMAND_SCOPES.NONE;
    case "research":
      return taskNeedsWorkspaceInspection(task)
        ? WORKSPACE_COMMAND_SCOPES.READ_ONLY
        : WORKSPACE_COMMAND_SCOPES.NONE;
    default:
      return WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION;
  }
}

function defaultWriteAllowanceForTask(task, phase) {
  return phase === "implementation" || taskRequiresConcreteArtifact(task);
}

function normalizeBooleanOverride(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function deriveTaskRequirements(task = {}, options = {}) {
  const sourceRequirements =
    task?.requirements && typeof task.requirements === "object" ? task.requirements : {};
  const parentRequirements =
    options.parentRequirements && typeof options.parentRequirements === "object"
      ? options.parentRequirements
      : null;
  const inheritConcreteArtifactRequirement = options.inheritConcreteArtifactRequirement !== false;
  const phase = normalizePhase(task?.phase || sourceRequirements.phase || parentRequirements?.phase);
  const inferredConcreteArtifact = taskRequiresConcreteArtifact(task);
  const defaultCommandScope = defaultCommandScopeForTask(task, phase);
  const explicitCommandScope = hasOwn(sourceRequirements, "workspaceCommandScope")
    ? normalizeWorkspaceCommandScope(
      sourceRequirements.workspaceCommandScope,
      defaultCommandScope
    )
    : defaultCommandScope;
  let allowsWorkspaceWrite = normalizeBooleanOverride(
    sourceRequirements.allowsWorkspaceWrite,
    defaultWriteAllowanceForTask(task, phase)
  );
  let allowsWorkspaceCommand = normalizeBooleanOverride(
    sourceRequirements.allowsWorkspaceCommand,
    explicitCommandScope !== WORKSPACE_COMMAND_SCOPES.NONE
  );
  let workspaceCommandScope = allowsWorkspaceCommand
    ? explicitCommandScope
    : WORKSPACE_COMMAND_SCOPES.NONE;

  if (parentRequirements) {
    const parentAllowsWrite = Boolean(parentRequirements.allowsWorkspaceWrite);
    const parentAllowsCommand = Boolean(parentRequirements.allowsWorkspaceCommand);
    if (!parentAllowsWrite) {
      allowsWorkspaceWrite = false;
    }
    if (!parentAllowsCommand) {
      allowsWorkspaceCommand = false;
      workspaceCommandScope = WORKSPACE_COMMAND_SCOPES.NONE;
    } else {
      workspaceCommandScope = clampWorkspaceCommandScope(
        workspaceCommandScope,
        parentRequirements.workspaceCommandScope || WORKSPACE_COMMAND_SCOPES.SAFE_EXECUTION
      );
      allowsWorkspaceCommand =
        allowsWorkspaceCommand && workspaceCommandScope !== WORKSPACE_COMMAND_SCOPES.NONE;
    }
  }

  return {
    phase,
    requiresWorkspaceWrite: Boolean(
      sourceRequirements.requiresWorkspaceWrite ?? allowsWorkspaceWrite
    ),
    requiresWorkspaceCommand: Boolean(
      sourceRequirements.requiresWorkspaceCommand ?? allowsWorkspaceCommand
    ),
    requiresConcreteArtifact: Boolean(
      sourceRequirements.requiresConcreteArtifact ??
        (inheritConcreteArtifactRequirement ? parentRequirements?.requiresConcreteArtifact : undefined) ??
        inferredConcreteArtifact
    ),
    allowsWorkspaceWrite,
    allowsWorkspaceCommand,
    workspaceCommandScope,
    workspaceCommandScopeDescription: describeWorkspaceCommandScope(workspaceCommandScope)
  };
}

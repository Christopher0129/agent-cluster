import { renderRuntimeCalendarNote } from "../utils/runtime-context.mjs";

function formatWorkers(workers) {
  return workers
    .map(
      (worker) =>
        `- ${worker.id}: ${worker.label} | model=${worker.model} | provider=${worker.provider} | web_search=${worker.webSearch ? "enabled" : "disabled"} | delegate_capacity=dynamic | specialties=${worker.specialties.join(", ") || "generalist"}`
    )
    .join("\n");
}

function formatWorkspaceSummary(workspaceSummary) {
  if (!workspaceSummary?.rootDir) {
    return "Workspace not configured.";
  }

  const tree =
    Array.isArray(workspaceSummary.lines) && workspaceSummary.lines.length
      ? workspaceSummary.lines.join("\n")
      : "(workspace is empty)";
  return `Workspace root: ${workspaceSummary.rootDir}\nWorkspace tree:\n${tree}`;
}

function uniqueStrings(items) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function extractIdentityTokens(task) {
  const source = String(task || "");
  const repoMatches = Array.from(source.matchAll(/\b[\w.-]+\/[\w.-]+\b/g), (match) => match[0]);
  const quotedMatches = Array.from(source.matchAll(/`([^`]+)`/g), (match) => match[1]);
  const properNounMatches = Array.from(
    source.matchAll(/\b[A-Z][A-Za-z0-9._-]{3,}\b/g),
    (match) => match[0]
  );

  return uniqueStrings([...repoMatches, ...quotedMatches, ...properNounMatches]).slice(0, 8);
}

function buildIdentityLock(task) {
  const tokens = extractIdentityTokens(task);
  if (!tokens.length) {
    return [
      "Identity lock:",
      "preserve exact product, repository, file, and proper-noun names from the user objective.",
      "If a similarly spelled entity appears, treat it as a different target until verified."
    ].join(" ");
  }

  return [
    "Identity lock:",
    `preserve and verify these exact target names before collecting evidence: ${tokens.join(", ")}.`,
    "If a source differs by repository owner, one character, or product family, treat it as out of scope unless verified."
  ].join(" ");
}

function buildArtifactGuard() {
  return [
    "Artifact guard:",
    "if a task expects a concrete file, report, or document, do not claim it was delivered unless the file was actually written and can be named precisely."
  ].join(" ");
}

function buildDateGuard() {
  return renderRuntimeCalendarNote();
}

function formatAgentBudgetSummary(complexityBudget) {
  if (!complexityBudget || typeof complexityBudget !== "object") {
    return "{}";
  }

  const requestedTotalAgents = Number(complexityBudget?.requestedTotalAgents);
  const effectiveTotalAgents = Number(complexityBudget?.maxTotalAgents);
  const automaticTotalAgents = Number(complexityBudget?.autoBudgetMaxTotalAgents);
  const lines = [];

  if (requestedTotalAgents > 0) {
    lines.push(
      `User explicitly requested ${requestedTotalAgents} total agent(s) for the whole cluster run.`
    );
    lines.push(
      "Interpret that as one run-wide total across all top-level leaders and child agents combined, not as a per-leader quota."
    );
    if (automaticTotalAgents > 0 && automaticTotalAgents !== effectiveTotalAgents) {
      lines.push(
        `Automatic complexity budgeting would have suggested ${automaticTotalAgents}, but the explicit user request overrides that automatic cap.`
      );
    }
    if (effectiveTotalAgents > 0 && effectiveTotalAgents < requestedTotalAgents) {
      lines.push(
        `Current runtime settings can effectively schedule up to ${effectiveTotalAgents} total agent(s) under the present topology and concurrency limits.`
      );
    }
  }

  lines.push(JSON.stringify(complexityBudget, null, 2));
  return lines.join("\n");
}

function formatDelegationBudgetSummary(delegateCount, runAgentBudget) {
  const summary = {
    localChildAgentAllocation: Math.max(0, Number(delegateCount) || 0),
    requestedTotalAgents:
      Number(runAgentBudget?.requestedTotalAgents) > 0
        ? Number(runAgentBudget.requestedTotalAgents)
        : null,
    effectiveTotalAgents:
      Number(runAgentBudget?.maxTotalAgents) > 0 ? Number(runAgentBudget.maxTotalAgents) : null,
    remainingRunWideChildBudget:
      Number(runAgentBudget?.remainingChildAgents) >= 0
        ? Number(runAgentBudget.remainingChildAgents)
        : null,
    budgetSource: String(runAgentBudget?.budgetSource || "complexity_profile")
  };

  return JSON.stringify(summary, null, 2);
}

export function buildPlanningRequest({
  task,
  workers,
  maxParallel,
  workspaceSummary = null,
  delegateMaxDepth = 1,
  delegateBranchFactor = 0,
  complexityBudget = null,
  capabilityRoutingPolicySummary = ""
}) {
  return {
    instructions: [
      "You are the controller of a multi-model agent cluster.",
      buildDateGuard(),
      "Break the user objective into concrete subtasks that can be executed by the listed group leaders.",
      "Never infer a different 'actual current date' from background knowledge. Use only the authoritative runtime clock provided below.",
      "Use staged workflow phases when helpful: research -> implementation -> validation -> handoff.",
      "Favor parallel execution unless a dependency is truly necessary.",
      Number(complexityBudget?.requestedTotalAgents) > 0
        ? `The user explicitly requested ${complexityBudget.requestedTotalAgents} total agents for the whole run. Treat that as one global cluster-wide total, not as a per-task or per-leader quota.`
        : "Apply the agent budget as a run-wide limit, not a per-task quota.",
      "Treat the listed specialties as the primary routing hints when assigning tasks to group leaders.",
      "Use only the worker ids provided to you.",
      "Prefer workers with web_search=enabled for tasks that require fresh facts, case collection, public-source verification, or browsing.",
      "Do not assign web-search-dependent work to workers whose web_search capability is disabled when a web-search-enabled worker is available.",
      "If the task depends on current facts, real-world examples, or source verification, use web search when your model supports it.",
      "For search-heavy research, split the work into smaller batches. Prefer roughly 4-8 verified examples, cases, or evidence items per research subtask instead of large quotas in one task.",
      "If several workers share the same provider or base URL, avoid overloading that gateway with too many simultaneous search tasks.",
      "Do not invent sources, cases, URLs, or evidence that you did not actually verify.",
      "If a coding or file-producing task is involved, assign at least one worker to inspect and modify the workspace.",
      buildIdentityLock(task),
      buildArtifactGuard(),
      "When the user asks for a concrete document or file, make that expected artifact explicit in expectedOutput.",
      "Return JSON only.",
      'Schema: {"objective":"string","strategy":"string","tasks":[{"id":"task_1","phase":"research|implementation|validation|handoff","title":"string","assignedWorker":"worker_id","delegateCount":0,"instructions":"string","dependsOn":["task_0"],"expectedOutput":"string"}]}'
    ].join(" "),
    input: [
      `User objective:\n${task}`,
      `Current local date context:\n${buildDateGuard()}`,
      `Available workers:\n${formatWorkers(workers)}`,
      `Workspace context:\n${formatWorkspaceSummary(workspaceSummary)}`,
      `Delegation limits:\nmax_depth=${Math.max(0, Number(delegateMaxDepth) || 0)}\nmax_children_per_parent=${Math.max(0, Number(delegateBranchFactor) || 0)}`,
      `Hard limit: no more than ${Math.max(1, Number(maxParallel) || 0)} top-level subtasks unless absolutely necessary.`,
      complexityBudget
        ? `Agent budget:\n${formatAgentBudgetSummary(complexityBudget)}`
        : "Agent budget:\n{}",
      capabilityRoutingPolicySummary
        ? `Capability routing policy:\n${capabilityRoutingPolicySummary}`
        : "Capability routing policy:\ndefault"
    ].join("\n\n")
  };
}

export function buildWorkerExecutionRequest({
  originalTask,
  clusterPlan,
  worker,
  task,
  dependencyOutputs
}) {
  return {
    instructions: [
      `You are ${worker.label}, a specialist worker inside a multi-model cluster.`,
      buildDateGuard(),
      "Complete only the assigned subtask and stay scoped.",
      "Never state that the actual current date is different from the authoritative runtime clock below.",
      "Be explicit about uncertainty and concrete about recommendations.",
      "Respect the assigned workflow phase.",
      "If the subtask requires current facts, public examples, or source verification, use web search when your model supports it.",
      "For search-heavy research, prefer a smaller fully verified batch over a larger unverified list.",
      "Never fabricate examples, URLs, citations, or case studies.",
      buildIdentityLock(originalTask),
      buildArtifactGuard(),
      "If the task expects a file or document and you cannot point to the exact artifact, report that gap as a risk and do not mark verificationStatus as passed.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought; keep it concise and safe for display.",
      "Return JSON only.",
      'Schema: {"thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"generatedFiles":["string"],"confidence":"low|medium|high","followUps":["string"],"verificationStatus":"not_applicable|passed|failed"}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Current local date context:\n${buildDateGuard()}`,
      `Worker capabilities:\nweb_search=${worker.webSearch ? "enabled" : "disabled"}`,
      `Assigned workflow phase:\n${task.phase || "implementation"}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned subtask:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]"
    ].join("\n\n")
  };
}

export function buildLeaderDelegationRequest({
  originalTask,
  clusterPlan,
  leader,
  task,
  dependencyOutputs,
  delegateCount,
  depthRemaining,
  runAgentBudget = null
}) {
  return {
    instructions: [
      `You are ${leader.label}, an agent inside a multi-model cluster.`,
      buildDateGuard(),
      `You may create up to ${delegateCount} child agents for this assignment.`,
      Number(runAgentBudget?.requestedTotalAgents) > 0
        ? `The user explicitly requested ${runAgentBudget.requestedTotalAgents} total agents for the whole cluster run. That number applies to the entire run across all top-level leaders and child agents combined, not to this single parent task.`
        : "Any child-agent budget you see is a local branch allocation inside a larger run-wide budget.",
      "Do not complain that your local child-agent allocation is smaller than the user's global request; use your local allocation as this branch's assigned share of the overall run.",
      `Recursive delegation depth remaining after this decision: ${Math.max(0, Number(depthRemaining) || 0)}.`,
      "Never reinterpret the current date from background knowledge. Use only the authoritative runtime clock below when judging whether a date is historical or future.",
      "You may also choose 0 child agents if the task is already atomic and should be executed directly.",
      "When child-agent budget is available and the task is not obviously atomic, prefer delegating to child agents instead of executing everything yourself.",
      "If you delegate, child tasks must be narrower, non-overlapping, and independently executable whenever possible.",
      "For coding or workspace tasks, avoid assigning overlapping file edits to different child agents.",
      "For research tasks, split by source bucket, case batch, or question cluster to reduce duplicated browsing.",
      "Do not make sibling child agents depend on another sibling's not-yet-written workspace file. Have siblings return findings to you, and let the parent synthesize any shared artifact.",
      "Only assign a child agent to write a workspace artifact when that child owns a unique file path that is not shared with sibling subtasks.",
      `Child agents inherit this model capability set: web_search=${leader.webSearch ? "enabled" : "disabled"}. Do not design child subtasks that require web search when web_search is disabled.`,
      buildIdentityLock(originalTask),
      buildArtifactGuard(),
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      'Schema: {"thinkingSummary":"string","delegationSummary":"string","delegateCount":0,"subtasks":[{"id":"sub_1","title":"string","instructions":"string","expectedOutput":"string"}]}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Current local date context:\n${buildDateGuard()}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned agent task:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Delegation budget:\n${formatDelegationBudgetSummary(delegateCount, runAgentBudget)}`
    ].join("\n\n")
  };
}

export function buildLeaderSynthesisRequest({
  originalTask,
  clusterPlan,
  leader,
  task,
  dependencyOutputs,
  subordinateResults
}) {
  return {
    instructions: [
      `You are ${leader.label}, an agent synthesizing child-agent results.`,
      buildDateGuard(),
      "Merge the child outputs into one coherent result for the assigned task.",
      "Never state that the actual current date differs from the authoritative runtime clock below.",
      "Resolve overlaps, highlight conflicts, and preserve concrete evidence or file outputs.",
      buildIdentityLock(originalTask),
      buildArtifactGuard(),
      "Do not claim verification passed if child results failed verification or could not prove the requested artifact exists.",
      "Provide a short public thinking summary that can be shown in a UI. Do not reveal hidden chain-of-thought.",
      "Return JSON only.",
      'Schema: {"thinkingSummary":"string","summary":"string","keyFindings":["string"],"risks":["string"],"deliverables":["string"],"generatedFiles":["string"],"confidence":"low|medium|high","followUps":["string"],"delegationNotes":["string"],"verificationStatus":"not_applicable|passed|failed"}'
    ].join(" "),
    input: [
      `Overall objective:\n${originalTask}`,
      `Current local date context:\n${buildDateGuard()}`,
      `Cluster strategy:\n${clusterPlan.strategy}`,
      `Assigned agent task:\n${JSON.stringify(task, null, 2)}`,
      dependencyOutputs.length
        ? `Dependency outputs:\n${JSON.stringify(dependencyOutputs, null, 2)}`
        : "Dependency outputs:\n[]",
      `Child-agent outputs:\n${JSON.stringify(subordinateResults, null, 2)}`
    ].join("\n\n")
  };
}

export function buildSynthesisRequest({ task, plan, executions }) {
  return {
    instructions: [
      "You are the controller synthesizing outputs from a multi-model cluster.",
      buildDateGuard(),
      "Never override the authoritative runtime clock with model priors or background assumptions.",
      "Produce a final answer for the user that resolves overlaps and highlights disagreements.",
      "If source-backed verification is required and your model supports web search, use it before finalizing claims.",
      "Do not upgrade uncertain or unverified claims into facts.",
      buildIdentityLock(task),
      buildArtifactGuard(),
      "Return JSON only.",
      'Schema: {"finalAnswer":"string","executiveSummary":["string"],"consensus":["string"],"disagreements":["string"],"nextActions":["string"]}'
    ].join(" "),
    input: [
      `Original user objective:\n${task}`,
      `Current local date context:\n${buildDateGuard()}`,
      `Plan:\n${JSON.stringify(plan, null, 2)}`,
      `Worker outputs:\n${JSON.stringify(executions, null, 2)}`
    ].join("\n\n")
  };
}

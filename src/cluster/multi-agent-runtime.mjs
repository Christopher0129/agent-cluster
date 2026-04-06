const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  mode: "group_chat",
  speakerStrategy: "phase_priority",
  maxRounds: 16,
  terminationKeyword: "TERMINATE",
  messageWindow: 28,
  summarizeLongMessages: true,
  includeSystemMessages: true
});

const SUPPORTED_MODES = new Set(["group_chat", "sequential", "workflow"]);
const SUPPORTED_SPEAKER_STRATEGIES = new Set(["round_robin", "phase_priority", "random"]);

function safeString(value) {
  return String(value || "").trim();
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.floor(number);
}

export function normalizeMultiAgentRuntimeSettings(value, fallback = DEFAULT_SETTINGS) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_SETTINGS;
  const normalizedMode = safeString(source.mode || backup.mode).toLowerCase();
  const normalizedSpeakerStrategy = safeString(
    source.speakerStrategy || backup.speakerStrategy
  ).toLowerCase();

  return {
    enabled: Boolean(source.enabled ?? backup.enabled ?? DEFAULT_SETTINGS.enabled),
    mode: SUPPORTED_MODES.has(normalizedMode)
      ? normalizedMode
      : backup.mode || DEFAULT_SETTINGS.mode,
    speakerStrategy: SUPPORTED_SPEAKER_STRATEGIES.has(normalizedSpeakerStrategy)
      ? normalizedSpeakerStrategy
      : backup.speakerStrategy || DEFAULT_SETTINGS.speakerStrategy,
    maxRounds: normalizePositiveInteger(
      source.maxRounds,
      normalizePositiveInteger(backup.maxRounds, DEFAULT_SETTINGS.maxRounds)
    ),
    terminationKeyword:
      safeString(source.terminationKeyword || backup.terminationKeyword) ||
      DEFAULT_SETTINGS.terminationKeyword,
    messageWindow: normalizePositiveInteger(
      source.messageWindow,
      normalizePositiveInteger(backup.messageWindow, DEFAULT_SETTINGS.messageWindow)
    ),
    summarizeLongMessages:
      source.summarizeLongMessages ?? backup.summarizeLongMessages ?? true,
    includeSystemMessages:
      source.includeSystemMessages ?? backup.includeSystemMessages ?? true
  };
}

function truncateContent(content, summarizeLongMessages) {
  const normalized = safeString(content).replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (!summarizeLongMessages || normalized.length <= 320) {
    return normalized;
  }

  return `${normalized.slice(0, 317)}...`;
}

function matchesTerminationKeyword(content, terminationKeyword) {
  const keyword = safeString(terminationKeyword);
  if (!keyword) {
    return false;
  }
  return String(content || "").toLowerCase().includes(keyword.toLowerCase());
}

export function createMultiAgentRuntime(rawSettings = {}) {
  const settings = normalizeMultiAgentRuntimeSettings(rawSettings);
  const messages = [];
  const participants = new Map();
  const phaseCounts = new Map();
  let nextMessageId = 0;
  let turnCount = 0;
  let totalMessageCount = 0;
  let foldedMessageCount = 0;
  let terminatedByKeyword = false;
  let summaryText = "";
  let objective = "";
  let status = settings.enabled ? "idle" : "disabled";
  let startedAt = "";
  let endedAt = "";

  function registerParticipant(agent, kind = "agent") {
    const agentId = safeString(agent?.runtimeId || agent?.agentId || agent?.id);
    if (!agentId) {
      return null;
    }

    const current = participants.get(agentId) || {
      id: agentId,
      label: safeString(agent?.displayLabel || agent?.agentLabel || agent?.label || agentId),
      kind: safeString(agent?.agentKind || kind || "agent") || "agent",
      messageCount: 0
    };
    current.label = safeString(agent?.displayLabel || agent?.agentLabel || agent?.label || current.label);
    current.kind = safeString(agent?.agentKind || kind || current.kind) || current.kind;
    current.messageCount += 1;
    participants.set(agentId, current);
    return current;
  }

  function pushMessage({
    kind = "message",
    stage = "",
    tone = "neutral",
    phase = "",
    speaker = null,
    target = null,
    content = "",
    summaryType = "",
    taskTitle = "",
    artifactPath = "",
    query = "",
    sourceStage = ""
  }) {
    if (!settings.enabled) {
      return null;
    }

    const normalizedContent = truncateContent(content, settings.summarizeLongMessages);
    if (!normalizedContent && kind !== "summary") {
      return null;
    }

    const shouldCountAsTurn = kind === "message";
    if (kind === "system" && !settings.includeSystemMessages) {
      return null;
    }

    if (shouldCountAsTurn && turnCount >= settings.maxRounds) {
      foldedMessageCount += 1;
      const lastFoldedSummary = messages.findLast(
        (entry) => entry.kind === "summary" && entry.summaryType === "folded"
      );
      if (lastFoldedSummary) {
        lastFoldedSummary.foldedCount = foldedMessageCount;
        lastFoldedSummary.content = `Folded ${foldedMessageCount} additional collaboration message(s) after reaching the round cap.`;
        return null;
      }

      const foldedSummary = {
        id: `ma_${String(++nextMessageId).padStart(4, "0")}`,
        kind: "summary",
        summaryType: "folded",
        stage: stage || "multi_agent_session_summary",
        tone: "warning",
        phase: safeString(phase),
        round: turnCount,
        timestamp: new Date().toISOString(),
        speakerId: "",
        speakerLabel: "",
        targetId: "",
        targetLabel: "",
        content: "Folded 1 additional collaboration message after reaching the round cap.",
        foldedCount: 1
      };
      messages.push(foldedSummary);
      totalMessageCount += 1;
      return foldedSummary;
    }

    if (shouldCountAsTurn) {
      turnCount += 1;
    }

    const speakerEntry = registerParticipant(speaker, kind);
    const targetEntry = target ? registerParticipant(target, "agent") : null;
    const normalizedPhase = safeString(phase);
    if (normalizedPhase) {
      phaseCounts.set(normalizedPhase, (phaseCounts.get(normalizedPhase) || 0) + 1);
    }

    const entry = {
      id: `ma_${String(++nextMessageId).padStart(4, "0")}`,
      kind,
      summaryType: safeString(summaryType),
      stage: safeString(stage),
      sourceStage: safeString(sourceStage || stage),
      tone: safeString(tone) || "neutral",
      phase: normalizedPhase,
      round: turnCount,
      timestamp: new Date().toISOString(),
      speakerId: speakerEntry?.id || "",
      speakerLabel: speakerEntry?.label || "",
      targetId: targetEntry?.id || "",
      targetLabel: targetEntry?.label || "",
      content: normalizedContent,
      taskTitle: safeString(taskTitle),
      artifactPath: safeString(artifactPath),
      query: safeString(query)
    };

    totalMessageCount += 1;
    terminatedByKeyword =
      terminatedByKeyword || matchesTerminationKeyword(normalizedContent, settings.terminationKeyword);
    messages.push(entry);
    return entry;
  }

  function start({ task = "", controller = null, detail = "" } = {}) {
    if (!settings.enabled) {
      return null;
    }

    objective = safeString(task);
    startedAt = new Date().toISOString();
    status = "running";

    return pushMessage({
      kind: "system",
      stage: "multi_agent_session_start",
      tone: "neutral",
      phase: "",
      speaker: controller,
      content:
        safeString(detail) ||
        `Multi-agent collaboration started in ${settings.mode} mode with ${settings.speakerStrategy} speaker strategy.`
    });
  }

  function recordSystem(payload = {}) {
    return pushMessage({
      kind: "system",
      stage: payload.stage || "multi_agent_message",
      tone: payload.tone || "neutral",
      phase: payload.phase || "",
      speaker: payload.speaker || null,
      target: payload.target || null,
      content: payload.content || payload.detail || "",
      summaryType: payload.summaryType || "",
      taskTitle: payload.taskTitle || "",
      artifactPath: payload.artifactPath || "",
      query: payload.query || "",
      sourceStage: payload.sourceStage || payload.stage || ""
    });
  }

  function recordMessage(payload = {}) {
    return pushMessage({
      kind: payload.kind || "message",
      stage: payload.stage || "multi_agent_message",
      tone: payload.tone || "neutral",
      phase: payload.phase || "",
      speaker: payload.speaker || null,
      target: payload.target || null,
      content: payload.content || payload.detail || "",
      summaryType: payload.summaryType || "",
      taskTitle: payload.taskTitle || "",
      artifactPath: payload.artifactPath || "",
      query: payload.query || "",
      sourceStage: payload.sourceStage || payload.stage || ""
    });
  }

  function recordSummary(payload = {}) {
    const nextSummary = safeString(payload.content || payload.detail);
    if (nextSummary) {
      summaryText = nextSummary;
    }

    return pushMessage({
      kind: "summary",
      stage: payload.stage || "multi_agent_session_summary",
      tone: payload.tone || "ok",
      phase: payload.phase || "",
      speaker: payload.speaker || null,
      target: payload.target || null,
      content: nextSummary,
      summaryType: payload.summaryType || "summary",
      taskTitle: payload.taskTitle || "",
      artifactPath: payload.artifactPath || "",
      query: payload.query || "",
      sourceStage: payload.sourceStage || payload.stage || ""
    });
  }

  function complete({ content = "", tone = "ok" } = {}) {
    if (!settings.enabled) {
      return null;
    }

    endedAt = new Date().toISOString();
    status = terminatedByKeyword ? "terminated" : "completed";
    const finalSummary =
      safeString(content) ||
      summaryText ||
      `Multi-agent collaboration completed with ${turnCount} visible turn(s).`;
    summaryText = finalSummary;

    return recordSummary({
      stage: "multi_agent_session_summary",
      tone,
      content: finalSummary,
      summaryType: "final"
    });
  }

  function buildSnapshot() {
    const visibleMessages = messages.slice(-Math.max(1, settings.messageWindow));
    return {
      enabled: settings.enabled,
      settings,
      status,
      objective,
      startedAt,
      endedAt,
      rounds: turnCount,
      totalMessageCount,
      foldedMessageCount,
      terminatedByKeyword,
      summary: summaryText,
      participantCount: participants.size,
      participants: Array.from(participants.values()).sort((left, right) =>
        left.label.localeCompare(right.label)
      ),
      phaseCounts: Object.fromEntries(phaseCounts.entries()),
      messages: visibleMessages
    };
  }

  return {
    settings,
    isEnabled() {
      return settings.enabled;
    },
    start,
    recordMessage,
    recordSummary,
    recordSystem,
    complete,
    buildSnapshot
  };
}

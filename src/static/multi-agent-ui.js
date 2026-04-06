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

const CHATTY_STAGE_KINDS = new Map([
  ["multi_agent_chat", "message"],
  ["planning_start", "system"],
  ["planning_done", "summary"],
  ["phase_start", "system"],
  ["phase_done", "system"],
  ["worker_start", "message"],
  ["worker_done", "summary"],
  ["leader_delegate_start", "message"],
  ["leader_delegate_done", "message"],
  ["leader_synthesis_start", "message"],
  ["subagent_created", "message"],
  ["subagent_start", "message"],
  ["subagent_done", "summary"],
  ["worker_fallback", "summary"],
  ["controller_fallback", "summary"],
  ["planning_retry", "system"],
  ["worker_retry", "system"],
  ["subagent_retry", "system"],
  ["leader_delegate_retry", "system"],
  ["leader_synthesis_retry", "system"],
  ["synthesis_start", "system"],
  ["synthesis_retry", "system"],
  ["workspace_list", "message"],
  ["workspace_read", "message"],
  ["workspace_write", "message"],
  ["workspace_web_search", "message"],
  ["workspace_command", "message"],
  ["workspace_tool_blocked", "message"],
  ["workspace_json_repair", "message"],
  ["memory_read", "message"],
  ["memory_write", "message"],
  ["circuit_opened", "system"],
  ["circuit_half_open", "system"],
  ["circuit_closed", "system"],
  ["circuit_blocked", "system"],
  ["validation_gate_failed", "system"],
  ["cancel_requested", "system"],
  ["cluster_done", "summary"],
  ["cluster_cancelled", "summary"],
  ["cluster_failed", "summary"]
]);

const CONVERSATIONAL_STAGE_SET = new Set([
  "multi_agent_chat",
  "leader_delegate_start",
  "leader_delegate_done",
  "subagent_created",
  "worker_start",
  "subagent_start",
  "leader_synthesis_start",
  "worker_done",
  "subagent_done",
  "worker_fallback",
  "controller_fallback"
]);

function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function resolveRuntimeLocale() {
  if (typeof document !== "undefined" && String(document.documentElement?.lang || "").toLowerCase().startsWith("en")) {
    return "en-US";
  }
  return "zh-CN";
}

function localizeConversationText(locale, englishText, chineseText) {
  return locale === "zh-CN" ? chineseText : englishText;
}

function createFallbackTranslator() {
  const catalog = {
    "zh-CN": {
      "multiAgent.mode.group_chat": "动态群聊",
      "multiAgent.mode.sequential": "顺序协作",
      "multiAgent.mode.workflow": "嵌套工具流",
      "multiAgent.strategy.round_robin": "轮询发言",
      "multiAgent.strategy.phase_priority": "阶段优先",
      "multiAgent.strategy.random": "随机发言",
      "multiAgent.hint.disabled": "关闭后维持当前原始集群编排，右侧协作区仅保留说明。",
      "multiAgent.hint.enabled": "开启后会记录协作消息、阶段接力和最终会话快照。群聊模式保留并行，顺序模式会串行化顶层任务，嵌套工具流模式会强化阶段交接与产物链路。",
      "multiAgent.status.disabled": "未启用",
      "multiAgent.status.ready": "等待运行",
      "multiAgent.status.running": "协作中",
      "multiAgent.status.completed": "已完成",
      "multiAgent.status.terminated": "已终止",
      "multiAgent.meta": "参与智能体 {participants}",
      "multiAgent.chat.title": "协作聊天室",
      "multiAgent.chat.copy.disabled": "开启左侧多智能体框架后，这里会展示主控、组长和子代理之间的交流细节。",
      "multiAgent.chat.copy.ready": "运行任务后，这里会按会话窗口实时展示协作过程与结果回放。",
      "multiAgent.chat.empty": "当前还没有协作消息。",
      "multiAgent.chat.summary.participants": "参与智能体",
      "multiAgent.chat.summary.none": "等待运行后生成会话摘要。",
      "multiAgent.chat.folded": "超过轮次上限的协作消息已折叠 {count} 条。",
      "multiAgent.chat.target": "发送给 {target}",
      "multiAgent.chat.task": "任务",
      "multiAgent.chat.artifact": "产物",
      "multiAgent.chat.query": "搜索",
      "multiAgent.chat.phase.research": "调研",
      "multiAgent.chat.phase.implementation": "实现",
      "multiAgent.chat.phase.validation": "验证",
      "multiAgent.chat.phase.handoff": "交付"
    },
    "en-US": {
      "multiAgent.mode.group_chat": "Group Chat",
      "multiAgent.mode.sequential": "Sequential",
      "multiAgent.mode.workflow": "Nested Tool Flow",
      "multiAgent.strategy.round_robin": "Round Robin",
      "multiAgent.strategy.phase_priority": "Phase Priority",
      "multiAgent.strategy.random": "Random",
      "multiAgent.hint.disabled": "When disabled, the cluster keeps the original orchestration and the chatroom stays as an explanation panel.",
      "multiAgent.hint.enabled": "When enabled, the app records collaboration messages, phase handoffs, and the final session snapshot. Group chat keeps parallel execution, sequential mode serializes top-level tasks, and nested tool flow strengthens staged handoffs and artifact contracts.",
      "multiAgent.status.disabled": "Disabled",
      "multiAgent.status.ready": "Ready",
      "multiAgent.status.running": "Running",
      "multiAgent.status.completed": "Completed",
      "multiAgent.status.terminated": "Terminated",
      "multiAgent.meta": "Participants {participants}",
      "multiAgent.chat.title": "Agent Chatroom",
      "multiAgent.chat.copy.disabled": "Enable the multi-agent framework on the left to inspect controller, leader, and child-agent collaboration here.",
      "multiAgent.chat.copy.ready": "Run a task to stream collaboration updates and synthesis handoff details into this chatroom.",
      "multiAgent.chat.empty": "No collaboration messages yet.",
      "multiAgent.chat.summary.participants": "Participants",
      "multiAgent.chat.summary.none": "The session summary appears here after a run starts.",
      "multiAgent.chat.folded": "{count} collaboration message(s) were folded after reaching the round cap.",
      "multiAgent.chat.target": "To {target}",
      "multiAgent.chat.task": "Task",
      "multiAgent.chat.artifact": "Artifact",
      "multiAgent.chat.query": "Search",
      "multiAgent.chat.phase.research": "Research",
      "multiAgent.chat.phase.implementation": "Implementation",
      "multiAgent.chat.phase.validation": "Validation",
      "multiAgent.chat.phase.handoff": "Handoff"
    }
  };

  return (key, values = {}) =>
    interpolate(catalog[resolveRuntimeLocale()]?.[key] ?? catalog["zh-CN"]?.[key] ?? key, values);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeChoice(value, supportedValues, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return supportedValues.has(normalized) ? normalized : fallback;
}

function normalizeSettings(value, fallback = DEFAULT_SETTINGS) {
  const source = value && typeof value === "object" ? value : {};
  const backup = fallback && typeof fallback === "object" ? fallback : DEFAULT_SETTINGS;

  return {
    enabled: Boolean(source.enabled ?? backup.enabled ?? DEFAULT_SETTINGS.enabled),
    mode: normalizeChoice(
      source.mode ?? backup.mode,
      new Set(["group_chat", "sequential", "workflow"]),
      DEFAULT_SETTINGS.mode
    ),
    speakerStrategy: normalizeChoice(
      source.speakerStrategy ?? backup.speakerStrategy,
      new Set(["round_robin", "phase_priority", "random"]),
      DEFAULT_SETTINGS.speakerStrategy
    ),
    maxRounds: normalizePositiveInteger(source.maxRounds, backup.maxRounds ?? DEFAULT_SETTINGS.maxRounds),
    terminationKeyword:
      String(source.terminationKeyword ?? backup.terminationKeyword ?? DEFAULT_SETTINGS.terminationKeyword).trim() ||
      DEFAULT_SETTINGS.terminationKeyword,
    messageWindow: normalizePositiveInteger(
      source.messageWindow,
      backup.messageWindow ?? DEFAULT_SETTINGS.messageWindow
    ),
    summarizeLongMessages: source.summarizeLongMessages ?? backup.summarizeLongMessages ?? true,
    includeSystemMessages: source.includeSystemMessages ?? backup.includeSystemMessages ?? true
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resolvePhaseLabel(phase, translate) {
  const normalized = String(phase || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return translate(`multiAgent.chat.phase.${normalized}`);
}

function summarizeContent(content, settings) {
  const normalized = String(content || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  if (!settings.summarizeLongMessages || normalized.length <= 320) {
    return normalized;
  }

  return `${normalized.slice(0, 317)}...`;
}

function isConversationalStage(stage) {
  return CONVERSATIONAL_STAGE_SET.has(String(stage || "").trim());
}

function isGroupDiscussionSourceStage(sourceStage) {
  const normalized = String(sourceStage || "").trim().toLowerCase();
  return normalized === "multi_agent_discussion" || normalized.startsWith("multi_agent_discussion_");
}

function shouldRenderChatEntryForMode(entry, settings) {
  if (!entry || !isConversationalStage(entry.stage)) {
    return false;
  }

  const mode = String(settings?.mode || DEFAULT_SETTINGS.mode)
    .trim()
    .toLowerCase();
  if (mode !== "group_chat") {
    return true;
  }

  return entry.stage === "multi_agent_chat" && isGroupDiscussionSourceStage(entry.sourceStage || entry.stage);
}

function resolveChatContentFromCandidates(candidates, settings) {
  for (const value of candidates) {
    const normalized = summarizeContent(value, settings);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function resolveChatContentFromEvent(event, settings) {
  const resolved = resolveChatContentFromCandidates(
    [event?.content, event?.summary, event?.thinkingSummary, event?.detail],
    settings
  );
  if (resolved) {
    return resolved;
  }

  return summarizeContent(event?.taskTitle || "", settings);
}

function joinConversationParts(parts) {
  return parts
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildMessageContextItems(entry, settings, translate) {
  const items = [];
  const taskTitle = summarizeContent(entry?.taskTitle || "", settings);
  const artifactPath = summarizeContent(entry?.artifactPath || "", settings);
  const query = summarizeContent(entry?.query || "", settings);

  if (taskTitle) {
    items.push({
      key: "task",
      label: translate("multiAgent.chat.task"),
      value: taskTitle
    });
  }
  if (artifactPath) {
    items.push({
      key: "artifact",
      label: translate("multiAgent.chat.artifact"),
      value: artifactPath
    });
  }
  if (query) {
    items.push({
      key: "query",
      label: translate("multiAgent.chat.query"),
      value: query
    });
  }

  return items;
}

function resolveQuotedTaskTitle(taskTitle, fallback) {
  const normalized = String(taskTitle || "").trim();
  return normalized
    ? resolveRuntimeLocale() === "zh-CN"
      ? `“${normalized}”`
      : `"${normalized}"`
    : fallback;
}

function buildConversationalContent(event, settings) {
  const locale = resolveRuntimeLocale();
  const stage = String(event?.stage || "").trim();
  const taskTitle = summarizeContent(event?.taskTitle || "", settings);
  const defaultDetail = resolveChatContentFromEvent(event, settings);
  const taskSpecificDetail = resolveChatContentFromCandidates(
    [event?.summary, event?.content, event?.thinkingSummary, event?.detail],
    settings
  );
  const technicalDetail = resolveChatContentFromCandidates(
    [event?.detail, event?.summary, event?.thinkingSummary, event?.content],
    settings
  );
  const taskLabel = resolveQuotedTaskTitle(taskTitle, locale === "zh-CN" ? "该任务" : "this task");
  const childTaskLabel = resolveQuotedTaskTitle(
    taskTitle,
    locale === "zh-CN" ? "该子任务" : "this child task"
  );

  switch (stage) {
    case "leader_delegate_start":
      return joinConversationParts([
        localizeConversationText(locale, `I'm splitting ${taskLabel} into child assignments.`, `我来把 ${taskLabel} 拆成若干子任务。`),
        taskSpecificDetail && taskSpecificDetail !== taskTitle
          ? localizeConversationText(locale, `Focus: ${taskSpecificDetail}`, `重点：${taskSpecificDetail}`)
          : ""
      ]);
    case "leader_delegate_done":
      return joinConversationParts([
        localizeConversationText(locale, "Delegation plan ready.", "分工计划已确定。"),
        technicalDetail && technicalDetail !== taskTitle ? technicalDetail : ""
      ]);
    case "worker_start":
      return joinConversationParts([
        localizeConversationText(locale, `I'm taking ${taskLabel}.`, `我来处理 ${taskLabel}。`),
        taskSpecificDetail && taskSpecificDetail !== taskTitle
          ? localizeConversationText(locale, `Plan: ${taskSpecificDetail}`, `计划：${taskSpecificDetail}`)
          : ""
      ]);
    case "subagent_created":
      return joinConversationParts([
        localizeConversationText(locale, `Please take ${childTaskLabel}.`, `请接手 ${childTaskLabel}。`),
        taskSpecificDetail && taskSpecificDetail !== taskTitle
          ? localizeConversationText(locale, `Focus: ${taskSpecificDetail}`, `重点：${taskSpecificDetail}`)
          : ""
      ]);
    case "subagent_start":
      return joinConversationParts([
        localizeConversationText(locale, `Acknowledged ${childTaskLabel}.`, `已接单，开始处理 ${childTaskLabel}。`),
        taskSpecificDetail && taskSpecificDetail !== taskTitle
          ? localizeConversationText(locale, `Plan: ${taskSpecificDetail}`, `计划：${taskSpecificDetail}`)
          : localizeConversationText(locale, "Starting now.", "马上开始。")
      ]);
    case "leader_synthesis_start":
      return joinConversationParts([
        localizeConversationText(locale, "I'm merging the child outputs into one answer.", "我正在汇总子任务结果。"),
        taskSpecificDetail && taskSpecificDetail !== taskTitle ? taskSpecificDetail : ""
      ]);
    case "worker_done":
      return joinConversationParts([
        localizeConversationText(locale, `Finished ${taskLabel}.`, `已完成 ${taskLabel}。`),
        taskSpecificDetail && taskSpecificDetail !== taskTitle
          ? localizeConversationText(locale, `Result: ${taskSpecificDetail}`, `结果：${taskSpecificDetail}`)
          : ""
      ]);
    case "subagent_done":
      return joinConversationParts([
        localizeConversationText(locale, `Completed ${childTaskLabel}.`, `已完成 ${childTaskLabel}。`),
        taskSpecificDetail && taskSpecificDetail !== taskTitle
          ? localizeConversationText(locale, `Result: ${taskSpecificDetail}`, `结果：${taskSpecificDetail}`)
          : ""
      ]);
    case "worker_fallback":
      return joinConversationParts([
        localizeConversationText(locale, "Rerouted after a provider failure.", "因 provider 故障已切换执行者。"),
        technicalDetail && technicalDetail !== taskTitle ? technicalDetail : ""
      ]);
    case "controller_fallback":
      return joinConversationParts([
        localizeConversationText(locale, "Controller fallback engaged.", "主控已切换到备用模型。"),
        technicalDetail && technicalDetail !== taskTitle ? technicalDetail : ""
      ]);
    default:
      return defaultDetail;
  }
}

function shouldIgnoreEvent(event) {
  const stage = String(event?.stage || "").trim();
  return (
    !stage ||
    stage === "submitted" ||
    stage === "session_update" ||
    stage.startsWith("trace_") ||
    stage.startsWith("model_test_")
  );
}

function createEmptySession(settings) {
  return {
    enabled: settings.enabled,
    settings,
    status: settings.enabled ? "ready" : "disabled",
    objective: "",
    startedAt: "",
    endedAt: "",
    rounds: 0,
    totalMessageCount: 0,
    foldedMessageCount: 0,
    terminatedByKeyword: false,
    summary: "",
    participantCount: 0,
    participants: [],
    phaseCounts: {},
    messages: []
  };
}

function upsertParticipant(session, speakerLabel = "") {
  const label = String(speakerLabel || "").trim();
  if (!label) {
    return;
  }

  const existing = session.participants.find((item) => item.label === label);
  if (existing) {
    existing.messageCount += 1;
  } else {
    session.participants.push({
      id: label,
      label,
      kind: "agent",
      messageCount: 1
    });
  }
  session.participantCount = session.participants.length;
}

export function buildChatEntryFromEvent(event, settings) {
  if (shouldIgnoreEvent(event)) {
    return null;
  }

  const stage = String(event.stage || "").trim();
  if (stage === "multi_agent_chat") {
    const content = summarizeContent(event?.content || "", settings);
    if (!content) {
      return null;
    }
    const entryKind = String(event.kind || "message").trim() || "message";
    if (!settings.includeSystemMessages && entryKind === "system") {
      return null;
    }
    return {
      id: String(event.id || `${stage}:${event.timestamp || Date.now()}`),
      kind: entryKind,
      stage,
      tone: String(event.tone || "neutral").trim() || "neutral",
      phase: String(event.phase || "").trim(),
      round: Number(event.round || 0),
      timestamp: String(event.timestamp || new Date().toISOString()),
      speakerLabel: String(event.speakerLabel || event.speaker?.displayLabel || event.speaker?.label || "").trim(),
      targetLabel: String(event.targetLabel || event.target?.displayLabel || event.target?.label || "").trim(),
      content,
      summaryType: String(event.summaryType || "").trim(),
      taskTitle: String(event.taskTitle || "").trim(),
      artifactPath: String(event.artifactPath || "").trim(),
      query: String(event.query || "").trim(),
      sourceStage: String(event.sourceStage || event.stage || "").trim()
    };
  }
  if (!isConversationalStage(stage)) {
    return null;
  }
  const kind = CHATTY_STAGE_KINDS.get(stage);
  if (!kind) {
    return null;
  }

  if (!settings.includeSystemMessages && kind === "system") {
    return null;
  }

  const sourceLabel = String(event.agentLabel || event.modelLabel || event.parentAgentLabel || "").trim();
  const speakerLabel =
    stage === "subagent_created"
      ? String(event.parentAgentLabel || event.agentLabel || "").trim()
      : sourceLabel;
  const targetLabel =
    String(
      event.targetAgentLabel ||
        (stage === "subagent_created"
          ? event.agentLabel
          : stage === "subagent_start" || stage === "subagent_done"
            ? event.parentAgentLabel
            : "")
    ).trim();
  const content = buildConversationalContent(event, settings);
  if (!content) {
    return null;
  }

  return {
    id: `${stage}:${event.timestamp || Date.now()}:${event.agentId || event.modelId || Math.random()}`,
    kind: kind === "summary" ? "message" : kind,
    stage,
    tone: String(event.tone || "neutral").trim() || "neutral",
    phase: String(event.phase || "").trim(),
    round: 0,
    timestamp: String(event.timestamp || new Date().toISOString()),
    speakerLabel,
    targetLabel,
    content,
    taskTitle: String(event.taskTitle || "").trim(),
    artifactPath: String(event.artifactPath || "").trim(),
    query: String(event.query || "").trim(),
    sourceStage: stage
  };
}

function normalizeIncomingChatEntry(entry, settings) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return buildChatEntryFromEvent(
    entry.stage === "multi_agent_chat"
      ? entry
      : {
          ...entry,
          stage: "multi_agent_chat"
        },
    settings
  );
}

export function createMultiAgentUi({
  state = {},
  elements,
  translate = createFallbackTranslator()
}) {
  const {
    multiAgentEnabledInput,
    multiAgentModeSelect,
    multiAgentSpeakerStrategySelect,
    multiAgentMaxRoundsInput,
    multiAgentTerminationKeywordInput,
    multiAgentMessageWindowInput,
    multiAgentSummarizeInput,
    multiAgentIncludeSystemInput,
    multiAgentSettingsHint,
    multiAgentChatTitle,
    multiAgentChatDescription,
    multiAgentChatStatus,
    multiAgentChatMeta,
    multiAgentChatSummary,
    multiAgentChatroom
  } = elements;

  state.settings = normalizeSettings(state.settings);
  state.session = createEmptySession(state.settings);

  function collectSettings() {
    return normalizeSettings({
      enabled: multiAgentEnabledInput?.checked,
      mode: multiAgentModeSelect?.value,
      speakerStrategy: multiAgentSpeakerStrategySelect?.value,
      maxRounds: multiAgentMaxRoundsInput?.value,
      terminationKeyword: multiAgentTerminationKeywordInput?.value,
      messageWindow: multiAgentMessageWindowInput?.value,
      summarizeLongMessages: multiAgentSummarizeInput?.checked,
      includeSystemMessages: multiAgentIncludeSystemInput?.checked
    });
  }

  function syncFieldState() {
    const enabled = Boolean(multiAgentEnabledInput?.checked);
    for (const input of [
      multiAgentModeSelect,
      multiAgentSpeakerStrategySelect,
      multiAgentMaxRoundsInput,
      multiAgentTerminationKeywordInput,
      multiAgentMessageWindowInput,
      multiAgentSummarizeInput,
      multiAgentIncludeSystemInput
    ]) {
      if (input) {
        input.disabled = !enabled;
      }
    }

    if (multiAgentSettingsHint) {
      multiAgentSettingsHint.textContent = enabled
        ? translate("multiAgent.hint.enabled")
        : translate("multiAgent.hint.disabled");
    }
  }

  function applySettings(settings = {}) {
    state.settings = normalizeSettings(settings, state.settings);
    if (multiAgentEnabledInput) {
      multiAgentEnabledInput.checked = state.settings.enabled;
    }
    if (multiAgentModeSelect) {
      multiAgentModeSelect.value = state.settings.mode;
    }
    if (multiAgentSpeakerStrategySelect) {
      multiAgentSpeakerStrategySelect.value = state.settings.speakerStrategy;
    }
    if (multiAgentMaxRoundsInput) {
      multiAgentMaxRoundsInput.value = state.settings.maxRounds;
    }
    if (multiAgentTerminationKeywordInput) {
      multiAgentTerminationKeywordInput.value = state.settings.terminationKeyword;
    }
    if (multiAgentMessageWindowInput) {
      multiAgentMessageWindowInput.value = state.settings.messageWindow;
    }
    if (multiAgentSummarizeInput) {
      multiAgentSummarizeInput.checked = state.settings.summarizeLongMessages;
    }
    if (multiAgentIncludeSystemInput) {
      multiAgentIncludeSystemInput.checked = state.settings.includeSystemMessages;
    }

    if (!state.session || !state.session.startedAt) {
      state.session = createEmptySession(state.settings);
    } else {
      state.session.settings = state.settings;
      state.session.enabled = state.settings.enabled;
    }

    syncFieldState();
    render();
  }

  function appendEntry(entry) {
    if (!entry || !shouldRenderChatEntryForMode(entry, state.settings)) {
      return;
    }

    if (!state.session.startedAt) {
      state.session.startedAt = entry.timestamp;
    }

    state.session.status = "running";
    state.session.totalMessageCount += 1;
    if (entry.kind === "message") {
      if (state.session.rounds >= state.settings.maxRounds) {
        state.session.foldedMessageCount += 1;
        const foldedEntry = state.session.messages.find((item) => item.summaryType === "folded");
        if (foldedEntry) {
          foldedEntry.content = translate("multiAgent.chat.folded", {
            count: state.session.foldedMessageCount
          });
        } else {
          state.session.messages.push({
            id: `folded:${entry.id}`,
            kind: "summary",
            summaryType: "folded",
            tone: "warning",
            phase: "",
            round: state.session.rounds,
            timestamp: entry.timestamp,
            speakerLabel: "",
            targetLabel: "",
            content: translate("multiAgent.chat.folded", {
              count: state.session.foldedMessageCount
            })
          });
        }
        return;
      }

      state.session.rounds += 1;
      entry.round = state.session.rounds;
    }

    upsertParticipant(state.session, entry.speakerLabel);
    if (entry.phase) {
      state.session.phaseCounts[entry.phase] = (state.session.phaseCounts[entry.phase] || 0) + 1;
    }

    state.session.messages.push(entry);
    const maxVisibleMessages = Math.max(1, state.settings.messageWindow);
    if (state.session.messages.length > maxVisibleMessages) {
      state.session.messages = state.session.messages.slice(-maxVisibleMessages);
    }
  }

  function updateFromEvent(event) {
    if (!state.settings.enabled) {
      return;
    }

    if (!state.session.objective && String(event?.stage || "") === "planning_start") {
      state.session.status = "running";
    }

    const injectedMessages = Array.isArray(event?.multiAgentMessages) ? event.multiAgentMessages : [];
    if (injectedMessages.length) {
      for (const message of injectedMessages) {
        appendEntry(normalizeIncomingChatEntry(message, state.settings));
      }
    } else {
      appendEntry(buildChatEntryFromEvent(event, state.settings));
    }

    if (event?.stage === "cluster_done") {
      state.session.status = "completed";
      state.session.endedAt = String(event.timestamp || new Date().toISOString());
      state.session.summary = summarizeContent(event.finalAnswer || event.detail || "", state.settings);
    } else if (event?.stage === "cluster_cancelled") {
      state.session.status = "terminated";
      state.session.endedAt = String(event.timestamp || new Date().toISOString());
    }

    render();
  }

  function applySession(session = null) {
    if (!session || typeof session !== "object") {
      return;
    }

    state.settings = normalizeSettings(session.settings || state.settings);
    state.session = {
      ...createEmptySession(state.settings),
      ...session,
      settings: state.settings,
      enabled: state.settings.enabled,
      messages: Array.isArray(session.messages)
        ? session.messages
            .map((entry) => normalizeIncomingChatEntry(entry, state.settings))
            .filter((entry) => shouldRenderChatEntryForMode(entry, state.settings))
        : []
    };
    syncFieldState();
    render();
  }

  function resetChatroom() {
    state.session = createEmptySession(state.settings);
    render();
  }

  function renderSummaryCards() {
    if (!multiAgentChatSummary) {
      return;
    }
    multiAgentChatSummary.hidden = true;
    multiAgentChatSummary.innerHTML = "";
  }

  function renderMessages() {
    if (!multiAgentChatroom) {
      return;
    }

    if (!state.settings.enabled) {
      multiAgentChatroom.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("multiAgent.chat.copy.disabled")
      )}</p>`;
      return;
    }

    const conversationEntries = state.session.messages.filter((entry) =>
      shouldRenderChatEntryForMode(entry, state.settings)
    );

    if (!conversationEntries.length) {
      multiAgentChatroom.innerHTML = `<p class="placeholder">${escapeHtml(
        translate("multiAgent.chat.empty")
      )}</p>`;
      return;
    }

    multiAgentChatroom.innerHTML = conversationEntries
      .map((entry) => {
        const displayKind = entry.kind === "summary" && isConversationalStage(entry.stage) ? "message" : entry.kind;
        const phaseLabel = resolvePhaseLabel(entry.phase, translate);
        const targetCopy = entry.targetLabel
          ? `<span class="multi-agent-message-target">${escapeHtml(
              translate("multiAgent.chat.target", { target: entry.targetLabel })
            )}</span>`
          : "";
        const contextItems = buildMessageContextItems(entry, state.settings, translate);
        const contextHtml = contextItems.length
          ? `
              <div class="multi-agent-message-context">
                ${contextItems
                  .map(
                    (item) => `
                      <span class="multi-agent-context-chip" data-context="${escapeHtml(item.key)}">
                        <span class="multi-agent-context-label">${escapeHtml(item.label)}</span>
                        <code class="multi-agent-context-value">${escapeHtml(item.value)}</code>
                      </span>
                    `
                  )
                  .join("")}
              </div>
            `
          : "";

        return `
          <article class="multi-agent-message" data-kind="${escapeHtml(displayKind)}" data-tone="${escapeHtml(
            entry.tone || "neutral"
          )}" data-source-stage="${escapeHtml(entry.sourceStage || entry.stage || "")}">
            <div class="multi-agent-message-head">
              <div class="multi-agent-message-meta">
                <strong>${escapeHtml(entry.speakerLabel || translate("multiAgent.chat.title"))}</strong>
                ${phaseLabel ? `<span class="chip">${escapeHtml(phaseLabel)}</span>` : ""}
                ${targetCopy}
              </div>
              <span class="multi-agent-message-time">${escapeHtml(
                String(entry.timestamp || "").slice(11, 19) || "--:--:--"
              )}</span>
            </div>
            ${contextHtml}
            <p>${escapeHtml(entry.content)}</p>
          </article>
        `;
      })
      .join("");
    multiAgentChatroom.scrollTop = multiAgentChatroom.scrollHeight;
  }

  function renderHeader() {
    if (multiAgentChatTitle) {
      multiAgentChatTitle.textContent = translate("multiAgent.chat.title");
    }
    if (multiAgentChatDescription) {
      multiAgentChatDescription.textContent = !state.settings.enabled
        ? translate("multiAgent.chat.copy.disabled")
        : translate("multiAgent.chat.copy.ready");
    }
    if (multiAgentChatStatus) {
      const statusKey =
        state.session.status === "completed"
          ? "multiAgent.status.completed"
          : state.session.status === "terminated"
            ? "multiAgent.status.terminated"
            : state.session.status === "running"
              ? "multiAgent.status.running"
              : state.settings.enabled
                ? "multiAgent.status.ready"
                : "multiAgent.status.disabled";
      multiAgentChatStatus.textContent = translate(statusKey);
      multiAgentChatStatus.dataset.tone =
        state.session.status === "completed"
          ? "ok"
          : state.session.status === "terminated"
            ? "warning"
            : state.session.status === "running"
              ? "testing"
              : "neutral";
    }
    if (multiAgentChatMeta) {
      multiAgentChatMeta.textContent = translate("multiAgent.meta", {
        participants: state.session.participantCount || 0
      });
    }
  }

  function render() {
    renderHeader();
    renderSummaryCards();
    renderMessages();
  }

  function refreshLocale() {
    syncFieldState();
    render();
  }

  function bindEvents() {
    const syncDraftSettings = () => {
      state.settings = collectSettings();
      state.session.settings = state.settings;
      state.session.enabled = state.settings.enabled;
      if (!state.settings.enabled) {
        state.session.status = "disabled";
      } else if (state.session.status === "disabled") {
        state.session.status = "ready";
      }
      syncFieldState();
      render();
    };

    for (const input of [
      multiAgentEnabledInput,
      multiAgentModeSelect,
      multiAgentSpeakerStrategySelect,
      multiAgentMaxRoundsInput,
      multiAgentTerminationKeywordInput,
      multiAgentMessageWindowInput,
      multiAgentSummarizeInput,
      multiAgentIncludeSystemInput
    ]) {
      input?.addEventListener("change", syncDraftSettings);
      input?.addEventListener?.("input", syncDraftSettings);
    }
  }

  applySettings(state.settings);

  return {
    applySession,
    applySettings,
    bindEvents,
    collectSettings,
    refreshLocale,
    resetChatroom,
    updateFromEvent
  };
}

const RUN_CONSOLE_CATALOG = {
  "zh-CN": {
    "common.na": "无",
    "common.medium": "中",
    "common.low": "低",
    "common.high": "高",
    "common.unknown": "未知",
    "phase.research": "调研",
    "phase.implementation": "实现",
    "phase.validation": "验证",
    "phase.handoff": "交付",
    "execution.done": "已完成",
    "execution.failed": "失败",
    "execution.running": "进行中",
    "execution.unknown": "未知",
    "verification.passed": "通过",
    "verification.failed": "失败",
    "verification.not_applicable": "不适用",
    "span.ok": "正常",
    "span.error": "错误",
    "span.running": "进行中",
    "circuit.closed": "关闭",
    "circuit.open": "打开",
    "circuit.half_open": "半开",
    "worker.none": "暂无工作模型结果。",
    "worker.phase": "阶段",
    "worker.confidence": "置信度",
    "worker.verification": "验证",
    "worker.toolCalls": "工具调用",
    "worker.memoryRw": "记忆读写",
    "worker.files": "文件",
    "worker.thinkingSummary": "思考摘要",
    "worker.noThinkingSummary": "没有公开思考摘要。",
    "worker.noSummary": "没有返回摘要。",
    "worker.keyFindings": "关键发现",
    "worker.noKeyFindings": "没有返回关键发现。",
    "worker.risks": "风险",
    "worker.noRisks": "没有报告风险。",
    "worker.deliverables": "交付物",
    "worker.noDeliverables": "没有列出交付物。",
    "worker.toolLayer": "工具调用层",
    "worker.noToolCalls": "未记录工具调用。",
    "worker.memoryReadsWrites": "记忆读取 / 写入",
    "worker.leaderDelegationNotes": "组长分工说明",
    "worker.noDelegationNotes": "没有返回分工说明。",
    "worker.handledDirectly": "该任务未创建下属 agent，已直接处理。",
    "worker.subordinateAgents": "下属 Agent",
    "worker.noSubordinateAgents": "未创建下属 agent。",
    "worker.noSubordinateSummary": "无摘要",
    "worker.followUps": "后续建议",
    "worker.noFollowUps": "没有建议后续动作。",
    "worker.executedCommands": "执行的命令",
    "worker.noExecutedCommands": "未执行任何工作区命令。",
    "worker.generatedFiles": "生成的文件",
    "worker.noGeneratedFiles": "未报告生成文件。",
    "worker.verifiedFiles": "已验证文件",
    "worker.noVerifiedFiles": "工作区中没有已验证的生成文件。",
    "trace.placeholder": "运行后会在这里显示任务 Trace 和调用链。",
    "trace.summary.spans": "Span 数",
    "trace.summary.completed": "已完成",
    "trace.summary.providerCalls": "模型调用",
    "trace.summary.toolCalls": "工具调用",
    "trace.title.providerCall": "模型调用",
    "trace.title.delegation": "委派",
    "trace.title.tool.list_files": "列出文件",
    "trace.title.tool.read_files": "读取文件",
    "trace.title.tool.write_files": "写入文件",
    "trace.title.tool.write_docx": "写入 Word 文档",
    "trace.title.tool.web_search": "网页搜索",
    "trace.title.tool.run_command": "执行命令",
    "trace.title.tool.recall_memory": "召回记忆",
    "trace.title.tool.remember": "写入记忆",
    "trace.purpose.planning": "任务规划",
    "trace.purpose.synthesis": "结果汇总",
    "trace.purpose.worker_execution": "工作模型执行",
    "trace.purpose.subordinate_execution": "下属执行",
    "trace.purpose.worker_web_search": "网页搜索",
    "trace.purpose.worker_json_repair": "JSON 修复",
    "trace.purpose.leader_delegation": "组长分工",
    "trace.purpose.leader_synthesis": "组长汇总",
    "trace.purpose.connectivity_test_basic": "基础连通性测试",
    "trace.purpose.connectivity_test_workflow": "工作流连通性测试",
    "trace.metric.tokens": "Tokens 输入 {input} / 输出 {output} / 总计 {total}",
    "trace.metric.cost": "成本 {value}",
    "trace.metric.results": "结果 {value}",
    "trace.metric.memory": "记忆 {value}",
    "trace.metric.exit": "退出码 {value}",
    "trace.detail.providerCompleted": "模型调用已完成：{purpose}。",
    "trace.detail.listedPath": "已查看工作区路径：{path}",
    "trace.detail.readFiles": "已读取 {count} 个工作区文件。",
    "trace.detail.wroteFiles": "已写入 {count} 个工作区文件。",
    "trace.detail.wroteWord": "已写入 Word 文档：{path}",
    "trace.detail.webSearch": "已完成网页搜索：{query}",
    "trace.detail.memoryStored": "已写入会话记忆：{title}",
    "trace.detail.memoryRecalled": "已召回 {count} 条会话记忆。",
    "trace.detail.jsonRepair": "检测到无效的 workspace JSON 响应，已自动修复。",
    "trace.detail.toolCompleted": "工具调用已完成。",
    "session.placeholder": "运行后会在这里显示会话记忆、Token / 成本、重试和熔断状态。",
    "session.providerCalls": "模型调用",
    "session.failures": "失败",
    "session.retries": "重试",
    "session.toolCalls": "工具调用",
    "session.memoryRw": "记忆读写",
    "session.tokens": "Tokens",
    "session.cost": "成本",
    "session.modelStats": "模型统计",
    "session.sessionMemory": "会话记忆",
    "session.circuitBreakers": "熔断器",
    "session.modelCount": "{count} 个模型",
    "session.itemCount": "{count} 项",
    "session.noProviderCalls": "尚未记录模型调用。",
    "session.noMemoryEntries": "尚未记录会话记忆。",
    "session.noCircuitBreakers": "尚未记录熔断器状态。",
    "session.calls": "调用 {count}",
    "session.retriesMeta": "重试 {count}",
    "session.failuresMeta": "失败 {count}",
    "session.tokensMeta": "Tokens {count}",
    "session.costMeta": "成本 {value}",
    "session.memoryTag": "记忆",
    "session.breakerFailures": "失败 {count}",
    "session.noBreakerError": "没有最近一次熔断错误。"
  },
  "en-US": {
    "common.na": "n/a",
    "common.medium": "medium",
    "common.low": "low",
    "common.high": "high",
    "common.unknown": "unknown",
    "phase.research": "Research",
    "phase.implementation": "Implementation",
    "phase.validation": "Validation",
    "phase.handoff": "Handoff",
    "execution.done": "done",
    "execution.failed": "failed",
    "execution.running": "running",
    "execution.unknown": "unknown",
    "verification.passed": "passed",
    "verification.failed": "failed",
    "verification.not_applicable": "not_applicable",
    "span.ok": "ok",
    "span.error": "error",
    "span.running": "running",
    "circuit.closed": "closed",
    "circuit.open": "open",
    "circuit.half_open": "half_open",
    "worker.none": "No worker results yet.",
    "worker.phase": "Phase",
    "worker.confidence": "Confidence",
    "worker.verification": "Verification",
    "worker.toolCalls": "Tool Calls",
    "worker.memoryRw": "Memory R/W",
    "worker.files": "Files",
    "worker.thinkingSummary": "Thinking Summary",
    "worker.noThinkingSummary": "No public thinking summary.",
    "worker.noSummary": "No summary returned.",
    "worker.keyFindings": "Key Findings",
    "worker.noKeyFindings": "No key findings returned.",
    "worker.risks": "Risks",
    "worker.noRisks": "No risks reported.",
    "worker.deliverables": "Deliverables",
    "worker.noDeliverables": "No deliverables listed.",
    "worker.toolLayer": "Tool Layer",
    "worker.noToolCalls": "No tool calls were recorded.",
    "worker.memoryReadsWrites": "Memory reads / writes",
    "worker.leaderDelegationNotes": "Leader Delegation Notes",
    "worker.noDelegationNotes": "No delegation notes returned.",
    "worker.handledDirectly": "This task was handled without subordinate agents.",
    "worker.subordinateAgents": "Subordinate Agents",
    "worker.noSubordinateAgents": "No subordinate agents were created.",
    "worker.noSubordinateSummary": "No summary",
    "worker.followUps": "Follow-ups",
    "worker.noFollowUps": "No follow-up actions suggested.",
    "worker.executedCommands": "Executed Commands",
    "worker.noExecutedCommands": "No workspace commands were executed.",
    "worker.generatedFiles": "Generated Files",
    "worker.noGeneratedFiles": "No generated files were reported.",
    "worker.verifiedFiles": "Verified Files",
    "worker.noVerifiedFiles": "No generated files were verified in the workspace.",
    "trace.placeholder": "Run the cluster to populate the task trace and call chain.",
    "trace.summary.spans": "Spans",
    "trace.summary.completed": "Completed",
    "trace.summary.providerCalls": "Provider Calls",
    "trace.summary.toolCalls": "Tool Calls",
    "trace.title.providerCall": "Provider Call",
    "trace.title.delegation": "Delegation",
    "trace.title.tool.list_files": "List Files",
    "trace.title.tool.read_files": "Read Files",
    "trace.title.tool.write_files": "Write Files",
    "trace.title.tool.write_docx": "Write Word Document",
    "trace.title.tool.web_search": "Web Search",
    "trace.title.tool.run_command": "Run Command",
    "trace.title.tool.recall_memory": "Recall Memory",
    "trace.title.tool.remember": "Remember",
    "trace.purpose.planning": "Planning",
    "trace.purpose.synthesis": "Synthesis",
    "trace.purpose.worker_execution": "Worker Execution",
    "trace.purpose.subordinate_execution": "Subordinate Execution",
    "trace.purpose.worker_web_search": "Web Search",
    "trace.purpose.worker_json_repair": "JSON Repair",
    "trace.purpose.leader_delegation": "Leader Delegation",
    "trace.purpose.leader_synthesis": "Leader Synthesis",
    "trace.purpose.connectivity_test_basic": "Basic Connectivity Test",
    "trace.purpose.connectivity_test_workflow": "Workflow Connectivity Test",
    "trace.metric.tokens": "Tokens {input} in / {output} out / {total} total",
    "trace.metric.cost": "Cost {value}",
    "trace.metric.results": "Results {value}",
    "trace.metric.memory": "Memory {value}",
    "trace.metric.exit": "Exit {value}",
    "trace.detail.providerCompleted": "Provider call completed: {purpose}.",
    "trace.detail.listedPath": "Listed workspace path: {path}",
    "trace.detail.readFiles": "Read {count} workspace file(s).",
    "trace.detail.wroteFiles": "Wrote {count} workspace file(s).",
    "trace.detail.wroteWord": "Wrote Word document: {path}",
    "trace.detail.webSearch": "Web searched: {query}",
    "trace.detail.memoryStored": "Stored session memory: {title}",
    "trace.detail.memoryRecalled": "Recalled {count} session memory item(s).",
    "trace.detail.jsonRepair": "Detected an invalid workspace JSON response and repaired it automatically.",
    "trace.detail.toolCompleted": "Tool call completed.",
    "session.placeholder": "Run the cluster to populate session memory, token/cost stats, retries, and circuit-breaker state.",
    "session.providerCalls": "Provider Calls",
    "session.failures": "Failures",
    "session.retries": "Retries",
    "session.toolCalls": "Tool Calls",
    "session.memoryRw": "Memory R/W",
    "session.tokens": "Tokens",
    "session.cost": "Cost",
    "session.modelStats": "Model Stats",
    "session.sessionMemory": "Session Memory",
    "session.circuitBreakers": "Circuit Breakers",
    "session.modelCount": "{count} model(s)",
    "session.itemCount": "{count} item(s)",
    "session.noProviderCalls": "No provider calls recorded yet.",
    "session.noMemoryEntries": "No session memory entries recorded yet.",
    "session.noCircuitBreakers": "No circuit-breaker state recorded yet.",
    "session.calls": "Calls {count}",
    "session.retriesMeta": "Retries {count}",
    "session.failuresMeta": "Failures {count}",
    "session.tokensMeta": "Tokens {count}",
    "session.costMeta": "Cost {value}",
    "session.memoryTag": "memory",
    "session.breakerFailures": "Failures {count}",
    "session.noBreakerError": "No recent breaker error."
  }
};

function interpolate(template, values = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

function resolveLocale(getLocale) {
  if (typeof getLocale === "function") {
    const locale = String(getLocale() || "").trim();
    if (locale === "en-US") {
      return "en-US";
    }
  }

  if (
    typeof document !== "undefined" &&
    String(document.documentElement?.lang || "").toLowerCase().startsWith("en")
  ) {
    return "en-US";
  }

  return "zh-CN";
}

export function formatMetricNumber(value, locale = "en-US") {
  return new Intl.NumberFormat(locale).format(Math.max(0, Number(value) || 0));
}

export function formatUsd(value, fallback = "n/a") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallback;
  }
  return `$${amount >= 1 ? amount.toFixed(2) : amount.toFixed(4)}`;
}

export function createRunConsoleUi({
  workerOutput,
  traceOutput,
  sessionOutput,
  traceUiState,
  escapeHtml,
  escapeAttribute,
  renderList,
  getLocale
}) {
  let lastExecutions = [];

  function ensureFoldPanel(contentNode, { panelId, extraClass = "" } = {}) {
    if (!contentNode || typeof document === "undefined") {
      return;
    }

    const existingPanel = contentNode.closest(`#${panelId}`);
    if (existingPanel && existingPanel.id === panelId) {
      return;
    }

    const panel = contentNode.closest(".subpanel");
    const header = panel?.querySelector(".subpanel-head");
    if (!panel || !header || !panel.parentNode) {
      return;
    }

    const details = document.createElement("details");
    details.id = panelId;
    details.className = ["subpanel", "fold-panel", extraClass].filter(Boolean).join(" ");
    details.open = true;

    const summary = document.createElement("summary");
    summary.className = "fold-summary";
    summary.append(header);

    const indicator = document.createElement("span");
    indicator.className = "fold-summary-indicator";
    indicator.setAttribute("aria-hidden", "true");
    summary.append(indicator);

    const body = document.createElement("div");
    body.className = "fold-body";
    body.append(contentNode);

    details.append(summary, body);
    panel.parentNode.replaceChild(details, panel);
  }

  function ensureRunFoldPanels() {
    if (typeof document === "undefined") {
      return;
    }

    [
      { contentNode: document.getElementById("liveOutput"), panelId: "liveStatusPanel" },
      { contentNode: document.getElementById("planOutput"), panelId: "taskPlanPanel" },
      { contentNode: workerOutput || document.getElementById("workerOutput"), panelId: "workerResultsPanel" },
      { contentNode: document.getElementById("synthesisOutput"), panelId: "finalSynthesisPanel" },
      {
        contentNode: traceOutput || document.getElementById("traceOutput"),
        panelId: "taskTracePanel",
        extraClass: "trace-fold-panel"
      },
      { contentNode: sessionOutput || document.getElementById("sessionOutput"), panelId: "sessionStatsPanel" }
    ].forEach(({ contentNode, panelId, extraClass }) =>
      ensureFoldPanel(contentNode, {
        panelId,
        extraClass
      })
    );
  }

  function t(key, values = {}) {
    const locale = resolveLocale(getLocale);
    return interpolate(
      RUN_CONSOLE_CATALOG[locale]?.[key] ??
        RUN_CONSOLE_CATALOG["zh-CN"]?.[key] ??
        key,
      values
    );
  }

  function hasCatalogKey(key) {
    const locale = resolveLocale(getLocale);
    return Boolean(
      RUN_CONSOLE_CATALOG[locale]?.[key] ||
        RUN_CONSOLE_CATALOG["zh-CN"]?.[key]
    );
  }

  ensureRunFoldPanels();

  function metricNumber(value) {
    return formatMetricNumber(value, resolveLocale(getLocale));
  }

  function currency(value) {
    return formatUsd(value, t("common.na"));
  }

  function localizePhase(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return hasCatalogKey(`phase.${normalized}`) ? t(`phase.${normalized}`) : value || t("common.na");
  }

  function localizeConfidence(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "low" || normalized === "medium" || normalized === "high") {
      return t(`common.${normalized}`);
    }
    return value || t("common.medium");
  }

  function localizeExecutionStatus(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return hasCatalogKey(`execution.${normalized}`)
      ? t(`execution.${normalized}`)
      : value || t("execution.unknown");
  }

  function localizeVerificationStatus(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return hasCatalogKey(`verification.${normalized}`)
      ? t(`verification.${normalized}`)
      : value || t("verification.not_applicable");
  }

  function localizeSpanStatus(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return hasCatalogKey(`span.${normalized}`) ? t(`span.${normalized}`) : value || t("span.running");
  }

  function localizeCircuitState(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return hasCatalogKey(`circuit.${normalized}`)
      ? t(`circuit.${normalized}`)
      : value || t("circuit.closed");
  }

  function localizeToolLabel(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return (
      {
        list_files: t("trace.title.tool.list_files"),
        read_files: t("trace.title.tool.read_files"),
        write_files: t("trace.title.tool.write_files"),
        write_docx: t("trace.title.tool.write_docx"),
        web_search: t("trace.title.tool.web_search"),
        run_command: t("trace.title.tool.run_command"),
        recall_memory: t("trace.title.tool.recall_memory"),
        remember: t("trace.title.tool.remember")
      }[normalized] || value
    );
  }

  function localizePurpose(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return RUN_CONSOLE_CATALOG[resolveLocale(getLocale)]?.[`trace.purpose.${normalized}`]
      ? t(`trace.purpose.${normalized}`)
      : value;
  }

  function localizeTraceTitle(span) {
    if (span.spanKind === "provider_call") {
      const purpose = localizePurpose(span.purpose);
      return purpose
        ? `${t("trace.title.providerCall")} · ${purpose}`
        : t("trace.title.providerCall");
    }

    if (span.toolAction) {
      return localizeToolLabel(span.toolAction);
    }

    if (span.spanKind === "delegation") {
      return t("trace.title.delegation");
    }

    if (span.spanKind === "memory_read") {
      return localizeToolLabel("recall_memory");
    }

    if (span.spanKind === "memory_write") {
      return localizeToolLabel("remember");
    }

    return span.spanLabel || span.spanKind || "span";
  }

  function localizeTraceDetail(span) {
    const detail = String(span?.detail || "").trim();
    if (!detail) {
      return "";
    }

    let match = detail.match(/^Provider call completed for (.+)\.$/i);
    if (match) {
      return t("trace.detail.providerCompleted", {
        purpose: localizePurpose(match[1]) || match[1]
      });
    }

    match = detail.match(/^Listed workspace path: (.+)$/i);
    if (match) {
      return t("trace.detail.listedPath", { path: match[1] });
    }

    match = detail.match(/^Read (\d+) workspace file\(s\)\.?$/i);
    if (match) {
      return t("trace.detail.readFiles", { count: metricNumber(match[1]) });
    }

    match = detail.match(/^Wrote (\d+) workspace file\(s\)\.?$/i);
    if (match) {
      return t("trace.detail.wroteFiles", { count: metricNumber(match[1]) });
    }

    match = detail.match(/^Wrote Word document: (.+)$/i);
    if (match) {
      return t("trace.detail.wroteWord", { path: match[1] });
    }

    match = detail.match(/^Web searched: (.+)$/i);
    if (match) {
      return t("trace.detail.webSearch", { query: match[1] });
    }

    match = detail.match(/^(?:Stored session memory|已写入会话记忆)[：:]\s*(.+)$/i);
    if (match) {
      return t("trace.detail.memoryStored", { title: match[1] });
    }

    match = detail.match(/^(?:Recalled\s+(\d+)\s+session memory item\(s\)\.?|已召回\s+(\d+)\s+条会话记忆。?)$/i);
    if (match) {
      return t("trace.detail.memoryRecalled", { count: metricNumber(match[1] || match[2]) });
    }

    if (/invalid workspace json response/i.test(detail)) {
      return t("trace.detail.jsonRepair");
    }

    if (/^Tool call completed\.?$/i.test(detail)) {
      return t("trace.detail.toolCompleted");
    }

    return detail;
  }

  function renderWorkers(executions) {
    lastExecutions = Array.isArray(executions) ? executions : [];

    if (!lastExecutions.length) {
      workerOutput.innerHTML = `<p class="placeholder">${escapeHtml(t("worker.none"))}</p>`;
      return;
    }

    workerOutput.innerHTML = lastExecutions
      .map((execution) => {
        const output = execution.output || {};
        const rawStatus = String(execution.status || "unknown");
        const statusBadgeClass =
          rawStatus === "done" ? "completed" : rawStatus === "failed" ? "failed" : "";
        const rawVerificationStatus = String(output.verificationStatus || "not_applicable");
        const verificationBadgeClass =
          rawVerificationStatus === "passed"
            ? "completed"
            : rawVerificationStatus === "failed"
              ? "failed"
              : "";
        const toolUsage = Array.isArray(output.toolUsage) ? output.toolUsage.filter(Boolean) : [];
        const generatedFiles = Array.isArray(output.generatedFiles) ? output.generatedFiles.filter(Boolean) : [];
        const verifiedGeneratedFiles = Array.isArray(output.verifiedGeneratedFiles)
          ? output.verifiedGeneratedFiles.filter(Boolean)
          : [];
        const subordinateResults = Array.isArray(output.subordinateResults)
          ? output.subordinateResults
          : [];
        const memoryReads = Math.max(0, Number(output.memoryReads || 0));
        const memoryWrites = Math.max(0, Number(output.memoryWrites || 0));
        const metricCards = [
          [t("worker.phase"), localizePhase(execution.phase || "implementation")],
          [t("worker.confidence"), localizeConfidence(output.confidence || "medium")],
          [t("worker.verification"), localizeVerificationStatus(rawVerificationStatus)],
          [t("worker.toolCalls"), metricNumber(toolUsage.length)],
          [t("worker.memoryRw"), `${metricNumber(memoryReads)} / ${metricNumber(memoryWrites)}`],
          [
            t("worker.files"),
            metricNumber(Math.max(generatedFiles.length, verifiedGeneratedFiles.length))
          ]
        ];

        return `
          <section class="worker-card">
            <div class="worker-head">
              <strong>${escapeHtml(execution.workerLabel || execution.workerId || "Worker")}</strong>
              <span class="badge ${escapeHtml(statusBadgeClass)}">${escapeHtml(localizeExecutionStatus(rawStatus))}</span>
            </div>
            <div class="worker-metric-grid">
              ${metricCards
                .map(
                  ([label, value]) => `
                    <article class="worker-metric-card">
                      <span>${escapeHtml(label)}</span>
                      <strong>${escapeHtml(value)}</strong>
                    </article>
                  `
                )
                .join("")}
            </div>
            <p class="meta-row">${escapeHtml(t("worker.thinkingSummary"))}: ${escapeHtml(output.thinkingSummary || t("worker.noThinkingSummary"))}</p>
            <p>${escapeHtml(output.summary || t("worker.noSummary"))}</p>
            <h3>${escapeHtml(t("worker.keyFindings"))}</h3>
            ${renderList(output.keyFindings, t("worker.noKeyFindings"))}
            <h3>${escapeHtml(t("worker.risks"))}</h3>
            ${renderList(output.risks, t("worker.noRisks"))}
            <h3>${escapeHtml(t("worker.deliverables"))}</h3>
            ${renderList(output.deliverables, t("worker.noDeliverables"))}
            <h3>${escapeHtml(t("worker.toolLayer"))}</h3>
            ${
              toolUsage.length
                ? `<div class="worker-chip-row">${toolUsage
                    .map((tool) => `<span class="chip">${escapeHtml(localizeToolLabel(tool))}</span>`)
                    .join("")}</div>`
                : `<p class="placeholder">${escapeHtml(t("worker.noToolCalls"))}</p>`
            }
            <p class="meta-row">${escapeHtml(t("worker.memoryReadsWrites"))}: ${escapeHtml(metricNumber(memoryReads))} / ${escapeHtml(metricNumber(memoryWrites))}</p>
            <h3>${escapeHtml(t("worker.leaderDelegationNotes"))}</h3>
            ${renderList(
              output.delegationNotes,
              output.subordinateCount ? t("worker.noDelegationNotes") : t("worker.handledDirectly")
            )}
            <h3>${escapeHtml(t("worker.subordinateAgents"))}</h3>
            ${renderList(
              subordinateResults.map(
                (item) =>
                  `${item.agentLabel || item.agentId}: ${item.summary || item.status || t("worker.noSubordinateSummary")}`
              ),
              t("worker.noSubordinateAgents")
            )}
            <h3>${escapeHtml(t("worker.followUps"))}</h3>
            ${renderList(output.followUps, t("worker.noFollowUps"))}
            <h3>${escapeHtml(t("worker.verification"))}</h3>
            <p><span class="badge ${escapeHtml(verificationBadgeClass)}">${escapeHtml(localizeVerificationStatus(rawVerificationStatus))}</span></p>
            <h3>${escapeHtml(t("worker.executedCommands"))}</h3>
            ${renderList(output.executedCommands, t("worker.noExecutedCommands"))}
            <h3>${escapeHtml(t("worker.generatedFiles"))}</h3>
            ${renderList(generatedFiles, t("worker.noGeneratedFiles"))}
            <h3>${escapeHtml(t("worker.verifiedFiles"))}</h3>
            ${renderList(verifiedGeneratedFiles, t("worker.noVerifiedFiles"))}
          </section>
        `;
      })
      .join("");
  }

  function resetTracePanels() {
    traceUiState.spans = new Map();
    traceUiState.session = null;
    if (traceOutput) {
      traceOutput.innerHTML = `<p class="placeholder">${escapeHtml(t("trace.placeholder"))}</p>`;
    }
    if (sessionOutput) {
      sessionOutput.innerHTML = `<p class="placeholder">${escapeHtml(t("session.placeholder"))}</p>`;
    }
  }

  function renderTracePanel() {
    if (!traceOutput) {
      return;
    }

    const spans = Array.from(traceUiState.spans.values());
    if (!spans.length) {
      traceOutput.innerHTML = `<p class="placeholder">${escapeHtml(t("trace.placeholder"))}</p>`;
      return;
    }

    const completedCount = spans.filter((span) => span.endedAt).length;
    const providerCount = spans.filter((span) => span.spanKind === "provider_call").length;
    const toolCount = spans.filter((span) =>
      ["tool", "memory_read", "memory_write"].includes(String(span.spanKind || ""))
    ).length;
    const childrenByParent = new Map();

    for (const span of spans) {
      const key = span.parentSpanId || "__root__";
      if (!childrenByParent.has(key)) {
        childrenByParent.set(key, []);
      }
      childrenByParent.get(key).push(span);
    }

    for (const entries of childrenByParent.values()) {
      entries.sort(
        (left, right) =>
          Number(left.startedAt || 0) - Number(right.startedAt || 0) ||
          String(left.spanId || "").localeCompare(String(right.spanId || ""))
      );
    }

    function renderChildren(parentKey = "__root__", depth = 0) {
      return (childrenByParent.get(parentKey) || [])
        .map((span) => {
          const status = span.status || "running";
          const badgeClass =
            status === "error" ? "failed" : status === "ok" ? "completed" : "";
          const metricParts = [];

          if (span.usage && typeof span.usage === "object") {
            metricParts.push(
              t("trace.metric.tokens", {
                input: metricNumber(span.usage.inputTokens || 0),
                output: metricNumber(span.usage.outputTokens || 0),
                total: metricNumber(span.usage.totalTokens || 0)
              })
            );
          }
          if (Number.isFinite(Number(span.estimatedCostUsd)) && Number(span.estimatedCostUsd) > 0) {
            metricParts.push(
              t("trace.metric.cost", {
                value: currency(span.estimatedCostUsd)
              })
            );
          }
          if (Number.isFinite(Number(span.resultCount)) && Number(span.resultCount) >= 0) {
            metricParts.push(
              t("trace.metric.results", {
                value: metricNumber(span.resultCount)
              })
            );
          }
          if (Number.isFinite(Number(span.memoryCount)) && Number(span.memoryCount) > 0) {
            metricParts.push(
              t("trace.metric.memory", {
                value: metricNumber(span.memoryCount)
              })
            );
          }
          if (Number.isFinite(Number(span.exitCode))) {
            metricParts.push(
              t("trace.metric.exit", {
                value: span.exitCode
              })
            );
          }

          const meta = [
            span.agentLabel || "",
            span.taskTitle || "",
            span.modelLabel || "",
            span.purpose ? localizePurpose(span.purpose) : "",
            span.toolAction ? localizeToolLabel(span.toolAction) : "",
            span.durationMs ? `${span.durationMs} ms` : ""
          ]
            .filter(Boolean)
            .join(" / ");
          const detail = localizeTraceDetail(span);

          return [
            `<article class="trace-node" style="--trace-depth:${depth};">`,
            '  <div class="trace-node-head">',
            `    <strong>${escapeHtml(localizeTraceTitle(span))}</strong>`,
            `    <span class="badge ${escapeHtml(badgeClass)}">${escapeHtml(localizeSpanStatus(status))}</span>`,
            "  </div>",
            `  <p class="trace-node-meta">${escapeHtml(meta || span.spanKind || "")}</p>`,
            detail ? `  <p class="trace-node-detail">${escapeHtml(detail)}</p>` : "",
            metricParts.length
              ? `  <p class="trace-node-metrics">${escapeHtml(metricParts.join(" | "))}</p>`
              : "",
            renderChildren(span.spanId, depth + 1),
            "</article>"
          ].join("");
        })
        .join("");
    }

    traceOutput.innerHTML = [
      '<section class="trace-summary">',
      `  <article class="session-metric-card"><span>${escapeHtml(t("trace.summary.spans"))}</span><strong>${escapeHtml(metricNumber(spans.length))}</strong></article>`,
      `  <article class="session-metric-card"><span>${escapeHtml(t("trace.summary.completed"))}</span><strong>${escapeHtml(metricNumber(completedCount))}</strong></article>`,
      `  <article class="session-metric-card"><span>${escapeHtml(t("trace.summary.providerCalls"))}</span><strong>${escapeHtml(metricNumber(providerCount))}</strong></article>`,
      `  <article class="session-metric-card"><span>${escapeHtml(t("trace.summary.toolCalls"))}</span><strong>${escapeHtml(metricNumber(toolCount))}</strong></article>`,
      "</section>",
      renderChildren()
    ].join("");
  }

  function renderSessionPanel() {
    if (!sessionOutput) {
      return;
    }

    const session = traceUiState.session;
    if (!session) {
      sessionOutput.innerHTML = `<p class="placeholder">${escapeHtml(t("session.placeholder"))}</p>`;
      return;
    }

    const totals = session.totals || {};
    const metrics = [
      [t("session.providerCalls"), metricNumber(totals.providerCalls)],
      [t("session.failures"), metricNumber(totals.providerFailures)],
      [t("session.retries"), metricNumber(totals.retries)],
      [t("session.toolCalls"), metricNumber(totals.toolCalls)],
      [t("session.memoryRw"), `${metricNumber(totals.memoryReads)} / ${metricNumber(totals.memoryWrites)}`],
      [t("session.tokens"), metricNumber(totals.totalTokens)],
      [t("session.cost"), currency(totals.estimatedCostUsd)]
    ];
    const circuits = Array.isArray(session.circuits) ? session.circuits : [];
    const recentMemory = Array.isArray(session.memory?.recent) ? session.memory.recent : [];
    const models = Array.isArray(session.models) ? session.models : [];

    sessionOutput.innerHTML = [
      '<section class="session-metric-grid">',
      metrics
        .map(
          ([label, value]) =>
            `<article class="session-metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
        )
        .join(""),
      "</section>",
      '<section class="session-block">',
      `  <div class="trace-node-head"><h4>${escapeHtml(t("session.modelStats"))}</h4><span class="chip">${escapeHtml(t("session.modelCount", { count: metricNumber(models.length) }))}</span></div>`,
      models.length
        ? models
            .map(
              (model) => `
                <article class="session-model-card">
                  <div class="trace-node-head">
                    <strong>${escapeHtml(model.modelLabel || model.modelId)}</strong>
                    <span class="chip">${escapeHtml(model.provider || "provider")}</span>
                  </div>
                  <p class="trace-node-meta">${escapeHtml(
                    [
                      t("session.calls", { count: metricNumber(model.providerCalls) }),
                      t("session.retriesMeta", { count: metricNumber(model.retries) }),
                      t("session.failuresMeta", { count: metricNumber(model.providerFailures) })
                    ].join(" | ")
                  )}</p>
                  <p class="trace-node-detail">${escapeHtml(
                    [
                      t("session.tokensMeta", { count: metricNumber(model.totalTokens) }),
                      t("session.costMeta", { value: currency(model.estimatedCostUsd) })
                    ].join(" | ")
                  )}</p>
                </article>
              `
            )
            .join("")
        : `<p class="placeholder">${escapeHtml(t("session.noProviderCalls"))}</p>`,
      "</section>",
      '<section class="session-block">',
      `  <div class="trace-node-head"><h4>${escapeHtml(t("session.sessionMemory"))}</h4><span class="chip">${escapeHtml(t("session.itemCount", { count: metricNumber(session.memory?.count || 0) }))}</span></div>`,
      recentMemory.length
        ? recentMemory
            .map(
              (entry) => `
                <article class="session-memory-card">
                  <div class="trace-node-head">
                    <strong>${escapeHtml(entry.title || entry.id)}</strong>
                    <span class="chip">${escapeHtml((entry.tags || []).join(", ") || t("session.memoryTag"))}</span>
                  </div>
                  <p class="trace-node-meta">${escapeHtml(entry.agentLabel || "")}</p>
                  <p class="trace-node-detail">${escapeHtml(entry.content || "")}</p>
                </article>
              `
            )
            .join("")
        : `<p class="placeholder">${escapeHtml(t("session.noMemoryEntries"))}</p>`,
      "</section>",
      '<section class="session-block">',
      `  <div class="trace-node-head"><h4>${escapeHtml(t("session.circuitBreakers"))}</h4><span class="chip">${escapeHtml(t("session.modelCount", { count: metricNumber(circuits.length) }))}</span></div>`,
      circuits.length
        ? circuits
            .map(
              (entry) => `
                <article class="session-circuit-card" data-state="${escapeAttribute(entry.state || "closed")}">
                  <div class="trace-node-head">
                    <strong>${escapeHtml(entry.modelLabel || entry.modelId)}</strong>
                    <span class="badge ${entry.state === "open" ? "failed" : entry.state === "closed" ? "completed" : ""}">${escapeHtml(localizeCircuitState(entry.state || "closed"))}</span>
                  </div>
                  <p class="trace-node-meta">${escapeHtml(
                    t("session.breakerFailures", {
                      count: metricNumber(entry.consecutiveFailures)
                    })
                  )}</p>
                  <p class="trace-node-detail">${escapeHtml(entry.lastError || t("session.noBreakerError"))}</p>
                </article>
              `
            )
            .join("")
        : `<p class="placeholder">${escapeHtml(t("session.noCircuitBreakers"))}</p>`,
      "</section>"
    ].join("");
  }

  function updateTraceStateFromEvent(event) {
    if (event.stage === "trace_span_start") {
      traceUiState.spans.set(event.spanId, {
        ...(traceUiState.spans.get(event.spanId) || {}),
        ...event,
        status: "running"
      });
      renderTracePanel();
      return;
    }

    if (event.stage === "trace_span_end") {
      traceUiState.spans.set(event.spanId, {
        ...(traceUiState.spans.get(event.spanId) || {}),
        ...event
      });
      renderTracePanel();
    }
  }

  function updateSessionStateFromEvent(event) {
    if ((event.stage === "session_update" || event.stage === "cluster_done") && event.session) {
      traceUiState.session = event.session;
      renderSessionPanel();
    }
  }

  function refreshLocale() {
    if (lastExecutions.length || workerOutput?.querySelector(".worker-card")) {
      renderWorkers(lastExecutions);
    }
    renderTracePanel();
    renderSessionPanel();
  }

  return {
    renderWorkers,
    refreshLocale,
    resetTracePanels,
    updateTraceStateFromEvent,
    updateSessionStateFromEvent
  };
}

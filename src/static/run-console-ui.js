export function formatMetricNumber(value) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Number(value) || 0));
}

export function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "n/a";
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
  renderList
}) {
  function renderWorkers(executions) {
    if (!executions?.length) {
      workerOutput.innerHTML = '<p class="placeholder">No worker results yet.</p>';
      return;
    }

    workerOutput.innerHTML = executions
      .map((execution) => {
        const output = execution.output || {};
        const status = String(execution.status || "unknown");
        const statusBadgeClass = status === "done" ? "completed" : status === "failed" ? "failed" : "";
        const verificationStatus = String(output.verificationStatus || "not_applicable");
        const verificationBadgeClass =
          verificationStatus === "passed"
            ? "completed"
            : verificationStatus === "failed"
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
          ["Phase", execution.phase || "n/a"],
          ["Confidence", output.confidence || "medium"],
          ["Verification", verificationStatus],
          ["Tool Calls", formatMetricNumber(toolUsage.length)],
          ["Memory R/W", `${formatMetricNumber(memoryReads)} / ${formatMetricNumber(memoryWrites)}`],
          [
            "Files",
            formatMetricNumber(
              Math.max(generatedFiles.length, verifiedGeneratedFiles.length)
            )
          ]
        ];

        return `
          <section class="worker-card">
            <div class="worker-head">
              <strong>${escapeHtml(execution.workerLabel || execution.workerId || "Worker")}</strong>
              <span class="badge ${escapeHtml(statusBadgeClass)}">${escapeHtml(status)}</span>
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
            <p class="meta-row">Thinking Summary: ${escapeHtml(output.thinkingSummary || "No public thinking summary.")}</p>
            <p>${escapeHtml(output.summary || "No summary returned.")}</p>
            <h3>Key Findings</h3>
            ${renderList(output.keyFindings, "No key findings returned.")}
            <h3>Risks</h3>
            ${renderList(output.risks, "No risks reported.")}
            <h3>Deliverables</h3>
            ${renderList(output.deliverables, "No deliverables listed.")}
            <h3>Tool Layer</h3>
            ${
              toolUsage.length
                ? `<div class="worker-chip-row">${toolUsage
                    .map((tool) => `<span class="chip">${escapeHtml(tool)}</span>`)
                    .join("")}</div>`
                : '<p class="placeholder">No tool calls were recorded.</p>'
            }
            <p class="meta-row">Memory reads / writes: ${escapeHtml(formatMetricNumber(memoryReads))} / ${escapeHtml(formatMetricNumber(memoryWrites))}</p>
            <h3>Leader Delegation Notes</h3>
            ${renderList(
              output.delegationNotes,
              output.subordinateCount ? "No delegation notes returned." : "This task was handled without subordinate agents."
            )}
            <h3>Subordinate Agents</h3>
            ${renderList(
              subordinateResults.map(
                (item) => `${item.agentLabel || item.agentId}: ${item.summary || item.status || "No summary"}`
              ),
              "No subordinate agents were created."
            )}
            <h3>Follow-ups</h3>
            ${renderList(output.followUps, "No follow-up actions suggested.")}
            <h3>Verification</h3>
            <p><span class="badge ${escapeHtml(verificationBadgeClass)}">${escapeHtml(verificationStatus)}</span></p>
            <h3>Executed Commands</h3>
            ${renderList(output.executedCommands, "No workspace commands were executed.")}
            <h3>Generated Files</h3>
            ${renderList(generatedFiles, "No generated files were reported.")}
            <h3>Verified Files</h3>
            ${renderList(verifiedGeneratedFiles, "No generated files were verified in the workspace.")}
          </section>
        `;
      })
      .join("");
  }

  function resetTracePanels() {
    traceUiState.spans = new Map();
    traceUiState.session = null;
    if (traceOutput) {
      traceOutput.innerHTML = '<p class="placeholder">Run the cluster to populate the task trace and call chain.</p>';
    }
    if (sessionOutput) {
      sessionOutput.innerHTML = '<p class="placeholder">Run the cluster to populate session memory, token/cost stats, retries, and circuit-breaker state.</p>';
    }
  }

  function renderTracePanel() {
    if (!traceOutput) {
      return;
    }

    const spans = Array.from(traceUiState.spans.values());
    if (!spans.length) {
      traceOutput.innerHTML = '<p class="placeholder">Run the cluster to populate the task trace and call chain.</p>';
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
          const badgeClass = status === "error" ? "failed" : status === "ok" ? "completed" : "";
          const usageLine = span.usage && typeof span.usage === "object"
            ? `Tokens ${formatMetricNumber(span.usage.inputTokens || 0)} in / ${formatMetricNumber(span.usage.outputTokens || 0)} out / ${formatMetricNumber(span.usage.totalTokens || 0)} total`
            : "";
          const metricParts = [];

          if (usageLine) {
            metricParts.push(usageLine);
          }
          if (Number.isFinite(Number(span.estimatedCostUsd)) && Number(span.estimatedCostUsd) > 0) {
            metricParts.push(`Cost ${formatUsd(span.estimatedCostUsd)}`);
          }
          if (Number.isFinite(Number(span.resultCount)) && Number(span.resultCount) >= 0) {
            metricParts.push(`Results ${formatMetricNumber(span.resultCount)}`);
          }
          if (Number.isFinite(Number(span.memoryCount)) && Number(span.memoryCount) > 0) {
            metricParts.push(`Memory ${formatMetricNumber(span.memoryCount)}`);
          }
          if (Number.isFinite(Number(span.exitCode))) {
            metricParts.push(`Exit ${span.exitCode}`);
          }

          const meta = [
            span.agentLabel || "",
            span.taskTitle || "",
            span.modelLabel || "",
            span.purpose || "",
            span.toolAction || "",
            span.durationMs ? `${span.durationMs} ms` : ""
          ]
            .filter(Boolean)
            .join(" / ");
          const detail = span.detail || "";

          return [
            `<article class="trace-node" style="--trace-depth:${depth};">`,
            '  <div class="trace-node-head">',
            `    <strong>${escapeHtml(span.spanLabel || span.spanKind || "span")}</strong>`,
            `    <span class="badge ${escapeHtml(badgeClass)}">${escapeHtml(status)}</span>`,
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
      `  <article class="session-metric-card"><span>Spans</span><strong>${escapeHtml(formatMetricNumber(spans.length))}</strong></article>`,
      `  <article class="session-metric-card"><span>Completed</span><strong>${escapeHtml(formatMetricNumber(completedCount))}</strong></article>`,
      `  <article class="session-metric-card"><span>Provider Calls</span><strong>${escapeHtml(formatMetricNumber(providerCount))}</strong></article>`,
      `  <article class="session-metric-card"><span>Tool Calls</span><strong>${escapeHtml(formatMetricNumber(toolCount))}</strong></article>`,
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
      sessionOutput.innerHTML = '<p class="placeholder">Run the cluster to populate session memory, token/cost stats, retries, and circuit-breaker state.</p>';
      return;
    }

    const totals = session.totals || {};
    const metrics = [
      ["Provider Calls", formatMetricNumber(totals.providerCalls)],
      ["Failures", formatMetricNumber(totals.providerFailures)],
      ["Retries", formatMetricNumber(totals.retries)],
      ["Tool Calls", formatMetricNumber(totals.toolCalls)],
      ["Memory R/W", `${formatMetricNumber(totals.memoryReads)} / ${formatMetricNumber(totals.memoryWrites)}`],
      ["Tokens", formatMetricNumber(totals.totalTokens)],
      ["Cost", formatUsd(totals.estimatedCostUsd)]
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
      `  <div class="trace-node-head"><h4>Model Stats</h4><span class="chip">${escapeHtml(formatMetricNumber(models.length))} model(s)</span></div>`,
      models.length
        ? models
            .map(
              (model) => `
                <article class="session-model-card">
                  <div class="trace-node-head">
                    <strong>${escapeHtml(model.modelLabel || model.modelId)}</strong>
                    <span class="chip">${escapeHtml(model.provider || "provider")}</span>
                  </div>
                  <p class="trace-node-meta">Calls ${escapeHtml(formatMetricNumber(model.providerCalls))} | Retries ${escapeHtml(formatMetricNumber(model.retries))} | Failures ${escapeHtml(formatMetricNumber(model.providerFailures))}</p>
                  <p class="trace-node-detail">Tokens ${escapeHtml(formatMetricNumber(model.totalTokens))} | Cost ${escapeHtml(formatUsd(model.estimatedCostUsd))}</p>
                </article>
              `
            )
            .join("")
        : '<p class="placeholder">No provider calls recorded yet.</p>',
      "</section>",
      '<section class="session-block">',
      `  <div class="trace-node-head"><h4>Session Memory</h4><span class="chip">${escapeHtml(formatMetricNumber(session.memory?.count || 0))} item(s)</span></div>`,
      recentMemory.length
        ? recentMemory
            .map(
              (entry) => `
                <article class="session-memory-card">
                  <div class="trace-node-head">
                    <strong>${escapeHtml(entry.title || entry.id)}</strong>
                    <span class="chip">${escapeHtml((entry.tags || []).join(", ") || "memory")}</span>
                  </div>
                  <p class="trace-node-meta">${escapeHtml(entry.agentLabel || "")}</p>
                  <p class="trace-node-detail">${escapeHtml(entry.content || "")}</p>
                </article>
              `
            )
            .join("")
        : '<p class="placeholder">No session memory entries recorded yet.</p>',
      "</section>",
      '<section class="session-block">',
      `  <div class="trace-node-head"><h4>Circuit Breakers</h4><span class="chip">${escapeHtml(formatMetricNumber(circuits.length))} model(s)</span></div>`,
      circuits.length
        ? circuits
            .map(
              (entry) => `
                <article class="session-circuit-card" data-state="${escapeAttribute(entry.state || "closed")}">
                  <div class="trace-node-head">
                    <strong>${escapeHtml(entry.modelLabel || entry.modelId)}</strong>
                    <span class="badge ${entry.state === "open" ? "failed" : entry.state === "closed" ? "completed" : ""}">${escapeHtml(entry.state || "closed")}</span>
                  </div>
                  <p class="trace-node-meta">Failures ${escapeHtml(formatMetricNumber(entry.consecutiveFailures))}</p>
                  <p class="trace-node-detail">${escapeHtml(entry.lastError || "No recent breaker error.")}</p>
                </article>
              `
            )
            .join("")
        : '<p class="placeholder">No circuit-breaker state recorded yet.</p>',
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

  return {
    renderWorkers,
    resetTracePanels,
    updateTraceStateFromEvent,
    updateSessionStateFromEvent
  };
}

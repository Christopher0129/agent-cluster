import {
  buildAgentLayout as buildAgentTreeLayout,
  resolveAgentGraphParentId,
  summarizeAgentActivity
} from "./agent-graph-layout.js";
import { describeOperationEvent as describeOperationEventMessage } from "./operation-events.js";

const AGENT_PREFIXES = {
  research: { leader: "Research Lead", subordinate: "Research Agent" },
  implementation: { leader: "Build Lead", subordinate: "Build Agent" },
  validation: { leader: "Validation Lead", subordinate: "Validation Agent" },
  handoff: { leader: "Handoff Lead", subordinate: "Handoff Agent" },
  general: { leader: "General Lead", subordinate: "General Agent" }
};

export function createAgentVizUi({
  elements,
  knownModelConfigs,
  escapeHtml,
  escapeAttribute,
  getSelectedControllerId,
  formatDelay,
  formatTimestamp
}) {
  const {
    agentVizSummary,
    agentVizTimer,
    agentVizStage,
    agentVizZoomLayer,
    agentVizSvg,
    agentVizTooltip,
    agentVizInspector,
    agentVizZoomLabel,
    agentVizZoomOutButton,
    agentVizZoomInButton,
    agentVizResetButton
  } = elements;

  const agentGraphState = {
    agents: new Map(),
    controllerId: "",
    controllerLabel: ""
  };
  const agentVizState = {
    scale: 1,
    minScale: 0.001,
    maxScale: 3.2,
    panX: 0,
    panY: 0,
    graphWidth: 1200,
    graphHeight: 760,
    hasViewportInteraction: false,
    isDragging: false,
    dragPointerId: null,
    dragMoved: false,
    dragStartX: 0,
    dragStartY: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    pointerDownAgentId: "",
    runStartedAt: 0,
    selectedAgentId: "",
    hoveredAgentId: ""
  };
  let agentRunTimerInterval = null;

  function setSummary(message, tone = "neutral") {
    if (!agentVizSummary) {
      return;
    }

    agentVizSummary.textContent = message;
    agentVizSummary.dataset.tone = tone;
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isAgentActiveStatus(status) {
    return ["thinking", "delegating", "spawning", "running", "retrying", "synthesizing"].includes(status);
  }

  function resolvePhaseLabel(phase) {
    switch (phase) {
      case "research":
        return "Research";
      case "implementation":
        return "Implementation";
      case "validation":
        return "Validation";
      case "handoff":
        return "Handoff";
      default:
        return "General";
    }
  }

  function resolveNodePalette(agent) {
    if (agent.kind === "controller") {
      return {
        accent: "#7aeaff",
        glow: "rgba(122, 234, 255, 0.34)",
        core: "#143d72",
        ring: "rgba(122, 234, 255, 0.9)"
      };
    }

    switch (agent.phase) {
      case "research":
        return {
          accent: "#58d7ff",
          glow: "rgba(88, 215, 255, 0.32)",
          core: "#113a62",
          ring: "rgba(88, 215, 255, 0.86)"
        };
      case "implementation":
        return {
          accent: "#6f9dff",
          glow: "rgba(111, 157, 255, 0.32)",
          core: "#182f67",
          ring: "rgba(111, 157, 255, 0.9)"
        };
      case "validation":
        return {
          accent: "#5ef0d2",
          glow: "rgba(94, 240, 210, 0.28)",
          core: "#0f4252",
          ring: "rgba(94, 240, 210, 0.88)"
        };
      case "handoff":
        return {
          accent: "#ffbf71",
          glow: "rgba(255, 191, 113, 0.28)",
          core: "#4b2f1d",
          ring: "rgba(255, 191, 113, 0.88)"
        };
      default:
        return {
          accent: "#74dfff",
          glow: "rgba(116, 223, 255, 0.3)",
          core: "#14385d",
          ring: "rgba(116, 223, 255, 0.88)"
        };
    }
  }

  function resolveStatusColor(status) {
    switch (status) {
      case "done":
        return "#36efb1";
      case "failed":
      case "cancelled":
        return "#ff6e8d";
      case "retrying":
        return "#ffd36d";
      case "thinking":
      case "delegating":
      case "spawning":
      case "synthesizing":
        return "#8ae8ff";
      default:
        return "#8fb8eb";
    }
  }

  function splitNodeLabel(label, maxCharsPerLine = 8, maxLines = 2) {
    const chars = Array.from(String(label || "Unnamed"));
    const lines = [];

    for (let lineIndex = 0; lineIndex < maxLines; lineIndex += 1) {
      const start = lineIndex * maxCharsPerLine;
      if (start >= chars.length) {
        break;
      }

      const end = start + maxCharsPerLine;
      let segment = chars.slice(start, end).join("");
      if (lineIndex === maxLines - 1 && chars.length > end) {
        segment = `${chars.slice(start, Math.max(start, end - 1)).join("")}...`;
      }
      lines.push(segment);
    }

    return lines.length ? lines : ["Unnamed"];
  }

  function resolveAgentPrefix(phase, kind) {
    const bucket = AGENT_PREFIXES[String(phase || "").trim()] || AGENT_PREFIXES.general;
    return bucket[kind] || AGENT_PREFIXES.general[kind] || "";
  }

  function formatLeaderDisplayLabel(workerId, phase) {
    const model = knownModelConfigs.get(workerId);
    const baseLabel = model?.label || workerId || "Unnamed Leader";
    return `${resolveAgentPrefix(phase, "leader")} | ${baseLabel}`;
  }

  function summarizeAgentStatus(agent) {
    switch (agent.status) {
      case "thinking":
        return "Thinking";
      case "delegating":
        return "Delegating";
      case "spawning":
        return "Spawning";
      case "running":
        return "Running";
      case "retrying":
        return "Retrying";
      case "synthesizing":
        return "Synthesizing";
      case "done":
        return "Done";
      case "failed":
        return "Failed";
      case "cancelled":
        return "Cancelled";
      default:
        return "Idle";
    }
  }

  function ensureAgentState(partial = {}) {
    const id = String(partial.id || "").trim();
    if (!id) {
      return null;
    }

    const existing = agentGraphState.agents.get(id) || {
      id,
      label: partial.label || id,
      kind: partial.kind || "leader",
      parentId: partial.parentId || "",
      parentLabel: partial.parentLabel || "",
      phase: partial.phase || "",
      status: "idle",
      action: "Waiting for work",
      notes: [],
      modelId: partial.modelId || "",
      modelLabel: partial.modelLabel || "",
      taskTitle: "",
      updatedAt: Date.now()
    };

    const next = {
      ...existing,
      ...partial,
      notes: Array.isArray(existing.notes) ? existing.notes : [],
      updatedAt: Date.now()
    };

    agentGraphState.agents.set(id, next);
    return next;
  }

  function appendAgentNote(agentId, message, timestamp = "") {
    if (!agentId || !message) {
      return;
    }

    const entry = ensureAgentState({ id: agentId });
    if (!entry) {
      return;
    }

    const note = `${timestamp ? `${timestamp} ` : ""}${message}`;
    if (entry.notes[entry.notes.length - 1] === note) {
      return;
    }

    entry.notes.push(note);
    if (entry.notes.length > 20) {
      entry.notes.shift();
    }
  }

  function getAgentNodeRadius(agent) {
    if (agent.kind === "controller") {
      return 58;
    }
    if (agent.kind === "leader") {
      return 46;
    }
    return 34;
  }

  function renderAgentInspector() {
    if (!agentVizInspector) {
      return;
    }

    const selectedAgent =
      (agentVizState.selectedAgentId && agentGraphState.agents.get(agentVizState.selectedAgentId)) ||
      (agentGraphState.controllerId && agentGraphState.agents.get(agentGraphState.controllerId)) ||
      Array.from(agentGraphState.agents.values()).find((agent) => isAgentActiveStatus(agent.status)) ||
      Array.from(agentGraphState.agents.values())[0];

    if (!selectedAgent) {
      agentVizInspector.innerHTML =
        '<p class="placeholder">Run the cluster and click a node to inspect the current agent.</p>';
      return;
    }

    const metaItems = [
      `Role: ${selectedAgent.kind === "controller" ? "Controller" : selectedAgent.kind === "leader" ? "Leader" : "Subordinate"}`,
      `Status: ${summarizeAgentStatus(selectedAgent)}`,
      selectedAgent.phase ? `Phase: ${resolvePhaseLabel(selectedAgent.phase)}` : "",
      selectedAgent.modelLabel ? `Model: ${selectedAgent.modelLabel}` : "",
      selectedAgent.taskTitle ? `Task: ${selectedAgent.taskTitle}` : ""
    ].filter(Boolean);

    const notes = selectedAgent.notes?.length
      ? `<ul>${selectedAgent.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
      : '<p class="placeholder">No public reasoning notes yet.</p>';

    agentVizInspector.innerHTML = `
      <div class="agent-inspector-head">
        <div>
          <p class="panel-kicker">Agent Detail</p>
          <h3>${escapeHtml(selectedAgent.label || selectedAgent.id)}</h3>
        </div>
        <span class="badge">${escapeHtml(summarizeAgentStatus(selectedAgent))}</span>
      </div>
      <p class="agent-inspector-action">${escapeHtml(selectedAgent.action || "Waiting for work")}</p>
      <div class="agent-inspector-meta">
        ${metaItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
      <div class="agent-inspector-notes">
        <h4>Public Reasoning And Trail</h4>
        ${notes}
      </div>
    `;
  }

  function hideAgentTooltip() {
    if (!agentVizTooltip) {
      return;
    }

    agentVizTooltip.hidden = true;
    agentVizTooltip.innerHTML = "";
  }

  function updateAgentTooltipPosition(clientX, clientY) {
    if (!agentVizStage || !agentVizTooltip || agentVizTooltip.hidden) {
      return;
    }

    const stageRect = agentVizStage.getBoundingClientRect();
    const tooltipRect = agentVizTooltip.getBoundingClientRect();
    const maxLeft = stageRect.width - tooltipRect.width - 12;
    const maxTop = stageRect.height - tooltipRect.height - 12;
    const left = clampNumber(clientX - stageRect.left + 18, 12, Math.max(12, maxLeft));
    const top = clampNumber(clientY - stageRect.top + 18, 12, Math.max(12, maxTop));
    agentVizTooltip.style.left = `${left}px`;
    agentVizTooltip.style.top = `${top}px`;
  }

  function showAgentTooltip(agent, clientX, clientY) {
    if (!agentVizTooltip || !agent) {
      return;
    }

    const latestNotes = (agent.notes || []).slice(-4);
    const noteMarkup = latestNotes.length
      ? `<ul>${latestNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
      : '<p class="placeholder">No public reasoning notes yet.</p>';

    agentVizTooltip.innerHTML = `
      <div class="agent-tooltip-head">
        <strong>${escapeHtml(agent.label || agent.id)}</strong>
        <span>${escapeHtml(summarizeAgentStatus(agent))}</span>
      </div>
      <p class="agent-tooltip-action">${escapeHtml(agent.action || "Waiting for work")}</p>
      ${noteMarkup}
    `;
    agentVizTooltip.hidden = false;
    updateAgentTooltipPosition(clientX, clientY);
  }

  function updateZoomLabel() {
    if (!agentVizZoomLabel) {
      return;
    }

    const percent = agentVizState.scale * 100;
    agentVizZoomLabel.textContent =
      percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(percent >= 1 ? 1 : 2)}%`;
  }

  function applyTransform() {
    if (!agentVizZoomLayer) {
      return;
    }

    agentVizZoomLayer.style.width = `${agentVizState.graphWidth}px`;
    agentVizZoomLayer.style.height = `${agentVizState.graphHeight}px`;
    agentVizZoomLayer.style.transform =
      `translate(${agentVizState.panX}px, ${agentVizState.panY}px) scale(${agentVizState.scale})`;
    updateZoomLabel();
  }

  function fitToGraph(force = false) {
    if (!agentVizStage || (!force && agentVizState.hasViewportInteraction)) {
      return;
    }

    const stageRect = agentVizStage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) {
      return;
    }

    const widthScale = (stageRect.width - 36) / Math.max(1, agentVizState.graphWidth);
    const heightScale = (stageRect.height - 36) / Math.max(1, agentVizState.graphHeight);
    agentVizState.scale = clampNumber(Math.min(widthScale, heightScale, 1), agentVizState.minScale, 1.15);
    agentVizState.panX = (stageRect.width - agentVizState.graphWidth * agentVizState.scale) / 2;
    agentVizState.panY = (stageRect.height - agentVizState.graphHeight * agentVizState.scale) / 2;
    applyTransform();
  }

  function setScale(nextScale, anchorX = null, anchorY = null) {
    if (!agentVizStage) {
      return;
    }

    const stageRect = agentVizStage.getBoundingClientRect();
    const pivotX = anchorX ?? stageRect.width / 2;
    const pivotY = anchorY ?? stageRect.height / 2;
    const previousScale = agentVizState.scale;
    const normalizedScale = clampNumber(nextScale, agentVizState.minScale, agentVizState.maxScale);

    if (Math.abs(normalizedScale - previousScale) < 0.0001) {
      return;
    }

    const worldX = (pivotX - agentVizState.panX) / previousScale;
    const worldY = (pivotY - agentVizState.panY) / previousScale;
    agentVizState.scale = normalizedScale;
    agentVizState.panX = pivotX - worldX * normalizedScale;
    agentVizState.panY = pivotY - worldY * normalizedScale;
    agentVizState.hasViewportInteraction = true;
    applyTransform();
  }

  function polarToCartesian(centerX, centerY, radius, angle) {
    return {
      x: Number((centerX + Math.cos(angle) * radius).toFixed(2)),
      y: Number((centerY + Math.sin(angle) * radius).toFixed(2))
    };
  }

  function buildDonutSectorPath(centerX, centerY, innerRadius, outerRadius, startAngle, endAngle) {
    const span = Math.max(0.001, endAngle - startAngle);
    const largeArc = span > Math.PI ? 1 : 0;
    const outerStart = polarToCartesian(centerX, centerY, outerRadius, startAngle);
    const outerEnd = polarToCartesian(centerX, centerY, outerRadius, endAngle);
    const innerEnd = polarToCartesian(centerX, centerY, innerRadius, endAngle);
    const innerStart = polarToCartesian(centerX, centerY, innerRadius, startAngle);

    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      `L ${innerEnd.x} ${innerEnd.y}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
      "Z"
    ].join(" ");
  }

  function buildRadialEdgePath(source, target, centerX, centerY) {
    if (!source || !target) {
      return "";
    }

    const sourceAngle = Number.isFinite(source.angle) ? source.angle : target.angle || -Math.PI / 2;
    const targetAngle = Number.isFinite(target.angle) ? target.angle : source.angle || -Math.PI / 2;
    const controlAngle = (sourceAngle + targetAngle) / 2;
    const sourceRadius = Math.max(0, Number(source.orbitRadius) || 0);
    const targetRadius = Math.max(0, Number(target.orbitRadius) || 0);
    const controlRadius =
      sourceRadius === 0 || targetRadius === 0
        ? Math.max(sourceRadius, targetRadius) * 0.54
        : (sourceRadius + targetRadius) / 2;
    const control = polarToCartesian(centerX, centerY, controlRadius, controlAngle);

    return `M ${source.x} ${source.y} Q ${control.x} ${control.y} ${target.x} ${target.y}`;
  }

  function buildAgentLayout(agents) {
    return buildAgentTreeLayout(agents, {
      controllerId: agentGraphState.controllerId
    });
  }

  function buildAgentSvg(layout) {
    const nodeMap = new Map(layout.nodes.map((node) => [node.agent.id, node]));
    const orbitMarkup = (layout.orbits || [])
      .map(
        (orbit) => `
          <circle
            class="agent-orbit-ring ${orbit.kind || ""}"
            cx="${layout.centerX}"
            cy="${layout.centerY}"
            r="${orbit.radius}"
          ></circle>
        `
      )
      .join("");
    const groupMarkup = layout.groups
      .map((group) => {
        const label = `${resolvePhaseLabel(group.leader.phase)} Group`;
        return `
          <g class="agent-group" data-phase="${escapeAttribute(group.leader.phase || "general")}">
            <path
              class="agent-group-band"
              d="${buildDonutSectorPath(
                layout.centerX,
                layout.centerY,
                group.bandInnerRadius,
                group.bandOuterRadius,
                group.startAngle,
                group.endAngle
              )}"
            ></path>
            <text class="agent-group-label" x="${group.labelPoint.x}" y="${group.labelPoint.y}">${escapeHtml(label)}</text>
          </g>
        `;
      })
      .join("");

    const edgeMarkup = layout.edges
      .map((edge) => {
        const source = nodeMap.get(edge.from);
        const target = nodeMap.get(edge.to);
        if (!source || !target) {
          return "";
        }

        const path = buildRadialEdgePath(source, target, layout.centerX, layout.centerY);
        return `
          <g class="agent-edge-group ${edge.active ? "active" : ""}" data-phase="${escapeAttribute(edge.phase || "general")}">
            <path class="agent-edge" d="${path}"></path>
            <path class="agent-edge-flow" d="${path}"></path>
          </g>
        `;
      })
      .join("");

    const nodeMarkup = layout.nodes
      .map((node) => {
        const { agent, x, y, radius } = node;
        const lines = splitNodeLabel(agent.label, agent.kind === "subordinate" ? 6 : 8, 2);
        const palette = resolveNodePalette(agent);
        const statusColor = resolveStatusColor(agent.status);
        const orbitDuration =
          agent.status === "thinking"
            ? "5s"
            : agent.status === "delegating" || agent.status === "spawning"
              ? "2.2s"
              : agent.status === "retrying"
                ? "1.6s"
                : "3.4s";
        const captionY = radius + 24;

        return `
          <g
            class="agent-node ${escapeAttribute(agent.kind || "leader")}"
            data-agent-id="${escapeAttribute(agent.id)}"
            data-status="${escapeAttribute(agent.status || "idle")}"
            transform="translate(${x} ${y})"
            style="--node-accent:${palette.accent}; --node-glow:${palette.glow}; --node-core:${palette.core}; --node-ring:${palette.ring}; --node-status:${statusColor};"
          >
            <title>${escapeHtml(agent.label || agent.id)}</title>
            <circle class="agent-node-wave wave-a" r="${radius + 10}">
              <animate attributeName="r" values="${radius + 8};${radius + 26};${radius + 8}" dur="2.4s" repeatCount="indefinite"></animate>
              <animate attributeName="opacity" values="0.7;0;0.7" dur="2.4s" repeatCount="indefinite"></animate>
            </circle>
            <circle class="agent-node-wave wave-b" r="${radius + 16}">
              <animate attributeName="r" values="${radius + 14};${radius + 34};${radius + 14}" dur="2.4s" begin="1.1s" repeatCount="indefinite"></animate>
              <animate attributeName="opacity" values="0.45;0;0.45" dur="2.4s" begin="1.1s" repeatCount="indefinite"></animate>
            </circle>
            <circle class="agent-node-shell" r="${radius + 10}"></circle>
            <circle class="agent-node-ring" r="${radius + 4}"></circle>
            <circle class="agent-node-core" r="${radius}"></circle>
            <circle class="agent-node-inner" r="${Math.round(radius * 0.72)}"></circle>
            <g class="agent-node-orbit">
              <circle class="agent-node-orb" cx="0" cy="${-(radius + 14)}" r="${Math.max(3, Math.round(radius * 0.11))}"></circle>
              <animateTransform
                attributeName="transform"
                attributeType="XML"
                type="rotate"
                from="0"
                to="360"
                dur="${orbitDuration}"
                repeatCount="indefinite"
              ></animateTransform>
            </g>
            <text class="agent-node-title" y="${lines.length > 1 ? -6 : 2}">${escapeHtml(lines[0])}</text>
            ${lines[1] ? `<text class="agent-node-title secondary" y="12">${escapeHtml(lines[1])}</text>` : ""}
            <text class="agent-node-caption" y="${captionY}">${escapeHtml(summarizeAgentStatus(agent))}</text>
          </g>
        `;
      })
      .join("");

    return `
      <defs>
        <filter id="agentNodeGlow" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="10" result="blur"></feGaussianBlur>
          <feMerge>
            <feMergeNode in="blur"></feMergeNode>
            <feMergeNode in="SourceGraphic"></feMergeNode>
          </feMerge>
        </filter>
      </defs>
      ${orbitMarkup}
      ${groupMarkup}
      ${edgeMarkup}
      ${nodeMarkup}
    `;
  }

  function renderEmpty() {
    if (agentVizSvg) {
      agentVizSvg.setAttribute("viewBox", "0 0 1200 760");
      agentVizSvg.innerHTML = `
        <defs>
          <filter id="agentNodeGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="10" result="blur"></feGaussianBlur>
            <feMerge>
              <feMergeNode in="blur"></feMergeNode>
              <feMergeNode in="SourceGraphic"></feMergeNode>
            </feMerge>
          </filter>
        </defs>
        <g class="agent-empty-state" transform="translate(600 320)">
          <circle class="agent-empty-orbit" r="92"></circle>
          <circle class="agent-empty-core" r="38"></circle>
          <circle class="agent-empty-dot" cx="0" cy="-92" r="5">
            <animateTransform
              attributeName="transform"
              attributeType="XML"
              type="rotate"
              from="0"
              to="360"
              dur="7s"
              repeatCount="indefinite"
            ></animateTransform>
          </circle>
          <text class="agent-empty-title" x="0" y="146">Waiting For Cluster Start</text>
          <text class="agent-empty-copy" x="0" y="176">The live agent graph will appear here once the run begins.</text>
        </g>
      `;
    }

    agentVizState.graphWidth = 1200;
    agentVizState.graphHeight = 760;
    agentVizState.selectedAgentId = "";
    agentVizState.hoveredAgentId = "";
    agentVizState.hasViewportInteraction = false;
    agentVizState.dragPointerId = null;
    agentVizState.dragMoved = false;
    agentVizState.pointerDownAgentId = "";
    hideAgentTooltip();
    fitToGraph(true);
    updateRunTimer("00:00");
    renderAgentInspector();
  }

  function renderGraph() {
    if (!agentVizSvg) {
      return;
    }

    const agents = Array.from(agentGraphState.agents.values());
    if (!agents.length) {
      renderEmpty();
      return;
    }

    const layout = buildAgentLayout(agents);
    agentVizState.graphWidth = layout.width;
    agentVizState.graphHeight = layout.height;
    agentVizSvg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    agentVizSvg.innerHTML = buildAgentSvg(layout);

    if (!agentVizState.selectedAgentId || !agentGraphState.agents.has(agentVizState.selectedAgentId)) {
      const defaultAgent =
        layout.controller ||
        layout.groups.find((group) => isAgentActiveStatus(group.leader.status))?.leader ||
        layout.groups[0]?.leader ||
        layout.nodes[0]?.agent;
      agentVizState.selectedAgentId = defaultAgent?.id || "";
    }

    renderAgentInspector();
    fitToGraph(!agentVizState.hasViewportInteraction);
    applyTransform();

    const activity = summarizeAgentActivity(agents);
    setSummary(
      activity.activeCount ? `Active ${activity.activeCount} / Total ${activity.totalCount}` : `Synced ${activity.totalCount}`,
      activity.activeCount ? "warning" : "ok"
    );
  }

  function bindEvents() {
    if (!agentVizStage) {
      return;
    }

    const resolveAgentNodeElement = (target) =>
      target instanceof Element ? target.closest("[data-agent-id]") : null;

    agentVizStage.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = agentVizStage.getBoundingClientRect();
        const anchorX = event.clientX - rect.left;
        const anchorY = event.clientY - rect.top;
        const zoomFactor = event.deltaY < 0 ? 1.12 : 0.9;
        setScale(agentVizState.scale * zoomFactor, anchorX, anchorY);
      },
      { passive: false }
    );

    agentVizStage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      const nodeElement = resolveAgentNodeElement(event.target);
      agentVizState.isDragging = true;
      agentVizState.dragMoved = false;
      agentVizState.dragPointerId = event.pointerId;
      agentVizState.dragStartX = event.clientX;
      agentVizState.dragStartY = event.clientY;
      agentVizState.lastPointerX = event.clientX;
      agentVizState.lastPointerY = event.clientY;
      agentVizState.pointerDownAgentId = nodeElement?.dataset.agentId || "";
      agentVizStage.classList.add("dragging");
      agentVizStage.setPointerCapture(event.pointerId);
      if (!agentVizState.pointerDownAgentId) {
        hideAgentTooltip();
      }
    });

    agentVizStage.addEventListener("pointermove", (event) => {
      if (agentVizState.isDragging && event.pointerId === agentVizState.dragPointerId) {
        const deltaX = event.clientX - agentVizState.lastPointerX;
        const deltaY = event.clientY - agentVizState.lastPointerY;
        const totalDeltaX = event.clientX - agentVizState.dragStartX;
        const totalDeltaY = event.clientY - agentVizState.dragStartY;
        agentVizState.lastPointerX = event.clientX;
        agentVizState.lastPointerY = event.clientY;
        if (!agentVizState.dragMoved && Math.hypot(totalDeltaX, totalDeltaY) >= 4) {
          agentVizState.dragMoved = true;
          hideAgentTooltip();
        }
        if (agentVizState.dragMoved) {
          agentVizState.panX += deltaX;
          agentVizState.panY += deltaY;
          agentVizState.hasViewportInteraction = true;
          applyTransform();
        }
        return;
      }

      const nodeElement = resolveAgentNodeElement(event.target);
      if (!nodeElement) {
        agentVizState.hoveredAgentId = "";
        hideAgentTooltip();
        return;
      }

      const agentId = nodeElement.dataset.agentId || "";
      const agent = agentGraphState.agents.get(agentId);
      if (!agent) {
        hideAgentTooltip();
        return;
      }

      agentVizState.hoveredAgentId = agentId;
      showAgentTooltip(agent, event.clientX, event.clientY);
    });
    const stopDragging = (event, selectNode = true) => {
      if (agentVizState.dragPointerId != null && event.pointerId !== agentVizState.dragPointerId) {
        return;
      }

      const selectedAgentId =
        selectNode && !agentVizState.dragMoved ? agentVizState.pointerDownAgentId : "";
      if (agentVizState.dragPointerId != null && agentVizStage.hasPointerCapture(agentVizState.dragPointerId)) {
        agentVizStage.releasePointerCapture(agentVizState.dragPointerId);
      }
      agentVizState.isDragging = false;
      agentVizState.dragPointerId = null;
      agentVizState.pointerDownAgentId = "";
      agentVizState.dragMoved = false;
      agentVizStage.classList.remove("dragging");

      if (selectedAgentId && agentGraphState.agents.has(selectedAgentId)) {
        agentVizState.selectedAgentId = selectedAgentId;
        renderAgentInspector();
      }
    };

    agentVizStage.addEventListener("pointerup", (event) => {
      stopDragging(event, true);
    });
    agentVizStage.addEventListener("pointercancel", (event) => {
      stopDragging(event, false);
    });
    agentVizStage.addEventListener("pointerleave", () => {
      if (!agentVizState.isDragging) {
        agentVizState.hoveredAgentId = "";
        hideAgentTooltip();
      }
    });

    agentVizZoomOutButton?.addEventListener("click", () => {
      setScale(agentVizState.scale * 0.9);
    });
    agentVizZoomInButton?.addEventListener("click", () => {
      setScale(agentVizState.scale * 1.12);
    });
    agentVizResetButton?.addEventListener("click", () => {
      agentVizState.hasViewportInteraction = false;
      fitToGraph(true);
    });
    window.addEventListener("resize", () => {
      if (!agentGraphState.agents.size) {
        renderEmpty();
        return;
      }

      fitToGraph(!agentVizState.hasViewportInteraction);
      applyTransform();
    });
  }

  function formatElapsedDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function updateRunTimer(forceText = "") {
    if (!agentVizTimer) {
      return;
    }

    if (forceText) {
      agentVizTimer.textContent = forceText;
      return;
    }

    if (!agentVizState.runStartedAt) {
      agentVizTimer.textContent = "00:00";
      return;
    }

    agentVizTimer.textContent = formatElapsedDuration(Date.now() - agentVizState.runStartedAt);
  }

  function startRunTimer() {
    agentVizState.runStartedAt = Date.now();
    updateRunTimer();
    if (agentRunTimerInterval) {
      clearInterval(agentRunTimerInterval);
    }
    agentRunTimerInterval = setInterval(() => {
      updateRunTimer();
    }, 1000);
  }

  function stopRunTimer() {
    if (agentRunTimerInterval) {
      clearInterval(agentRunTimerInterval);
      agentRunTimerInterval = null;
    }
  }

  function resolveControllerEventMeta() {
    const fallbackId = agentGraphState.controllerId || getSelectedControllerId?.() || "controller";
    const knownModel = knownModelConfigs.get(fallbackId);
    const fallbackLabel = agentGraphState.controllerLabel || knownModel?.label || "Controller Agent";
    return {
      agentId: fallbackId,
      agentLabel: fallbackLabel,
      agentKind: "controller",
      modelId: fallbackId,
      modelLabel: fallbackLabel
    };
  }

  function updateFromEvent(event) {
    const timestamp = formatTimestamp(event.timestamp);

    if (
      event.stage === "planning_start" ||
      event.stage === "planning_done" ||
      event.stage === "planning_retry" ||
      event.stage === "synthesis_start" ||
      event.stage === "synthesis_retry" ||
      event.stage === "cluster_done" ||
      event.stage === "cluster_failed" ||
      event.stage === "cluster_cancelled"
    ) {
      const controllerId = event.agentId || event.modelId || "controller";
      const controllerLabel = event.agentLabel || event.modelLabel || "Controller Agent";
      agentGraphState.controllerId = controllerId;
      agentGraphState.controllerLabel = controllerLabel;
      const controller = ensureAgentState({
        id: controllerId,
        label: controllerLabel,
        kind: "controller",
        modelId: event.modelId || controllerId,
        modelLabel: event.modelLabel || controllerLabel,
        status:
          event.stage === "planning_start"
            ? "thinking"
            : event.stage === "planning_retry" || event.stage === "synthesis_retry"
              ? "retrying"
              : event.stage === "synthesis_start"
                ? "synthesizing"
                : event.stage === "cluster_done"
                  ? "done"
                  : event.stage === "cluster_cancelled"
                    ? "cancelled"
                    : event.stage === "cluster_failed"
                      ? "failed"
                      : "delegating",
        action:
          event.stage === "planning_start"
            ? "Breaking down and assigning work"
            : event.stage === "synthesis_start"
              ? "Combining group outputs"
              : event.stage === "cluster_done"
                ? "Cluster synthesis completed"
                : event.stage === "cluster_cancelled"
                  ? "Run cancelled"
                  : event.stage === "cluster_failed"
                    ? "Run failed"
                    : event.detail || "Refreshing plan"
      });
      appendAgentNote(
        controller.id,
        event.planStrategy || event.detail || describeOperationEventMessage(event, { formatDelay }),
        timestamp
      );

      if (event.stage === "planning_done" && Array.isArray(event.planTasks)) {
        for (const task of event.planTasks) {
          const leaderId = `leader:${task.assignedWorker}`;
          ensureAgentState({
            id: leaderId,
            label: formatLeaderDisplayLabel(task.assignedWorker, task.phase),
            kind: "leader",
            modelId: task.assignedWorker,
            modelLabel: knownModelConfigs.get(task.assignedWorker)?.label || task.assignedWorker,
            phase: task.phase,
            status: task.delegateCount ? "delegating" : "idle",
            action: task.delegateCount
              ? `Prepared ${task.delegateCount} subordinate agent(s)`
              : "Ready for direct execution",
            taskTitle: task.title
          });
        }
      }

      renderGraph();
      return;
    }

    const fallbackAgentId =
      event.agentId ||
      (event.agentKind === "subordinate"
        ? `subordinate:${event.modelId}:${event.taskId || "task"}`
        : event.modelId
          ? `leader:${event.modelId}`
          : "");

    if (!fallbackAgentId) {
      return;
    }

    const normalizedKind =
      event.agentKind ||
      (String(event.stage || "").startsWith("subagent_") ? "subordinate" : "leader");
    const inferredLabel =
      event.agentLabel ||
      (normalizedKind === "leader"
        ? formatLeaderDisplayLabel(event.modelId || "", event.phase || "")
        : event.modelLabel || fallbackAgentId);

    const existingAgent = agentGraphState.agents.get(fallbackAgentId) || null;
    const agent = ensureAgentState({
      id: fallbackAgentId,
      label: inferredLabel,
      kind: normalizedKind,
      parentId: resolveAgentGraphParentId(event, normalizedKind, existingAgent),
      parentLabel: event.parentAgentLabel || existingAgent?.parentLabel || "",
      phase: event.phase || "",
      modelId: event.modelId || "",
      modelLabel: event.modelLabel || "",
      taskTitle: event.taskTitle || ""
    });

    switch (event.stage) {
      case "worker_start":
        agent.status = "running";
        agent.action = event.detail || "Leader execution started";
        break;
      case "worker_done":
        agent.status = event.tone === "warning" ? "failed" : "done";
        agent.action = "Leader execution completed";
        break;
      case "worker_failed":
        agent.status = "failed";
        agent.action = "Leader execution failed";
        break;
      case "worker_retry":
        agent.status = "retrying";
        agent.action = `Retry ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
        break;
      case "leader_delegate_start":
        agent.status = "thinking";
        agent.action = "Designing delegation plan";
        break;
      case "leader_delegate_done":
        agent.status = "delegating";
        agent.action = event.detail || "Delegation prepared";
        break;
      case "leader_delegate_retry":
        agent.status = "retrying";
        agent.action = `Delegation retry ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
        break;
      case "leader_synthesis_start":
        agent.status = "synthesizing";
        agent.action = "Collecting subordinate outputs";
        break;
      case "leader_synthesis_retry":
        agent.status = "retrying";
        agent.action = `Synthesis retry ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
        break;
      case "subagent_created":
        agent.status = "spawning";
        agent.action = event.detail || "Subordinate agent created";
        break;
      case "subagent_start":
        agent.status = "running";
        agent.action = "Subordinate execution started";
        break;
      case "subagent_done":
        agent.status = "done";
        agent.action = "Subordinate execution completed";
        break;
      case "subagent_failed":
        agent.status = "failed";
        agent.action = "Subordinate execution failed";
        break;
      case "subagent_retry":
        agent.status = "retrying";
        agent.action = `Retry ${event.attempt || ""}/${event.maxRetries || ""}`.trim();
        break;
      case "workspace_list":
      case "workspace_read":
      case "workspace_write":
      case "workspace_command":
        agent.status = "running";
        agent.action = describeOperationEventMessage(event, { formatDelay });
        break;
      default:
        break;
    }

    appendAgentNote(
      agent.id,
      event.thinkingSummary || event.detail || describeOperationEventMessage(event, { formatDelay }),
      timestamp
    );
    renderGraph();
  }

  function reset() {
    agentGraphState.controllerId = "";
    agentGraphState.controllerLabel = "";
    agentGraphState.agents.clear();
    agentVizState.selectedAgentId = "";
    agentVizState.hoveredAgentId = "";
    agentVizState.hasViewportInteraction = false;
    agentVizState.isDragging = false;
    agentVizState.dragPointerId = null;
    agentVizState.dragMoved = false;
    agentVizState.pointerDownAgentId = "";
    stopRunTimer();
    renderEmpty();
    setSummary("Waiting for run", "neutral");
  }

  return {
    bindEvents,
    reset,
    resolveControllerEventMeta,
    startRunTimer,
    stopRunTimer,
    updateFromEvent
  };
}

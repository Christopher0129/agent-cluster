function compareAgentLabels(left, right) {
  const leftLabel = String(left?.label || left?.id || "");
  const rightLabel = String(right?.label || right?.id || "");
  return leftLabel.localeCompare(rightLabel, "zh-CN");
}

function polarToCartesian(centerX, centerY, radius, angle) {
  return {
    x: Number((centerX + Math.cos(angle) * radius).toFixed(2)),
    y: Number((centerY + Math.sin(angle) * radius).toFixed(2))
  };
}

function computeMinimumChordRadius(span, itemCount, minimumDistance, fallbackRadius = 0) {
  const count = Math.max(0, Number(itemCount) || 0);
  if (count <= 1) {
    return Math.max(0, fallbackRadius);
  }

  const normalizedSpan = Math.max(0.001, Math.abs(Number(span) || 0));
  const step = normalizedSpan / Math.max(1, count - 1);
  const sine = Math.sin(Math.min(Math.PI - 0.001, step) / 2);

  if (!Number.isFinite(sine) || sine <= 0.001) {
    return Math.max(fallbackRadius, minimumDistance * count);
  }

  return Math.max(fallbackRadius, minimumDistance / (2 * sine));
}

function getAgentNodeRadius(agent) {
  if (agent?.kind === "controller") {
    return 58;
  }
  if (agent?.kind === "leader") {
    return 46;
  }
  return 34;
}

function isAgentActiveStatus(status) {
  return ["thinking", "delegating", "spawning", "running", "retrying", "synthesizing"].includes(status);
}

export function summarizeAgentActivity(agents) {
  const normalizedAgents = Array.isArray(agents) ? agents.filter(Boolean) : [];
  return {
    totalCount: normalizedAgents.length,
    activeCount: normalizedAgents.filter((agent) => isAgentActiveStatus(agent.status)).length
  };
}

function inferLeaderIdFromRuntimeId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const separatorIndex = normalized.indexOf("::");
  if (separatorIndex > 0) {
    return normalized.slice(0, separatorIndex);
  }

  return normalized.startsWith("leader:") ? normalized : "";
}

function allocateAngularSegments(items, startAngle, endAngle, fallbackAngle, getWeight) {
  const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!normalizedItems.length) {
    return [];
  }

  if (normalizedItems.length === 1) {
    return [
      {
        item: normalizedItems[0],
        startAngle,
        endAngle,
        centerAngle: fallbackAngle
      }
    ];
  }

  const span = endAngle - startAngle;
  if (!Number.isFinite(span) || Math.abs(span) < 0.001) {
    return normalizedItems.map((item) => ({
      item,
      startAngle,
      endAngle,
      centerAngle: fallbackAngle
    }));
  }

  const weights = normalizedItems.map((item) => Math.max(1, Number(getWeight(item)) || 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = startAngle;

  return normalizedItems.map((item, index) => {
    const sliceSpan = index === normalizedItems.length - 1 ? endAngle - cursor : (span * weights[index]) / totalWeight;
    const sliceStart = cursor;
    const sliceEnd = index === normalizedItems.length - 1 ? endAngle : cursor + sliceSpan;
    cursor = sliceEnd;
    return {
      item,
      startAngle: sliceStart,
      endAngle: sliceEnd,
      centerAngle: sliceStart + (sliceEnd - sliceStart) / 2
    };
  });
}

function resolveRootLeaderId(agent, agentById, cache, stack = new Set()) {
  if (!agent?.id) {
    return "";
  }

  if (cache.has(agent.id)) {
    return cache.get(agent.id);
  }

  if (agent.kind === "leader") {
    cache.set(agent.id, agent.id);
    return agent.id;
  }

  if (stack.has(agent.id)) {
    cache.set(agent.id, "");
    return "";
  }

  stack.add(agent.id);
  const explicitParentId = String(agent.parentId || "").trim();

  if (!explicitParentId) {
    cache.set(agent.id, "");
    stack.delete(agent.id);
    return "";
  }

  const parent = agentById.get(explicitParentId);
  let result = "";

  if (parent) {
    result = resolveRootLeaderId(parent, agentById, cache, stack);
  } else {
    result = inferLeaderIdFromRuntimeId(explicitParentId);
  }

  cache.set(agent.id, result);
  stack.delete(agent.id);
  return result;
}

function resolveGraphEdgeParentId(event, normalizedKind, existingAgent = null) {
  const explicitParentId = String(event?.parentAgentId || "").trim();
  if (explicitParentId) {
    return explicitParentId;
  }

  const retainedParentId = String(existingAgent?.parentId || "").trim();
  if (retainedParentId) {
    return retainedParentId;
  }

  if (normalizedKind !== "subordinate") {
    return "";
  }

  const runtimeAgentId = String(event?.agentId || "").trim();
  const separatorIndex = runtimeAgentId.lastIndexOf("::");
  if (separatorIndex > 0) {
    return runtimeAgentId.slice(0, separatorIndex);
  }

  const modelId = String(event?.modelId || "").trim();
  return modelId ? `leader:${modelId}` : "";
}

export function resolveAgentGraphParentId(event, normalizedKind, existingAgent = null) {
  return resolveGraphEdgeParentId(event, normalizedKind, existingAgent);
}

export function buildAgentLayout(agents, options = {}) {
  const normalizedAgents = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const controllerId = String(options.controllerId || "").trim();
  const agentById = new Map(
    normalizedAgents
      .filter((agent) => agent?.id)
      .map((agent) => [agent.id, agent])
  );
  const controller =
    normalizedAgents.find((agent) => agent.kind === "controller") ||
    (controllerId ? agentById.get(controllerId) : null);
  const leaders = normalizedAgents
    .filter((agent) => agent.kind === "leader")
    .sort(compareAgentLabels);
  const childrenByParent = new Map();

  for (const agent of normalizedAgents) {
    const parentId = String(agent?.parentId || "").trim();
    if (!parentId) {
      continue;
    }

    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, []);
    }
    childrenByParent.get(parentId).push(agent);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareAgentLabels);
  }

  const rootLeaderCache = new Map();
  const subtreeWeightCache = new Map();
  const subtreeDepthCache = new Map();
  const maxSiblingCount = Array.from(childrenByParent.values()).reduce(
    (maximum, children) => Math.max(maximum, children.length),
    0
  );

  const computeSubtreeWeight = (agentId) => {
    if (subtreeWeightCache.has(agentId)) {
      return subtreeWeightCache.get(agentId);
    }

    const children = childrenByParent.get(agentId) || [];
    const weight = children.length
      ? children.reduce((sum, child) => sum + computeSubtreeWeight(child.id), 0)
      : 1;
    subtreeWeightCache.set(agentId, weight);
    return weight;
  };

  const computeSubtreeDepth = (agentId) => {
    if (subtreeDepthCache.has(agentId)) {
      return subtreeDepthCache.get(agentId);
    }

    const children = childrenByParent.get(agentId) || [];
    const depth = children.length
      ? 1 + Math.max(...children.map((child) => computeSubtreeDepth(child.id)))
      : 0;
    subtreeDepthCache.set(agentId, depth);
    return depth;
  };

  const groups = leaders.map((leader) => {
    const descendants = normalizedAgents
      .filter(
        (agent) =>
          agent.kind === "subordinate" &&
          resolveRootLeaderId(agent, agentById, rootLeaderCache) === leader.id
      )
      .sort(compareAgentLabels);

    return {
      leader,
      descendants,
      subordinates: descendants,
      descendantCount: descendants.length,
      maxDepth: computeSubtreeDepth(leader.id)
    };
  });

  const maxDepth = groups.reduce((maxDepthValue, group) => Math.max(maxDepthValue, group.maxDepth), 0);
  const maxLeaderChildCount = leaders.reduce(
    (maximum, leader) => Math.max(maximum, (childrenByParent.get(leader.id) || []).length),
    0
  );
  const leaderOrbitRadius =
    leaders.length
      ? (controller ? 250 : 180) + Math.max(0, leaders.length - 4) * 18
      : 0;
  const firstSubordinateRadius =
    maxDepth > 0
      ? Math.max(
          leaderOrbitRadius + (controller ? 178 : 150),
          leaderOrbitRadius + 132 + Math.max(0, maxLeaderChildCount - 3) * 34,
          leaderOrbitRadius + 118 + Math.max(0, maxSiblingCount - 3) * 20
        )
      : 0;
  const subordinateRingSpacing = Math.max(112, 112 + Math.max(0, maxSiblingCount - 4) * 18);
  const outerContentRadiusEstimate =
    maxDepth > 0
      ? firstSubordinateRadius + Math.max(0, maxDepth - 1) * subordinateRingSpacing
      : leaderOrbitRadius || 180;
  const sectorInnerRadius =
    controller
      ? Math.max(118, leaderOrbitRadius - 88)
      : Math.max(94, outerContentRadiusEstimate - 132);
  const centerX = 0;
  const centerY = 0;
  const nodes = [];
  const edges = [];
  const nodeById = new Map();

  function pushNode(entry) {
    nodes.push(entry);
    if (entry?.agent?.id) {
      nodeById.set(entry.agent.id, entry);
    }
  }

  if (controller) {
    pushNode({
      agent: controller,
      x: centerX,
      y: centerY,
      angle: -Math.PI / 2,
      orbitRadius: 0,
      radius: getAgentNodeRadius(controller)
    });
  }

  const weights = groups.map((group) => Math.max(1, 0.96 + group.descendantCount * 0.24 + group.maxDepth * 0.34));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const spans = groups.map((group, index) => ((Math.PI * 2) * weights[index]) / totalWeight);
  let angleCursor = spans.length ? -Math.PI / 2 - spans[0] / 2 : -Math.PI / 2;

  groups.forEach((group, index) => {
    const span = spans[index] || Math.PI * 2;
    const startAngle = angleCursor;
    const endAngle = angleCursor + span;
    const centerAngle = startAngle + span / 2;
    const leaderPoint = polarToCartesian(centerX, centerY, leaderOrbitRadius, centerAngle);
    pushNode({
      agent: group.leader,
      x: leaderPoint.x,
      y: leaderPoint.y,
      angle: centerAngle,
      orbitRadius: leaderOrbitRadius,
      radius: getAgentNodeRadius(group.leader)
    });

    if (controller) {
      edges.push({
        from: controller.id,
        to: group.leader.id,
        phase: group.leader.phase,
        active: isAgentActiveStatus(controller.status) || isAgentActiveStatus(group.leader.status)
      });
    }

    const sectorPadding = Math.min(0.22, span * 0.14);
    group.startAngle = startAngle;
    group.endAngle = endAngle;
    group.centerAngle = centerAngle;
    group.bandInnerRadius = sectorInnerRadius;
    group.bandOuterRadius = leaderOrbitRadius + 80;
    let groupMaxOrbitRadius = leaderOrbitRadius + getAgentNodeRadius(group.leader);

    const placeChildren = (parentAgent, rangeStart, rangeEnd, fallbackAngle, depth) => {
      const children = childrenByParent.get(parentAgent.id) || [];
      if (!children.length) {
        return;
      }

      const spanSize = rangeEnd - rangeStart;
      const padding = Math.min(0.18, Math.max(0, spanSize) * 0.08);
      let effectiveStart = rangeStart + padding;
      let effectiveEnd = rangeEnd - padding;
      if (effectiveEnd - effectiveStart < 0.08) {
        effectiveStart = rangeStart;
        effectiveEnd = rangeEnd;
      }
      const effectiveSpan = Math.max(0.08, effectiveEnd - effectiveStart);
      const parentNode = nodeById.get(parentAgent.id);
      const parentOrbitRadius = Math.max(0, Number(parentNode?.orbitRadius) || 0);
      const baseOrbitRadius =
        firstSubordinateRadius + Math.max(0, depth - 1) * subordinateRingSpacing;
      const siblingDrivenRadius = computeMinimumChordRadius(
        effectiveSpan,
        children.length,
        116,
        baseOrbitRadius
      );
      const edgeDrivenRadius =
        parentOrbitRadius +
        Math.max(
          138,
          getAgentNodeRadius(parentAgent) + 72 + Math.max(0, children.length - 3) * 16
        );
      const orbitRadius = Math.max(baseOrbitRadius, siblingDrivenRadius, edgeDrivenRadius);
      groupMaxOrbitRadius = Math.max(groupMaxOrbitRadius, orbitRadius + 48);
      const segments = allocateAngularSegments(
        children,
        effectiveStart,
        effectiveEnd,
        fallbackAngle,
        (child) => computeSubtreeWeight(child.id)
      );

      segments.forEach((segment) => {
        const child = segment.item;
        const point = polarToCartesian(centerX, centerY, orbitRadius, segment.centerAngle);
        const childRadius = getAgentNodeRadius(child);
        pushNode({
          agent: child,
          x: point.x,
          y: point.y,
          angle: segment.centerAngle,
          orbitRadius,
          radius: childRadius
        });
        groupMaxOrbitRadius = Math.max(groupMaxOrbitRadius, orbitRadius + childRadius + 18);
        edges.push({
          from: parentAgent.id,
          to: child.id,
          phase: child.phase || parentAgent.phase || group.leader.phase,
          active: isAgentActiveStatus(parentAgent.status) || isAgentActiveStatus(child.status)
        });

        placeChildren(child, segment.startAngle, segment.endAngle, segment.centerAngle, depth + 1);
      });
    };

    placeChildren(group.leader, startAngle + sectorPadding, endAngle - sectorPadding, centerAngle, 1);
    group.bandOuterRadius = groupMaxOrbitRadius + 92;
    group.labelPoint = polarToCartesian(centerX, centerY, group.bandOuterRadius - 28, centerAngle);
    angleCursor = endAngle;
  });

  if (controller && !groups.length) {
    nodes[0].x = centerX;
    nodes[0].y = centerY;
  }

  const orbitKinds = new Map();
  for (const node of nodes) {
    const orbitRadius = Math.max(0, Number(node.orbitRadius) || 0);
    if (!orbitRadius) {
      continue;
    }

    const roundedRadius = Math.max(1, Math.round(orbitRadius / 12) * 12);
    if (!orbitKinds.has(roundedRadius)) {
      orbitKinds.set(roundedRadius, node.agent?.kind === "leader" ? "leaders" : "subordinates");
    }
  }

  const orbits = Array.from(orbitKinds.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([radius, kind], index) => ({
      radius,
      kind: kind || (index === 0 ? "leaders" : "subordinates")
    }));

  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity
  };
  const updateBounds = (x, y, padding = 0) => {
    bounds.minX = Math.min(bounds.minX, x - padding);
    bounds.maxX = Math.max(bounds.maxX, x + padding);
    bounds.minY = Math.min(bounds.minY, y - padding);
    bounds.maxY = Math.max(bounds.maxY, y + padding);
  };

  for (const node of nodes) {
    updateBounds(node.x, node.y, node.radius + 28);
  }

  for (const group of groups) {
    updateBounds(0, 0, group.bandOuterRadius + 8);
    updateBounds(group.labelPoint.x, group.labelPoint.y, 128);
  }

  if (!Number.isFinite(bounds.minX)) {
    updateBounds(0, 0, 180);
  }

  const margin = 160;
  const width = Math.max(1320, Math.ceil(bounds.maxX - bounds.minX + margin * 2));
  const height = Math.max(960, Math.ceil(bounds.maxY - bounds.minY + margin * 2));
  const offsetX = margin - bounds.minX;
  const offsetY = margin - bounds.minY;

  for (const node of nodes) {
    node.x = Number((node.x + offsetX).toFixed(2));
    node.y = Number((node.y + offsetY).toFixed(2));
  }

  for (const group of groups) {
    group.labelPoint = {
      x: Number((group.labelPoint.x + offsetX).toFixed(2)),
      y: Number((group.labelPoint.y + offsetY).toFixed(2))
    };
  }

  const finalCenterX = Number(offsetX.toFixed(2));
  const finalCenterY = Number(offsetY.toFixed(2));

  return {
    centerX: finalCenterX,
    centerY: finalCenterY,
    controller,
    orbits,
    groups,
    nodes,
    edges,
    width,
    height
  };
}

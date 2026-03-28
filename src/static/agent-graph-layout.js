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
  const leaderOrbitRadius = leaders.length ? (controller ? 250 : 180) : 0;
  const firstSubordinateRadius = maxDepth > 0 ? leaderOrbitRadius + (controller ? 178 : 150) : 0;
  const subordinateRingSpacing = 112;
  const subordinateRings = Array.from({ length: maxDepth }, (_, index) => firstSubordinateRadius + index * subordinateRingSpacing);
  const outerContentRadius = subordinateRings[subordinateRings.length - 1] || leaderOrbitRadius || 180;
  const sectorInnerRadius = controller ? Math.max(118, leaderOrbitRadius - 88) : Math.max(94, outerContentRadius - 132);
  const sectorOuterRadius = outerContentRadius + 88;
  const graphRadius = sectorOuterRadius + 134;
  const width = Math.max(1320, Math.round(graphRadius * 2));
  const height = Math.max(960, Math.round(graphRadius * 2));
  const centerX = width / 2;
  const centerY = height / 2;
  const nodes = [];
  const edges = [];
  const orbits = [leaderOrbitRadius, ...subordinateRings]
    .filter((radius) => Number(radius) > 0)
    .map((radius, index) => ({
      radius,
      kind: index === 0 ? "leaders" : index === 1 ? "subordinates" : "subordinates-outer"
    }));

  if (controller) {
    nodes.push({
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
    nodes.push({
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

    const phaseBandOuterRadius =
      group.maxDepth > 0
        ? (subordinateRings[group.maxDepth - 1] || outerContentRadius) + 72
        : leaderOrbitRadius + 80;
    const sectorPadding = Math.min(0.22, span * 0.14);
    group.startAngle = startAngle;
    group.endAngle = endAngle;
    group.centerAngle = centerAngle;
    group.bandInnerRadius = sectorInnerRadius;
    group.bandOuterRadius = phaseBandOuterRadius;
    group.labelPoint = polarToCartesian(centerX, centerY, phaseBandOuterRadius - 30, centerAngle);

    const placeChildren = (parentAgent, rangeStart, rangeEnd, fallbackAngle, depth) => {
      const children = childrenByParent.get(parentAgent.id) || [];
      if (!children.length) {
        return;
      }

      const spanSize = rangeEnd - rangeStart;
      const padding = Math.min(0.18, Math.max(0, spanSize) * 0.08);
      const effectiveStart = rangeStart + padding;
      const effectiveEnd = rangeEnd - padding;
      const orbitRadius =
        subordinateRings[Math.max(0, depth - 1)] ||
        firstSubordinateRadius + Math.max(0, depth - 1) * subordinateRingSpacing;
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
        nodes.push({
          agent: child,
          x: point.x,
          y: point.y,
          angle: segment.centerAngle,
          orbitRadius,
          radius: getAgentNodeRadius(child)
        });
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
    angleCursor = endAngle;
  });

  if (controller && !groups.length) {
    nodes[0].x = centerX;
    nodes[0].y = centerY;
  }

  return {
    centerX,
    centerY,
    controller,
    orbits,
    groups,
    nodes,
    edges,
    width,
    height
  };
}

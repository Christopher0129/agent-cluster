export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

export function renderList(items, emptyText = "暂无内容。") {
  const values = (Array.isArray(items) ? items : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);

  if (!values.length) {
    return `<p class="placeholder">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function normalizeStringList(value) {
  const normalizedValue = Array.isArray(value)
    ? value
    : String(value || "").replaceAll("锛沢", ",g");
  const items = Array.isArray(value)
    ? normalizedValue
    : normalizedValue.split(/[,\n，；;、锛沢]+/);

  return Array.from(
    new Set(
      items
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
}

export function formatDelay(ms) {
  return `${(Number(ms || 0) / 1000).toFixed(1)} 秒`;
}

export function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function openOperationStream(operationId, onEvent) {
  const source = new EventSource(`/api/operations/${encodeURIComponent(operationId)}/events`);
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      onEvent(payload);
    } catch {
      // Ignore malformed events from stale streams.
    }
  };
  return source;
}

export function createOperationId(prefix) {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomPart}`;
}

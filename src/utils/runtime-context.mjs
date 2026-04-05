function pad(value) {
  return String(value).padStart(2, "0");
}

function normalizeDateString(value) {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function normalizeTimeString(value) {
  const normalized = String(value || "").trim();
  return /^\d{2}:\d{2}(:\d{2})?$/.test(normalized)
    ? (normalized.length === 5 ? `${normalized}:00` : normalized)
    : "";
}

function resolveRuntimeNow(options = {}) {
  if (options.now instanceof Date) {
    return options.now;
  }

  const overrideDate = normalizeDateString(
    options.currentDate ||
      process.env.AGENT_CLUSTER_CURRENT_DATE ||
      process.env.CODEX_CURRENT_DATE
  );
  const overrideTime = normalizeTimeString(
    options.currentTime ||
      process.env.AGENT_CLUSTER_CURRENT_TIME
  );

  if (overrideDate) {
    const candidate = new Date(`${overrideDate}T${overrideTime || "12:00:00"}`);
    if (!Number.isNaN(candidate.valueOf())) {
      return candidate;
    }
  }

  return new Date();
}

function extractDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: parts.year || "0000",
    month: parts.month || "01",
    day: parts.day || "01",
    hour: parts.hour || "00",
    minute: parts.minute || "00",
    second: parts.second || "00"
  };
}

export function getRuntimeCalendarContext(options = {}) {
  const now = resolveRuntimeNow(options);
  const timeZone =
    String(options.timeZone || process.env.AGENT_CLUSTER_TIMEZONE || "").trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const parts = extractDateParts(now, timeZone);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;

  return {
    now,
    timeZone,
    localDate,
    localTime,
    localDateTime: `${localDate} ${localTime}`,
    isoTimestamp: now.toISOString()
  };
}

export function renderRuntimeCalendarNote(options = {}) {
  const context = getRuntimeCalendarContext(options);
  return [
    `Authoritative runtime clock: ${context.localDateTime} (${context.timeZone}).`,
    `This runtime clock overrides any background assumption about today's date. Do not claim the current date is anything else.`,
    `Treat any explicit date on or before ${context.localDate} as historical, not future.`,
    "Anchor relative terms such as today, yesterday, and tomorrow only to the authoritative runtime clock above."
  ].join(" ");
}

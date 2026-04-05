import test from "node:test";
import assert from "node:assert/strict";
import {
  getRuntimeCalendarContext,
  renderRuntimeCalendarNote
} from "../src/utils/runtime-context.mjs";

test("getRuntimeCalendarContext honors explicit runtime date overrides", () => {
  const context = getRuntimeCalendarContext({
    currentDate: "2026-04-04",
    currentTime: "08:16:00",
    timeZone: "Asia/Shanghai"
  });

  assert.equal(context.localDate, "2026-04-04");
  assert.equal(context.localTime, "08:16:00");
  assert.equal(context.timeZone, "Asia/Shanghai");
});

test("renderRuntimeCalendarNote marks the runtime clock as authoritative", () => {
  const note = renderRuntimeCalendarNote({
    currentDate: "2026-04-04",
    currentTime: "08:16:00",
    timeZone: "Asia/Shanghai"
  });

  assert.match(note, /Authoritative runtime clock:/);
  assert.match(note, /Do not claim the current date is anything else/);
  assert.match(note, /Treat any explicit date on or before 2026-04-04 as historical/);
});

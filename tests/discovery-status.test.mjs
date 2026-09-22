import assert from "node:assert/strict";
import test from "node:test";
import { isValidDiscoverySchedule, nextDiscoveryRun, presentDiscoveryStatus } from "../lib/discovery-status.ts";

const schedule = { minute: 6, startHour: 9, endHour: 20, timeZone: "America/New_York" };

test("finds the next hourly discovery run in the configured timezone", () => {
  assert.equal(nextDiscoveryRun(new Date("2026-09-22T15:45:30Z"), schedule), "2026-09-22T16:06:00.000Z");
  assert.equal(nextDiscoveryRun(new Date("2026-09-23T00:07:00Z"), schedule), "2026-09-23T13:06:00.000Z");
});

test("validates discovery schedules", () => {
  assert.equal(isValidDiscoverySchedule(schedule), true);
  assert.equal(isValidDiscoverySchedule({ ...schedule, minute: 60 }), false);
  assert.equal(isValidDiscoverySchedule({ ...schedule, timeZone: "Not/AZone" }), false);
});

test("marks abandoned running states as stale", () => {
  const base = {
    state: "running",
    runId: "run-1",
    startedAt: "2026-09-22T12:00:00.000Z",
    lastFinishedAt: "2026-09-22T11:10:00.000Z",
    lastResult: "No new work.",
    scheduleMinute: 6,
    scheduleStartHour: 9,
    scheduleEndHour: 20,
    scheduleTimeZone: "America/New_York",
    updatedAt: "2026-09-22T12:00:00.000Z",
  };
  assert.equal(presentDiscoveryStatus(base, new Date("2026-09-22T12:30:00.000Z")).state, "running");
  assert.equal(presentDiscoveryStatus(base, new Date("2026-09-22T14:00:00.000Z")).state, "stale");
});

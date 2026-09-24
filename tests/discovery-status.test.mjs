import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidDiscoverySchedule,
  nextDiscoveryRun,
  parseScheduleMinutes,
  presentDiscoveryStatus,
  previousDiscoveryRun,
  scheduleMinutes,
} from "../lib/discovery-status.ts";

const schedule = { minute: 6, minutes: [6], startHour: 9, endHour: 20, timeZone: "America/New_York" };
const halfHourly = { ...schedule, minutes: [6, 36] };

test("finds the next hourly discovery run in the configured timezone", () => {
  assert.equal(nextDiscoveryRun(new Date("2026-09-22T15:45:30Z"), schedule), "2026-09-22T16:06:00.000Z");
  assert.equal(nextDiscoveryRun(new Date("2026-09-23T00:07:00Z"), schedule), "2026-09-23T13:06:00.000Z");
});

test("finds half-hourly runs when two minute marks are configured", () => {
  assert.equal(nextDiscoveryRun(new Date("2026-09-22T16:10:00Z"), halfHourly), "2026-09-22T16:36:00.000Z");
  assert.equal(previousDiscoveryRun(new Date("2026-09-22T16:40:00Z"), halfHourly), "2026-09-22T16:36:00.000Z");
  assert.equal(previousDiscoveryRun(new Date("2026-09-23T06:00:00Z"), halfHourly), "2026-09-23T00:36:00.000Z");
});

test("validates discovery schedules", () => {
  assert.equal(isValidDiscoverySchedule(schedule), true);
  assert.equal(isValidDiscoverySchedule({ minutes: [6, 36], startHour: 9, endHour: 20, timeZone: "America/New_York" }), true);
  assert.equal(isValidDiscoverySchedule({ minutes: [], startHour: 9, endHour: 20, timeZone: "America/New_York" }), false);
  assert.equal(isValidDiscoverySchedule({ minutes: [6, 61], startHour: 9, endHour: 20, timeZone: "America/New_York" }), false);
  assert.deepEqual(scheduleMinutes({ minute: 36, minutes: [36, 6, 6] }), [6, 36]);
  assert.deepEqual(parseScheduleMinutes("6,36", 6), [6, 36]);
  assert.deepEqual(parseScheduleMinutes(null, 6), [6]);
  assert.equal(parseScheduleMinutes(null, null), null);
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
    scheduleMinutes: null,
    scheduleStartHour: 9,
    scheduleEndHour: 20,
    scheduleTimeZone: "America/New_York",
    updatedAt: "2026-09-22T12:00:00.000Z",
  };
  assert.equal(presentDiscoveryStatus(base, new Date("2026-09-22T12:30:00.000Z")).state, "running");
  assert.equal(presentDiscoveryStatus(base, new Date("2026-09-22T14:00:00.000Z")).state, "stale");
});

test("marks an idle schedule stale once a scheduled run is missed", () => {
  const base = {
    state: "idle",
    runId: "run-2",
    startedAt: "2026-09-22T22:12:59.000Z",
    lastFinishedAt: "2026-09-22T22:15:15.000Z",
    lastResult: "One card.",
    scheduleMinute: 6,
    scheduleMinutes: "6,36",
    scheduleStartHour: 9,
    scheduleEndHour: 20,
    scheduleTimeZone: "America/New_York",
    updatedAt: "2026-09-22T22:15:15.000Z",
  };
  assert.deepEqual(presentDiscoveryStatus(base, new Date("2026-09-23T06:00:00.000Z")).schedule.minutes, [6, 36]);
  // The 8:36 PM ET tick came and went with no start, so even overnight this is stale.
  const overnight = presentDiscoveryStatus(base, new Date("2026-09-23T06:00:00.000Z"));
  assert.equal(overnight.state, "stale");
  assert.equal(overnight.missedRunAt, "2026-09-23T00:36:00.000Z");
  // A pass that covered the last evening tick stays idle overnight.
  const evening = { ...base, startedAt: "2026-09-23T00:42:00.000Z", lastFinishedAt: "2026-09-23T00:45:00.000Z" };
  assert.equal(presentDiscoveryStatus(evening, new Date("2026-09-23T06:00:00.000Z")).state, "idle");
  // 9:06 AM ET passed 10 minutes ago: still inside the grace period.
  assert.equal(presentDiscoveryStatus(evening, new Date("2026-09-23T13:16:00.000Z")).state, "idle");
  // 9:06 AM ET passed 25 minutes ago with no start: the coordinator is gone.
  const missed = presentDiscoveryStatus(base, new Date("2026-09-23T13:31:00.000Z"));
  assert.equal(missed.state, "stale");
  assert.equal(missed.missedRunAt, "2026-09-23T13:06:00.000Z");
  // A run that started late for that tick clears it.
  const late = { ...base, state: "running", startedAt: "2026-09-23T13:13:00.000Z" };
  assert.equal(presentDiscoveryStatus(late, new Date("2026-09-23T13:31:00.000Z")).state, "running");
  const done = { ...base, startedAt: "2026-09-23T13:13:00.000Z", lastFinishedAt: "2026-09-23T13:16:00.000Z" };
  assert.equal(presentDiscoveryStatus(done, new Date("2026-09-23T13:31:00.000Z")).state, "idle");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { insideDiscoveryHours, missedRunNeedsRestart, oldestQueuedAgeMs, protectedPath } from "../scripts/agency-health.mjs";

test("protected paths are the macOS TCC folders only", () => {
  assert.equal(protectedPath("/Users/me/Documents/GitHub/agency"), true);
  assert.equal(protectedPath("/Users/me/Desktop"), true);
  assert.equal(protectedPath("/Users/me/Downloads/x"), true);
  assert.equal(protectedPath("/Users/me/agency"), false);
  assert.equal(protectedPath("/Users/me/MyDocuments/agency"), false);
});

test("oldest queued age uses the earliest job and tolerates sqlite timestamps", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const jobs = [{ createdAt: "2026-10-06 11:30:00" }, { createdAt: "2026-10-06 11:50:00" }, { createdAt: "garbage" }];
  assert.equal(oldestQueuedAgeMs(jobs, now), 30 * 60 * 1000);
  assert.equal(oldestQueuedAgeMs([], now), 0);
});

test("discovery hours follow the schedule's own time zone", () => {
  const schedule = { startHour: 9, endHour: 20, timeZone: "America/New_York" };
  assert.equal(insideDiscoveryHours(schedule, Date.parse("2026-10-10T00:36:00Z")), true); // 8:36 PM ET
  assert.equal(insideDiscoveryHours(schedule, Date.parse("2026-10-10T01:05:00Z")), false); // 9:05 PM ET
  assert.equal(insideDiscoveryHours(schedule, Date.parse("2026-10-10T12:09:00Z")), false); // 8:09 AM ET
  assert.equal(insideDiscoveryHours(schedule, Date.parse("2026-10-10T13:06:00Z")), true); // 9:06 AM ET
  assert.equal(insideDiscoveryHours(null), true);
});

test("a missed run stops asking for restarts once one happened and no catch-up can run", () => {
  const schedule = { startHour: 9, endHour: 20, timeZone: "America/New_York" };
  const stale = { state: "stale", missedRunAt: "2026-10-10T00:36:00.000Z", schedule };
  const night = Date.parse("2026-10-10T12:09:00Z");
  const day = Date.parse("2026-10-10T15:00:00Z");
  assert.equal(missedRunNeedsRestart(stale, undefined, night), true);
  assert.equal(missedRunNeedsRestart(stale, "2026-10-09T00:36:00.000Z", night), true);
  assert.equal(missedRunNeedsRestart(stale, stale.missedRunAt, night), false);
  // Inside discovery hours a catch-up pass is still possible, so keep restarting.
  assert.equal(missedRunNeedsRestart(stale, stale.missedRunAt, day), true);
  assert.equal(missedRunNeedsRestart({ state: "idle", missedRunAt: null, schedule }, undefined, night), false);
});

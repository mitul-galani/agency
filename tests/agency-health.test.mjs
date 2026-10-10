import { test } from "node:test";
import assert from "node:assert/strict";
import { missedRunNeedsRestart, oldestQueuedAgeMs, protectedPath } from "../scripts/agency-health.mjs";

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

test("a missed run stops asking for restarts once one happened and no catch-up can run", () => {
  const now = Date.parse("2026-10-10T01:30:00Z");
  const stale = { state: "stale", missedRunAt: "2026-10-10T00:36:00.000Z", nextRunAt: "2026-10-10T13:06:00.000Z" };
  const before = Date.parse("2026-10-10T00:30:00Z");
  const after = Date.parse("2026-10-10T00:56:00Z");
  assert.equal(missedRunNeedsRestart(stale, undefined, now), true);
  assert.equal(missedRunNeedsRestart(stale, before, now), true);
  assert.equal(missedRunNeedsRestart(stale, after, now), false);
  // Inside discovery hours a catch-up pass is still possible, so keep restarting.
  const inHours = { ...stale, nextRunAt: "2026-10-10T01:36:00.000Z" };
  assert.equal(missedRunNeedsRestart(inHours, after, now), true);
  assert.equal(missedRunNeedsRestart({ state: "idle", missedRunAt: null }, undefined, now), false);
});

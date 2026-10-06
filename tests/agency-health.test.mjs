import { test } from "node:test";
import assert from "node:assert/strict";
import { oldestQueuedAgeMs, protectedPath } from "../scripts/agency-health.mjs";

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

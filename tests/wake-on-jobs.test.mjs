import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findCoordinator, nudgeText } from "../scripts/wake-on-jobs.mjs";

test("picks the newest matching coordinator session in the right directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-"));
  writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, name: "Personal Agency", cwd: "/repo", startedAt: 10 }));
  writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: 2, name: "personal agency cron recreation", cwd: "/repo", startedAt: 20 }));
  writeFileSync(join(dir, "3.json"), JSON.stringify({ pid: 3, name: "Personal Agency", cwd: "/elsewhere", startedAt: 30 }));
  writeFileSync(join(dir, "4.json"), JSON.stringify({ pid: 4, name: "Agency Discovery", cwd: "/repo", startedAt: 40 }));
  assert.equal(findCoordinator(dir, /personal agency/i, "/repo")?.pid, 2);
  assert.equal(findCoordinator(dir, /nobody/i, "/repo"), null);
});

test("the wake message names the jobs and forbids new schedules", () => {
  const text = nudgeText([390, 391]);
  assert.match(text, /^WAKE: 2 new Agency jobs queued \(ids 390, 391\)/);
  assert.match(text, /chatUrl/);
  assert.match(text, /Do not create any new scheduled task/);
});

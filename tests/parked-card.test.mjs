import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cardShortcut } from "../lib/card-shortcut.ts";
import { APPEND_JOB_INSTRUCTION_SQL, UPDATE_JOB_STATUS_SQL } from "../lib/job-instructions.ts";
import { normalizeParkedUntil, WAKE_PARKED_SQL } from "../lib/parked-card.ts";

test("normalizes timezone-aware return times to UTC", () => {
  assert.deepEqual(
    normalizeParkedUntil("2026-09-21T09:00:00-04:00", new Date("2026-09-16T12:00:00Z")),
    { value: "2026-09-21 13:00:00" },
  );
  assert.equal(normalizeParkedUntil(null).value, null);
});

test("rejects ambiguous or elapsed return times", () => {
  assert.match(normalizeParkedUntil("2026-09-21T09:00:00", new Date("2026-09-16T12:00:00Z")).error, /timezone/);
  assert.match(normalizeParkedUntil("2026-09-15T09:00:00-04:00", new Date("2026-09-16T12:00:00Z")).error, /future/);
});

test("wakes only due parked cards", () => {
  const directory = mkdtempSync(join(tmpdir(), "agency-parked-"));
  const database = join(directory, "test.sqlite");
  try {
    execFileSync("sqlite3", [database, `
      CREATE TABLE ideas (id INTEGER PRIMARY KEY, status TEXT, parked_until TEXT, parked_at TEXT, parked_note TEXT, created_at TEXT);
      INSERT INTO ideas VALUES (1, 'parked', '2020-01-01 00:00:00', '2019-01-01', 'due', '2019-01-01');
      INSERT INTO ideas VALUES (2, 'parked', '2999-01-01 00:00:00', '2026-01-01', 'later', '2026-01-01');
      INSERT INTO ideas VALUES (3, 'parked', NULL, '2026-01-01', 'indefinite', '2026-01-01');
      ${WAKE_PARKED_SQL};
    `]);
    const rows = JSON.parse(execFileSync("sqlite3", ["-json", database, "SELECT id,status,parked_until,parked_note FROM ideas ORDER BY id"], { encoding: "utf8" }));
    assert.deepEqual(rows, [
      { id: 1, status: "new", parked_until: null, parked_note: "" },
      { id: 2, status: "parked", parked_until: "2999-01-01 00:00:00", parked_note: "later" },
      { id: 3, status: "parked", parked_until: null, parked_note: "indefinite" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("P is the park shortcut", () => {
  assert.equal(cardShortcut({ key: "p", editable: false }), "park");
  assert.equal(cardShortcut({ key: "p", editable: true }), null);
});

test("new instructions prevent completion from an older job snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "agency-addendum-"));
  const database = join(directory, "test.sqlite");
  try {
    execFileSync("sqlite3", [database, `
      CREATE TABLE agent_jobs (
        id INTEGER PRIMARY KEY, idea_id INTEGER, status TEXT, user_feedback TEXT,
        feedback_revision INTEGER DEFAULT 0, result TEXT, ticket_outcome TEXT, updated_at TEXT
      );
      INSERT INTO agent_jobs VALUES (1, 10, 'running', 'Start here', 0, '', NULL, CURRENT_TIMESTAMP);
    `]);
    const appendSql = APPEND_JOB_INSTRUCTION_SQL.replaceAll("?", (match, offset) => {
      const before = APPEND_JOB_INSTRUCTION_SQL.slice(0, offset);
      const index = (before.match(/\?/g) ?? []).length;
      return ["'Also check Slack'", "'Also check Slack'", "1", "10"][index] ?? match;
    });
    execFileSync("sqlite3", [database, appendSql]);
    const staleUpdate = UPDATE_JOB_STATUS_SQL
      .replace("?", "'done'").replace("?", "'Finished'").replace("?", "'review'")
      .replace("?", "1").replace("?", "'running'").replace("?", "0");
    execFileSync("sqlite3", [database, staleUpdate]);
    const stale = JSON.parse(execFileSync("sqlite3", ["-json", database, "SELECT status,user_feedback,feedback_revision FROM agent_jobs"], { encoding: "utf8" }));
    assert.equal(stale[0].status, "running");
    assert.equal(stale[0].feedback_revision, 1);
    assert.match(stale[0].user_feedback, /Also check Slack/);

    const currentUpdate = UPDATE_JOB_STATUS_SQL
      .replace("?", "'done'").replace("?", "'Finished'").replace("?", "'review'")
      .replace("?", "1").replace("?", "'running'").replace("?", "1");
    execFileSync("sqlite3", [database, currentUpdate]);
    const current = JSON.parse(execFileSync("sqlite3", ["-json", database, "SELECT status FROM agent_jobs"], { encoding: "utf8" }));
    assert.equal(current[0].status, "done");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

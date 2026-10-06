import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveCronsFromTranscript } from "../scripts/lib/session-crons.mjs";

function row(type, content, extra = {}) {
  return JSON.stringify({ type, timestamp: "2026-10-06T10:00:00.000Z", message: { content }, ...extra });
}
const create = (id, input) => row("assistant", [{ type: "tool_use", id, name: "CronCreate", input }]);
const created = (useId, jobId, recurring) =>
  row("user", [{ type: "tool_result", tool_use_id: useId, content: `Scheduled ${recurring ? "recurring job" : "one-shot task"} ${jobId}` }]);
const del = (useId, id) => row("assistant", [{ type: "tool_use", id: useId, name: "CronDelete", input: { id } }]);
const deleted = (useId, text = "Deleted") => row("user", [{ type: "tool_result", tool_use_id: useId, content: text }]);
const fire = (taskId) => JSON.stringify({ type: "system", subtype: "scheduled_task_fire", taskId });

function transcript(lines) {
  const path = join(mkdtempSync(join(tmpdir(), "crons-")), "t.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("keeps recurring crons that were not deleted", async () => {
  const live = await liveCronsFromTranscript(transcript([
    create("a", { cron: "*/30 * * * *", prompt: "pass", recurring: true }),
    created("a", "aaaaaaaa", true),
    create("b", { cron: "0 9 * * *", prompt: "morning", recurring: true }),
    created("b", "bbbbbbbb", true),
    del("d", "bbbbbbbb"),
    deleted("d"),
    fire("aaaaaaaa"),
    fire("aaaaaaaa"),
  ]));
  assert.deepEqual(live.map((c) => c.oldId), ["aaaaaaaa"]);
  assert.equal(live[0].fires, 2);
  assert.equal(live[0].cron, "*/30 * * * *");
});

test("drops one-shots that fired or whose time passed, keeps future ones", async () => {
  const now = new Date("2026-10-06T12:00:00Z");
  const live = await liveCronsFromTranscript(transcript([
    create("a", { at: "2026-10-06T11:00:00Z", prompt: "past" }),
    created("a", "aaaaaaaa", false),
    create("b", { at: "2026-10-06T13:00:00Z", prompt: "future" }),
    created("b", "bbbbbbbb", false),
    create("c", { at: "2026-10-06T14:00:00Z", prompt: "fired" }),
    created("c", "cccccccc", false),
    fire("cccccccc"),
  ]), now);
  assert.deepEqual(live.map((c) => c.oldId), ["bbbbbbbb"]);
  assert.equal(live[0].recurring, false);
});

test("a failed delete keeps the cron alive", async () => {
  const live = await liveCronsFromTranscript(transcript([
    create("a", { cron: "*/15 * * * *", prompt: "p", recurring: true }),
    created("a", "aaaaaaaa", true),
    del("d", "aaaaaaaa"),
    deleted("d", "Error: job aaaaaaaa not found"),
  ]));
  assert.equal(live.length, 1);
});

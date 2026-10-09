import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store location is read at import time, so point it at a fixture first.
const store = mkdtempSync(join(tmpdir(), "wispr-"));
process.env.WISPR_FLOW_DIR = store;
const { getTranscript, speakerNames } = await import("../scripts/wispr-flow.mjs");

const speakerMap = JSON.stringify({
  people: { p1: { name: "Ada Lovelace" }, me: { name: "Grace Hopper" } },
  assignments: {
    1: { consensus: "p1", user: null },
    2: { consensus: "p1", user: "me" },
    3: { consensus: null, user: null },
  },
});

test("speaker labels resolve through the map, user assignment first", () => {
  assert.deepEqual(speakerNames(speakerMap), { 1: "Ada Lovelace", 2: "Grace Hopper" });
  assert.deepEqual(speakerNames(null), {});
  assert.deepEqual(speakerNames("not json"), {});
});

test("transcript turns are parsed and named without a database", () => {
  const id = "abc";
  mkdirSync(join(store, "meetings", id), { recursive: true });
  writeFileSync(join(store, "meetings", id, "live.ndjson"), [
    JSON.stringify({ meta: { v: 3 } }),
    JSON.stringify({ timestamp: "0:02", text: " hello ", speaker: { id: 1001, source: "system", name: null } }),
    JSON.stringify({ timestamp: "0:05", text: "hi", speaker: { id: 7, source: "mic", name: "Grace" } }),
    "",
  ].join("\n"));
  const result = getTranscript(id);
  assert.equal(result.source, "live");
  assert.deepEqual(result.turns, [
    { at: "0:02", speaker: "Others", text: "hello" },
    { at: "0:05", speaker: "Grace", text: "hi" },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { combineContextItems, MAX_CONTEXT_ITEM_LENGTH } from "../lib/context-items.ts";

test("combines separate context notes in their supplied order", () => {
  const combined = combineContextItems([
    { text: "Prioritize anything blocking a launch." },
    { text: "Ignore routine medical-records updates." },
  ]);

  assert.equal(combined, "Prioritize anything blocking a launch.\n\nIgnore routine medical-records updates.");
});

test("trims context notes and omits empty entries", () => {
  assert.equal(combineContextItems([{ text: "  Keep this.  " }, { text: "   " }]), "Keep this.");
});

test("keeps individual context notes bounded", () => {
  assert.equal(MAX_CONTEXT_ITEM_LENGTH, 10_000);
});

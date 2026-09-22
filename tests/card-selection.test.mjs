import assert from "node:assert/strict";
import test from "node:test";

import { cardSelectionSubmission, MAX_CARD_SELECTION_LENGTH, normalizeCardSelection } from "../lib/card-selection.ts";

test("normalizes a card selection without flattening paragraphs", () => {
  assert.equal(normalizeCardSelection("  First   line\n\n Second\tline  "), "First line\nSecond line");
});

test("limits selected text before it is sent to an agent", () => {
  const selection = normalizeCardSelection("x".repeat(MAX_CARD_SELECTION_LENGTH + 20));
  assert.equal(selection.length, MAX_CARD_SELECTION_LENGTH);
  assert.match(selection, /…$/);
});

test("add to chat keeps selected text as context", () => {
  const submission = cardSelectionSubmission("chat", "A quoted claim", "Please verify this.");
  assert.equal(submission.label, "Selected context");
  assert.match(submission.prompt, /context.*instructions/);
  assert.match(submission.note, /A quoted claim/);
  assert.match(submission.note, /Please verify this\./);
});

test("start new task requests a deduplicated split from the current card", () => {
  const submission = cardSelectionSubmission("task", "Follow up with Cole", "Draft the reply first.");
  assert.equal(submission.label, "Start new task");
  assert.match(submission.prompt, /Reuse an existing Agency card/);
  assert.match(submission.prompt, /Remove that workstream from the current card/);
  assert.match(submission.addendum, /Draft the reply first\./);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/chat-activity.mjs", import.meta.url).pathname;

function row(type, content, extra = {}) {
  return JSON.stringify({ type, timestamp: "2026-10-02T15:00:00.000Z", cwd: "/Users/me/work", sessionId: "s1", message: { content }, ...extra });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "chat-activity-"));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const project = join(claude, "projects", "-Users-me-work");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(codex, "sessions", "2026", "10", "02"), { recursive: true });

  writeFileSync(join(project, "s1.jsonl"), [
    JSON.stringify({ type: "custom-title", customTitle: "Pricing memo", sessionId: "s1" }),
    row("user", "draft the pricing memo for Dana by friday, my api_key=abc123def456ghi789 is in the env"),
    row("assistant", [{ type: "tool_use", name: "Bash", input: {} }]),
    row("user", [{ type: "tool_result", content: "secret output" }]),
    row("assistant", [{ type: "text", text: "Drafted. Want me to send it to Dana?" }]),
    row("user", "Running scheduled task", { scheduledTaskId: "abcd1234" }),
    row("assistant", [{ type: "text", text: "Cron reply that is automation." }]),
    row("user", "<local-command-stdout>noise</local-command-stdout>"),
  ].join("\n"));
  // Headless pipeline run: excluded entirely.
  writeFileSync(join(project, "s2.jsonl"), [
    row("user", "You are the publish step. Publish now.", { sessionKind: "bg", sessionId: "s2" }),
    row("assistant", [{ type: "text", text: "Published." }], { sessionId: "s2" }),
  ].join("\n"));
  // Agency's own coordinator: excluded by cwd.
  writeFileSync(join(project, "s3.jsonl"), [
    row("user", "run discovery", { cwd: "/Users/me/agency-discovery", sessionId: "s3" }),
    row("assistant", [{ type: "text", text: "Pass complete." }], { cwd: "/Users/me/agency-discovery", sessionId: "s3" }),
  ].join("\n"));

  const codexRow = (role, text) => JSON.stringify({ timestamp: "2026-10-02T15:10:00.000Z", type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  writeFileSync(join(codex, "sessions", "2026", "10", "02", "rollout-2026-10-02T15-00-00-thread1.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-02T14:00:00.000Z", type: "session_meta", payload: { id: "thread1", cwd: "/Users/me/work" } }),
    codexRow("user", "# AGENTS.md instructions for /Users/me/work\n\n<INSTRUCTIONS>…"),
    codexRow("user", "<in-app-browser-context>tabs</in-app-browser-context>let's ship the referral fix tomorrow"),
    codexRow("assistant", "Planned for tomorrow."),
    codexRow("user", "<heartbeat><automation_id>x</automation_id>"),
  ].join("\n"));
  writeFileSync(join(codex, "sessions", "2026", "10", "02", "rollout-2026-10-02T15-00-00-review.jsonl"), [
    JSON.stringify({ timestamp: "2026-10-02T14:00:00.000Z", type: "session_meta", payload: { id: "review", cwd: "/Users/me/work" } }),
    codexRow("user", "The following is the Codex agent history whose request action you are assessing. …"),
    codexRow("assistant", "{\"risk_level\":\"low\"}"),
  ].join("\n"));
  return { claude, codex };
}

test("digests human turns only and scrubs secrets", () => {
  const { claude, codex } = setup();
  const output = execFileSync(process.execPath, [
    script, "--since", "2026-10-02T14:30:00Z", "--until", "2026-10-02T16:00:00Z",
    "--claude-dir", claude, "--codex-dir", codex,
  ], { encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.claudeCode.length, 1);
  assert.equal(result.claudeCode[0].name, "Pricing memo");
  assert.deepEqual(result.claudeCode[0].messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(result.claudeCode[0].messages[0].text, /pricing memo for Dana/);
  assert.doesNotMatch(output, /abc123def456ghi789/);
  assert.equal(result.codex.length, 1);
  assert.equal(result.codex[0].threadId, "thread1");
  assert.deepEqual(result.codex[0].messages.map((message) => message.text), ["let's ship the referral fix tomorrow", "Planned for tomorrow."]);
});

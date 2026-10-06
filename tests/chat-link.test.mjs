import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chatLinkFor } from "../scripts/chat-link.mjs";

test("maps a session id to its claude.ai link through the sessions registry", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-link-"));
  const dir = join(root, "sessions");
  mkdirSync(dir);
  writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "aaa", bridgeSessionId: "session_01ABC" }));
  writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: 2, sessionId: "bbb" }));
  writeFileSync(join(dir, "3.key"), "not json");
  assert.equal(chatLinkFor("aaa", dir), "https://claude.ai/code/session_01ABC");
  assert.equal(chatLinkFor("bbb", dir), null);
  assert.equal(chatLinkFor("zzz", dir), null);
  const script = new URL("../scripts/chat-link.mjs", import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, "--session", "aaa", "--claude-dir", root], { encoding: "utf8" }).trim();
  assert.equal(out, "https://claude.ai/code/session_01ABC");
});

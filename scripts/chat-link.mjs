#!/usr/bin/env node
/**
 * Print the claude.ai link for a Claude Code session, so a coordinator can
 * record which conversation it is running a job in. Every Claude Code session
 * that syncs to claude.ai has a bridge id in ~/.claude/sessions/<pid>.json;
 * the link is https://claude.ai/code/<that id>.
 *
 *   node scripts/chat-link.mjs                 # the calling session (CLAUDE_CODE_SESSION_ID)
 *   node scripts/chat-link.mjs --session <id>  # a specific session id
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const sessionId = flag("session") || process.env.CLAUDE_CODE_SESSION_ID;
const sessionsDir = flag("claude-dir") ? join(flag("claude-dir"), "sessions") : join(homedir(), ".claude", "sessions");

export function chatLinkFor(id, dir) {
  if (!id) return null;
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (record.sessionId === id && typeof record.bridgeSessionId === "string" && /^session_[A-Za-z0-9]+$/.test(record.bridgeSessionId)) {
        return `https://claude.ai/code/${record.bridgeSessionId}`;
      }
    } catch {
      // Not a session record.
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const link = chatLinkFor(sessionId, sessionsDir);
  if (!link) {
    console.error(sessionId ? `No claude.ai link found for session ${sessionId}.` : "No session id: set CLAUDE_CODE_SESSION_ID or pass --session.");
    process.exit(1);
  }
  console.log(link);
}

#!/usr/bin/env node
/**
 * Digest the user's recent Claude Code and Codex conversations on this machine,
 * so discovery can treat them as a source: what the user asked for, decided,
 * promised, or left unfinished in their coding-agent chats.
 *
 * Read-only. Prints the user's own messages and the assistant's replies inside
 * a time window, newest session first. It leaves out tool calls and results,
 * Agency's own coordinator sessions, scheduled-task firings and other
 * automation, Codex's internal review threads, and anything that looks like a
 * credential.
 *
 *   node scripts/chat-activity.mjs --since 2026-10-02T12:00:00Z [--until ISO] [--text]
 *       [--max-messages 40] [--max-chars 600] [--exclude <regex>]
 */
import { createReadStream, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
const text = args.includes("--text");
const until = new Date(flag("until", new Date().toISOString()));
const since = new Date(flag("since", new Date(until.getTime() - 90 * 60_000).toISOString()));
const maxMessages = Number(flag("max-messages", 40));
const maxChars = Number(flag("max-chars", 600));
const claudeDir = flag("claude-dir", join(homedir(), ".claude"));
const codexDir = flag("codex-dir", join(homedir(), ".codex"));
// Sessions that are automation rather than the user's own conversations.
const excludeName = new RegExp(
  flag("exclude", "^(🧭 )?personal agency$|^agency discovery|front lookup|chandler|publish .*artifact|dashboard artifact|oncall dashboard|chase dashboard"),
  "i",
);
const excludeCwd = /\/agency(-discovery)?$/;

if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
  console.error("Invalid --since or --until timestamp.");
  process.exit(1);
}

const SECRET_PATTERNS = [
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
];

function scrub(value) {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function clip(value) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function inWindow(timestamp) {
  const at = new Date(timestamp);
  return !Number.isNaN(at.getTime()) && at >= since && at <= until;
}

function modifiedSince(path) {
  try {
    return statSync(path).mtime >= since;
  } catch {
    return false;
  }
}

// Transcripts can run to hundreds of megabytes, mostly tool output. Stream
// them and only parse lines that can matter: session metadata, or a message
// stamped inside the window.
const STAMP = /"timestamp":"([^"]+)"/;
async function* readRows(path, keep) {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    const kind = line ? keep(line) : false;
    if (!kind) continue;
    const stamp = kind === "meta" ? null : STAMP.exec(line);
    if (stamp && !inWindow(stamp[1])) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Partial trailing line while the session is still writing.
    }
  }
}

// --- Claude Code -------------------------------------------------------------

function liveClaudeSessions() {
  const dir = join(claudeDir, "sessions");
  const names = new Map();
  if (!existsSync(dir)) return names;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const session = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (session.sessionId) names.set(session.sessionId, { name: session.name || "", live: true });
    } catch {
      // Not a session record.
    }
  }
  return names;
}

function claudeText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// Text the harness puts in the user's seat that the user never typed.
function isAutomationPrompt(value) {
  return value.startsWith("/") || value.includes("<command-name>") || value.startsWith("<local-command")
    || value.startsWith("[Request interrupted") || value.includes("<system-reminder>")
    || value.includes("[SYSTEM NOTIFICATION") || value.includes("<task-notification>");
}

// User-typed rows are read regardless of the window so that cron-driven and
// human turns can be told apart; tool results (the bulk of a transcript) are not.
const CLAUDE_KEEP = (line) => {
  if (line.includes('"type":"custom-title"')) return "meta";
  if (line.includes('"type":"user"')) return line.includes('"tool_result"') ? false : "meta";
  return line.includes('"type":"assistant"');
};

async function claudeSessions() {
  const projects = join(claudeDir, "projects");
  if (!existsSync(projects)) return [];
  const live = liveClaudeSessions();
  const sessions = [];
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project);
    let files;
    try {
      files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(dir, file);
      if (!modifiedSince(path)) continue;
      let name = "";
      let cwd = "";
      let sessionId = basename(file, ".jsonl");
      const messages = [];
      let headless = false;
      let humanTurns = 0;
      // A scheduled task's prompt and the replies to it are automation, not a
      // conversation; skip them until the user types something themselves.
      let automated = false;
      for await (const row of readRows(path, CLAUDE_KEEP)) {
        if (row.type === "custom-title" && row.customTitle) name = row.customTitle;
        if (row.sessionId) sessionId = row.sessionId;
        if (row.cwd && !cwd) cwd = row.cwd;
        if (row.type !== "user" && row.type !== "assistant") continue;
        if (row.sessionKind === "bg") {
          headless = true;
          break;
        }
        if (row.isSidechain || row.isMeta) continue;
        if (row.type === "user") {
          const body = claudeText(row.message?.content);
          if (!body.trim()) continue; // tool results
          automated = Boolean(row.scheduledTaskId) || isAutomationPrompt(body);
          if (automated) continue;
          humanTurns += 1;
          if (!row.timestamp || !inWindow(row.timestamp)) continue;
          messages.push({ at: row.timestamp, role: "user", text: clip(scrub(body)) });
          continue;
        }
        if (automated || !row.timestamp || !inWindow(row.timestamp)) continue;
        const body = claudeText(row.message?.content);
        if (body.trim()) messages.push({ at: row.timestamp, role: "assistant", text: clip(scrub(body)) });
      }
      if (headless || !humanTurns || !messages.length) continue;
      const registry = live.get(sessionId);
      if (registry?.name) name = registry.name;
      if (excludeCwd.test(cwd) || excludeName.test(name)) continue;
      sessions.push({
        source: "claude-code",
        sessionId,
        name,
        cwd,
        live: Boolean(registry),
        lastActivity: messages[messages.length - 1].at,
        messages: messages.slice(-maxMessages),
      });
    }
  }
  return sessions;
}

// --- Codex -------------------------------------------------------------------

const CODEX_REVIEW_PREFIX = "The following is the Codex agent history whose request action you are assessing";
const CODEX_NOISE = [/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/g, /<environment_context>[\s\S]*?<\/environment_context>/g];

function codexText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

const CODEX_KEEP = (line) => (line.includes('"session_meta"') ? "meta"
  : line.includes('"response_item"') && line.includes('"message"'));
const CODEX_AUTOMATION = /<heartbeat>|<automation_id>/;

async function codexSessions() {
  const sessions = [];
  for (const path of walk(join(codexDir, "sessions"))) {
    if (!modifiedSince(path)) continue;
    let cwd = "";
    let threadId = basename(path, ".jsonl").replace(/^rollout-[0-9T-]+-/, "");
    const messages = [];
    let review = false;
    for await (const row of readRows(path, CODEX_KEEP)) {
      const payload = row.payload || {};
      if (row.type === "session_meta") {
        cwd = payload.cwd || cwd;
        threadId = payload.id || threadId;
        continue;
      }
      if (row.type !== "response_item" || payload.type !== "message") continue;
      if (payload.role !== "user" && payload.role !== "assistant") continue;
      let body = codexText(payload.content);
      if (payload.role === "user") {
        if (body.startsWith(CODEX_REVIEW_PREFIX)) {
          review = true;
          break;
        }
        if (body.startsWith("# AGENTS.md instructions") || body.startsWith("<INSTRUCTIONS>")) continue;
        for (const pattern of CODEX_NOISE) body = body.replace(pattern, "");
      }
      if (CODEX_AUTOMATION.test(body)) continue;
      if (!row.timestamp || !inWindow(row.timestamp) || !body.trim()) continue;
      messages.push({ at: row.timestamp, role: payload.role, text: clip(scrub(body)) });
    }
    if (review || excludeCwd.test(cwd)) continue;
    if (!messages.some((message) => message.role === "user")) continue;
    sessions.push({
      source: "codex",
      threadId,
      cwd,
      file: path,
      lastActivity: messages[messages.length - 1].at,
      messages: messages.slice(-maxMessages),
    });
  }
  return sessions;
}

// --- output ------------------------------------------------------------------

const sessions = [...(await claudeSessions()), ...(await codexSessions())].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
const result = {
  since: since.toISOString(),
  until: until.toISOString(),
  sessions: sessions.length,
  messages: sessions.reduce((sum, session) => sum + session.messages.length, 0),
  claudeCode: sessions.filter((session) => session.source === "claude-code"),
  codex: sessions.filter((session) => session.source === "codex"),
};

if (!text) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Chats between ${result.since} and ${result.until}: ${result.sessions} sessions, ${result.messages} messages.`);
  for (const session of sessions) {
    const label = session.source === "claude-code"
      ? `Claude Code · ${session.name || session.sessionId}${session.live ? " (live)" : ""}`
      : `Codex · ${session.threadId}`;
    console.log(`\n== ${label} · ${session.cwd} · last ${session.lastActivity}`);
    for (const message of session.messages) {
      console.log(`[${message.at}] ${message.role === "user" ? "USER" : "ASSISTANT"}: ${message.text}`);
    }
  }
}

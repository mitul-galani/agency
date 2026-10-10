#!/usr/bin/env node
/**
 * Keep Agency healthy without a person watching it.
 *
 *   node scripts/agency-health.mjs check            # one report, as JSON
 *   node scripts/agency-health.mjs auto             # check every minute and apply the known fixes
 *   node scripts/agency-health.mjs fix <code>       # apply one fix by issue code
 *   node scripts/agency-health.mjs notify "<text>"  # push a line to the user's Slack (notify-me webhook)
 *
 * `check` looks at every running piece (app, discovery coordinator, execution
 * coordinator, wake watcher, orphaned workers) and names each problem with a
 * code and the fix that applies. `auto` runs those fixes with cooldowns and
 * records what it did in health.log; a problem that survives three fixes is
 * marked unresolved in health-state.json, where the Agency Health Claude
 * session picks it up (see health/CLAUDE.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { liveCronsFromTranscript } from "./lib/session-crons.mjs";
import {
  WINDOWS,
  agencyUrl,
  appLoopCommand,
  appStatus,
  healthClaudeCommand,
  healthLoopCommand,
  kickstartStack,
  orphanWorkerds,
  reapOrphans,
  restartWindow,
  root,
  tmuxSessionExists,
  tmuxWindows,
  wakeLoopCommand,
  windowOutput,
} from "./lib/stack.mjs";

const discoveryDir = resolve(process.env.AGENCY_DISCOVERY_DIR || root);
const statePath = resolve(root, "health-state.json");
const logPath = resolve(root, "health.log");
const sessionsDir = join(homedir(), ".claude", "sessions");
const projectsDir = join(homedir(), ".claude", "projects");
const executionModel = process.env.AGENCY_CLAUDE_MODEL || "claude-sonnet-5-5";
const executionName = process.env.AGENCY_EXECUTION_NAME || "🧭 Personal Agency";

const MINUTE = 60_000;
// How long a fix is left to take effect before the same issue is acted on again.
const COOLDOWN_MS = {
  "app.unreachable": 3 * MINUTE,
  "app.errors": 10 * MINUTE,
  "app.window": 2 * MINUTE,
  "wake.window": 2 * MINUTE,
  "health.window": 2 * MINUTE,
  "orphans": MINUTE,
  "discovery.missed": 30 * MINUTE,
  "discovery.source": 6 * 60 * MINUTE,
  "discovery.process": 5 * MINUTE,
  "execution.missing": 10 * MINUTE,
  "execution.stuck": 10 * MINUTE,
  "stack.down": 5 * MINUTE,
};
const UNRESOLVED_AFTER = 3;
const NOTIFY_EVERY_MS = 6 * 60 * MINUTE;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    // Logging must never break the checker.
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// A hand-edited or partial state file must not stop the checker.
function readState() {
  const state = readJson(statePath, {});
  for (const key of ["fixes", "unresolved", "notified", "sourceFailures"]) {
    if (!state[key] || typeof state[key] !== "object") state[key] = {};
  }
  state.executionSessionId ??= null;
  return state;
}

function writeState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

// --- signals -----------------------------------------------------------------

function sessionRecords() {
  let files = [];
  try {
    files = readdirSync(sessionsDir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const records = [];
  for (const file of files) {
    const record = readJson(join(sessionsDir, file), null);
    if (record?.pid) records.push(record);
  }
  return records;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function executionSession() {
  const candidates = sessionRecords()
    .filter((record) => record.kind === "bg" && record.cwd === root && alive(record.pid))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return candidates[0] ?? null;
}

function discoveryProcessAlive() {
  const listed = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
  return /(^|\/)claude .*--name Agency Discovery/m.test(listed.stdout || "");
}

async function queuedJobs() {
  try {
    const response = await fetch(`${agencyUrl}/api/agent-jobs`, { headers: { "x-radar-local-agent": "1" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return ((await response.json()).jobs ?? []).filter((job) => job.status === "queued");
  } catch {
    return null;
  }
}

async function discoveryStatus() {
  try {
    const response = await fetch(`${agencyUrl}/api/discovery-status`, { headers: { "x-radar-local-agent": "1" }, signal: AbortSignal.timeout(5_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function appErrorCount() {
  const output = windowOutput(WINDOWS.app, 120);
  const errors = (output.match(/ 500 in \d+ms|internal error; reference|EPERM/g) ?? []).length;
  return { errors, tail: output.split("\n").filter(Boolean).slice(-6) };
}

export function oldestQueuedAgeMs(jobs, now = Date.now()) {
  const stamps = jobs.map((job) => Date.parse(`${(job.createdAt ?? "").replace(" ", "T")}Z`)).filter(Number.isFinite);
  return stamps.length ? now - Math.min(...stamps) : 0;
}

export function protectedPath(path) {
  return /\/(Documents|Desktop|Downloads)(\/|$)/.test(path);
}

// A missed run is only worth another coordinator restart while a catch-up
// pass could still run. After the day's last scheduled run the coordinator
// rightly declines to catch up (it is outside discovery hours), so repeating
// the restart cannot clear the flag and would eventually page the owner for
// nothing. `handledMissedRunAt` is the missed run a restart was already
// requested for; it lives in its own state field because the fix counters
// reset whenever an issue disappears.
export function insideDiscoveryHours(schedule, now = Date.now()) {
  if (!schedule?.timeZone) return true;
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: schedule.timeZone }).format(now));
    return hour >= schedule.startHour && hour <= schedule.endHour;
  } catch {
    return true;
  }
}

export function missedRunNeedsRestart(discovery, handledMissedRunAt, now = Date.now()) {
  if (discovery?.state !== "stale" || !discovery.missedRunAt) return false;
  return insideDiscoveryHours(discovery.schedule, now) || handledMissedRunAt !== discovery.missedRunAt;
}

export async function check(state = readState()) {
  const issues = [];
  const found = { at: new Date().toISOString() };

  found.stack = tmuxSessionExists();
  if (!found.stack) {
    issues.push({ code: "stack.down", detail: "The agency-discovery tmux session is gone.", fix: "kickstart" });
    return { ...found, issues };
  }
  const windows = tmuxWindows();
  found.windows = windows;

  found.app = await appStatus();
  if (!found.app.ok) {
    // One retry: the dev server restarts itself in a few seconds after a crash.
    await new Promise((done) => setTimeout(done, 8_000));
    found.app = await appStatus();
  }
  if (!windows.includes(WINDOWS.app)) issues.push({ code: "app.window", detail: "The app window is missing.", fix: "app" });
  else if (!found.app.ok) issues.push({ code: "app.unreachable", detail: `Agency answers ${found.app.status || found.app.error} at ${agencyUrl}.`, fix: "app" });
  found.appErrors = appErrorCount();
  if (found.app.ok && found.appErrors.errors >= 3) {
    issues.push({ code: "app.errors", detail: `${found.appErrors.errors} server errors in the app's recent output.`, fix: "app" });
  }

  found.orphans = orphanWorkerds();
  if (found.orphans.length) issues.push({ code: "orphans", detail: `${found.orphans.length} orphaned workerd process(es).`, fix: "orphans" });

  if (!windows.includes(WINDOWS.wake)) issues.push({ code: "wake.window", detail: "The job wake watcher window is missing.", fix: "wake" });
  if (!windows.includes(WINDOWS.healthClaude)) issues.push({ code: "health.window", detail: "The Agency Health coordinator window is missing.", fix: "health-claude" });

  found.discoveryProcess = discoveryProcessAlive();
  found.discovery = await discoveryStatus();
  if (!found.discoveryProcess) {
    issues.push({ code: "discovery.process", detail: "No Agency Discovery Claude process is running.", fix: "discovery-restart" });
  } else if (missedRunNeedsRestart(found.discovery, state.handledMissedRunAt)) {
    issues.push({ code: "discovery.missed", detail: `Discovery missed its ${found.discovery.missedRunAt} run.`, fix: "discovery-restart" });
  }
  const discoveryState = readJson(resolve(discoveryDir, "discovery-state.json"), null);
  const sources = discoveryState?.lastSuccessfulPass?.sources ?? {};
  const runId = discoveryState?.lastSuccessfulPass?.runId ?? "";
  const failing = Object.entries(sources).filter(([, value]) => /^FAILED/i.test(String(value))).map(([name]) => name);
  found.failingSources = failing;
  // Two consecutive passes with the same connector failing: the session needs
  // fresh connections, which only a restart gives it.
  const previous = state.sourceFailures ?? {};
  const repeated = failing.filter((name) => previous[name] && previous[name] !== runId);
  if (repeated.length) issues.push({ code: "discovery.source", detail: `Source(s) failing on consecutive passes: ${repeated.join(", ")}.`, fix: "discovery-restart" });
  found.sourceFailures = Object.fromEntries(failing.map((name) => [name, runId]));

  found.execution = executionSession();
  if (!found.execution) {
    issues.push({ code: "execution.missing", detail: "No execution coordinator session is running in the repository.", fix: "execution" });
  } else {
    found.queued = await queuedJobs();
    if (found.queued && found.queued.length && found.execution.status !== "busy" && oldestQueuedAgeMs(found.queued) > 10 * MINUTE) {
      issues.push({ code: "execution.stuck", detail: `${found.queued.length} job(s) queued for over 10 minutes while the coordinator is idle.`, fix: "nudge" });
    }
  }

  if (protectedPath(root) || protectedPath(discoveryDir)) {
    issues.push({ code: "path.protected", detail: "The checkout lives in a macOS-protected folder (Documents/Desktop/Downloads); unattended processes get denied there.", fix: null });
  }
  return { ...found, issues };
}

// --- fixes -------------------------------------------------------------------

async function relaunchExecution(state) {
  const sessionId = state.executionSessionId;
  if (!sessionId) return "no previous execution session id recorded; nothing to resume";
  const slug = `-${root.replace(/^\//, "").replace(/\//g, "-")}`;
  const transcript = join(projectsDir, slug, `${sessionId}.jsonl`);
  if (existsSync(transcript)) {
    const crons = await liveCronsFromTranscript(transcript);
    mkdirSync(resolve(root, "agent-work"), { recursive: true });
    writeFileSync(resolve(root, "agent-work", "personal-agency-crons.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), fromSession: sessionId, note: "Live session-only schedules recovered by agency-health before a relaunch. Recreate each with CronCreate using cron/at, recurring, and prompt exactly; skip any one-shot whose time has passed.", schedules: crons }, null, 2)}\n`);
  }
  const prompt = "RESTART. The execution coordinator process was found missing by agency-health and resumed; the owner has standing approval for this restart. Session-only scheduled tasks did not survive. First read agent-work/personal-agency-crons.json and recreate every schedule listed there with CronCreate, using each entry's cron (or at), recurring flag, and prompt exactly as stored, skipping any one-shot whose time has already passed; verify with CronList. Then read CLAUDE.md and .pilot/PERSISTENT.md, process any queued agent jobs oldest first per the normal protocol (include chatUrl from node scripts/chat-link.mjs), and remain available through Remote Control.";
  const result = spawnSync("claude", [
    "--bg", "--resume", sessionId, "--remote-control", executionName, "--dangerously-skip-permissions",
    "--model", executionModel, "--effort", "high", prompt,
  ], { cwd: root, encoding: "utf8", timeout: 60_000 });
  return result.status === 0 ? `resumed ${sessionId} (${(result.stdout || "").trim().split("\n").pop()})` : `relaunch failed: ${(result.stderr || result.stdout || "").trim().slice(-200)}`;
}

export async function applyFix(fix, state) {
  switch (fix) {
    case "app":
      reapOrphans();
      restartWindow(WINDOWS.app, appLoopCommand());
      return "restarted the app window";
    case "orphans":
      return `killed orphaned workerd: ${reapOrphans().join(", ") || "none"}`;
    case "wake":
      restartWindow(WINDOWS.wake, wakeLoopCommand());
      return "restarted the wake watcher window";
    case "health-claude":
      restartWindow(WINDOWS.healthClaude, healthClaudeCommand());
      return "restarted the Agency Health coordinator window";
    case "health":
      restartWindow(WINDOWS.health, healthLoopCommand());
      return "restarted the health checker window";
    case "discovery-restart":
      if (!discoveryProcessAlive() && !tmuxWindows().includes(WINDOWS.coordinator)) {
        return kickstartStack() ? "stack relaunched through launchd" : "launchctl kickstart failed";
      }
      writeFileSync(resolve(discoveryDir, "discovery-restart-requested"), "");
      return "asked the discovery supervisor to resume the coordinator";
    case "nudge": {
      const result = spawnSync(process.execPath, [resolve(root, "scripts", "wake-on-jobs.mjs"), "--once", "--force"], { cwd: root, encoding: "utf8", timeout: 150_000 });
      return `nudged the execution coordinator (${(result.stdout || "").trim().split("\n").pop()})`;
    }
    case "execution":
      return relaunchExecution(state);
    case "kickstart":
      return kickstartStack() ? "stack relaunched through launchd" : "launchctl kickstart failed";
    default:
      return `no fix named ${fix}`;
  }
}

export function notify(text) {
  const webhookPath = join(homedir(), ".claude", "secrets", "claude_notifier_webhook");
  if (!existsSync(webhookPath)) return false;
  const url = readFileSync(webhookPath, "utf8").trim();
  const result = spawnSync("curl", ["-s", "-m", "15", "-X", "POST", "-H", "Content-type: application/json", "--data", JSON.stringify({ text }), url], { encoding: "utf8" });
  return result.status === 0;
}

// --- auto loop ---------------------------------------------------------------

async function autoOnce() {
  const state = readState();
  const report = await check(state);
  state.sourceFailures = report.sourceFailures ?? state.sourceFailures;
  if (report.execution?.sessionId) state.executionSessionId = report.execution.sessionId;
  const now = Date.now();
  const seen = new Set();
  for (const issue of report.issues) {
    seen.add(issue.code);
    const record = state.fixes[issue.code] ?? { attempts: 0, lastAt: 0 };
    if (!issue.fix) {
      if (!state.unresolved[issue.code]) log(`UNFIXABLE ${issue.code}: ${issue.detail}`);
      state.unresolved[issue.code] = { detail: issue.detail, since: state.unresolved[issue.code]?.since ?? report.at };
      continue;
    }
    if (now - record.lastAt < (COOLDOWN_MS[issue.code] ?? 5 * MINUTE)) continue;
    if (record.attempts >= UNRESOLVED_AFTER) {
      if (!state.unresolved[issue.code]) {
        log(`UNRESOLVED ${issue.code} after ${record.attempts} fixes: ${issue.detail}`);
        state.unresolved[issue.code] = { detail: issue.detail, since: report.at, attempts: record.attempts };
      }
      const lastNotified = state.notified[issue.code] ?? 0;
      if (now - lastNotified > NOTIFY_EVERY_MS) {
        notify(`Agency Health: ${issue.code} is still broken after ${record.attempts} automatic fixes. ${issue.detail} The Agency Health chat is on it; check health.log in the agency repo.`);
        state.notified[issue.code] = now;
      }
      continue;
    }
    const outcome = await applyFix(issue.fix, state);
    log(`FIX ${issue.code} (${issue.detail}) -> ${outcome}`);
    if (issue.code === "discovery.missed") state.handledMissedRunAt = report.discovery?.missedRunAt ?? null;
    state.fixes[issue.code] = { attempts: record.attempts + 1, lastAt: now, lastOutcome: outcome };
  }
  // Issues that disappeared are resolved: reset their counters.
  for (const code of Object.keys(state.fixes)) {
    if (!seen.has(code) && now - (state.fixes[code].lastAt ?? 0) > (COOLDOWN_MS[code] ?? 5 * MINUTE)) {
      if (state.fixes[code].attempts) log(`RESOLVED ${code}`);
      delete state.fixes[code];
      delete state.unresolved[code];
    }
  }
  for (const code of Object.keys(state.unresolved)) if (!seen.has(code)) delete state.unresolved[code];
  state.lastCheckAt = report.at;
  state.lastIssues = report.issues.map((issue) => issue.code);
  writeState(state);
  return report;
}

const command = process.argv[2];
if (process.argv[1] && basename(process.argv[1]) === "agency-health.mjs") {
  if (command === "check") {
    console.log(JSON.stringify(await check(), null, 2));
  } else if (command === "fix") {
    console.log(await applyFix(process.argv[3], readState()));
  } else if (command === "notify") {
    console.log(notify(process.argv.slice(3).join(" ")) ? "sent" : "no webhook configured");
  } else if (command === "auto") {
    log(`Health checker started (pid ${process.pid}); checking every minute.`);
    for (;;) {
      try {
        await autoOnce();
      } catch (error) {
        log(`check failed: ${error.message}`);
      }
      await new Promise((done) => setTimeout(done, MINUTE));
    }
  } else {
    console.error("usage: agency-health.mjs check | auto | fix <code> | notify <text>");
    process.exit(1);
  }
}

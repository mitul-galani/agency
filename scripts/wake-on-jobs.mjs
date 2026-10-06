#!/usr/bin/env node
/**
 * Wake the execution coordinator the moment a job is queued.
 *
 * The coordinator checks the queue on a schedule, so without this a user's
 * action could wait up to a full interval. This watcher polls the queue every
 * few seconds and, when a job it has not seen appears, sends the coordinator a
 * cross-session message through a short headless Claude run (the supported way
 * to message a running session from outside one). The coordinator processes the
 * queue on receipt and then returns to its schedule.
 *
 *   node scripts/wake-on-jobs.mjs            # run until stopped
 *   node scripts/wake-on-jobs.mjs --once     # one poll, nudge if needed, exit
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agencyUrl = process.env.RADAR_URL || "http://localhost:3100";
const pollMs = Number(process.env.AGENCY_WAKE_POLL_MS || 10_000);
// The coordinator session is found by name in the Claude Code sessions registry.
const coordinatorPattern = new RegExp(process.env.AGENCY_EXECUTION_SESSION || "personal agency", "i");
const nudgeModel = process.env.AGENCY_NUDGE_MODEL || "sonnet";
const once = process.argv.includes("--once");
const sessionsDir = join(homedir(), ".claude", "sessions");

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function queuedJobs() {
  const response = await fetch(`${agencyUrl}/api/agent-jobs`, {
    headers: { "x-radar-local-agent": "1" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return (body.jobs ?? []).filter((job) => job.status === "queued");
}

/**
 * The live execution coordinator. A resumed background session is renamed
 * after its first prompt, so a name match is only the first choice; the
 * fallback is the newest background session running in the repository.
 */
export function findCoordinator(dir = sessionsDir, pattern = coordinatorPattern, cwd = root) {
  let byName = null;
  let byPlace = null;
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return null;
  }
  const newer = (candidate, current) => !current || (candidate.startedAt ?? 0) > (current.startedAt ?? 0);
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (cwd && record.cwd && record.cwd !== cwd) continue;
      if (record.name && pattern.test(record.name) && newer(record, byName)) byName = record;
      if (record.kind === "bg" && newer(record, byPlace)) byPlace = record;
    } catch {
      // Not a session record.
    }
  }
  return byName ?? byPlace;
}

export function nudgeText(ids) {
  return `WAKE: ${ids.length} new Agency job${ids.length === 1 ? "" : "s"} queued (id${ids.length === 1 ? "" : "s"} ${ids.join(", ")}). `
    + "Run your queue pass now, exactly as your scheduled pass does: claim and process the queued jobs oldest first per PERSISTENT.md, "
    + "include chatUrl on each status update, then return to your normal schedule. Do not create any new scheduled task.";
}

function nudge(coordinator, ids) {
  const text = nudgeText(ids);
  const prompt = `Use the SendMessage tool to send exactly the following message to the Claude session named ${JSON.stringify(coordinator.name)} (pid ${coordinator.pid}). Send it verbatim, then reply with one word: sent.\n\n${text}`;
  // No MCP servers: the nudge only needs the built-in SendMessage tool, and
  // starting the user's servers each time spawns node processes that macOS
  // asks the user to allow. The prompt must come before --mcp-config, which
  // is variadic.
  const result = spawnSync("claude", [
    "-p", prompt, "--model", nudgeModel, "--permission-mode", "bypassPermissions", "--max-turns", "4",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const ok = result.status === 0 && /sent/i.test(output);
  log(ok ? `Nudged "${coordinator.name}" for job${ids.length === 1 ? "" : "s"} ${ids.join(", ")}.` : `Nudge failed (exit ${result.status}): ${output.slice(-300)}`);
  return ok;
}

const seen = new Set();
let primed = false;

async function poll() {
  let jobs;
  try {
    jobs = await queuedJobs();
  } catch (error) {
    log(`Agency not reachable (${error.message}); will retry.`);
    return;
  }
  const fresh = jobs.map((job) => job.id).filter((id) => !seen.has(id));
  for (const id of fresh) seen.add(id);
  if (!fresh.length) return;
  if (!primed) {
    // Jobs already waiting when the watcher starts still deserve a nudge.
    primed = true;
  }
  const coordinator = findCoordinator();
  if (!coordinator) {
    log(`${fresh.length} new job(s) queued but no execution coordinator session is registered; the schedule will pick them up.`);
    return;
  }
  nudge(coordinator, fresh);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  log(`Watching ${agencyUrl} for queued jobs every ${Math.round(pollMs / 1000)}s; coordinator name matches /${coordinatorPattern.source}/i.`);
  await poll();
  if (!once) {
    setInterval(() => { void poll(); }, pollMs);
  }
}

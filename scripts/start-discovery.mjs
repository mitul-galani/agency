/**
 * Dedicated Agency Discovery coordinator, kept alive until you stop it.
 *
 * Claude scheduled tasks live only inside one Claude process, so the whole
 * design is about keeping that one process (or its resumed successor) alive:
 *
 *   1. The launcher moves itself into a detached tmux session, so closing the
 *      terminal does not close the coordinator. It refuses to run under a
 *      parent that reaps its children (a Codex thread, the Claude daemon).
 *   2. Inside tmux it supervises Claude: if Claude exits for any reason it is
 *      relaunched with `--resume` on the same session ID, so the conversation
 *      continues, and the resume prompt recreates the schedules.
 *   3. The scheduled prompt itself renews the crons before their 7-day expiry
 *      (see CLAUDE.md), so nothing has to be touched by hand.
 *
 * Stop it with `npm run agency:discovery:stop`; watch it with
 * `npm run agency:discovery:attach`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInitialPrompt, buildResumePrompt, forbiddenParent } from "./lib/discovery-launcher.mjs";
import {
  WINDOWS, agencyUrl, appLoopCommand, appStatus, ensureWindow, healthClaudeCommand, healthLoopCommand,
  root, tmuxSession as stackSession, tmuxSessionExists, wakeLoopCommand,
} from "./lib/stack.mjs";
import { sleep, supervise } from "./lib/supervise.mjs";

const model = process.env.AGENCY_CLAUDE_MODEL || "claude-opus-5-5";
const discoveryCron = process.env.AGENCY_DISCOVERY_CRON || "6,36 9-20 * * *";
const keepaliveCron = process.env.AGENCY_KEEPALIVE_CRON || "6 0,3,6 * * *";
// Where the coordinator runs: a checkout with its own CLAUDE.md and state.
const discoveryDir = resolve(process.env.AGENCY_DISCOVERY_DIR || root);
const tmuxSession = stackSession;
const useTmux = process.env.AGENCY_NO_TMUX !== "1";
const startApp = process.env.AGENCY_START_APP !== "0";
// Wake the execution coordinator when a job is queued (scripts/wake-on-jobs.mjs).
const wakeOnJobs = process.env.AGENCY_WAKE_ON_JOBS !== "0";
// Keep the stack healthy without a person: the checker and the Agency Health session.
const healthOn = process.env.AGENCY_HEALTH !== "0";
const runtimePath = resolve(discoveryDir, "discovery-runtime.json");
const logPath = resolve(discoveryDir, "discovery-supervisor.log");
// The coordinator creates this file to ask for a restart (see CLAUDE.md). A
// long-running session never reconnects an MCP server that dropped; a resumed
// one starts them all fresh.
const restartRequestPath = resolve(discoveryDir, "discovery-restart-requested");
const claudeBinary = "claude";

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    appendFileSync(logPath, `${line}\n`);
  } catch {
    // The log is a convenience; never let it stop the coordinator.
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}



function ancestorCommands() {
  const commands = [];
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth += 1) {
    const info = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" });
    const line = (info.stdout || "").trim();
    if (!line) break;
    const [ppid, ...rest] = line.split(/\s+/);
    commands.push(rest.join(" "));
    pid = Number(ppid);
  }
  return commands;
}


function tmuxAvailable() {
  return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
}



// --- preflight ---------------------------------------------------------------

if (!existsSync(resolve(discoveryDir, "CLAUDE.md"))) {
  fail(`No CLAUDE.md in ${discoveryDir}. Point AGENCY_DISCOVERY_DIR at the discovery checkout.`);
}

const version = spawnSync(claudeBinary, ["--version"], { encoding: "utf8" });
if (version.error?.code === "ENOENT") {
  fail("Claude Code is not installed. Install it, sign in, then run this command again.");
}
if (version.status !== 0) {
  fail(version.stderr || "Claude Code is not available.");
}

// --- detach into tmux --------------------------------------------------------

if (useTmux && !process.env.TMUX) {
  if (!tmuxAvailable()) {
    fail("tmux is not installed (brew install tmux). Set AGENCY_NO_TMUX=1 to run in this terminal instead.");
  }
  if (tmuxSessionExists()) {
    console.log(`Agency Discovery is already running in tmux session "${tmuxSession}".`);
    console.log(`Watch it with: tmux attach -t ${tmuxSession}`);
    process.exit(0);
  }
  const passthrough = ["RADAR_URL", "AGENCY_CLAUDE_MODEL", "AGENCY_DISCOVERY_CRON", "AGENCY_KEEPALIVE_CRON", "AGENCY_START_APP", "AGENCY_WAKE_ON_JOBS", "AGENCY_EXECUTION_SESSION", "AGENCY_NUDGE_MODEL", "AGENCY_HEALTH", "AGENCY_HEALTH_CRON"]
    .filter((name) => process.env[name])
    .flatMap((name) => ["-e", `${name}=${process.env[name]}`]);
  const started = spawnSync("tmux", [
    "new-session", "-d", "-s", tmuxSession, "-c", root,
    "-e", `AGENCY_DISCOVERY_DIR=${discoveryDir}`,
    ...passthrough,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(import.meta.url))}`,
  ], { encoding: "utf8" });
  if (started.status !== 0) fail(started.stderr || "Could not start the tmux session.");
  console.log(`Agency Discovery started in tmux session "${tmuxSession}" with ${version.stdout.trim()}.`);
  console.log(`Discovery schedule: ${discoveryCron}. Keepalive: ${keepaliveCron}. Coordinator cwd: ${discoveryDir}.`);
  console.log(`Watch it:  npm run agency:discovery:attach   (detach with Ctrl-B then D)`);
  console.log(`Stop it:   npm run agency:discovery:stop`);
  process.exit(0);
}

if (!process.env.TMUX) {
  // Foreground mode: this process is the coordinator's parent, so check who
  // would take it down with them.
  const reaper = forbiddenParent(ancestorCommands());
  if (reaper) {
    fail(`Refusing to start under ${reaper.reason}.\n  parent: ${reaper.command}\n  Run this from a normal terminal, or let it detach into tmux (unset AGENCY_NO_TMUX).`);
  }
}

// --- supervise ---------------------------------------------------------------

function ensureCompanions() {
  if (!process.env.TMUX || !tmuxSessionExists()) return;
  if (wakeOnJobs && ensureWindow(WINDOWS.wake, wakeLoopCommand())) log("Started the job wake watcher in a tmux window.");
  if (healthOn && ensureWindow(WINDOWS.health, healthLoopCommand())) log("Started the health checker in a tmux window.");
  if (healthOn && ensureWindow(WINDOWS.healthClaude, healthClaudeCommand())) log("Started the Agency Health coordinator in a tmux window.");
}

async function ensureApp() {
  ensureCompanions();
  if ((await appStatus()).ok) return;
  log(`Agency is not reachable at ${agencyUrl}.`);
  if (startApp && process.env.TMUX) {
    if (ensureWindow(WINDOWS.app, appLoopCommand())) log("Starting the Agency app in a second tmux window.");
  } else {
    log("Waiting for it. Start it with: npm run dev");
  }
  let waited = 0;
  while (!(await appStatus()).ok) {
    await sleep(5_000);
    waited += 5_000;
    if (waited % 60_000 === 0) log(`Still waiting for Agency at ${agencyUrl}.`);
  }
}

log(`Discovery schedule: ${discoveryCron}. Keepalive: ${keepaliveCron}.`);
await supervise({
  cwd: discoveryDir,
  name: "Agency Discovery",
  model,
  runtimePath,
  logPath,
  restartRequestPath,
  initialPrompt: () => buildInitialPrompt({ agencyUrl, discoveryCron, keepaliveCron }),
  resumePrompt: () => buildResumePrompt({ agencyUrl, discoveryCron, keepaliveCron }),
  beforeLaunch: ensureApp,
});
process.exit(0);

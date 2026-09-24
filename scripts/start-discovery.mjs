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
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInitialPrompt,
  buildResumePrompt,
  forbiddenParent,
  restartDelayMs,
  shouldStartFresh,
} from "./lib/discovery-launcher.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agencyUrl = process.env.RADAR_URL || "http://localhost:3100";
const model = process.env.AGENCY_CLAUDE_MODEL || "claude-opus-5-5";
const discoveryCron = process.env.AGENCY_DISCOVERY_CRON || "6,36 9-20 * * *";
const keepaliveCron = process.env.AGENCY_KEEPALIVE_CRON || "6 0,3,6 * * *";
// Where the coordinator runs: a checkout with its own CLAUDE.md and state.
const discoveryDir = resolve(process.env.AGENCY_DISCOVERY_DIR || root);
const tmuxSession = process.env.AGENCY_TMUX_SESSION || "agency-discovery";
const useTmux = process.env.AGENCY_NO_TMUX !== "1";
const startApp = process.env.AGENCY_START_APP !== "0";
const runtimePath = resolve(discoveryDir, "discovery-runtime.json");
const logPath = resolve(discoveryDir, "discovery-supervisor.log");
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

function readRuntime() {
  try {
    return JSON.parse(readFileSync(runtimePath, "utf8"));
  } catch {
    return null;
  }
}

function writeRuntime(runtime) {
  writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
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

async function appReachable() {
  try {
    const response = await fetch(`${agencyUrl}/api/state?light=1`, {
      headers: { "x-radar-local-agent": "1" },
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function tmuxAvailable() {
  return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
}

function tmuxSessionExists() {
  return spawnSync("tmux", ["has-session", "-t", tmuxSession]).status === 0;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
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
  const passthrough = ["RADAR_URL", "AGENCY_CLAUDE_MODEL", "AGENCY_DISCOVERY_CRON", "AGENCY_KEEPALIVE_CRON", "AGENCY_START_APP"]
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

let child = null;
let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  log(`Stopping (${signal}).`);
  if (child && child.exitCode === null) {
    child.kill("SIGINT");
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill("SIGTERM");
    }, 5_000).unref();
  }
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGHUP"));

async function ensureApp() {
  if (await appReachable()) return;
  log(`Agency is not reachable at ${agencyUrl}.`);
  if (startApp && process.env.TMUX) {
    const hasWindow = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf8" });
    if (!(hasWindow.stdout || "").split("\n").includes("app")) {
      log("Starting the Agency app in a second tmux window.");
      spawnSync("tmux", [
        "new-window", "-d", "-t", tmuxSession, "-n", "app", "-c", root,
        "while true; do npm run dev; echo 'Agency app exited; restarting in 5s'; sleep 5; done",
      ]);
    }
  } else {
    log("Waiting for it. Start it with: npm run dev");
  }
  let waited = 0;
  while (!stopping && !(await appReachable())) {
    await sleep(5_000);
    waited += 5_000;
    if (waited % 60_000 === 0) log(`Still waiting for Agency at ${agencyUrl}.`);
  }
}

function launchArgs(runtime) {
  const fresh = shouldStartFresh(runtime);
  const sessionId = fresh ? randomUUID() : runtime.sessionId;
  const prompt = fresh
    ? buildInitialPrompt({ agencyUrl, discoveryCron, keepaliveCron })
    : buildResumePrompt({ agencyUrl, discoveryCron, keepaliveCron });
  const args = [
    "--model", model,
    "--effort", "high",
    "--permission-mode", "bypassPermissions",
    "--name", "Agency Discovery",
    ...(fresh ? ["--session-id", sessionId] : ["--resume", sessionId]),
    prompt,
  ];
  return { fresh, sessionId, args };
}

function runClaude(args) {
  return new Promise((done) => {
    const startedAt = Date.now();
    child = spawn(claudeBinary, args, { cwd: discoveryDir, stdio: "inherit", env: process.env });
    child.on("error", (error) => {
      log(`Could not start Claude: ${error.message}`);
      done({ exitCode: -1, signal: null, durationMs: Date.now() - startedAt });
    });
    child.on("exit", (exitCode, signal) => {
      child = null;
      done({ exitCode, signal, durationMs: Date.now() - startedAt });
    });
  });
}

log(`Supervisor started with ${version.stdout.trim()} (pid ${process.pid}) in ${discoveryDir}.`);
log(`Discovery schedule: ${discoveryCron}. Keepalive: ${keepaliveCron}.`);

while (!stopping) {
  await ensureApp();
  if (stopping) break;
  const runtime = readRuntime() ?? { launches: [] };
  const { fresh, sessionId, args } = launchArgs(runtime);
  const launches = (runtime.launches ?? []).slice(-50);
  const launchedAt = new Date().toISOString();
  writeRuntime({ ...runtime, sessionId, launches, lastLaunchAt: launchedAt, supervisorPid: process.pid });
  log(fresh ? `Starting a new coordinator session ${sessionId}.` : `Resuming coordinator session ${sessionId}.`);

  const result = await runClaude(args);
  const record = { sessionId, at: launchedAt, ...result };
  writeRuntime({ ...(readRuntime() ?? {}), sessionId, launches: [...launches, record] });
  log(`Claude exited (code ${result.exitCode}, signal ${result.signal}) after ${Math.round(result.durationMs / 1000)}s.`);
  if (stopping) break;

  const delay = restartDelayMs([...launches, record]);
  log(`Relaunching in ${Math.round(delay / 1000)}s.`);
  await sleep(delay);
}

log("Supervisor stopped.");
process.exit(0);

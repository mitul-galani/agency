// The running pieces of Agency on this machine, and how to start or restart
// each one. Shared by the launcher and the health checker so they never
// disagree about what a healthy stack looks like.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const agencyUrl = process.env.RADAR_URL || "http://localhost:3100";
export const agencyPort = new URL(agencyUrl).port || "3100";
export const tmuxSession = process.env.AGENCY_TMUX_SESSION || "agency-discovery";
export const launchdLabel = "com.agency.discovery";

export const WINDOWS = {
  coordinator: "node", // the discovery supervisor, created with the session
  app: "app",
  wake: "wake",
  health: "health",
  healthClaude: "health-claude",
};

function loop(command, what) {
  return `while true; do ${command}; echo "${what} exited at $(date); restarting in 5s"; sleep 5; done`;
}

// The dev server can die on an uncaught error from the Cloudflare tooling. Two
// things keep that from compounding: its dev registry lives outside the
// repository (a heartbeat on those files has crashed it before), and any
// workerd a dead server left behind is reaped before the next start, so stale
// processes never share the local database with the new one.
export function appLoopCommand() {
  const registry = "$HOME/.cache/agency/wrangler-registry";
  const orphans = JSON.stringify(`${root}/node_modules/@cloudflare/workerd`);
  return loop(
    `MINIFLARE_REGISTRY_PATH="${registry}" npm run dev -- --host 127.0.0.1 --port ${agencyPort}; pkill -P 1 -f ${orphans}`,
    "Agency app",
  );
}

export function wakeLoopCommand() {
  return loop(`${JSON.stringify(process.execPath)} scripts/wake-on-jobs.mjs`, "wake watcher");
}

export function healthLoopCommand() {
  return loop(`${JSON.stringify(process.execPath)} scripts/agency-health.mjs auto`, "health checker");
}

export function healthClaudeCommand() {
  return loop(`${JSON.stringify(process.execPath)} scripts/start-health.mjs`, "health coordinator supervisor");
}

export function tmuxSessionExists() {
  return spawnSync("tmux", ["has-session", "-t", tmuxSession]).status === 0;
}

export function tmuxWindows() {
  const listed = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf8" });
  return (listed.stdout || "").split("\n").filter(Boolean);
}

export function ensureWindow(name, command) {
  if (!tmuxSessionExists() || tmuxWindows().includes(name)) return false;
  spawnSync("tmux", ["new-window", "-d", "-t", tmuxSession, "-n", name, "-c", root, command]);
  return true;
}

export function restartWindow(name, command) {
  if (!tmuxSessionExists()) return false;
  if (tmuxWindows().includes(name)) spawnSync("tmux", ["kill-window", "-t", `${tmuxSession}:${name}`]);
  spawnSync("tmux", ["new-window", "-d", "-t", tmuxSession, "-n", name, "-c", root, command]);
  return true;
}

export function windowOutput(name, lines = 300) {
  const captured = spawnSync("tmux", ["capture-pane", "-p", "-S", `-${lines}`, "-t", `${tmuxSession}:${name}`], { encoding: "utf8" });
  return captured.status === 0 ? captured.stdout : "";
}

/** workerd processes from this checkout whose dev server is gone. */
export function orphanWorkerds() {
  const listed = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const marker = `${root}/node_modules/@cloudflare/workerd`;
  return (listed.stdout || "").split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === "1" && parts.slice(2).join(" ").includes(marker))
    .map((parts) => Number(parts[0]));
}

export function reapOrphans() {
  const pids = orphanWorkerds();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  return pids;
}

export async function appStatus() {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${agencyUrl}/api/state?light=1`, {
      headers: { "x-radar-local-agent": "1" },
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: response.ok, status: response.status, ms: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - startedAt, error: error.message };
  }
}

/** Relaunch the whole stack through the login item (restarts the tmux session). */
export function kickstartStack() {
  const result = spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${launchdLabel}`], { encoding: "utf8" });
  return result.status === 0;
}

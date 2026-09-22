/**
 * One command: bring the app up, wait for it, then hand the terminal to Claude.
 *
 * `npm run dev` and `npm run agency:claude` have to run at the same time — the
 * agent talks to the app over HTTP. Running them yourself means two terminals
 * and remembering the order, so this does it: the dev server starts in the
 * background, we wait until it actually answers, and Claude takes the
 * foreground. Ctrl-C stops both.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agencyUrl = process.env.RADAR_URL || "http://localhost:3100";
const startupTimeoutMs = Number(process.env.AGENCY_STARTUP_TIMEOUT_MS || 90_000);

let server = null;
let claude = null;
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  // Only our own child; an already-running server belongs to whoever started it.
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (claude && claude.exitCode === null) claude.kill(signal);
}

async function readState() {
  try {
    const response = await fetch(`${agencyUrl}/api/state?light=1`, {
      headers: { "x-radar-local-agent": "1" },
      signal: AbortSignal.timeout(2500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function reachable() {
  return Boolean(await readState());
}

// Check Claude before starting a server we would only have to tear down again.
const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (version.error?.code === "ENOENT") {
  console.error("Claude Code is not installed. Install it, sign in, then run this command again.");
  process.exit(1);
}
if (version.status !== 0) {
  console.error(version.stderr || "Claude Code is not available.");
  process.exit(version.status || 1);
}

// Someone may already have `npm run dev` open. Use it rather than fighting it
// for the port, and leave it running when we exit.
if (await reachable()) {
  console.log(`Agency is already running at ${agencyUrl}.`);
} else {
  console.log(`Starting Agency at ${agencyUrl} ...`);
  server = spawn("npm", ["run", "dev"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  server.on("exit", (code) => {
    if (!stopping) {
      console.error(`Agency stopped on its own (exit ${code}). Run "npm run dev" to see why.`);
      process.exit(code ?? 1);
    }
  });

  const deadline = Date.now() + startupTimeoutMs;
  let up = false;
  while (Date.now() < deadline) {
    if (await reachable()) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    console.error(
      `Agency did not answer at ${agencyUrl} within ${Math.round(startupTimeoutMs / 1000)}s. ` +
        `Run "npm run dev" on its own to see the error.`,
    );
    stop();
    process.exit(1);
  }
  console.log(`Agency is up. Open ${agencyUrl} to watch the cards arrive.`);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("exit", stop);

let state = await readState();
if (!state?.context?.text?.trim()) {
  console.log(`Open ${agencyUrl} and add your first Context note. Claude will start as soon as it is saved.`);
  while (!stopping && !state?.context?.text?.trim()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    state = await readState();
  }
  if (stopping) process.exit(1);
  console.log("Context saved. Starting Claude.");
}

claude = spawn("node", [resolve(root, "scripts/start-claude.mjs")], {
  cwd: root,
  stdio: "inherit",
});
claude.on("exit", (code, signal) => {
  stop();
  process.exit(signal ? 1 : (code ?? 0));
});

// Keep one Claude Code session alive: start it with a fixed session id, resume
// it on the same id whenever the process exits, back off on crash loops, and
// restart it on request. Shared by the discovery and health coordinators.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { restartDelayMs, shouldStartFresh } from "./discovery-launcher.mjs";

export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * @param {object} options
 * @param {string} options.cwd            directory the session runs in (its CLAUDE.md applies)
 * @param {string} options.name           display name for the session
 * @param {string} options.model
 * @param {string} options.runtimePath    where the session id and launch history are kept
 * @param {string} options.logPath
 * @param {string} options.restartRequestPath  touching this file makes the supervisor resume the session
 * @param {(sessionId: string) => string} options.initialPrompt
 * @param {(sessionId: string) => string} options.resumePrompt
 * @param {() => Promise<void>} [options.beforeLaunch]   awaited before every launch (e.g. wait for the app)
 * @param {() => boolean} [options.stopping]
 */
export async function supervise(options) {
  const { cwd, name, model, runtimePath, logPath, restartRequestPath, initialPrompt, resumePrompt } = options;
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      // The log is a convenience; never let it stop the coordinator.
    }
  };
  const readRuntime = () => {
    try {
      return JSON.parse(readFileSync(runtimePath, "utf8"));
    } catch {
      return null;
    }
  };
  const writeRuntime = (runtime) => writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);

  let child = null;
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`Stopping (${signal}).`);
    if (child && child.exitCode === null) {
      child.kill("SIGINT");
      setTimeout(() => {
        if (child && child.exitCode === null) child.kill("SIGTERM");
      }, 5_000).unref();
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGHUP"));

  const run = (args) => new Promise((done) => {
    const startedAt = Date.now();
    rmSync(restartRequestPath, { force: true });
    child = spawn("claude", args, { cwd, stdio: "inherit", env: process.env });
    const watch = setInterval(() => {
      if (!existsSync(restartRequestPath) || !child || child.exitCode !== null) return;
      rmSync(restartRequestPath, { force: true });
      log("Coordinator requested a restart; resuming it with fresh connections.");
      child.kill("SIGTERM");
    }, 30_000);
    child.on("exit", () => clearInterval(watch));
    child.on("error", (error) => {
      log(`Could not start Claude: ${error.message}`);
      done({ exitCode: -1, signal: null, durationMs: Date.now() - startedAt });
    });
    child.on("exit", (exitCode, signal) => {
      child = null;
      done({ exitCode, signal, durationMs: Date.now() - startedAt });
    });
  });

  log(`Supervisor for ${name} started (pid ${process.pid}) in ${cwd}.`);
  while (!stopping) {
    if (options.beforeLaunch) await options.beforeLaunch();
    if (stopping) break;
    const runtime = readRuntime() ?? { launches: [] };
    const fresh = shouldStartFresh(runtime);
    const sessionId = fresh ? randomUUID() : runtime.sessionId;
    const args = [
      "--model", model, "--effort", "high", "--permission-mode", "bypassPermissions", "--name", name,
      ...(fresh ? ["--session-id", sessionId] : ["--resume", sessionId]),
      fresh ? initialPrompt(sessionId) : resumePrompt(sessionId),
    ];
    const launches = (runtime.launches ?? []).slice(-50);
    const launchedAt = new Date().toISOString();
    writeRuntime({ ...runtime, sessionId, launches, lastLaunchAt: launchedAt, supervisorPid: process.pid });
    log(fresh ? `Starting a new ${name} session ${sessionId}.` : `Resuming ${name} session ${sessionId}.`);

    const result = await run(args);
    const record = { sessionId, at: launchedAt, ...result };
    writeRuntime({ ...(readRuntime() ?? {}), sessionId, launches: [...launches, record] });
    log(`Claude exited (code ${result.exitCode}, signal ${result.signal}) after ${Math.round(result.durationMs / 1000)}s.`);
    if (stopping) break;
    const delay = restartDelayMs([...launches, record]);
    log(`Relaunching in ${Math.round(delay / 1000)}s.`);
    await sleep(delay);
  }
  log("Supervisor stopped.");
}

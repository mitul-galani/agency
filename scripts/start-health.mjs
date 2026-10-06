#!/usr/bin/env node
/**
 * The Agency Health coordinator: a Claude session that looks at what the
 * deterministic checker could not fix and resolves it. Started by the
 * discovery launcher in its own tmux window and supervised like the
 * discovery coordinator (same session resumed on exit, crons renewed by the
 * session itself). Its playbook is health/CLAUDE.md.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { supervise } from "./lib/supervise.mjs";
import { appStatus, root } from "./lib/stack.mjs";

const healthDir = resolve(root, "health");
const model = process.env.AGENCY_CLAUDE_MODEL || "claude-opus-5-5";
const healthCron = process.env.AGENCY_HEALTH_CRON || "*/15 * * * *";

if (!existsSync(resolve(healthDir, "CLAUDE.md"))) {
  console.error(`No CLAUDE.md in ${healthDir}.`);
  process.exit(1);
}

const common = [
  "Read CLAUDE.md in this directory completely before doing anything.",
  `Create one recurring Claude scheduled task with CronCreate at ${healthCron} whose prompt tells this same session to run the health pass defined in CLAUDE.md, including the schedule renewal rule there. Verify it with CronList and record its ID and the current ISO timestamp under the schedule key in health-state-session.json in this directory.`,
  "Keep this exact Claude process open after reporting; a supervisor resumes it if it exits.",
];

await supervise({
  cwd: healthDir,
  name: "Agency Health",
  model,
  runtimePath: resolve(healthDir, "health-runtime.json"),
  logPath: resolve(healthDir, "health-supervisor.log"),
  restartRequestPath: resolve(healthDir, "health-restart-requested"),
  initialPrompt: () => ["You are the Agency Health coordinator.", "Run one health pass now, then", ...common].join(" "),
  resumePrompt: () => ["RESTART. You are resuming as the Agency Health coordinator after a process restart; session-only scheduled tasks did not survive.", ...common, "Then run one health pass."].join(" "),
  beforeLaunch: async () => {
    while (!(await appStatus()).ok) await new Promise((done) => setTimeout(done, 10_000));
  },
});

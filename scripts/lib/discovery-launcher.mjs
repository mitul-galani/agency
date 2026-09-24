// Pure pieces of the discovery launcher, kept separate so they can be tested
// without spawning Claude or tmux.

export const RESTART_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
// A launch that dies inside this window counts as a failed start, not a run.
export const SHORT_RUN_MS = 2 * 60 * 1000;
// After this many failed starts in a row on the same session, resume is not
// going to work (corrupt transcript, changed CLI) and a fresh session is used.
export const MAX_FAILED_RESUMES = 3;
// A resumed coordinator runs a catch-up pass only if the last one is older than this.
export const CATCH_UP_AFTER_MINUTES = 40;
// Session crons expire after seven days; renew with a margin.
export const RENEW_AFTER_DAYS = 5;

const FORBIDDEN_PARENTS = [
  { pattern: /codex/i, reason: "a Codex thread (its exec sessions are killed when the thread shuts down)" },
  { pattern: /ChatGPT\.app/i, reason: "the ChatGPT app (its child processes die with the thread)" },
  { pattern: /claude (daemon|bg-|--bg)/i, reason: "the Claude background daemon (it retires idle sessions)" },
  { pattern: /(^|\/)claude(\s|$)/i, reason: "another Claude session (the coordinator would die with that session)" },
];

/** Names the ancestor that would eventually reap this process, or null. */
export function forbiddenParent(ancestorCommands) {
  for (const command of ancestorCommands) {
    for (const { pattern, reason } of FORBIDDEN_PARENTS) {
      if (pattern.test(command)) return { command, reason };
    }
  }
  return null;
}

/** Delay before the next launch, given the launches so far (newest last). */
export function restartDelayMs(launches) {
  let shortRuns = 0;
  for (let index = launches.length - 1; index >= 0; index -= 1) {
    if ((launches[index].durationMs ?? 0) >= SHORT_RUN_MS) break;
    shortRuns += 1;
  }
  if (shortRuns === 0) return RESTART_DELAYS_MS[0];
  return RESTART_DELAYS_MS[Math.min(shortRuns, RESTART_DELAYS_MS.length - 1)];
}

/** True when the saved session should be abandoned for a fresh one. */
export function shouldStartFresh(runtime) {
  if (!runtime?.sessionId) return true;
  const launches = runtime.launches ?? [];
  let failed = 0;
  for (let index = launches.length - 1; index >= 0; index -= 1) {
    const launch = launches[index];
    if (launch.sessionId !== runtime.sessionId) break;
    if ((launch.durationMs ?? 0) >= SHORT_RUN_MS) break;
    failed += 1;
  }
  return failed >= MAX_FAILED_RESUMES;
}

export function buildInitialPrompt({ agencyUrl, discoveryCron, keepaliveCron }) {
  return [
    "You are the sole Agency Discovery coordinator. Run discovery only, never approved execution jobs.",
    "Read CLAUDE.md and skills/agency/SKILL.md completely before doing anything.",
    `Use the local Agency app at ${agencyUrl} and include x-radar-local-agent: 1 on its agent API requests.`,
    "Run one discovery pass immediately. Use the user's existing Claude connections, follow the approval policy, check every card status and current agent job for duplicates, and report each source failure separately from a successful check with no useful material.",
    `Create one recurring discovery task with CronCreate at ${discoveryCron}. Its prompt must tell this same coordinator to run the complete discovery pass defined in CLAUDE.md and the Agency skill, and to perform the schedule renewal defined in CLAUDE.md.`,
    `Create one recurring check-only keepalive task with CronCreate at ${keepaliveCron}. It may only call CronList and confirm that both schedules remain present. It must not inspect sources, create cards, process jobs, call Agency APIs, or change schedules.`,
    "Call CronList to verify both tasks. Record both task IDs and the current ISO timestamp under a schedule key in discovery-state.json, then report the IDs and schedules.",
    "Keep this exact Claude process open after reporting. These scheduled tasks are session-only and stop when this process exits; a supervisor restarts and resumes this session if it ever does.",
  ].join(" ");
}

export function buildResumePrompt({ agencyUrl, discoveryCron, keepaliveCron }) {
  return [
    "RESTART. You are resuming as the sole Agency Discovery coordinator after this process was restarted by its supervisor. Session-only scheduled tasks did not survive the restart, so nothing is scheduled right now.",
    "Read CLAUDE.md and skills/agency/SKILL.md completely before doing anything, then reread discovery-state.json.",
    `Use the local Agency app at ${agencyUrl} and include x-radar-local-agent: 1 on its agent API requests.`,
    `Recreate the recurring discovery task with CronCreate at ${discoveryCron} and the check-only keepalive task at ${keepaliveCron}, with the same prompts and rules as before, including the schedule renewal defined in CLAUDE.md. Verify both with CronList and record the new task IDs and the current ISO timestamp under the schedule key in discovery-state.json.`,
    `Then decide whether to catch up: if the current time in the schedule's timezone falls inside the discovery hours of ${discoveryCron} and lastSuccessfulPass.completedAt is missing or more than ${CATCH_UP_AFTER_MINUTES} minutes old, run exactly one discovery pass now. Otherwise do not run a pass.`,
    "Report the task IDs and whether a catch-up pass ran, then keep this exact Claude process open.",
  ].join(" ");
}

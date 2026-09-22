import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agencyUrl = process.env.RADAR_URL || "http://localhost:3100";
const model = process.env.AGENCY_CLAUDE_MODEL || "opus";
const discoveryCron = process.env.AGENCY_DISCOVERY_CRON || "6,36 9-20 * * *";
const keepaliveCron = process.env.AGENCY_KEEPALIVE_CRON || "6 0,3,6 * * *";
const claudeBinary = "claude";

const version = spawnSync(claudeBinary, ["--version"], {
  encoding: "utf8",
});
if (version.error?.code === "ENOENT") {
  console.error("Claude Code is not installed. Install it, sign in, then run this command again.");
  process.exit(1);
}
if (version.status !== 0) {
  console.error(version.stderr || "Claude Code is not available.");
  process.exit(version.status || 1);
}

try {
  const response = await fetch(`${agencyUrl}/api/state?light=1`, {
    headers: { "x-radar-local-agent": "1" },
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch {
  console.error(`Agency is not reachable at ${agencyUrl}. Start it first with: npm run dev`);
  process.exit(1);
}

const prompt = [
  "You are the sole Agency Discovery coordinator. Run discovery only, never approved execution jobs.",
  "Read CLAUDE.md and skills/agency/SKILL.md completely before doing anything.",
  `Use the local Agency app at ${agencyUrl} and include x-radar-local-agent: 1 on its agent API requests.`,
  "Run one discovery pass immediately. Use the user's existing Claude connections, follow the approval policy, check every card status and current agent job for duplicates, and report each source failure separately from a successful check with no useful material.",
  `Create one recurring discovery task with CronCreate at ${discoveryCron}. Its prompt must tell this same coordinator to run the complete discovery pass defined in CLAUDE.md and the Agency skill.`,
  `Create one recurring check-only keepalive task with CronCreate at ${keepaliveCron}. It may only call CronList and confirm that both schedules remain present. It must not inspect sources, create cards, process jobs, call Agency APIs, or change schedules.`,
  "Call CronList to verify both tasks and report their IDs and schedules.",
  "Keep this exact Claude process open after reporting. These scheduled tasks are session-only and stop when this process exits.",
].join(" ");

console.log(`Starting dedicated Agency Discovery with ${version.stdout.trim()}.`);
console.log(`Discovery schedule: ${discoveryCron}`);
console.log(`Keepalive schedule: ${keepaliveCron}`);

const result = spawnSync(claudeBinary, [
  "--model", model,
  "--effort", "high",
  "--permission-mode", "bypassPermissions",
  "--name", "Agency Discovery",
  prompt,
], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);

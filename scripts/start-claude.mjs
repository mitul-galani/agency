import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agencyUrl = process.env.RADAR_URL || "http://localhost:3100";
const model = process.env.AGENCY_CLAUDE_MODEL || "opus";

const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
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
  "Read CLAUDE.md and skills/agency/SKILL.md completely.",
  `Set up and start this user's local Agency at ${agencyUrl}.`,
  "Use the dream already saved in the app. Inspect the tools, connectors, CLIs, and authenticated sessions available to this exact Claude session.",
  "For each source that is useful to the user's goals, perform a harmless live read and report it as Connected, Needs sign-in, or Unavailable. Do not ask the user to paste service credentials into Agency.",
  "Create the first useful cards only after checking for duplicates. Keep personal profiles, source material, credentials, and generated work out of git.",
  "Do not create a recurring schedule until the user explicitly chooses a cadence.",
].join(" ");

const result = spawnSync("claude", [
  "--model", model,
  "--effort", "high",
  "--permission-mode", "auto",
  "--name", "Agency",
  prompt,
], { cwd: root, stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 0);

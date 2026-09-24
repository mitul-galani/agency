/**
 * Start the discovery launcher at login, so a reboot or logout is not
 * something you have to remember. launchd only runs the launcher once per
 * login (RunAtLoad, no KeepAlive); the launcher then detaches into tmux and
 * supervises Claude itself. Stopping the tmux session stays a manual choice.
 *
 *   node scripts/install-launchd.mjs           install (or reinstall) and start now
 *   node scripts/install-launchd.mjs --remove  uninstall
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "com.agency.discovery";
const plistPath = resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const logDir = resolve(homedir(), "Library", "Logs", "agency");
const discoveryDir = resolve(process.env.AGENCY_DISCOVERY_DIR || root);
const domain = `gui/${process.getuid()}`;

function escape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

if (process.argv.includes("--remove")) {
  launchctl(["bootout", `${domain}/${label}`]);
  if (existsSync(plistPath)) unlinkSync(plistPath);
  console.log(`Removed ${label}. The running tmux session, if any, is untouched: npm run agency:discovery:stop ends it.`);
  process.exit(0);
}

if (!existsSync(resolve(discoveryDir, "CLAUDE.md"))) {
  console.error(`No CLAUDE.md in ${discoveryDir}. Set AGENCY_DISCOVERY_DIR to the discovery checkout.`);
  process.exit(1);
}

mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(logDir, { recursive: true });

const env = {
  AGENCY_DISCOVERY_DIR: discoveryDir,
  ...Object.fromEntries(
    ["RADAR_URL", "AGENCY_CLAUDE_MODEL", "AGENCY_DISCOVERY_CRON", "AGENCY_KEEPALIVE_CRON", "AGENCY_START_APP"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  ),
};

// launchd does not run a login shell, so version managers like nvm are not
// on its PATH. Resolve the tools now, from the shell that ran the installer.
function locate(tool) {
  const found = spawnSync("which", [tool], { encoding: "utf8" });
  if (found.status !== 0) {
    console.error(`${tool} is not on PATH. Install it, then run this installer from a terminal where it works.`);
    process.exit(1);
  }
  return found.stdout.trim();
}
const toolDirs = [process.execPath, locate("claude"), locate("tmux"), locate("npm")].map((path) => dirname(path));
env.PATH = [...new Set([...toolDirs, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(resolve(root, "scripts", "start-discovery.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${key}</key>\n    <string>${escape(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escape(resolve(logDir, "discovery-launchd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(resolve(logDir, "discovery-launchd.err"))}</string>
</dict>
</plist>
`;

launchctl(["bootout", `${domain}/${label}`]);
writeFileSync(plistPath, plist);
const loaded = launchctl(["bootstrap", domain, plistPath]);
if (loaded.status !== 0) {
  console.error(loaded.stderr || "launchctl bootstrap failed.");
  process.exit(loaded.status || 1);
}
console.log(`Installed ${label} at ${plistPath}.`);
console.log(`It starts the discovery launcher at every login and started it now. Logs: ${logDir}.`);
console.log(`Remove with: npm run agency:discovery:uninstall`);

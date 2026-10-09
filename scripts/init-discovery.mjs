#!/usr/bin/env node
/**
 * Create a dedicated discovery checkout from templates/discovery: the
 * coordinator's CLAUDE.md plus a .claude/settings.local.json whose paths
 * point at this repository. Private files (profile, approvals, persistent
 * rules) are referenced only when they exist.
 *
 *   node scripts/init-discovery.mjs <directory> [--timezone America/New_York] [--muesli-guide <path>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./lib/stack.mjs";

export function discoverySettings({ rootDir = root, timeZone, muesliGuide } = {}) {
  const env = {
    AGENCY_ROOT: rootDir,
    RADAR_URL: process.env.RADAR_URL || "http://localhost:3100",
    AGENCY_TIMEZONE: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    AGENCY_SKILL_PATH: resolve(rootDir, "skills", "agency", "SKILL.md"),
    LAYOUT_PATH: resolve(rootDir, "skills", "agency", "LAYOUT.md"),
    WISPR_FLOW_READER: resolve(rootDir, "scripts", "wispr-flow.mjs"),
    WISPR_FLOW_GUIDE_PATH: resolve(rootDir, "docs", "WISPR_FLOW.md"),
  };
  const optional = {
    ME_PATH: resolve(rootDir, "me.md"),
    APPROVALS_PATH: resolve(rootDir, "approvals.local.md"),
    PERSISTENT_PATH: resolve(rootDir, ".pilot", "PERSISTENT.md"),
    MUESLI_GUIDE_PATH: muesliGuide,
  };
  for (const [key, path] of Object.entries(optional)) if (path && existsSync(path)) env[key] = path;
  return { env, permissions: { defaultMode: "bypassPermissions" } };
}

export function initDiscovery(directory, options = {}) {
  const target = resolve(directory);
  const claudeMd = resolve(target, "CLAUDE.md");
  if (existsSync(claudeMd) && !options.force) throw new Error(`${claudeMd} already exists; pass --force to overwrite it.`);
  mkdirSync(resolve(target, ".claude"), { recursive: true });
  writeFileSync(claudeMd, readFileSync(resolve(root, "templates", "discovery", "CLAUDE.md"), "utf8"));
  const settingsPath = resolve(target, ".claude", "settings.local.json");
  writeFileSync(settingsPath, `${JSON.stringify(discoverySettings(options), null, 2)}\n`);
  return { target, claudeMd, settingsPath };
}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    } else out._.push(args[i]);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("init-discovery.mjs")) {
  const args = flags(process.argv.slice(2));
  const [directory] = args._;
  if (!directory) {
    console.error("Usage: node scripts/init-discovery.mjs <directory> [--timezone <IANA zone>] [--muesli-guide <path>] [--force]");
    process.exit(1);
  }
  try {
    const { target, settingsPath } = initDiscovery(directory, { timeZone: args.timezone, muesliGuide: args.muesliGuide, force: Boolean(args.force) });
    console.log(`Discovery checkout ready at ${target}.`);
    console.log(`Edit ${settingsPath} if a path is wrong, then start it with:`);
    console.log(`  AGENCY_DISCOVERY_DIR=${JSON.stringify(target)} npm run agency:discovery`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

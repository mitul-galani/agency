import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverySettings, initDiscovery } from "../scripts/init-discovery.mjs";

test("settings point every path at the repository and only list private files that exist", () => {
  const { env } = discoverySettings({ rootDir: "/repo", timeZone: "America/New_York", muesliGuide: "/nope/MUESLI.md" });
  assert.equal(env.AGENCY_ROOT, "/repo");
  assert.equal(env.AGENCY_TIMEZONE, "America/New_York");
  assert.equal(env.AGENCY_SKILL_PATH, "/repo/skills/agency/SKILL.md");
  assert.equal(env.WISPR_FLOW_READER, "/repo/scripts/wispr-flow.mjs");
  assert.equal(env.ME_PATH, undefined);
  assert.equal(env.MUESLI_GUIDE_PATH, undefined);
});

test("init writes the template CLAUDE.md and settings, and refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-"));
  const { claudeMd, settingsPath } = initDiscovery(dir, { timeZone: "UTC" });
  assert.match(readFileSync(claudeMd, "utf8"), /^# Agency Discovery Runner/);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.env.AGENCY_TIMEZONE, "UTC");
  assert.equal(settings.permissions.defaultMode, "bypassPermissions");
  assert.throws(() => initDiscovery(dir, { timeZone: "UTC" }), /already exists/);
});

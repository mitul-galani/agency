import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const forbiddenPaths = [
  /^\.claude(?:\/|$)/,
  /^\.wrangler(?:\/|$)/,
  /^\.env(?:\.|$)/,
  /^me\.md$/,
  /^approvals\.local\.md$/,
  /^layout\.local\.md$/,
  /^agent-cards(?:\/|$)/,
  /^public\/(?:agent-assets|media|screenshots|videos)(?:\/|$)/,
];
const suspiciousContent = [
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-proj-[A-Za-z0-9_-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  new RegExp(["@finch", "legal\\.com"].join(""), "i"),
];

const failures = [];
for (const path of tracked) {
  if (forbiddenPaths.some((pattern) => pattern.test(path))) {
    failures.push(`${path}: private path must not be tracked`);
    continue;
  }
  try {
    const content = readFileSync(path);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (suspiciousContent.some((pattern) => pattern.test(text))) failures.push(`${path}: possible private credential or organization-specific data`);
  } catch {
    failures.push(`${path}: could not inspect tracked file`);
  }
}

if (failures.length) {
  console.error("Share check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Share check passed for ${tracked.length} tracked files.`);

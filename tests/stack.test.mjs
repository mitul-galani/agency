import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOWS, agencyPort, appLoopCommand, healthClaudeCommand, healthLoopCommand, wakeLoopCommand } from "../scripts/lib/stack.mjs";

test("every window has a distinct name", () => {
  const names = Object.values(WINDOWS);
  assert.equal(new Set(names).size, names.length);
});

test("the app loop binds the port, keeps the registry out of the repo and reaps orphans", () => {
  const command = appLoopCommand();
  assert.match(command, new RegExp(`--port ${agencyPort}`));
  assert.match(command, /MINIFLARE_REGISTRY_PATH="\$HOME\/\.cache\/agency\/wrangler-registry"/);
  assert.match(command, /pkill -P 1 -f/);
  assert.match(command, /^while true; do .*; sleep 5; done$/);
});

test("companion loops run the right scripts with the current node", () => {
  assert.match(wakeLoopCommand(), /scripts\/wake-on-jobs\.mjs/);
  assert.match(healthLoopCommand(), /scripts\/agency-health\.mjs auto/);
  assert.match(healthClaudeCommand(), /scripts\/start-health\.mjs/);
  for (const command of [wakeLoopCommand(), healthLoopCommand(), healthClaudeCommand()]) {
    assert.ok(command.includes(JSON.stringify(process.execPath)));
  }
});

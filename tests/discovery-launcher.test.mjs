import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialPrompt,
  buildResumePrompt,
  forbiddenParent,
  restartDelayMs,
  shouldStartFresh,
  SHORT_RUN_MS,
} from "../scripts/lib/discovery-launcher.mjs";

test("refuses parents that reap their children", () => {
  assert.equal(forbiddenParent(["/bin/zsh -l", "login -pf mitul", "/sbin/launchd"]), null);
  assert.equal(forbiddenParent(["tmux: server", "/sbin/launchd"]), null);
  assert.match(forbiddenParent(["/bin/zsh -lc claude --model opus", "/Applications/ChatGPT.app/Contents/Resources/codex app-server"]).reason, /Codex|ChatGPT/);
  assert.match(forbiddenParent(["/Users/me/.local/bin/claude daemon run --json-path x"]).reason, /daemon/);
  assert.match(forbiddenParent(["claude --name Other"]).reason, /another Claude session/);
});

test("backs off after repeated short-lived launches", () => {
  const long = { durationMs: SHORT_RUN_MS * 10 };
  const short = { durationMs: 1_000 };
  assert.equal(restartDelayMs([]), 5_000);
  assert.equal(restartDelayMs([long]), 5_000);
  assert.equal(restartDelayMs([long, short]), 15_000);
  assert.equal(restartDelayMs([long, short, short]), 30_000);
  assert.equal(restartDelayMs([short, short, short, short, short, short, short]), 300_000);
  assert.equal(restartDelayMs([short, short, long]), 5_000);
});

test("abandons a session only after several failed resumes", () => {
  const short = (sessionId) => ({ sessionId, durationMs: 1_000 });
  const long = (sessionId) => ({ sessionId, durationMs: SHORT_RUN_MS * 5 });
  assert.equal(shouldStartFresh(null), true);
  assert.equal(shouldStartFresh({ sessionId: "a", launches: [] }), false);
  assert.equal(shouldStartFresh({ sessionId: "a", launches: [long("a"), short("a"), short("a")] }), false);
  assert.equal(shouldStartFresh({ sessionId: "a", launches: [long("a"), short("a"), short("a"), short("a")] }), true);
  assert.equal(shouldStartFresh({ sessionId: "b", launches: [short("a"), short("a"), short("a")] }), false);
});

test("prompts carry the cadence and the renewal rule", () => {
  const options = { agencyUrl: "http://localhost:3100", discoveryCron: "6,36 9-20 * * *", keepaliveCron: "6 0,3,6 * * *" };
  const initial = buildInitialPrompt(options);
  assert.match(initial, /6,36 9-20 \* \* \*/);
  assert.match(initial, /schedule renewal/);
  assert.match(initial, /Run one discovery pass immediately/);
  const resume = buildResumePrompt(options);
  assert.match(resume, /RESTART/);
  assert.match(resume, /more than 40 minutes old/);
  assert.match(resume, /Otherwise do not run a pass/);
});

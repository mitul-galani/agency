# Discovery runtime

Agency discovery runs in one dedicated Claude Code session. Claude scheduled tasks live only inside that process, so the runtime is built around keeping that one session alive, and resuming it when it is not.

## Start it

```sh
npm run agency:discovery
```

That is the only command. The launcher:

1. Checks that Claude Code is installed and moves itself into a detached tmux session named `agency-discovery`, so closing the terminal does not end discovery.
2. Starts the Agency app in a second tmux window if nothing answers at `RADAR_URL` (default `http://localhost:3100`).
3. Starts Claude Sonnet 5.5 (`AGENCY_CLAUDE_MODEL` overrides it) with a fixed session ID, runs one discovery pass, and creates two session crons:
   - discovery at `6,36 9-20 * * *`, every 30 minutes from 9:06 AM through 8:36 PM local time
   - a check-only keepalive at `6 0,3,6 * * *`, which only confirms both schedules still exist
4. Supervises Claude. If the process exits for any reason it is relaunched with `--resume` on the same session ID, so the conversation continues. The resume prompt recreates both crons and runs a catch-up pass only if the last one is more than 40 minutes old. Repeated crashes back off up to five minutes; three failed resumes in a row start a fresh session.
5. Restarts the coordinator on request. If a connector drops out of the long-running session, the coordinator creates `discovery-restart-requested`; the supervisor sees it within 30 seconds, stops Claude, and resumes the same session with every connector started fresh.
6. Wakes the execution coordinator when a job is queued. A `wake` tmux window runs `scripts/wake-on-jobs.mjs`, which polls the queue every 10 seconds and, on a new job, sends the coordinator a cross-session message through a short headless Claude run (about 7 seconds, `AGENCY_NUDGE_MODEL`, default `claude-sonnet-5-5`). The coordinator processes the queue on receipt instead of waiting for its next scheduled tick. `AGENCY_WAKE_ON_JOBS=0` turns it off; `AGENCY_EXECUTION_SESSION` is the regex that finds the coordinator by session name (default `personal agency`).
7. The discovery cron renews itself. Session crons expire after seven days; the scheduled prompt re-creates both tasks once they are five days old and records the new IDs in `discovery-state.json`.
8. Keeps itself healthy (see below). A `health` window runs the checker every minute; a `health-claude` window runs the Agency Health session that handles what the checker cannot. `AGENCY_HEALTH=0` turns both off.

Running the command again while it is up just tells you it is running.

## Self-healing

Nothing here needs a person to open a chat when something breaks.

- `scripts/agency-health.mjs auto` (the `health` window, log in `health.log`, state in `health-state.json`) checks every minute: tmux session gone, app window missing or not answering, repeated 500s in the app's output, orphaned `workerd` processes, wake or health windows missing, discovery process gone or a scheduled run missed, a connector failing on two consecutive discovery passes, no execution coordinator session, jobs queued for over ten minutes with an idle coordinator, and a checkout inside a macOS-protected folder. Each finding has a fix it applies itself (restart the window, reap orphans, ask the discovery supervisor for a restart, nudge the coordinator, relaunch the execution coordinator with `--resume` and its recovered schedules, or `launchctl kickstart` the whole stack), with a cooldown so a fix gets time to work. After three fixes that did not take, it marks the issue unresolved and tells you once every six hours through the notifier webhook in `~/.claude/secrets/claude_notifier_webhook`.
- The Agency Health session (`scripts/start-health.mjs`, playbook `health/CLAUDE.md`, supervised and resumed exactly like the discovery coordinator) runs a pass every 15 minutes (`AGENCY_HEALTH_CRON`). It only investigates when the checker reports an unresolved or unfixable issue: it reads the windows and logs, applies fixes, and may commit and push a code fix when tests and lint pass. It never creates cards, processes jobs, or touches external services.
- By hand: `npm run agency:health` prints the full report, `npm run agency:health:fix <code>` applies one fix (`app`, `orphans`, `wake`, `health`, `health-claude`, `discovery-restart`, `nudge`, `execution`, `kickstart`).

The coordinator's working directory is the repository by default. For a private checkout with its own `CLAUDE.md`, state file, and settings, set `AGENCY_DISCOVERY_DIR`:

```sh
AGENCY_DISCOVERY_DIR=/path/to/agency-discovery npm run agency:discovery
```

## Watch, stop, and survive reboots

```sh
npm run agency:discovery:attach     # open the tmux session; Ctrl-B then D leaves it running
npm run agency:discovery:stop       # end discovery until you start it again
npm run agency:discovery:install    # also start it at every login (launchd, RunAtLoad)
npm run agency:discovery:uninstall  # remove the login item; a running session is untouched
```

The launcher writes `discovery-runtime.json` (session ID, launch history) and `discovery-supervisor.log` next to the coordinator's `CLAUDE.md`; the health session keeps the same two files in `health/`. All are ignored by git.

## Where the checkout must live (macOS)

Keep the repository and the discovery checkout outside `~/Documents`, `~/Desktop`, and `~/Downloads`. macOS asks each new binary for permission to touch those folders, and processes started by the login item or by tmux have no app to ask through, so they are silently denied: the app's database writes fail with "internal error", `npm` cannot even read its working directory, and every Claude Code update brings a fresh "node" prompt. A plain path such as `~/agency` has none of that.

The same mechanism produces a "claude (or node) wants to access data from other apps" prompt whenever an unattended session starts an MCP server that reads a sandboxed app's container; the 1Password server (`1password-mcp`) is one. Disable such servers for the coordinator folders (`/mcp` in a session rooted there, or `disabledMcpServers` for the project in `~/.claude.json`) rather than answering the prompt: macOS keys the grant to the exact binary, so every Claude update would ask again.

## What must not run it

The coordinator must be a child of tmux or of a plain terminal. It must never be started from inside a Codex thread, a Claude session, or the Claude background daemon: all three end their child processes when they shut down, which takes the in-memory schedule with them. The launcher refuses to run in the foreground under any of those parents; the tmux path is always safe.

## Changing the cadence

Both schedules can be changed without editing source:

```sh
AGENCY_DISCOVERY_CRON='6,36 9-20 * * *' \
AGENCY_KEEPALIVE_CRON='6 0,3,6 * * *' \
npm run agency:discovery
```

Stop the running session first (`npm run agency:discovery:stop`); the launcher will not start a second coordinator while one is up.

## Status in the app

The sidebar reads `/api/discovery-status`. It shows the last finished pass, the next scheduled one, and a live running state. If a scheduled minute passes by more than 20 minutes with no `start`, the indicator turns stale and names the missed run, so a dead coordinator is visible within one tick instead of promising a next run forever.

## Chats as a source

`scripts/chat-activity.mjs` digests the user's recent Claude Code and Codex conversations from `~/.claude/projects` and `~/.codex/sessions`, so discovery can pick up decisions and unfinished asks made in those chats. It is read-only and prints only the user's messages and the assistant's replies for a window:

```sh
node scripts/chat-activity.mjs --since 2026-10-02T12:00:00Z --text
```

It leaves out tool calls and results, Agency's own coordinator sessions, scheduled-task turns, headless pipeline runs, Codex's internal review threads and automations, and anything that looks like a credential. `--exclude <regex>` widens the session-name exclusions; `--max-messages` and `--max-chars` bound the output.

# Discovery runtime

Agency discovery runs in one dedicated Claude Code session. Claude scheduled tasks live only inside that process, so the runtime is built around keeping that one session alive, and resuming it when it is not.

## Start it

```sh
npm run agency:discovery
```

That is the only command. The launcher:

1. Checks that Claude Code is installed and moves itself into a detached tmux session named `agency-discovery`, so closing the terminal does not end discovery.
2. Starts the Agency app in a second tmux window if nothing answers at `RADAR_URL` (default `http://localhost:3100`).
3. Starts Claude Opus with a fixed session ID, runs one discovery pass, and creates two session crons:
   - discovery at `6,36 9-20 * * *`, every 30 minutes from 9:06 AM through 8:36 PM local time
   - a check-only keepalive at `6 0,3,6 * * *`, which only confirms both schedules still exist
4. Supervises Claude. If the process exits for any reason it is relaunched with `--resume` on the same session ID, so the conversation continues. The resume prompt recreates both crons and runs a catch-up pass only if the last one is more than 40 minutes old. Repeated crashes back off up to five minutes; three failed resumes in a row start a fresh session.
5. The discovery cron renews itself. Session crons expire after seven days; the scheduled prompt re-creates both tasks once they are five days old and records the new IDs in `discovery-state.json`.

Running the command again while it is up just tells you it is running.

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

The launcher writes `discovery-runtime.json` (session ID, launch history) and `discovery-supervisor.log` next to the coordinator's `CLAUDE.md`. Both are ignored by git.

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

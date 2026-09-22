# Discovery runtime

Agency discovery runs in one dedicated, foreground Claude Code process. The schedules belong to that process and disappear when it exits.

Start the local app first:

```sh
npm run dev
```

Then start discovery in a second terminal:

```sh
npm run agency:discovery
```

The launcher uses Claude Opus through the existing Claude Code login. It does not use an Anthropic API key. By default it creates:

- discovery at `6,36 9-20 * * *`, every 30 minutes from 9:06 AM through 8:36 PM
- a check-only keepalive at `6 0,3,6 * * *`, at 12:06 AM, 3:06 AM, and 6:06 AM

The keepalive never reads sources or creates cards. It only confirms that both schedules remain attached to the session.

## Pinning a known-good Claude version

If a Claude Code update breaks scheduled wakeups, launch an installed version directly and disable its auto-updater for this process:

```sh
AGENCY_CLAUDE_VERSION=2.1.278 npm run agency:discovery
```

The launcher resolves that to `~/.local/share/claude/versions/2.1.278`. You can instead provide an explicit executable:

```sh
AGENCY_CLAUDE_BIN=/absolute/path/to/claude npm run agency:discovery
```

Pinning affects only this discovery process. Other Claude sessions continue using the normal installed version. Remove the pin after scheduled wakeups are confirmed on a newer release.

## Changing the cadence

Both schedules can be changed without editing source:

```sh
AGENCY_DISCOVERY_CRON='6,36 9-20 * * *' \
AGENCY_KEEPALIVE_CRON='6 0,3,6 * * *' \
npm run agency:discovery
```

Do not run more than one discovery coordinator at a time. Stop the old coordinator before starting a replacement, otherwise duplicate schedules may create duplicate work.

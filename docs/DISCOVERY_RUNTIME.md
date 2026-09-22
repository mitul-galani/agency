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

The launcher always uses the current `claude` executable on the user's path. Reliability comes from keeping one dedicated foreground coordinator alive, not from pinning a Claude Code version.

## Changing the cadence

Both schedules can be changed without editing source:

```sh
AGENCY_DISCOVERY_CRON='6,36 9-20 * * *' \
AGENCY_KEEPALIVE_CRON='6 0,3,6 * * *' \
npm run agency:discovery
```

Do not run more than one discovery coordinator at a time. Stop the old coordinator before starting a replacement, otherwise duplicate schedules may create duplicate work.

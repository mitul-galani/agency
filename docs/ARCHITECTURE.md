# How Agency works

Agency has two parts:

1. **The local app** stores the dream, cards, decisions, job instructions, and results in a local SQLite/D1 database.
2. **The local Claude session** reads authorized sources, prepares cards, watches the job queue, and performs approved work.

The browser app does not hold third-party credentials and does not call an LLM API. The launcher uses the user's existing Claude Code login and subscription.

## Data flow

```text
Your connected apps -> local Claude session -> Agency cards -> your decision
                                                   |
                                                   v
                                      approved work and verification
```

The app listens on loopback and exposes a local agent API. It is not a multi-user server. Do not expose it through a public bind address or tunnel.

## Repository boundaries

Shared source includes the app, schema, migrations, tests, agent instructions, and setup scripts.

Local-only data includes:

- `me.md` and personal approval/layout overrides
- `.wrangler/` databases
- `.claude/` sessions and schedules
- credentials and environment files
- cards, source exports, and generated private artifacts

These paths are Git-ignored. Run `npm run share:check` before pushing changes.


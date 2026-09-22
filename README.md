![Agency](docs/readme/agency-header.svg)

# Agency

Agency is a personal operating layer for Claude Code. It turns the work scattered across your connected apps into one local queue of prepared decisions, follow-ups, and tasks.

It is not a hosted service and it does not use an LLM API. The web app runs on your computer. Your local Claude session does the research and work using the accounts and tools it can already access.

## Quick start

You need:

- Node.js 22.13 or later
- Claude Code installed and signed in
- Any apps you want Agency to use connected to that Claude session

```sh
git clone https://github.com/mitul-galani/agency.git
cd agency
npm ci
npm run dev
```

Open [http://localhost:3100](http://localhost:3100), describe what you want Agency to help with, and save it.

Keep the app running. In a second terminal:

```sh
npm run agency:claude
```

That command launches Claude Opus through your existing Claude Code login. Claude reads the Agency instructions, tests its available connections, and prepares the first cards. No Anthropic API key is required.

## How connected apps work

Agency does not ask for Slack, Granola, Notion, Gmail, Calendar, or GitHub credentials.

```text
Your connected apps -> your local Claude session -> Agency cards -> your decision
```

If Claude can access an app in its current session, Agency can use it through that coordinator. During setup Claude performs a harmless live read and reports each relevant source as:

- **Connected:** the intended account returned data
- **Needs sign-in:** the integration exists but authentication or consent is missing
- **Unavailable:** the required connector or capability is not present

An installed connector or a browser login alone is not proof of access. See [Connecting apps](docs/CONNECTING_APPS.md).

## What you do in Agency

- **New:** review prepared work and choose what matters
- **Working:** see your instructions and add more while Claude works
- **Parked:** remove something from the queue until you or Agency brings it back
- **Done:** review completed and dismissed cards later

You can also add a task directly in the app when Claude did not discover it.

Cards stay local. They include the source, useful evidence, prepared work, and the exact decision still needed from you.

## Persistent discovery

Start with a one-time run. If it proves useful, tell the Agency Claude session what cadence you want.

The recommended structure is:

- one Claude session owns discovery
- one Claude session executes approved card work
- discovery and execution never create duplicate schedules

Granola discovery scans the full current day and deduplicates individual actions against every card status and active job. Other sources use an incremental window with a small overlap.

Claude scheduled tasks are attached to the Claude session that created them. Keep that session running. If it exits, restart the coordinator and recreate the schedule.

## Privacy and safety

Agency is a trusted single-user app with unauthenticated local routes.

- Keep it on `localhost`. Do not bind it to `0.0.0.0` or expose it through a public tunnel.
- Do not paste credentials into the app or cards.
- External sends, publishing, spend, access changes, merges, and deployments follow the approval policy.
- Private files, databases, cards, Claude sessions, credentials, and generated artifacts are Git-ignored.

Run this before sharing changes:

```sh
npm run share:check
```

See [How Agency works](docs/ARCHITECTURE.md) for the data and repository boundaries.

## Customize it

Agency ships one agent skill with editable defaults:

| File | Purpose |
| --- | --- |
| [`skills/agency/SKILL.md`](skills/agency/SKILL.md) | Discovery, preparation, deduplication, and execution behavior |
| [`skills/agency/APPROVALS.md`](skills/agency/APPROVALS.md) | What Claude may do and when it must ask |
| [`skills/agency/LAYOUT.md`](skills/agency/LAYOUT.md) | Card structure and presentation |
| `me.md` | Your private profile, priorities, preferences, and exclusions |

To install the skill globally for Claude or Codex:

```sh
node scripts/install-skill.mjs --claude
# or
node scripts/install-skill.mjs --codex
```

The installer never overwrites an existing installation.

## Develop and share updates

```sh
npm test
npm run lint
npm run build
npm run share:check
```

GitHub Actions runs the same checks on pushes and pull requests. See [Contributing](CONTRIBUTING.md).

When this repository is used as a fork, keep the original project as `upstream`:

```sh
git remote add upstream https://github.com/browser-use/agency.git
git fetch upstream
```

Share product updates through branches and pull requests. Each user's cards, profile, connected accounts, and schedules remain local and are never synchronized by Git.

## More documentation

- [Connecting apps](docs/CONNECTING_APPS.md)
- [Architecture and privacy](docs/ARCHITECTURE.md)
- [Contribution guide](CONTRIBUTING.md)
- [Attribution and license notice](NOTICE.md)

## Upstream

This project derives from [browser-use/agency](https://github.com/browser-use/agency). The upstream repository currently has no license file. Read [NOTICE.md](NOTICE.md) before distributing this project outside GitHub's fork workflow.

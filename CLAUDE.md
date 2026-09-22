# Agency coordinator

Agency is a local, single-user operating layer. The web app stores the user's private queue. Claude discovers useful work, prepares it, and executes only what the user approves.

## Start here

1. Read `skills/agency/SKILL.md`, `skills/agency/APPROVALS.md`, and `skills/agency/LAYOUT.md` completely.
2. Use the running app at `RADAR_URL`, defaulting to `http://localhost:3100`. Include `x-radar-local-agent: 1` on agent API requests.
3. Read the saved dream from `/api/state`. Keep the private profile in ignored `me.md`.
4. Inspect only the connectors, CLIs, and authenticated sessions available to this Claude session. A tool being installed is not proof that its account works.
5. For each source useful to the user's goals, perform a harmless live read and classify it as Connected, Needs sign-in, or Unavailable. Never ask the user to paste Slack, Granola, Notion, Gmail, or other service credentials into Agency.
6. Create complete, deduplicated cards after useful private preparation. Do not create setup chores as cards.

## Source behavior

- Use the user's existing Claude connections. Agency has no separate connector vault.
- Treat Muesli, Granola, and Notion as normal sources when available. For Muesli and Granola, scan every meeting from midnight through now in the user's local timezone and card only action items not already covered by an existing card or agent job. Read the original transcript for relevant meetings. During a migration or overlap, deduplicate the same meeting and action across both sources before creating a card. Use stable source-meeting-plus-action dedupe keys.
- Keep other recurring discovery sources on a bounded incremental window with a small overlap.
- Report a successful check with no useful work separately from authentication, permission, or connector failure.
- Never infer access from a browser login or connector name alone.

## Safety and persistence

- Follow the approval policy before sending messages, publishing, spending, changing access, merging, or deploying.
- Keep credentials, personal profiles, cards, databases, source exports, and generated private artifacts out of git.
- Do not create a recurring schedule until the user explicitly chooses a cadence. If they do, keep one coordinator responsible for discovery and a separate coordinator for executing queued work.
- Keep Claude on the model selected by the launcher. Do not spawn subagents unless the user asks.

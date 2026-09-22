# Connecting apps

Agency does not maintain a second set of integrations. It uses the tools and signed-in accounts already available to the local Claude session that coordinates Agency.

## What a user does

1. Connect Slack, Granola, Notion, Gmail, Calendar, GitHub, or another service through Claude Code or an installed Claude MCP server.
2. Start Agency with `npm run dev`.
3. In another terminal, run `npm run agency:claude`.
4. Claude performs a harmless live read for each source relevant to the saved dream.

Claude should report one of three states:

- **Connected:** A live read succeeded for the intended account.
- **Needs sign-in:** The integration exists but authentication or consent is missing.
- **Unavailable:** The connector or required capability is not present.

An installed connector, a browser login, or a source name in the user's dream is not proof of access.

## Credentials

Never paste credentials into the Agency web app or save them in cards. Credentials stay in the service, Claude Code, the MCP server, the operating system keychain, or another approved secret store.

## Discovery windows

Granola is scanned from midnight through the current time on every pass. The coordinator deduplicates each meeting action against every card status and active agent job. Other sources use the incremental window recorded by the coordinator, with a small overlap so late updates are not missed.


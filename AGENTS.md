# Agency contributor instructions

- Read `README.md` and `docs/ARCHITECTURE.md` before changing behavior.
- Preserve the local-only security boundary. Do not add hosted authentication, public listeners, credential storage, or automatic external writes without an explicit product decision.
- Never commit `me.md`, local approval files, `.wrangler`, `.claude`, cards, customer data, credentials, or generated private media.
- Run `npm test`, `npm run lint`, and `npm run build` before sharing a change.
- Keep user-facing writing plain and concise. Do not use em dashes.
- Preserve upstream attribution. This repository derives from `browser-use/agency`.


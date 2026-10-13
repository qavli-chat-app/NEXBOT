# NEXBOT PRO

NEXBOT PRO is a self-hosted WhatsApp automation and group-moderation worker. It is a separate project from QAVLI.

## Current capabilities

- Mobile-first multi-page dashboard at `/dashboard`.
- Protected API routes using the `x-panel-key` header (the key is never accepted in a URL).
- WhatsApp connection state, protected QR retrieval, reconnect control, and health endpoint at `/health`.
- Existing command handlers and permission checks for supported group operations.
- Group metadata, participant lists, subject/description changes, invite controls, and member administration where WhatsApp permissions allow.
- Persisted bot settings, warnings, blocked words, group replies, and workflows on the `DATA_DIR` volume.
- Workflow editor and backend execution for incoming-message triggers, match conditions, sender/group conditions, delays, text replies, event labels, optional AI responses, and allowlisted HTTPS webhooks.
- Dry-run workflow testing that does not send messages or call webhooks.
- Persistent, bounded event history and analytics; message bodies and secrets are not written to the event store.
- Optional OpenRouter AI integration with request timeouts. AI is not required for core bot features.
- API request limits, bounded inputs, and graceful shutdown/reconnect handling.

## Railway setup

1. Deploy the repository branch `nexbot-pro-rebuild` to the existing NEXBOT WhatsApp Worker service.
2. Keep the existing persistent volume mounted at `/data`. Do not detach it or delete `/data/auth` during a normal deployment.
3. Set `DATA_DIR=/data`, `PORT=3000` (or keep the Railway-injected port), `PANEL_KEY` to a long private random value, and optionally `BOT_OWNER` and `COMMAND_PREFIX`.
4. Set the Railway health-check path to `/health`.
5. Open `/dashboard`, enter the `PANEL_KEY`, and connect. The dashboard sends the key in the `x-panel-key` header; it is not placed in the URL.
6. If pairing is required, use the protected **Get pairing QR** action. On the phone, open WhatsApp → Linked devices → Link a device and scan the QR.
7. For group actions, connect the bot account to a test group and grant it group-admin permissions as required.

## Environment variables

- `PANEL_KEY` — required to use private dashboard APIs.
- `BOT_OWNER` — optional owner phone number, digits only.
- `COMMAND_PREFIX` — optional command prefix; defaults to `!`.
- `DATA_DIR` — persistent data path; use `/data` on Railway.
- `OPENROUTER_API_KEY` and `AI_MODEL` — optional AI provider configuration. Provider usage may have limits or charges.
- `WORKFLOW_WEBHOOK_ALLOWLIST` — optional comma-separated list of trusted HTTPS hostnames allowed for workflow webhooks. Do not add hosts you do not control or trust.
- `LOG_LEVEL` — optional Pino log level.

## Verification

Run locally with Node.js 20 or newer:

```sh
npm install
npm test
npm start
```

The test suite checks JavaScript syntax, event-store persistence and redaction, workflow validation/execution, and dashboard script/navigation syntax.

Manual verification still requires the owner's WhatsApp account and (for group operations) a real test group:
- Scan a QR if pairing is required.
- Send `!ping` and `!help` from a test chat/group.
- Confirm an active workflow replies only when its condition matches.
- Test group administration only with explicit group selection and appropriate admin permissions.
- Confirm settings and workflows remain after a Railway restart.

## Important limitations and safety

- Baileys is an unofficial WhatsApp Web integration, not the official WhatsApp Business Platform. WhatsApp may change behavior or restrict accounts. Review current platform terms and use a test/secondary account.
- Official WhatsApp Business Platform onboarding, approved templates, and pricing are separate and may incur charges.
- Do not use the bot for unsolicited bulk messaging, spam, scraping, or unauthorized access to conversations.
- Group actions succeed only when WhatsApp confirms the operation and the bot has sufficient permissions.
- Never share `PANEL_KEY`, a live QR code, API keys, or session files. The settings backup intentionally excludes WhatsApp authentication credentials.
- Do not claim live commands or group moderation are verified until tested with the account owner’s connected WhatsApp session.

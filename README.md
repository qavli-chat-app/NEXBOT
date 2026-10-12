# NEXBOT — WhatsApp Group Moderation Worker

NEXBOT is a separate project from QAVLI. It is a self-hosted WhatsApp group moderation worker using the unofficial Baileys Web API.

## Included
- Protected QR pairing page at `/qr?key=YOUR_PANEL_KEY`
- Health endpoint at `/health` and a small status page at `/`
- Welcome messages when members join
- Anti-link moderation and basic burst anti-spam
- Commands: `!help`, `!ping`, `!groupinfo`, `!tagall [message]`, `!kick @member`, `!warn @member`, `!warnings @member`, `!clearwarn @member`, `!antilink on|off`, `!antispam on|off`, `!welcome on|off`
- Private-message protection with the exact auto-reply: `I am not accepting private messages. Please do not message me.` (enabled by default; one reply per sender per 24 hours)
- Protected panel APIs to check/toggle private-message protection: `GET /api/private-protection` and `PATCH /api/private-protection` with `{ "enabled": true|false }`
- Persistent WhatsApp auth and saved warning/settings state when `DATA_DIR` points to a persistent volume
- Automatic reconnect after temporary connection drops

## Railway deployment
1. Deploy the `qavli-chat-app/NEXBOT` repository from branch `main`.
2. Use the repository's `Dockerfile` and Node.js 20 runtime.
3. Attach a persistent volume mounted at `/data`.
4. Set `DATA_DIR=/data`, `PORT=3000`, and `PANEL_KEY` to a long random private secret.
5. Set the Railway health check path to `/health` and expose the service on port 3000.
6. After the deployment succeeds, open `https://YOUR-DOMAIN/health`. Wait for `qrAvailable: true`, then open `https://YOUR-DOMAIN/qr?key=YOUR_PANEL_KEY`.
7. In WhatsApp, go to Settings → Linked Devices → Link a Device and scan the private QR.
8. Add the account to a test group and promote it to group admin for moderation/removal actions.

## Important
- Do not commit the QR, `PANEL_KEY`, or `/data/auth` session files.
- Keep the QR page private. Anyone with access to a live pairing QR may link a device.
- The bot needs group-admin permission for link deletion and member removal. WhatsApp behavior can vary.
- This uses an unofficial WhatsApp Web connection library; WhatsApp may change behavior or restrict accounts. Use a test/secondary account and follow WhatsApp's terms.
- The project code being committed does not mean the Railway deployment or WhatsApp session is already live. Verify both before using it in a real group.
- Test all moderation features in a small test group before relying on them.

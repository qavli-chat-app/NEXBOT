# NEXBOT — One-Click Quick Setup

NEXBOT is separate from QAVLI. This guide uses the existing Railway deployment.

## Open the running service

- Status: https://nexbot-whatsapp-worker-production.up.railway.app/health
- Railway dashboard: https://railway.com/

## First-time pairing (one manual scan is required)

1. In Railway, open the **NEXBOT WhatsApp Worker** service and its **Variables** tab.
2. Copy the value of `PANEL_KEY` privately. Do not post it in chat or share it.
3. Open this URL in your browser, replacing `YOUR_PANEL_KEY` locally with that value:
   `https://nexbot-whatsapp-worker-production.up.railway.app/qr?key=YOUR_PANEL_KEY`
4. On the phone that owns the WhatsApp account, open **WhatsApp → Settings → Linked Devices → Link a Device** and scan the QR code.
5. Refresh the health page. The `connected` field should become `true`.
6. Add the bot account to a test group and promote it to group admin before testing moderation commands.

## What is already configured

- Railway deployment from `qavli-chat-app/NEXBOT` branch `main`
- Persistent session volume mounted at `/data`
- Health check endpoint at `/health`
- QR pairing endpoint at `/qr?key=...`

## Free hosting and lifetime note

The repository is free to use, but that does **not** make the hosting provider's compute and storage free forever. Railway plans, quotas, and pricing can change. Check the account's current plan before relying on a permanent always-on service. Do not add paid services or enable a paid upgrade unless you choose to.

## Safety

- Never share the QR code, `PANEL_KEY`, or the saved `/data/auth` session.
- Use a test/secondary WhatsApp account first. This bot uses an unofficial WhatsApp Web library; connection behavior and account restrictions are outside NEXBOT's control.
- The bot must be a group admin for moderation actions. Test commands in a small group before relying on them.

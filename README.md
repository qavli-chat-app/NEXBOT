# NEXBOT — WhatsApp Group Moderation Worker

A self-hosted WhatsApp group moderation worker using the unofficial Baileys Web API. It is independent from QAVLI.

## Features
- Protected QR pairing page and health endpoint
- Welcome messages
- Anti-link removal (bot must be group admin)
- Basic burst anti-spam
- Admin commands: `!help`, `!ping`, `!tagall`, `!kick @member`, `!warn @member`, `!warnings @member`, `!clearwarn @member`, `!antilink on|off`, `!antispam on|off`, `!welcome on|off`, `!groupinfo`

## Railway setup
1. Deploy this repository as a Railway service using the Dockerfile.
2. Add a persistent volume mounted at `/data`. Without it, pairing credentials may be lost on redeploy/restart.
3. Set `PANEL_KEY` to a long, private random secret.
4. Set `DATA_DIR=/data`.
5. Generate a public Railway domain and open `https://YOUR-DOMAIN/qr?key=YOUR_PANEL_KEY`.
6. On WhatsApp, open Settings → Linked Devices → Link a Device and scan the QR.
7. Add the bot account to your group and promote it to group admin for link removal and member removal.

Health endpoint: `/health`.

## Important
- This project uses an unofficial WhatsApp Web connection library; WhatsApp may change behavior or restrict accounts. Use responsibly and avoid spam.
- Never commit the QR, `PANEL_KEY`, or the `/data/auth` session files. Keep the QR page private.
- This is a first working worker implementation, not a claim that a live session is already connected.
- Settings and warning counts currently live in memory and reset when the worker restarts.
- Always test moderation in a small test group first.

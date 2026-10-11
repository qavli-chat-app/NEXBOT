import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || '/data';
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const STATE_FILE = path.join(DATA_DIR, 'bot-state.json');
const PANEL_KEY = process.env.PANEL_KEY || '';
const PREFIX = process.env.COMMAND_PREFIX || '!';
const OWNER = (process.env.BOT_OWNER || '').replace(/\D/g, '');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock;
let latestQR = '';
let connected = false;
let connectionState = 'starting';
let lastDisconnect = null;
let reconnectTimer;
let starting = false;
const warnings = new Map();
const recentMessages = new Map();
const defaults = { antiLink: true, antiSpam: true, welcome: true };
let settings = { ...defaults };

try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    settings = { ...defaults, ...(saved.settings || {}) };
    for (const [key, value] of Object.entries(saved.warnings || {})) warnings.set(key, Number(value) || 0);
  }
} catch (e) { logger.warn({ err: String(e) }, 'Saved state could not be read; using defaults'); }

function saveState() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ settings, warnings: Object.fromEntries(warnings) }), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { logger.error({ err: String(e) }, 'Could not persist bot state; verify DATA_DIR volume permissions'); }
}

app.get('/health', (_req, res) => res.json({
  ok: true, name: 'NEXBOT', connected, connectionState,
  qrAvailable: Boolean(latestQR), lastDisconnect, uptimeSeconds: Math.floor(process.uptime())
}));
app.get('/', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXBOT Worker</title><style>body{font:16px system-ui;background:#0b1220;color:#e5e7eb;max-width:760px;margin:40px auto;padding:20px}main{background:#111c2e;padding:24px;border:1px solid #26354d;border-radius:18px}a{color:#67e8c2}.muted{color:#9ca3af}</style></head><body><main><h1>🤖 NEXBOT</h1><p>WhatsApp moderation worker</p><p>Status: <b>${connected ? 'Connected' : connectionState}</b></p><p><a href="/health">Health status</a></p><p class="muted">Pair using the protected QR endpoint configured by the owner.</p></main></body></html>`));
app.get('/qr', async (req, res) => {
  if (!PANEL_KEY || req.query.key !== PANEL_KEY) return res.status(403).type('text').send('Access denied. Configure PANEL_KEY in the hosting environment.');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  if (connected) return res.type('html').send('<meta name="viewport" content="width=device-width"><h2>NEXBOT is already connected ✅</h2><p>Use WhatsApp Linked Devices to review linked devices.</p>');
  if (!latestQR) return res.status(202).type('html').send('<meta name="viewport" content="width=device-width"><h2>QR not ready yet</h2><p>Refresh in a few seconds. Check /health and hosting logs if it stays here.</p><meta http-equiv="refresh" content="5">');
  const image = await QRCode.toDataURL(latestQR, { width: 320, margin: 2 });
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXBOT Pairing</title><style>body{font:16px system-ui;background:#0b1220;color:#eee;text-align:center;padding:24px}main{max-width:440px;margin:auto;background:#111c2e;padding:24px;border-radius:20px}img{width:min(320px,100%);background:white;border-radius:12px}p{color:#b9c5d7}</style></head><body><main><h1>NEXBOT Pairing</h1><img src="${image}" alt="WhatsApp pairing QR"><p>WhatsApp → Settings → Linked Devices → Link a Device.</p><p>Keep this page and QR private. Refresh if it expires.</p><p><a href="/qr?key=${encodeURIComponent(PANEL_KEY)}">Refresh QR</a></p></main></body></html>`);
});
app.listen(PORT, '0.0.0.0', () => logger.info({ PORT }, 'NEXBOT HTTP status server listening'));

const jidNumber = (jid = '') => jid.split('@')[0].split(':')[0].replace(/\D/g, '');
const isAdmin = async (groupJid, userJid) => {
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta.participants.some(p => p.id === userJid && ['admin', 'superadmin'].includes(p.admin));
  } catch { return false; }
};
const send = (jid, text, options = {}) => sock.sendMessage(jid, { text, ...options });

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || msg.key.fromMe) return;
  const sender = msg.key.participant || msg.key.remoteJid;
  const text = (msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '').trim();
  if (!text) return;

  const isGroup = jid.endsWith('@g.us');
  const senderIsAdmin = isGroup ? await isAdmin(jid, sender) : false;

  if (isGroup && settings.antiLink && !senderIsAdmin &&
      /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/)/i.test(text)) {
    try {
      await sock.sendMessage(jid, { delete: msg.key });
      await send(jid, '⚠️ Link removed. Please ask an admin before sharing links.');
    } catch (e) { logger.warn({ err: String(e) }, 'Could not remove link; bot may need admin permission'); }
    return;
  }

  if (isGroup && settings.antiSpam) {
    const key = jid + ':' + sender;
    const now = Date.now();
    const history = (recentMessages.get(key) || []).filter(t => now - t < 8000);
    history.push(now); recentMessages.set(key, history);
    if (history.length >= 6 && !senderIsAdmin) {
      try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
      await send(jid, '🛡️ Anti-spam: please slow down.');
      recentMessages.set(key, []);
      return;
    }
  }

  if (!text.startsWith(PREFIX)) return;
  const [rawCommand, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = (rawCommand || '').toLowerCase();
  const adminOnly = new Set(['tagall', 'kick', 'warn', 'warnings', 'clearwarn', 'antilink', 'antispam', 'welcome', 'groupinfo']);
  if (adminOnly.has(command) && isGroup && !senderIsAdmin && (!OWNER || jidNumber(sender) !== OWNER)) {
    return send(jid, '⛔ This command is for group admins only.');
  }

  switch (command) {
    case 'help':
      return send(jid, [
        '🤖 *NEXBOT Commands*',
        PREFIX + 'help — show commands',
        PREFIX + 'ping — test response',
        PREFIX + 'groupinfo — group details (admin)',
        PREFIX + 'tagall [message] — mention members (admin)',
        PREFIX + 'kick @mention — remove member (admin)',
        PREFIX + 'warn @mention — issue warning (admin)',
        PREFIX + 'warnings @mention — show warnings (admin)',
        PREFIX + 'clearwarn @mention — clear warnings (admin)',
        PREFIX + 'antilink on|off — link moderation (admin)',
        PREFIX + 'antispam on|off — spam moderation (admin)',
        PREFIX + 'welcome on|off — welcome messages (admin)',
        '',
        'Note: NEXBOT needs group-admin rights to remove links or members.'
      ].join('\n'));
    case 'ping': return send(jid, '🏓 NEXBOT is online.');
    case 'groupinfo': {
      if (!isGroup) return send(jid, 'This command works in groups.');
      const meta = await sock.groupMetadata(jid);
      return send(jid, `👥 ${meta.subject}\nMembers: ${meta.participants.length}\nAnti-link: ${settings.antiLink ? 'ON' : 'OFF'}\nAnti-spam: ${settings.antiSpam ? 'ON' : 'OFF'}\nWelcome: ${settings.welcome ? 'ON' : 'OFF'}`);
    }
    case 'tagall': {
      if (!isGroup) return send(jid, 'This command works in groups.');
      const meta = await sock.groupMetadata(jid);
      const ids = meta.participants.map(p => p.id);
      const message = args.join(' ') || 'Attention everyone!';
      return sock.sendMessage(jid, { text: `📢 ${message}\n\n` + ids.map(id => '@' + jidNumber(id)).join(' '), mentions: ids });
    }
    case 'kick': {
      if (!isGroup) return send(jid, 'This command works in groups.');
      const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!target) return send(jid, 'Mention the member to remove: ' + PREFIX + 'kick @member');
      try { await sock.groupParticipantsUpdate(jid, [target], 'remove'); return send(jid, '✅ Removal request sent.'); }
      catch { return send(jid, '❌ Could not remove member. Make NEXBOT a group admin.'); }
    }
    case 'warn':
    case 'warnings':
    case 'clearwarn': {
      if (!isGroup) return send(jid, 'This command works in groups.');
      const target = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      if (!target) return send(jid, 'Mention a member, e.g. ' + PREFIX + command + ' @member');
      const key = jid + ':' + target;
      if (command === 'clearwarn') { warnings.delete(key); saveState(); return send(jid, '✅ Warnings cleared.'); }
      const count = warnings.get(key) || 0;
      if (command === 'warnings') return send(jid, `⚠️ @${jidNumber(target)} has ${count} warning(s).`, { mentions: [target] });
      warnings.set(key, count + 1);
      saveState();
      return send(jid, `⚠️ Warning ${count + 1} for @${jidNumber(target)}. Please follow group rules.`, { mentions: [target] });
    }
    case 'antilink':
    case 'antispam':
    case 'welcome': {
      const value = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) return send(jid, `Usage: ${PREFIX}${command} on|off`);
      settings[command === 'antilink' ? 'antiLink' : command === 'antispam' ? 'antiSpam' : 'welcome'] = value === 'on';
      saveState();
      return send(jid, `✅ ${command} is now ${value.toUpperCase()} (saved on this worker).`);
    }
    default: return send(jid, 'Unknown command. Send ' + PREFIX + 'help');
  }
}

async function startBot() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { logger.warn({ err: String(e) }, 'Could not fetch latest WA version; using library default'); }
    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['NEXBOT', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect: disconnect, qr }) => {
      if (qr) { latestQR = qr; connectionState = 'qr_ready'; logger.info('Pairing QR is ready at the protected /qr endpoint'); }
      if (connection === 'connecting') connectionState = 'connecting';
      if (connection === 'open') { connected = true; connectionState = 'connected'; latestQR = ''; lastDisconnect = null; logger.info('WhatsApp connected'); }
      if (connection === 'close') {
        connected = false;
        const code = disconnect?.error?.output?.statusCode;
        lastDisconnect = String(disconnect?.error?.message || 'connection closed');
        connectionState = 'disconnected';
        logger.warn({ code, lastDisconnect }, 'WhatsApp connection closed');
        if (code !== DisconnectReason.loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { starting = false; startBot().catch(err => logger.error({ err: String(err) }, 'Restart failed')); }, 3000);
        } else logger.error('Session logged out. Review WhatsApp Linked Devices and pair again if needed.');
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(msg); } catch (e) { logger.error({ err: String(e) }, 'Message handler error'); }
      }
    });
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      if (action !== 'add' || !settings.welcome) return;
      try {
        const meta = await sock.groupMetadata(id);
        for (const user of participants) await sock.sendMessage(id, {
          text: `👋 Welcome @${jidNumber(user)} to *${meta.subject}*!\nPlease read the group rules and be respectful.`,
          mentions: [user]
        });
      } catch (e) { logger.warn({ err: String(e) }, 'Welcome message failed'); }
    });
  } finally {
    starting = false;
  }
}

startBot().catch(err => { logger.error({ err: String(err) }, 'Fatal startup error'); process.exit(1); });

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
app.get('/', (_req, res) => res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07111f"><title>NEXBOT — WhatsApp Connect</title>
<style>
:root{color-scheme:dark;--bg:#07111f;--panel:#101d30;--line:#26384f;--muted:#9aaec4;--mint:#63f0c0;--blue:#69a7ff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% -15%,#163b51 0,transparent 48%),var(--bg);color:#f3f7fb;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;padding:24px 16px 40px}
.wrap{max-width:900px;margin:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:12px}.logo{width:46px;height:46px;border-radius:15px;display:grid;place-items:center;background:linear-gradient(145deg,#6cf4c5,#49a8ff);color:#061421;font-weight:950;font-size:25px;box-shadow:0 8px 28px #4ad9b344}.brand h1{font-size:20px;letter-spacing:2px;margin:0}.brand p{margin:0;color:var(--muted);font-size:12px}.pill{border:1px solid var(--line);border-radius:999px;padding:7px 11px;color:var(--muted);font-size:12px;white-space:nowrap}.hero{text-align:center;padding:24px 0 30px}.eyebrow{color:var(--mint);font-weight:800;font-size:11px;letter-spacing:2px;text-transform:uppercase}.hero h2{font-size:clamp(32px,7vw,52px);line-height:1.08;letter-spacing:-1.5px;margin:12px auto;max-width:700px}.hero h2 span{color:var(--mint)}.hero p{max-width:570px;margin:0 auto;color:var(--muted);font-size:15px}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}.card{background:linear-gradient(155deg,#12233a,#0c1728);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 18px 50px #0002}.cardhead{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:18px}.card h3{font-size:17px;margin:0}.sub{color:var(--muted);font-size:12px;margin-top:4px}.status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);padding:6px 10px;border-radius:999px;font-size:12px;color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%;background:#f4b860;box-shadow:0 0 10px currentColor}.status.live{color:var(--mint)}.status.live .dot{background:var(--mint)}.steps{display:grid;gap:12px;margin:18px 0 22px}.step{display:flex;gap:12px;align-items:flex-start}.num{flex:0 0 28px;height:28px;border-radius:9px;background:#1c354d;color:var(--mint);display:grid;place-items:center;font-weight:800}.step strong{display:block;font-size:13px}.step span{display:block;color:var(--muted);font-size:12px;margin-top:2px}.fieldlabel{display:block;font-size:12px;color:#c9d6e5;margin-bottom:7px}.field{width:100%;border:1px solid #31465f;border-radius:12px;padding:13px 14px;background:#081321;color:#fff;font:inherit;outline:none}.field:focus{border-color:var(--mint);box-shadow:0 0 0 3px #63f0c01b}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.btn{border:0;border-radius:12px;padding:12px 16px;font:700 13px inherit;cursor:pointer;text-decoration:none;display:inline-flex;justify-content:center;align-items:center;gap:8px}.primary{background:var(--mint);color:#061820;flex:1}.secondary{background:#1a2a40;color:#eaf2fa;border:1px solid #30455d}.hint{font-size:11px;color:var(--muted);margin:12px 0 0}.message{display:none;border-radius:12px;padding:11px 12px;margin-top:12px;font-size:12px;background:#172a3c;color:#cfe5f5;overflow-wrap:anywhere}.message.show{display:block}.features{display:grid;gap:10px}.feature{display:flex;gap:12px;padding:12px;border:1px solid #26384d;background:#0b1727;border-radius:14px}.ico{width:35px;height:35px;display:grid;place-items:center;background:#17334a;border-radius:11px;font-size:17px;flex-shrink:0}.feature strong{font-size:13px;display:block}.feature span{font-size:11px;color:var(--muted);display:block;margin-top:2px}.foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#71869d;font-size:11px;padding:20px 4px}.foot a{color:var(--mint);text-decoration:none}.notice{border:1px solid #594b2c;background:#292316;color:#f6dca0;padding:12px 14px;border-radius:13px;font-size:12px;margin-top:16px}@media(max-width:700px){body{padding:16px 13px 28px}.top{margin-bottom:15px}.grid{grid-template-columns:1fr}.hero{padding:25px 0}.card{padding:18px}.pill{font-size:10px}.foot{padding-top:18px}} 
</style></head><body><div class="wrap">
<header class="top"><div class="brand"><div class="logo">N</div><div><h1>NEXBOT <span style="color:var(--mint)">PRO</span></h1><p>WHATSAPP GROUP ASSISTANT</p></div></div><div class="pill">● PRIVATE PAIRING PANEL</div></header>
<section class="hero"><div class="eyebrow">SECURE SETUP · STEP 01</div><h2>Connect your WhatsApp<br><span>to NEXBOT.</span></h2><p>Link your WhatsApp account, then let NEXBOT help moderate your groups with anti-spam, link protection and welcome messages.</p></section>
<div class="grid"><section class="card"><div class="cardhead"><div><h3>WhatsApp connection</h3><div class="sub">Your connection status updates automatically.</div></div><div id="status" class="status"><i class="dot"></i><span>Checking…</span></div></div>
<div class="steps"><div class="step"><div class="num">1</div><div><strong>Get your panel key</strong><span>Open Railway → NEXBOT service → Variables. Copy PANEL_KEY privately.</span></div></div><div class="step"><div class="num">2</div><div><strong>Open secure pairing</strong><span>Enter the key below. The QR page is protected and should not be shared.</span></div></div><div class="step"><div class="num">3</div><div><strong>Scan from WhatsApp</strong><span>WhatsApp → Linked Devices → Link a Device. Use another screen to display this QR.</span></div></div></div>
<label class="fieldlabel" for="key">Private panel key (PANEL_KEY)</label><input class="field" id="key" type="password" autocomplete="off" placeholder="Paste your key here" aria-label="Private panel key">
<div class="actions"><button class="btn primary" id="connect">Open secure QR pairing ↗</button><button class="btn secondary" id="refresh">Refresh status</button></div><div id="message" class="message" role="status"></div><p class="hint">Your key is used only to open the protected pairing page. Never send it to anyone.</p>
<div class="notice">Security note: WhatsApp pairing uses an unofficial connection library. Use an account you control, keep the QR private, and understand that third-party automation can risk account restrictions.</div>
</section>
<aside class="card"><div class="cardhead"><div><h3>What’s included</h3><div class="sub">Tools available after pairing</div></div></div><div class="features"><div class="feature"><div class="ico">🛡️</div><div><strong>Anti-link & anti-spam</strong><span>Moderation settings with on/off commands.</span></div></div><div class="feature"><div class="ico">👋</div><div><strong>Welcome messages</strong><span>Greet new group members automatically.</span></div></div><div class="feature"><div class="ico">⚠️</div><div><strong>Warnings & moderation</strong><span>Warn, check warnings, or clear them.</span></div></div><div class="feature"><div class="ico">📣</div><div><strong>Group admin tools</strong><span>Member tagging, group info and admin commands.</span></div></div><div class="feature"><div class="ico">💾</div><div><strong>Persistent session</strong><span>Railway volume stores the linked session when configured correctly.</span></div></div></div><div class="actions"><a class="btn secondary" href="/health" target="_blank" rel="noreferrer">View technical status ↗</a></div></aside></div>
<footer class="foot"><span>© NEXBOT PRO · Independent community tool</span><span><a href="https://github.com/qavli-chat-app/NEXBOT" target="_blank" rel="noreferrer">Source code</a> · Keep your session private</span></footer></div>
<script>
const statusEl=document.getElementById('status'),msg=document.getElementById('message'),keyInput=document.getElementById('key');
function showMessage(t){msg.textContent=t;msg.classList.add('show')}
async function refreshStatus(){try{const r=await fetch('/health',{cache:'no-store'});if(!r.ok)throw new Error('Status unavailable');const d=await r.json();const label=d.connected?'WhatsApp connected':d.connectionState==='qr_ready'?'QR ready':d.connectionState==='connecting'?'Connecting…':d.connectionState||'Starting';statusEl.className='status'+(d.connected?' live':'');statusEl.querySelector('span').textContent=label; if(d.connected)showMessage('WhatsApp is connected. You can now test !ping and !help in a chat.');}catch(e){statusEl.className='status';statusEl.querySelector('span').textContent='Status unavailable';}}
document.getElementById('refresh').addEventListener('click',refreshStatus);
document.getElementById('connect').addEventListener('click',()=>{const key=keyInput.value.trim();if(!key){showMessage('Enter your PANEL_KEY from Railway Variables first.');keyInput.focus();return;}showMessage('Opening protected QR pairing page…');window.open('/qr?key='+encodeURIComponent(key),'_blank','noopener');});
refreshStatus();setInterval(refreshStatus,8000);
</script></body></html>`));app.get('/qr', async (req, res) => {
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

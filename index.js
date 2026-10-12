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
const defaults = { antiLink: true, antiSpam: true, welcome: true, antiFlood: true, antiCaps: false, badWords: true, blockMedia: true, aiReplies: false };
let settings = { ...defaults, groups: {} };

try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    settings = { ...defaults, ...(saved.settings || {}), groups: saved.settings?.groups || {} };
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


function panelAuthorized(req) {
  return Boolean(PANEL_KEY) && (req.get('x-panel-key') === PANEL_KEY || req.query.key === PANEL_KEY);
}
function groupSettings(jid) { return { ...defaults, ...(settings.groups?.[jid] || {}) }; }
app.use(express.json({ limit: '32kb' }));
app.get('/api/ai-status', (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key' });
  res.set('Cache-Control', 'no-store');
  res.json({ configured: Boolean(OPENROUTER_API_KEY), provider: 'OpenRouter', model: OPENROUTER_MODEL, mode: OPENROUTER_API_KEY ? 'ai-ready' : 'fallback-only', note: OPENROUTER_API_KEY ? 'OpenRouter key is configured; free-model limits and availability apply.' : 'OPENROUTER_API_KEY is not configured. Existing local fallback remains active.' });
});
app.post('/api/ai-test', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key. Enter it at the top of the dashboard.' });
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt || prompt.length > 1000) return res.status(400).json({ error: 'Enter a test prompt up to 1000 characters.' });
  if (!OPENROUTER_API_KEY) return res.status(503).json({ error: 'OPENROUTER_API_KEY is missing in Railway Variables.' });
  const answer = await freeModelReply(prompt);
  if (!answer) return res.status(502).json({ error: 'AI did not reply. The free model may be busy; check Railway deploy logs.' });
  return res.json({ ok: true, model: OPENROUTER_MODEL, answer });
});
app.get('/api/groups', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key' });
  if (!connected || !sock) return res.status(503).json({ error: 'WhatsApp is not connected yet. Check /health first.' });
  try {
    const groups = await sock.groupFetchAllParticipating();
    res.set('Cache-Control', 'no-store');
    res.json({ groups: Object.values(groups).map(g => ({
      id: g.id, subject: g.subject || 'Unnamed group',
      size: g.participants?.length || 0,
      botIsAdmin: Boolean(g.participants?.some(p => jidNumber(p.id) === jidNumber(sock.user?.id) && ['admin','superadmin'].includes(p.admin))),
      settings: groupSettings(g.id)
    })).sort((a,b) => a.subject.localeCompare(b.subject)) });
  } catch (e) { logger.error({err:String(e)}, 'Could not fetch groups'); res.status(500).json({error:'Could not load groups from WhatsApp.'}); }
});
app.get('/api/groups/:id', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key' });
  if (!connected || !sock) return res.status(503).json({ error: 'WhatsApp is not connected.' });
  const id = String(req.params.id);
  if (!id.endsWith('@g.us')) return res.status(400).json({error:'Invalid group id'});
  try {
    const meta = await sock.groupMetadata(id);
    res.json({ id, subject: meta.subject, size: meta.participants.length,
      botIsAdmin: Boolean(meta.participants.some(p => jidNumber(p.id) === jidNumber(sock.user?.id) && ['admin','superadmin'].includes(p.admin))),
      settings: groupSettings(id),
      participants: meta.participants.map(p => ({id:p.id, name:p.name || p.notify || jidNumber(p.id), admin:p.admin || ''}))
    });
  } catch { res.status(404).json({error:'Group not found or bot is not a member.'}); }
});
const groupMessageStore = new Map();
function rememberGroupMessage(jid, item) {
  if (!jid?.endsWith('@g.us')) return;
  const list = groupMessageStore.get(jid) || [];
  list.push(item);
  if (list.length > 250) list.splice(0, list.length - 250);
  groupMessageStore.set(jid, list);
}
app.get('/api/groups/:id/messages', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({error:'Unauthorized panel key'});
  if (!connected || !sock) return res.status(503).json({error:'WhatsApp is not connected.'});
  const id = String(req.params.id);
  if (!id.endsWith('@g.us')) return res.status(400).json({error:'Invalid group id'});
  try { await sock.groupMetadata(id); } catch { return res.status(404).json({error:'Group not found or bot is not a member.'}); }
  const after = Number(req.query.after || 0);
  res.set('Cache-Control','no-store');
  res.json({messages:(groupMessageStore.get(id)||[]).filter(m=>m.time>after).slice(-100)});
});
app.post('/api/groups/:id/messages', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({error:'Unauthorized panel key'});
  if (!connected || !sock) return res.status(503).json({error:'WhatsApp is not connected.'});
  const id = String(req.params.id), message = String(req.body?.message || '').trim();
  if (!id.endsWith('@g.us')) return res.status(400).json({error:'Invalid group id'});
  if (!message || message.length > 4000) return res.status(400).json({error:'Message must be 1–4000 characters.'});
  try {
    const meta = await sock.groupMetadata(id);
    const bot = meta.participants.find(p => jidNumber(p.id) === jidNumber(sock.user?.id));
    if (!bot || !['admin','superadmin'].includes(bot.admin)) return res.status(403).json({error:'Make NEXBOT a group admin first to send from this control panel.'});
    await sock.sendMessage(id,{text:message});
    const item={id:'panel-'+Date.now(),time:Date.now(),sender:'NEXBOT · Control Panel',text:message,fromMe:true};
    rememberGroupMessage(id,item);
    return res.json({ok:true,message:'Message sent to selected group.',item});
  } catch(e) { logger.warn({err:String(e)},'Panel group message failed'); return res.status(500).json({error:'Could not send group message. Check NEXBOT admin permission.'}); }
});
app.post('/api/send-message', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key' });
  if (!connected || !sock) return res.status(503).json({ error: 'WhatsApp is not connected.' });
  const number = String(req.body?.number || '').replace(/[^0-9]/g, '');
  const message = String(req.body?.message || '').trim();
  if (number.length < 8 || number.length > 15) return res.status(400).json({error:'Enter a valid international phone number including country code, digits only.'});
  if (!message || message.length > 4000) return res.status(400).json({error:'Message must be between 1 and 4000 characters.'});
  try {
    const jid = number + '@s.whatsapp.net';
    const result = await sock.onWhatsApp(jid);
    if (!result?.some(x => x.exists)) return res.status(404).json({error:'This number does not appear to have a WhatsApp account.'});
    await sock.sendMessage(jid, { text: message });
    return res.json({ok:true,message:'WhatsApp message sent to +' + number + '.'});
  } catch (e) {
    logger.warn({err:String(e)}, 'Manual dashboard message failed');
    return res.status(500).json({error:'Could not send message. Check WhatsApp connection and try again.'});
  }
});

app.patch('/api/groups/:id/settings', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key' });
  if (!connected || !sock) return res.status(503).json({ error: 'WhatsApp is not connected.' });
  const id = String(req.params.id);
  if (!id.endsWith('@g.us')) return res.status(400).json({error:'Invalid group id'});
  const allowed = ['antiLink','antiSpam','welcome','antiFlood','antiCaps','badWords','blockMedia'];
  const patch = req.body || {};
  if (!Object.keys(patch).length || Object.keys(patch).some(k => !allowed.includes(k) || typeof patch[k] !== 'boolean')) return res.status(400).json({error:'Only supported boolean moderation settings are allowed.'});
  try { await sock.groupMetadata(id); } catch { return res.status(404).json({error:'Group not found or bot is not a member.'}); }
  settings.groups ||= {};
  settings.groups[id] = { ...groupSettings(id), ...patch };
  saveState();
  res.json({ok:true, id, settings:groupSettings(id)});
});
app.post('/api/groups/:id/action', async (req, res) => {
  if (!panelAuthorized(req)) return res.status(403).json({ error: 'Unauthorized panel key' });
  if (!connected || !sock) return res.status(503).json({ error: 'WhatsApp is not connected.' });
  const id = String(req.params.id), { action, participant } = req.body || {};
  if (!id.endsWith('@g.us')) return res.status(400).json({error:'Invalid group id'});
  const memberActions = ['warn','kick','promote','demote'];
  const groupActions = ['requestAdmin','getInviteCode','revokeInvite','announceOn','announceOff','editInfoOn','editInfoOff','getDescription','memberAddAll','memberAddAdmins','joinApprovalOn','joinApprovalOff','ephemeralOff','ephemeral24h','ephemeral7d','ephemeral90d'];
  if (memberActions.includes(action) && (typeof participant !== 'string' || !participant.includes('@'))) return res.status(400).json({error:'Choose a valid member and action.'});
  if (!memberActions.includes(action) && !groupActions.includes(action)) return res.status(400).json({error:'Unsupported action.'});
  try {
    const meta = await sock.groupMetadata(id);
    const bot = meta.participants.find(p => jidNumber(p.id) === jidNumber(sock.user?.id));
    const botAdmin = Boolean(bot && ['admin','superadmin'].includes(bot.admin));
    if (action === 'requestAdmin') {
      const admins = meta.participants.filter(p => ['admin','superadmin'].includes(p.admin) && jidNumber(p.id) !== jidNumber(sock.user?.id));
      const mentions = admins.map(p => p.id);
      const suffix = mentions.length ? '\\nRequesting group admins: ' + mentions.map(j => '@' + jidNumber(j)).join(' ') : '';
      await sock.sendMessage(id, { text: '🛡️ *NEXBOT ADMIN REQUEST*\\nPlease make NEXBOT a group admin so its moderation and group-management tools can work properly.\\n\\nAn existing group admin must approve this request.' + suffix, mentions });
      return res.json({ok:true,message:'Admin request posted in the selected group. An existing admin must promote NEXBOT manually.'});
    }
    if (['kick','promote','demote','announceOn','announceOff','editInfoOn','editInfoOff','revokeInvite','memberAddAll','memberAddAdmins','joinApprovalOn','joinApprovalOff','ephemeralOff','ephemeral24h','ephemeral7d','ephemeral90d'].includes(action) && !botAdmin) return res.status(403).json({error:'Promote NEXBOT to group admin first.'});
    if (action === 'getDescription') return res.json({ok:true,message:'Group description: '+(meta.desc || '(no description set)')});
    if (action === 'getInviteCode') {
      const code = await sock.groupInviteCode(id);
      return res.json({ok:true,message:'Invite link: https://chat.whatsapp.com/'+code});
    }
    if (action === 'revokeInvite') {
      const code = await sock.groupRevokeInvite(id);
      return res.json({ok:true,message:'Invite link reset. New link: https://chat.whatsapp.com/'+code});
    }
    if (action === 'announceOn' || action === 'announceOff') {
      await sock.groupSettingUpdate(id, action === 'announceOn' ? 'announcement' : 'not_announcement');
      return res.json({ok:true,message:action === 'announceOn' ? 'Only admins can send messages now.' : 'All members can send messages now.'});
    }
    if (action === 'editInfoOn' || action === 'editInfoOff') {
      await sock.groupSettingUpdate(id, action === 'editInfoOn' ? 'locked' : 'unlocked');
      return res.json({ok:true,message:action === 'editInfoOn' ? 'Only admins can edit group info.' : 'Group info editing is open to members.'});
    }
    if (action === 'memberAddAll' || action === 'memberAddAdmins') {
      await sock.groupMemberAddMode(id, action === 'memberAddAdmins' ? 'admin_add' : 'all_member_add');
      return res.json({ok:true,message:action === 'memberAddAdmins' ? 'Only admins can add members.' : 'Members can add participants.'});
    }
    if (action === 'joinApprovalOn' || action === 'joinApprovalOff') {
      await sock.groupJoinApprovalMode(id, action === 'joinApprovalOn' ? 'on' : 'off');
      return res.json({ok:true,message:action === 'joinApprovalOn' ? 'Join approval enabled.' : 'Join approval disabled.'});
    }
    if (action.startsWith('ephemeral')) {
      const durations = {ephemeralOff:0,ephemeral24h:86400,ephemeral7d:604800,ephemeral90d:7776000};
      await sock.groupToggleEphemeral(id, durations[action]);
      return res.json({ok:true,message:action === 'ephemeralOff' ? 'Disappearing messages turned off.' : 'Disappearing messages set to '+action.replace('ephemeral','').replace('h',' hours').replace('d',' days')+'.'});
    }
    if (!meta.participants.some(p => jidNumber(p.id) === jidNumber(participant))) return res.status(404).json({error:'Member is not in this group.'});
    if (action === 'kick') {
      await sock.groupParticipantsUpdate(id, [participant], 'remove');
      return res.json({ok:true, message:'Removal request sent.'});
    }
    if (action === 'promote' || action === 'demote') {
      await sock.groupParticipantsUpdate(id, [participant], action);
      return res.json({ok:true,message:action === 'promote' ? 'Admin promotion requested.' : 'Admin demotion requested.'});
    }
    const key = id + ':' + participant, count = warnings.get(key) || 0;
    warnings.set(key, count + 1); saveState();
    await sock.sendMessage(id,{text:`⚠️ Warning ${count+1} for @${jidNumber(participant)}. Please follow group rules.`,mentions:[participant]});
    return res.json({ok:true,message:`Warning ${count+1} sent.`});
  } catch (e) { res.status(500).json({error:'Action failed. Check bot permissions and Railway logs.'}); }
});


app.get('/dashboard', (_req, res) => res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXBOT Group Control</title><style>
:root{color-scheme:dark;--bg:#07111f;--card:#101e30;--line:#2b3d52;--mint:#63f0c0;--muted:#9fb1c6}*{box-sizing:border-box}body{margin:0;padding:20px;background:var(--bg);color:#eef6ff;font:15px system-ui}.wrap{max-width:900px;margin:auto}h1{margin:0;font-size:26px}p,.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;margin:15px 0}.field,button,select{font:inherit;border-radius:10px;padding:12px;border:1px solid var(--line);background:#091524;color:#fff}input,select{width:100%;margin:7px 0 12px}button{cursor:pointer;background:var(--mint);color:#061820;font-weight:750;border:0;margin:4px 4px 4px 0}.secondary{background:#21344a;color:white;border:1px solid var(--line)}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:180px}.toggle{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--line);padding:12px;border-radius:12px;margin:9px 0}.toggle input{width:auto;margin:0}.member{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--line);padding:10px 0}.member small{display:block;color:var(--muted);overflow-wrap:anywhere}.notice{font-size:12px;color:#f4d89b}.status{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--mint)}</style></head><body><main class="wrap"><h1>🛡️ NEXBOT Group Control</h1><p>Manage one selected group on your existing linked WhatsApp session.</p><section class="card"><label>Private PANEL_KEY</label><input id="key" class="field" type="password" autocomplete="off" placeholder="Enter Railway PANEL_KEY"><div class="row"><button id="load">Load my WhatsApp groups</button><a href="/health" style="align-self:center;color:var(--mint)">Connection health ↗</a></div><p class="muted">Your key is saved on this device so you normally enter it only once. Do not share it.</p></section>
<section class="card" id="aiAssistantCard" hidden style="border:1px solid #477fc4;background:linear-gradient(135deg,#132b49,#101e30)">
<div class="cardhead"><div><h2 style="margin:0">🤖 NEXBOT AI Assistant</h2><div class="sub">OpenRouter Free AI · optional smart replies</div></div><span class="pill">AI</span></div>
<p class="muted">Use OpenRouter to power NEXBOT's AI replies. Your API key must stay private in Railway Variables as <code>OPENROUTER_API_KEY</code>. Do not paste it into this dashboard or chat. Free models can have usage limits or temporary availability issues.</p>
<div id="aiConnectionStatus" class="notice" role="status">Enter PANEL_KEY above, then check AI status.</div>
<div class="row"><button type="button" id="connectAI" style="flex:1;background:linear-gradient(90deg,#63f0c0,#7ab6ff);color:#061820">✨ OpenRouter AI Setup</button><button type="button" class="secondary" id="checkAI">Check AI status</button></div>
<label for="aiTestPrompt">Test AI reply</label><textarea id="aiTestPrompt" class="field" rows="2" maxlength="1000" placeholder="Ask a simple question to test the assistant"></textarea><button type="button" id="testAI">🧪 Test assistant now</button><div id="aiTestResult" class="status" role="status"></div>
<p class="notice">To enable replies, select a group below and turn on “Basic free assistant replies”. Keep any paid credits or upgrades disabled if you want to use only free models.</p>
</section>
<section class="card"><label>Select one group</label><select id="groups"><option value="">Load groups first</option></select><div id="groupInfo" class="muted">Choose a group to view settings and members.</div><div class="row"><button type="button" class="secondary" id="refreshAdmin">Refresh admin status</button></div><p class="notice">To make NEXBOT an admin: open this group in WhatsApp → tap the group name → participants → select NEXBOT → Make group admin. Only an existing group admin can do this.</p></section><section class="card"><h3>Moderation settings — selected group only</h3><label class="toggle">Anti-link <input type="checkbox" id="antiLink"></label><label class="toggle">Anti-spam <input type="checkbox" id="antiSpam"></label><label class="toggle">Welcome new members <input type="checkbox" id="welcome"></label><label class="toggle">Anti-flood <input type="checkbox" id="antiFlood"></label><label class="toggle">Anti-caps spam <input type="checkbox" id="antiCaps"></label><label class="toggle">Bad-word filter <input type="checkbox" id="badWords"></label><label class="toggle">Block all member media (images, videos, stickers, files) <input type="checkbox" id="blockMedia"></label><button id="save">Save settings for this group</button><p class="notice">Anti-link and anti-spam may delete messages; NEXBOT needs group admin rights. Changes do not apply to other groups.</p></section><section class="card" style="border:2px solid #63f0c0;background:linear-gradient(135deg,#123c3a,#101e30);text-align:center"><h2 style="margin:0 0 8px;font-size:26px">👑 Make NEXBOT Admin</h2><p class="muted">One tap sends a clear admin request to this selected WhatsApp group and mentions current admins. An existing admin still has to approve it in WhatsApp.</p><button id="makeAdmin" style="width:100%;padding:19px;font-size:20px;border-radius:16px;background:linear-gradient(90deg,#63f0c0,#7ab6ff);color:#061820">👑 MAKE ME ADMIN</button></section><section class="card"><h3>Group admin tools</h3><p class="muted">These actions affect only the selected group and require NEXBOT admin rights where indicated.</p><div class="row"><button class="secondary" data-groupact="getInviteCode">Get invite link</button><button class="secondary" data-groupact="revokeInvite" data-confirm="yes">Reset invite link</button></div><div class="row"><button class="secondary" data-groupact="announceOn" data-confirm="yes">Admins-only messages</button><button class="secondary" data-groupact="announceOff" data-confirm="yes">Allow all messages</button></div><div class="row"><button class="secondary" data-groupact="editInfoOn">Lock group info</button><button class="secondary" data-groupact="editInfoOff">Unlock group info</button><button class="secondary" data-groupact="getDescription">View group description</button></div><h4>Member-add permissions</h4><div class="row"><button class="secondary" data-groupact="memberAddAdmins">Admins add members</button><button class="secondary" data-groupact="memberAddAll">Allow members to add</button></div><h4>Join approvals</h4><div class="row"><button class="secondary" data-groupact="joinApprovalOn">Require join approval</button><button class="secondary" data-groupact="joinApprovalOff">Disable join approval</button></div><h4>Disappearing messages</h4><div class="row"><button class="secondary" data-groupact="ephemeralOff">Off</button><button class="secondary" data-groupact="ephemeral24h">24 hours</button><button class="secondary" data-groupact="ephemeral7d">7 days</button><button class="secondary" data-groupact="ephemeral90d">90 days</button></div></section><section class="card" style="border:2px solid #63a7ff"><h2 style="margin-top:0">✉️ Send WhatsApp Message</h2><p class="muted">Send a message from NEXBOT's linked WhatsApp account to one number. Enter the international country code, for example Pakistan: 923001234567. Only message people you are allowed to contact.</p><label>Recipient phone number (country code included)</label><input id="recipientNumber" class="field" inputmode="numeric" autocomplete="off" placeholder="923001234567"><label>Message</label><textarea id="outgoingMessage" class="field" rows="5" maxlength="4000" placeholder="Write your message here…"></textarea><button id="sendMessage" style="width:100%;padding:16px;font-size:17px">🚀 SEND WHATSAPP MESSAGE</button></section><section class="card"><h3>Members</h3><div id="members" class="muted">Select a group to load members.</div></section><div class="card status" id="status" role="status">Ready.</div></main><script>
const $=id=>document.getElementById(id);let groups=[];
function key(){return $('key').value.trim()}try{const savedKey=localStorage.getItem('nexbot_panel_key');if(savedKey)$('key').value=savedKey}catch{} $('key').addEventListener('change',()=>{try{if(key())localStorage.setItem('nexbot_panel_key',key())}catch{}}); $('key').addEventListener('input',()=>{try{if(key())localStorage.setItem('nexbot_panel_key',key())}catch{}});async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json','x-panel-key':key(),...(opts.headers||{})}});const d=await r.json().catch(()=>({error:'Unexpected server response'}));if(!r.ok)throw Error(d.error||'Request failed');return d}
function say(t){$('status').textContent=t}function chosen(){return $('groups').value}

async function loadGroups(){try{say('Loading groups from your existing WhatsApp connection…');const d=await api('/api/groups');groups=d.groups;const previous=localStorage.getItem('nexbot_selected_group')||chosen();$('groups').innerHTML='<option value="">Choose a group</option>'+groups.map(g=>'<option value="'+g.id+'">'+g.subject.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))+' ('+g.size+')</option>').join('');if(previous&&groups.some(g=>g.id===previous)){$('groups').value=previous;await loadSelected();say('Restored your selected group. Group controls are ready.');}else{localStorage.removeItem('nexbot_selected_group');say('Loaded '+groups.length+' groups. Choose a group once to open its controls.');}}catch(e){say(e.message)}}
async function loadSelected(){const id=chosen();if(!id)return;try{const d=await api('/api/groups/'+encodeURIComponent(id));$('antiLink').checked=d.settings.antiLink;$('antiSpam').checked=d.settings.antiSpam;$('welcome').checked=d.settings.welcome;$('antiFlood').checked=Boolean(d.settings.antiFlood);$('antiCaps').checked=Boolean(d.settings.antiCaps);$('badWords').checked=Boolean(d.settings.badWords);$('blockMedia').checked=Boolean(d.settings.blockMedia);$('aiReplies').checked=Boolean(d.settings.aiReplies);$('groupInfo').textContent=d.subject+' · '+d.size+' members · NEXBOT admin: '+(d.botIsAdmin?'YES':'NO');$('members').innerHTML=d.participants.map(p=>'<div class="member"><div>'+String(p.name).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))+'<small>'+p.id+(p.admin?' · '+p.admin:'')+'</small></div><div><button class="secondary" data-act="warn" data-id="'+p.id+'">Warn</button><button class="secondary" data-act="promote" data-id="'+p.id+'">Promote</button><button class="secondary" data-act="demote" data-id="'+p.id+'">Demote</button><button data-act="kick" data-id="'+p.id+'">Remove</button></div></div>').join('');say(d.botIsAdmin?'Admin verified for selected group.':'NEXBOT is not an admin yet. Promote it in WhatsApp, then tap Refresh admin status.');}catch(e){say(e.message)}}
$('sendMessage').onclick=async()=>{const number=$('recipientNumber').value.trim(),message=$('outgoingMessage').value.trim();if(!number||!message)return say('Enter a phone number and message first.');if(!confirm('Send this message from your linked WhatsApp account to +'+number+'?'))return;try{const d=await api('/api/send-message',{method:'POST',body:JSON.stringify({number,message})});say(d.message)}catch(e){say(e.message)}}; $('makeAdmin').onclick=async()=>{if(!chosen())return say('Select a WhatsApp group first.');if(!confirm('Send an admin request to the selected WhatsApp group and mention current admins?'))return;try{const d=await api('/api/groups/'+encodeURIComponent(chosen())+'/action',{method:'POST',body:JSON.stringify({action:'requestAdmin'})});say(d.message)}catch(e){say(e.message)}}; $('load').onclick=loadGroups;$('groups').onchange=()=>{const id=chosen();if(id)localStorage.setItem('nexbot_selected_group',id);else localStorage.removeItem('nexbot_selected_group');loadSelected();};$('refreshAdmin').onclick=loadSelected;$('save').onclick=async()=>{if(!chosen())return say('Select a group first.');try{const d=await api('/api/groups/'+encodeURIComponent(chosen())+'/settings',{method:'PATCH',body:JSON.stringify({antiLink:$('antiLink').checked,antiSpam:$('antiSpam').checked,welcome:$('welcome').checked,antiFlood:$('antiFlood').checked,antiCaps:$('antiCaps').checked,badWords:$('badWords').checked,blockMedia:$('blockMedia').checked})});say('Saved settings for this group only.');}catch(e){say(e.message)}};
$('members').onclick=async e=>{const b=e.target.closest('button[data-act]');if(!b)return;const action=b.dataset.act, participant=b.dataset.id;if(['kick','promote','demote'].includes(action)&&!confirm(action==='kick'?'Remove this member from the selected group?':action+' this member?'))return;try{const d=await api('/api/groups/'+encodeURIComponent(chosen())+'/action',{method:'POST',body:JSON.stringify({action,participant})});say(d.message);await loadSelected()}catch(err){say(err.message)}};
document.querySelectorAll('[data-groupact]').forEach(b=>b.onclick=async()=>{if(!chosen())return say('Select a group first.');if(b.dataset.confirm==='yes'&&!confirm('Apply '+b.textContent+' to this selected group?'))return;try{const d=await api('/api/groups/'+encodeURIComponent(chosen())+'/action',{method:'POST',body:JSON.stringify({action:b.dataset.groupact})});say(d.message)}catch(e){say(e.message)}});
</script></body></html>`));

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
async function checkAI(){const el=document.getElementById('aiConnectionStatus');if(!key()){el.textContent='Enter PANEL_KEY in the field at the top first.';return;}try{const d=await api('/api/ai-status');el.textContent=d.configured?'✅ OpenRouter key detected. Model: '+(d.model||'free router')+'. Free-model limits apply.':'ℹ️ OPENROUTER_API_KEY missing in Railway Variables; add it privately and redeploy.';}catch(e){el.textContent='AI status check failed: '+e.message}}
document.getElementById('connectAI').addEventListener('click',()=>{window.open('https://openrouter.ai/keys','_blank','noopener');showMessage('OpenRouter opened. Add the key only in Railway Variables as OPENROUTER_API_KEY.');});
document.getElementById('checkAI').addEventListener('click',checkAI);
document.getElementById('testAI').addEventListener('click',async()=>{const out=document.getElementById('aiTestResult'),prompt=document.getElementById('aiTestPrompt').value.trim();if(!key()){out.textContent='Enter PANEL_KEY at the top first.';return;}if(!prompt){out.textContent='Type a question first.';return;}out.textContent='Testing free AI…';try{const d=await api('/api/ai-test',{method:'POST',body:JSON.stringify({prompt})});out.textContent='AI reply ('+d.model+'):\\n'+d.answer;}catch(e){out.textContent='AI test failed: '+e.message}});
checkAI();

document.getElementById('connect').addEventListener('click',()=>{const key=keyInput.value.trim();if(!key){showMessage('Enter your PANEL_KEY from Railway Variables first.');keyInput.focus();return;}showMessage('Opening protected QR pairing page…');window.open('/qr?key='+encodeURIComponent(key),'_blank','noopener');});
let chatAfter=0, chatGroup='';
function escChat(v){return String(v||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function loadGroupChat(reset=false){
 const id=document.getElementById('groups')?.value;
 const feed=document.getElementById('chatFeed');
 if(!id){feed.innerHTML='<div class="muted">Select a group to load messages.</div>';return;}
 if(reset||id!==chatGroup){chatGroup=id;chatAfter=0;feed.innerHTML='<div class="muted">Loading messages…</div>';}
 try{
  const d=await api('/api/groups/'+encodeURIComponent(id)+'/messages?after='+(reset?0:chatAfter));
  if(reset)feed.innerHTML='';
  for(const m of (d.messages||[])){
   const tm=new Date(m.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
   const node=document.createElement('div');
   node.style.cssText='padding:9px 11px;border-radius:12px;background:'+(m.fromMe?'#123c3a':'#14263a')+';max-width:95%;align-self:'+(m.fromMe?'flex-end':'flex-start')+';overflow-wrap:anywhere';
   node.innerHTML='<strong>'+escChat(m.sender)+'</strong><small style="float:right;color:#9fb1c6;margin-left:12px">'+escChat(tm)+'</small><div style="white-space:pre-wrap;margin-top:5px">'+escChat(m.text)+'</div>';
   feed.appendChild(node);chatAfter=Math.max(chatAfter,Number(m.time)||0);
  }
  if(!feed.children.length)feed.innerHTML='<div class="muted">No new messages recorded yet. Keep NEXBOT online to receive new messages.</div>';
  feed.scrollTop=feed.scrollHeight;
 }catch(e){feed.innerHTML='<div class="muted">'+escChat(e.message)+'</div>';}
}
document.getElementById('groups')?.addEventListener('change',()=>loadGroupChat(true));
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

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = 'openrouter/free';
const aiLastRequest = new Map();
async function freeModelReply(prompt) {
  if (!OPENROUTER_API_KEY || typeof fetch !== 'function') return '';
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'X-Title': 'NEXBOT' },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'system', content: 'You are NEXBOT, a helpful and safe WhatsApp group assistant. Reply concisely, respectfully, and in the language used by the user. Do not claim to be a human, reveal secrets, or execute admin actions. If unsure, say so.' }, { role: 'user', content: prompt.slice(0, 1500) }],
        temperature: 0.4,
        max_tokens: 180
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenRouter free AI unavailable; using local fallback');
      return '';
    }
    const data = await response.json();
    return String(data.choices?.[0]?.message?.content || '').trim().slice(0, 1200);
  } catch (e) {
    logger.warn({ err: String(e) }, 'OpenRouter request failed; using local fallback');
    return '';
  }
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || msg.key.fromMe) return;
  const sender = msg.key.participant || msg.key.remoteJid;
  const media = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.stickerMessage || msg.message?.documentMessage || msg.message?.audioMessage || msg.message?.ptvMessage || msg.message?.contactMessage || msg.message?.locationMessage;
  const text = (msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '').trim();
  const isGroup = jid.endsWith('@g.us');
  if (isGroup && !msg.key.fromMe) {
    const senderName = msg.pushName || jidNumber(sender) || 'Group member';
    const visibleText = text || (media ? '[Media message blocked/received]' : '[Non-text message]');
    rememberGroupMessage(jid, {id:msg.key.id || String(Date.now()),time:Number(msg.messageTimestamp || Math.floor(Date.now()/1000))*1000,sender:senderName,text:visibleText,fromMe:false});
  }
  if (isGroup && media && groupSettings(jid).blockMedia) {
    try { await sock.sendMessage(jid, { delete: msg.key }); await send(jid, '🛡️ Only text chat is allowed here. Photos, videos, stickers, files, contacts and locations are blocked.'); }
    catch (e) { logger.warn({err:String(e)}, 'Could not remove blocked media; NEXBOT may need group admin rights'); }
    return;
  }
  if (!text) return;
  const senderIsAdmin = isGroup ? await isAdmin(jid, sender) : false;

  const groupConfig = isGroup ? groupSettings(jid) : settings;
  if (isGroup && groupConfig.antiLink &&
      /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|\b[a-z0-9-]+\.(?:com|net|org|pk|io|co|me|ly|gg|xyz|info|biz)\b)/i.test(text)) {
    try {
      await sock.sendMessage(jid, { delete: msg.key });
      await send(jid, '⚠️ Link removed. Please ask an admin before sharing links.');
    } catch (e) { logger.warn({ err: String(e) }, 'Could not remove link; bot may need admin permission'); }
    return;
  }

  if (isGroup) {
    const lowerText = text.toLowerCase();
    const blockedTerms = [
      '18+', 'xxx', 'xxxxxx', 'sexy', 'sex', 'porn', 'nude', 'adult content',
      'buy now', 'sell', 'for sale', 'order now', 'business offer', 'investment',
      'earn money', 'marketing', 'promotion', 'contact me', 'dm me', 'inbox me',
      'whatsapp me', 'call me', 'deal', 'discount', 'shop now'
    ];
    const phoneLike = /(?:^|\\D)(?:\\+?\\d[\\s().-]*){9,15}(?:$|\\D)/.test(text);
    const businessLike = blockedTerms.some(term => lowerText.includes(term));
    if ((groupConfig.badWords && blockedTerms.some(term => lowerText.includes(term))) || phoneLike || businessLike) {
      try { await sock.sendMessage(jid, { delete: msg.key }); await send(jid, '🛡️ Group rule: only normal text chat is allowed. Links, phone numbers, adult/sexual words and business promotions are not allowed.'); }
      catch (e) { logger.warn({err:String(e)}, 'Could not remove restricted text; NEXBOT may need group admin rights'); }
      return;
    }
  }

  if (isGroup && groupConfig.antiSpam) {
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

  if (isGroup && !senderIsAdmin) {
    const groupKey = jid + ':' + sender;
    const now = Date.now();
    const recent = (recentMessages.get(groupKey) || []).filter(t => now - t < 10000);
    recent.push(now);
    recentMessages.set(groupKey, recent);
    if (groupConfig.antiFlood && recent.length >= 8) {
      try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
      await send(jid, '🛡️ Anti-flood: please slow down.');
      recentMessages.set(groupKey, []);
      return;
    }
    if (groupConfig.antiCaps && text.length >= 12 && text === text.toUpperCase() && /[A-Z]/.test(text)) {
      try { await sock.sendMessage(jid, { delete: msg.key }); await send(jid, '⚠️ Please avoid all-caps messages.'); } catch {}
      return;
    }
    if (groupConfig.badWords) {
      const blocked = (process.env.BLOCKED_WORDS || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
      if (blocked.some(w => text.toLowerCase().includes(w))) {
        try { await sock.sendMessage(jid, { delete: msg.key }); await send(jid, '⚠️ Message removed because it matched this group’s word filter.'); } catch {}
        return;
      }
    }
  }
  if (false && groupConfig.aiReplies && !text.startsWith(PREFIX)) {
    const q = text.toLowerCase();
    let answer = '';
    if (['hi','hello','salam','assalam','aoa'].some(word => q === word || q.startsWith(word + ' '))) answer = '👋 Hello! I am NEXBOT group assistant. Ask a clear question, or send !help for commands.';
    else if (q.includes('who are you') || q.includes('your name')) answer = '🤖 I am NEXBOT, your group assistant and moderator.';
    else if (q.includes('group rules') || q.includes('who is admin')) answer = '🛡️ Please follow this group’s rules. For group-specific decisions, contact a group admin.';
    else if (q.includes('2+2') || q.includes('2 + 2')) answer = '🧮 2 + 2 = 4';
    const asksAssistant = /\bnexbot\b/i.test(text) || text.includes('?') || /^(what|why|how|when|where|who|can you|please explain|explain|translate|define)\b/i.test(text);
    if (!answer && asksAssistant && OPENROUTER_API_KEY) {
      const now = Date.now(), last = aiLastRequest.get(jid) || 0;
      if (now - last >= 4000) {
        aiLastRequest.set(jid, now);
        answer = await freeModelReply(text);
      }
    }
    if (answer) { try { await send(jid, answer); } catch (e) { logger.warn({err:String(e)}, 'Assistant reply failed'); } }
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
      settings.groups ||= {};
      settings.groups[jid] = { ...groupSettings(jid), [command === 'antilink' ? 'antiLink' : command === 'antispam' ? 'antiSpam' : 'welcome']: value === 'on' };
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
      if (action !== 'add' || !groupSettings(id).welcome) return;
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

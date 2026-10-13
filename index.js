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
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

let sock = null, latestQR = '', connected = false, connectionState = 'starting';
let lastDisconnect = null, starting = false, reconnectTimer = null, startedAt = Date.now();
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
function scheduleReconnect(reason = 'connection closed') {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts += 1;
  const delay = Math.min(RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempts - 1, 5)), RECONNECT_MAX_MS);
  connectionState = 'reconnecting';
  logger.warn({ reason, attempt: reconnectAttempts, delayMs: delay }, 'Scheduling WhatsApp reconnect');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    starting = false;
    void startBot();
  }, delay);
  reconnectTimer.unref?.();
}
let settings = { antiLink: true, antiSpam: true, welcome: true, privateProtection: true, groups: {}, warnings: {}, rules: {}, customReplies: {}, blockedWords: {}, managedGroupId: '', textOnly: true, blockPhoneNumbers: true, blockBusinessPromo: true, deleteMedia: true };
let messageCount = 0, commandCount = 0, lastMessageAt = null;
const recentMessages = new Map(), privateReplyAt = new Map(), commandCooldown = new Map();
const cooldown = (key, ms) => { const now=Date.now(), prev=commandCooldown.get(key)||0; if(now-prev<ms) return false; commandCooldown.set(key,now); return true; };
try {
  if (fs.existsSync(STATE_FILE)) {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    settings = { ...settings, ...(s.settings || {}), groups: s.settings?.groups || {}, warnings: s.settings?.warnings || {}, rules: s.settings?.rules || {}, customReplies: s.settings?.customReplies || {}, blockedWords: s.settings?.blockedWords || {}, managedGroupId: s.settings?.managedGroupId || '', textOnly: s.settings?.textOnly !== false, blockPhoneNumbers: s.settings?.blockPhoneNumbers !== false, blockBusinessPromo: s.settings?.blockBusinessPromo !== false, deleteMedia: s.settings?.deleteMedia !== false };
  }
} catch (e) { logger.warn({ err: String(e) }, 'Could not load saved settings'); }
function saveState() {
  try { const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ settings }, null, 2)); fs.renameSync(tmp, STATE_FILE); }
  catch (e) { logger.error({ err: String(e) }, 'Could not save state'); }
}
function auth(req, res, next) {
  if (!PANEL_KEY) return res.status(503).json({ error: 'PANEL_KEY is not configured. Set it in Railway Variables.' });
  const provided = req.get('x-panel-key'); // Never accept panel secrets in URLs or request bodies.
  if (typeof provided !== 'string' || provided.length !== PANEL_KEY.length || !cryptoSafeEqual(provided, PANEL_KEY))
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function cryptoSafeEqual(a,b) {
  const { timingSafeEqual } = requireCrypto;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
import { timingSafeEqual as timingEqual } from 'node:crypto';
const requireCrypto = { timingSafeEqual: timingEqual };
const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
app.get('/health', (_req,res) => res.json({ ok:true, service:'NEXBOT Pro', state:connectionState, connected, uptimeSeconds:Math.floor((Date.now()-startedAt)/1000), messageCount, commandCount, lastMessageAt, lastDisconnect }));
app.get('/api/status', auth, (_req,res) => res.json({ service:'NEXBOT Pro', state:connectionState, connected, qrAvailable:!!latestQR, uptimeSeconds:Math.floor((Date.now()-startedAt)/1000), messageCount, commandCount, lastMessageAt, lastDisconnect, settings }));
app.get('/api/groups', auth, async (_req,res) => {
  if (!sock || !connected) return res.status(503).json({ error:'WhatsApp is not connected yet. Pair the account first.', connected:false, groups:[] });
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all || {}).map(g => ({
      id: g.id,
      subject: g.subject || 'Unnamed group',
      size: Array.isArray(g.participants) ? g.participants.length : 0,
      desc: g.desc || '',
      announce: !!g.announce,
      restrict: !!g.restrict,
      isCommunity: !!g.isCommunity,
      participants: (g.participants || []).map(p => ({ id:p.id, name:p.name || p.notify || p.id, admin:p.admin || '' }))
    })).sort((a,b) => a.subject.localeCompare(b.subject));
    res.json({ connected:true, count:groups.length, groups });
  } catch (e) {
    logger.warn({ err:String(e) }, 'Could not fetch WhatsApp groups');
    res.status(502).json({ error:'Could not load groups from WhatsApp. Refresh and try again.' });
  }
});
app.post('/api/group-control', auth, async (req,res) => {
  if (!sock || !connected) return res.status(503).json({ error:'WhatsApp is not connected.' });
  const { groupId, action, value, targetIds } = req.body || {};
  if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) return res.status(400).json({ error:'Select a valid group first.' });
  const allowed = ['subject','description','announcement','member-messaging','edit-info','invite','revoke-invite','promote','demote','remove'];
  if (!allowed.includes(action)) return res.status(400).json({ error:'Unsupported group action.' });
  try {
    const meta = await sock.groupMetadata(groupId);
    const botId = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    if (!isAdmin(meta, botId)) return res.status(403).json({ error:'Make the bot an admin in this group first.' });
    let result = { ok:true, action };
    if (action === 'subject') {
      if (typeof value !== 'string' || !value.trim()) return res.status(400).json({error:'Group name is required.'});
      await sock.groupUpdateSubject(groupId, value.trim().slice(0,100));
    } else if (action === 'description') {
      if (typeof value !== 'string') return res.status(400).json({error:'Group description is required.'});
      await sock.groupUpdateDescription(groupId, value.slice(0,2048));
    } else if (action === 'announcement') {
      if (!['on','off'].includes(value)) return res.status(400).json({error:'Use on or off.'});
      await sock.groupSettingUpdate(groupId, value === 'on' ? 'announcement' : 'not_announcement');
    } else if (action === 'member-messaging') {
      if (!['on','off'].includes(value)) return res.status(400).json({error:'Use on or off.'});
      await sock.groupSettingUpdate(groupId, value === 'on' ? 'unlocked' : 'locked');
    } else if (action === 'edit-info') {
      if (!['admins','all'].includes(value)) return res.status(400).json({error:'Use admins or all.'});
      await sock.groupSettingUpdate(groupId, value === 'admins' ? 'locked' : 'unlocked');
    } else if (action === 'invite') {
      result.inviteCode = await sock.groupInviteCode(groupId);
    } else if (action === 'revoke-invite') {
      await sock.groupRevokeInvite(groupId);
    } else {
      const ids = Array.isArray(targetIds) ? [...new Set(targetIds.filter(x => typeof x === 'string' && /^\d+@s\.whatsapp\.net$/.test(x)))].slice(0,10) : [];
      if (!ids.length) return res.status(400).json({error:'Select one or more valid member IDs.'});
      const method = action === 'promote' ? 'promote' : action === 'demote' ? 'demote' : 'remove';
      await sock.groupParticipantsUpdate(groupId, ids, method);
    }
    res.json(result);
  } catch (e) {
    logger.warn({ err:String(e), action, groupId }, 'Group control action failed');
    res.status(502).json({ error:'WhatsApp rejected this action or the operation failed. Check bot admin rights and group permissions.' });
  }
});
app.get('/api/qr', auth, async (_req,res) => {
  if (connected) return res.json({ connected:true, message:'WhatsApp is already connected.' });
  if (!latestQR) return res.status(404).json({ connected:false, state:connectionState, message:'QR not available yet. Refresh shortly and check runtime logs.' });
  try { res.json({ connected:false, qr: await QRCode.toDataURL(latestQR), state:connectionState }); }
  catch { res.status(500).json({ error:'QR generation failed' }); }
});
app.post('/api/settings', auth, (req,res) => {
  const allowed = ['antiLink','antiSpam','welcome','privateProtection','textOnly','blockPhoneNumbers','blockBusinessPromo','deleteMedia'];
  for (const key of allowed) if (typeof req.body?.[key] === 'boolean') settings[key] = req.body[key];
  if (typeof req.body?.managedGroupId === 'string' && (req.body.managedGroupId === '' || req.body.managedGroupId.endsWith('@g.us'))) settings.managedGroupId = req.body.managedGroupId;
  saveState(); res.json({ ok:true, settings });
});
app.get('/dashboard', (_req,res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXBOT Pro • Control Center</title><style>
:root{color-scheme:dark;--bg:#070b12;--panel:#101823;--line:#233142;--muted:#8ea2b7;--green:#25e6a2;--blue:#4d8dff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 12% 0%,#102b2a 0,transparent 32%),radial-gradient(ellipse at 100% 10%,#14213b 0,transparent 30%),var(--bg);color:#edf6f8;font:15px Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.1px}main{max-width:1180px;margin:auto;padding:clamp(14px,3vw,34px)}.hero{position:relative;overflow:hidden;padding:clamp(22px,4vw,38px);border:1px solid #25433f;border-radius:28px;background:linear-gradient(120deg,rgba(20,49,48,.96),rgba(14,23,39,.98) 70%);box-shadow:0 20px 60px #0005}.hero:after{content:'N';position:absolute;right:28px;top:-42px;font-size:190px;font-weight:900;color:#25e6a2;opacity:.055;pointer-events:none}h1{margin:0;font-size:clamp(29px,5vw,42px);letter-spacing:-1.5px;font-weight:850}h1:before{content:'●';color:var(--green);font-size:17px;vertical-align:middle;margin-right:12px;text-shadow:0 0 20px #25e6a2}h3{margin:0 0 10px;font-size:17px;letter-spacing:-.3px}h4{margin:0 0 8px}p{color:#a9bdca;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px;margin-top:18px}.card{grid-column:span 6;min-width:0;padding:22px;border-radius:20px;background:linear-gradient(145deg,rgba(17,27,40,.98),rgba(12,19,30,.98));border:1px solid var(--line);box-shadow:0 10px 30px #0002;transition:border-color .2s,transform .2s}.card:hover{border-color:#365c5b}.card[style*='grid-column:1/-1']{grid-column:1/-1}#groupControls .grid{grid-template-columns:repeat(2,minmax(0,1fr))}#groupControls .card{grid-column:auto}.hero #status{display:inline-block;margin-top:12px;padding:10px 14px;border:1px solid #2b4b47;border-radius:12px;background:#071c1a;color:#b9f8df;font-size:14px}label{display:block;color:#c4d3df;line-height:1.7;margin-top:8px}input,button,select{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid #2a3b4d;background:#09111b;color:#f4fbff;width:100%;margin-top:8px;outline:none}input:focus,select:focus{border-color:var(--green);box-shadow:0 0 0 3px #25e6a21c}input[type=checkbox]{accent-color:var(--green);width:17px!important;height:17px;vertical-align:middle;margin-right:9px}button{cursor:pointer;background:linear-gradient(135deg,#25dca0,#11b981);border:0;color:#062118;font-weight:800;box-shadow:0 5px 16px #25e6a21c;transition:transform .15s,filter .15s}button:hover{filter:brightness(1.08);transform:translateY(-1px)}button:active{transform:translateY(0)}.muted{font-size:13px;color:var(--muted)}pre{white-space:pre-wrap;word-break:break-word;color:#c0d5e2;background:#09111b;border:1px solid #243547;padding:14px;border-radius:12px;line-height:1.9}#groups button{background:#111f2a!important;color:#e9f8f4;border:1px solid #2a4148;text-align:left}#groups button:hover{border-color:var(--green)!important}.feature-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}.feature{display:flex;flex-direction:column;gap:7px;padding:14px;border:1px solid #263848;border-radius:14px;background:#0a131d;min-width:0}.feature b{font-size:13px}.feature small{color:var(--muted);line-height:1.4}.dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#536273;box-shadow:0 0 0 4px #53627322}.dot.on{background:var(--green);box-shadow:0 0 0 4px #25e6a222,0 0 14px #25e6a2}.dot.off{background:#687789}.dot.pending{background:#f4bd50;box-shadow:0 0 0 4px #f4bd5022}.state-pill{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;background:#0a1916;border:1px solid #285247;color:#b9f8df;font-size:12px;font-weight:800}.primary-action{min-height:48px;letter-spacing:.1px}#qr img{display:block;margin-top:14px}a{color:var(--green)}@media(max-width:680px){.feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:12px}.grid{grid-template-columns:1fr;gap:12px}.card,.card[style*='grid-column:1/-1']{grid-column:1/-1;padding:18px}.hero{border-radius:20px}#groupControls .grid{grid-template-columns:1fr}#groupControls .card{grid-column:1/-1}.hero:after{font-size:120px;right:8px;top:-10px}}
/* NEXBOT Pro v2 visual system */
:root{--bg:#090b10;--panel:#131722;--line:#282d3c;--muted:#9299ad;--green:#b8ff28;--blue:#6d9cff}
body{background:#090b10;background-image:radial-gradient(ellipse at 78% -10%,#1d2c3a 0,transparent 42%),radial-gradient(ellipse at 0% 45%,#13251f 0,transparent 28%);font-family:Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:0}
main{max-width:1440px;padding:clamp(14px,2.4vw,34px)}
.hero{border-radius:24px;border:1px solid #303849;background:linear-gradient(115deg,#171e2a 0%,#111820 56%,#16261c 100%);box-shadow:0 24px 70px #0006;padding:clamp(24px,4vw,44px)}
.hero:after{content:'NEX';font-size:clamp(100px,18vw,220px);right:2%;top:-18%;color:var(--green);opacity:.035;letter-spacing:-.1em}
h1{font-size:clamp(32px,4.5vw,52px);letter-spacing:-2px}h1:before{content:'✳';font-size:24px;color:var(--green)}
.grid{gap:14px}.card{border-radius:18px;border-color:#272d3a;background:linear-gradient(145deg,#151a26,#10141d);padding:22px;box-shadow:0 14px 35px #0003}.card:hover{border-color:#62713e;transform:translateY(-1px)}
button{background:linear-gradient(115deg,#c5ff32,#8be51b);color:#111807;border-radius:12px;min-height:44px;box-shadow:0 6px 22px #aaff2518}button:hover{filter:brightness(1.06)}
input,select,pre{background:#0b0f17;border-color:#30394a;border-radius:11px}input:focus,select:focus{border-color:var(--green);box-shadow:0 0 0 3px #b8ff2817}
.hero #status{background:#0d1715;border-color:#34483b;border-radius:13px;padding:13px 15px;max-width:100%}.state-pill{background:#111a12;border-color:#3a5125;color:#d7ff9a}
.feature{background:#0c1119;border-color:#29303d;border-radius:13px;padding:15px}.dot.on{background:var(--green);box-shadow:0 0 0 4px #b8ff2817,0 0 15px #b8ff2840}
#groups button{background:#111722!important;border-color:#2d3545!important;border-radius:11px;padding:12px 14px}#groups button:hover{border-color:var(--green)!important}
#groupControls .card{background:#0d131c;border-color:#293342}#qr img{box-shadow:0 10px 40px #0008;border:5px solid white}
@media(min-width:900px){.hero{display:block}.grid>.card{min-height:190px}.feature-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:680px){.hero{padding:23px 19px}.card{padding:18px}.feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}h1{letter-spacing:-1px}}
</style></head><body><main><section class="hero"><h1>⚡ NEXBOT Pro</h1><p>LIVE AUTOMATION WORKSPACE &nbsp;·&nbsp; WhatsApp operations, group security and bot intelligence</p><div id="status">Enter your private panel key to load status.</div></section><section class="card" style="margin-top:18px"><h3>System pulse</h3><p class="muted">These indicators come from the bot status API. Green means active/connected; grey means off or not selected.</p><div id="features" class="feature-grid"><div class="feature"><span class="dot pending"></span><b>WhatsApp connection</b><small>Connect dashboard to check live status</small></div><div class="feature"><span class="dot pending"></span><b>Group moderation</b><small>Waiting for status</small></div></div></section><section class="grid"><div class="card"><h3>01 / Secure access</h3><label>Panel key</label><input id="key" type="password" autocomplete="off" placeholder="Railway PANEL_KEY"><button class="primary-action" onclick="startLiveStatus()">✦ Connect dashboard & start live status</button><p class="muted">The key is used only for requests in this page; never share it.</p></div><div class="card"><h3>02 / WhatsApp link</h3><button class="primary-action" onclick="loadQR()">◉ Show WhatsApp pairing status</button><div id="qr"></div></div><div class="card" style="grid-column:1/-1"><h3>03 / Group operations</h3><p class="muted">Load connected groups, inspect members and run admin actions. The bot must be a group admin.</p><button class="primary-action" onclick="loadGroups()">↻ Refresh WhatsApp groups</button><div id="groups" class="muted">Connect the dashboard first, then load groups.</div><div id="groupControls"></div></div><div class="card"><h3>04 / Safety automations</h3><p class="muted">Choose one group above, then click “Manage this group only”. Other groups will be ignored by content moderation.</p><label><input id="antiLink" type="checkbox" style="width:auto"> Block links</label><label><input id="antiSpam" type="checkbox" style="width:auto"> Anti-spam</label><label><input id="welcome" type="checkbox" style="width:auto"> Welcome messages</label><label><input id="textOnly" type="checkbox" style="width:auto"> Text-only: block photos, videos, audio, files, stickers, contacts, locations and polls</label><label><input id="blockPhoneNumbers" type="checkbox" style="width:auto"> Block phone-number-like text</label><label><input id="blockBusinessPromo" type="checkbox" style="width:auto"> Block common business/promo words</label><label><input id="deleteMedia" type="checkbox" style="width:auto"> Delete violations when bot is admin</label><button onclick="saveSettings()">Save safety settings</button></div><div class="card"><h3>05 / Command console</h3><pre>!help !ping !menu
!rules !admins !groupinfo
!kick @user (admin)
!promote @user (admin)
!demote @user (admin)
!tagall (admin)
!antilink on|off (admin)
!antispam on|off (admin)</pre></div></section><p class="muted">Health endpoint: /health · Prefix: ${esc(PREFIX)} · Do not expose panel key.</p></main><script>
let key='';function headers(){return {'Content-Type':'application/json','x-panel-key':key}}async function loadStatus(){if(document.getElementById('key').value)key=document.getElementById('key').value;try{let r=await fetch('/api/status',{headers:headers(),cache:'no-store'});let d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');document.getElementById('status').innerHTML='<span class="state-pill"><span class="dot '+(d.connected?'on':'off')+'"></span> WhatsApp '+(d.connected?'CONNECTED':'DISCONNECTED')+'</span><br><br><b>Runtime:</b> '+escapeHtml(d.state)+' · <b>Messages:</b> '+d.messageCount+' · <b>Commands:</b> '+d.commandCount+' · <b>Uptime:</b> '+Math.floor(d.uptimeSeconds/60)+' min';const s=d.settings||{};const items=[['WhatsApp connection',d.connected?'Connected':'Not connected',!!d.connected],['Selected group',s.managedGroupId?'Group selected':'No group selected',!!s.managedGroupId],['Text-only moderation',s.textOnly?'Enabled':'Disabled',!!s.textOnly],['Link blocking',s.antiLink?'Enabled':'Disabled',!!s.antiLink],['Anti-spam',s.antiSpam?'Enabled':'Disabled',!!s.antiSpam],['Phone-number filter',s.blockPhoneNumbers?'Enabled':'Disabled',!!s.blockPhoneNumbers],['Business promo filter',s.blockBusinessPromo?'Enabled':'Disabled',!!s.blockBusinessPromo],['Delete violations',s.deleteMedia?'Enabled':'Disabled',!!s.deleteMedia],['Welcome messages',s.welcome?'Enabled':'Disabled',!!s.welcome]];document.getElementById('features').innerHTML=items.map(x=>'<div class="feature"><span class="dot '+(x[2]?'on':'off')+'"></span><b>'+x[0]+'</b><small>'+x[1]+'</small></div>').join('');for(let k of ['antiLink','antiSpam','welcome','textOnly','blockPhoneNumbers','blockBusinessPromo','deleteMedia'])document.getElementById(k).checked=!!s[k];}catch(e){document.getElementById('status').textContent=e.message}}
let groupCache=[];async function loadGroups(){if(!key)key=document.getElementById('key').value;let el=document.getElementById('groups');el.textContent='Loading groups from WhatsApp…';try{let r=await fetch('/api/groups',{headers:headers()});let d=await r.json();if(!r.ok)throw Error(d.error||'Could not load groups');groupCache=d.groups||[];if(!groupCache.length){el.textContent='No groups returned. Confirm WhatsApp is connected.';return}el.innerHTML='<p><b>'+d.count+' groups found</b></p>'+groupCache.map((g,i)=>'<button style="text-align:left;background:#17233d;margin:5px 0" onclick="selectGroup('+i+')">'+(i+1)+'. '+escapeHtml(g.subject)+' · '+g.size+' members</button>').join('')}catch(e){el.textContent=e.message}}function selectGroup(i){let g=groupCache[i];if(!g)return;let c=document.getElementById('groupControls');c.innerHTML='<h3>'+escapeHtml(g.subject)+'</h3><p class="muted">'+g.size+' members · '+escapeHtml(g.id)+'</p><button onclick="setManagedGroup('+i+')">Manage this group only</button><div class="grid"><div class="card"><h4>Group settings</h4><button onclick="runGroupAction(\'subject\',prompt(\'New group name\', '+JSON.stringify('Group')+'))">Change name</button><button onclick="runGroupAction(\'description\',prompt(\'New group description\'))">Change description</button><button onclick="runGroupAction(\'announcement\',confirm(\'Only admins should send messages? OK=ON, Cancel=OFF\')?\'on\':\'off\')">Admin-only messages toggle</button><button onclick="runGroupAction(\'member-messaging\',confirm(\'Allow all members to message? OK=YES, Cancel=NO\')?\'on\':\'off\')">Member messaging toggle</button><button onclick="runGroupAction(\'invite\')">Get invite link</button><button onclick="runGroupAction(\'revoke-invite\')">Revoke invite link</button></div><div class="card"><h4>Member management</h4><p class="muted">Select a member below, then choose an action.</p><select id="memberSelect" style="width:100%;padding:10px;background:#0b1020;color:white;border-radius:8px">'+g.participants.map(p=>'<option value="'+escapeHtml(p.id)+'">'+escapeHtml(p.name)+' '+(p.admin?'· '+p.admin:'')+'</option>').join('')+'</select><button onclick="runGroupAction(\'promote\',null,[document.getElementById(\'memberSelect\').value])">Promote member</button><button onclick="runGroupAction(\'demote\',null,[document.getElementById(\'memberSelect\').value])">Demote admin</button><button onclick="if(confirm(\'Remove selected member from group?\'))runGroupAction(\'remove\',null,[document.getElementById(\'memberSelect\').value])">Remove member</button></div></div>'}async function runGroupAction(action,value,targetIds){let g=groupCache.find(x=>x.id===document.querySelector('#groupControls p.muted')?.textContent?.split(' · ').pop());if(!g){const title=document.querySelector('#groupControls h3')?.textContent;g=groupCache.find(x=>x.subject===title)}if(!g){alert('Select a group first');return}try{let r=await fetch('/api/group-control',{method:'POST',headers:headers(),body:JSON.stringify({groupId:g.id,action,value,targetIds})});let d=await r.json();if(!r.ok)throw Error(d.error||'Action failed');alert(d.inviteCode?'Invite link: https://chat.whatsapp.com/'+d.inviteCode:'Action completed: '+action);if(['promote','demote','remove'].includes(action))loadGroups()}catch(e){alert(e.message)}}function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function loadQR(){if(!key)key=document.getElementById('key').value;let el=document.getElementById('qr');try{let r=await fetch('/api/qr',{headers:headers()});let d=await r.json();if(d.qr)el.innerHTML='<img alt="WhatsApp pairing QR" style="width:100%;max-width:260px;background:white;padding:8px;border-radius:10px" src="'+d.qr+'">';else el.textContent=d.message||'Connected or waiting for QR';}catch(e){el.textContent=e.message}}
async function setManagedGroup(i){let g=groupCache[i];if(!g)return;try{let r=await fetch('/api/settings',{method:'POST',headers:headers(),body:JSON.stringify({managedGroupId:g.id})});let d=await r.json();if(!r.ok)throw Error(d.error);alert('Selected group only: '+g.subject+'\\nOther groups will not be moderated by the text-only policy.');}catch(e){alert(e.message)}}async function saveSettings(){try{let b={};for(let k of ['antiLink','antiSpam','welcome','textOnly','blockPhoneNumbers','blockBusinessPromo','deleteMedia'])b[k]=document.getElementById(k).checked;let r=await fetch('/api/settings',{method:'POST',headers:headers(),body:JSON.stringify(b)});let d=await r.json();if(!r.ok)throw Error(d.error);alert('Safety settings saved');await loadStatus();}catch(e){alert(e.message)}}
let statusTimer=null;function startLiveStatus(){if(statusTimer)clearInterval(statusTimer);loadStatus();statusTimer=setInterval(()=>{if(key)loadStatus()},5000)}
</script></body></html>`));

const groupDefaults = { antiLink: settings.antiLink, antiSpam: settings.antiSpam, welcome: settings.welcome };
function groupSettings(id) { return { ...groupDefaults, ...(settings.groups[id] || {}) }; }
function warnKey(groupId, userId) { return groupId + '|' + userId; }
function getWarnings(groupId,userId) { return settings.warnings[warnKey(groupId,userId)] || []; }
function addWarning(groupId,userId,by,reason) { const k=warnKey(groupId,userId); const arr=getWarnings(groupId,userId); arr.push({by,reason:reason||'No reason provided',at:new Date().toISOString()}); settings.warnings[k]=arr.slice(-20); saveState(); return settings.warnings[k]; }
function parseTargets(msg) { return [...new Set([...mentionedJids(msg), ...(msg.message?.extendedTextMessage?.contextInfo?.participant ? [msg.message.extendedTextMessage.contextInfo.participant] : [])])]; }
function isAdmin(meta, jid) { return meta?.participants?.some(p => p.id === jid && (p.admin === 'admin' || p.admin === 'superadmin')); }
function mentionedJids(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || {};
  return ctx.mentionedJid || [];
}
async function sendText(jid, text, quoted) { if (sock && connected) return sock.sendMessage(jid, { text }, quoted ? { quoted } : {}); }
async function moderateLink(msg, groupId, meta) {
  const text = getText(msg.message);
  const gs = groupSettings(groupId);
  if (!gs.antiLink || !text || !/(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text)) return false;
  const sender = msg.key.participant || msg.key.remoteJid;
  if (isAdmin(meta, sender) || sender === OWNER + '@s.whatsapp.net') return false;
  const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
  if (!isAdmin(meta, botJid)) { logger.warn({ groupId }, 'Anti-link enabled but bot is not admin'); return false; }
  try { await sock.sendMessage(groupId, { delete: msg.key }); await sendText(groupId, '⚠️ Link removed. Please follow group rules.'); return true; }
  catch (e) { logger.warn({ err:String(e) }, 'Link moderation failed'); return false; }
}
function getText(m={}) {
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}
async function startBot() {
  if (starting) return; starting = true; connectionState = 'connecting';
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch { version = undefined; }
    sock = makeWASocket({ version, auth: state, logger: logger.child({ module:'baileys' }), printQRInTerminal:false, browser:['NEXBOT Pro','Chrome','1.0.0'], markOnlineOnConnect:false, syncFullHistory:false, connectTimeoutMs:60000, defaultQueryTimeoutMs:60000 });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, qr, lastDisconnect: ld }) => {
      if (qr) { latestQR = qr; connectionState = 'qr'; logger.info('WhatsApp QR available; open protected dashboard to pair.'); }
      if (connection === 'open') { connected = true; latestQR = ''; connectionState = 'connected'; lastDisconnect = null; reconnectAttempts = 0; logger.info('WhatsApp connected'); }
      if (connection === 'close') {
        connected = false; latestQR = ''; connectionState = 'disconnected';
        const code = ld?.error?.output?.statusCode; lastDisconnect = { code: code || null, at: new Date().toISOString() };
        logger.warn({ code }, 'WhatsApp connection closed');
        if (code === DisconnectReason.loggedOut) {
          connectionState = 'logged_out';
          logger.error('WhatsApp session logged out; manual re-pairing is required.');
        } else {
          scheduleReconnect(`WhatsApp close (${code || 'unknown status'})`);
        }
      }
    });
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      try {
        const gs = groupSettings(id);
        if (!gs.welcome || action !== 'add') return;
        for (const p of participants) await sock.sendMessage(id, { text: '👋 Welcome @' + p.split('@')[0] + '! Please read the group rules.', mentions: [p] }).catch(()=>{});
      } catch (e) { logger.warn({ err:String(e) }, 'Welcome handler failed'); }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid;
          if (!jid || jid === 'status@broadcast') continue;
          messageCount++; lastMessageAt = new Date().toISOString();
          const text = getText(msg.message).trim();
          const isGroup = jid.endsWith('@g.us');
          let meta = null;
          if (isGroup) { try { meta = await sock.groupMetadata(jid); } catch {} }
          const sender = msg.key.participant || jid;
          if (isGroup && settings.managedGroupId && jid !== settings.managedGroupId) continue;
          if (isGroup && jid === settings.managedGroupId) {
            const body = msg.message || {};
            const wrapped = body.ephemeralMessage?.message || body.viewOnceMessage?.message || body.viewOnceMessageV2?.message || body;
            const mediaKeys = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage','contactMessage','contactsArrayMessage','locationMessage','liveLocationMessage','pollCreationMessage','pollCreationMessageV2','pollCreationMessageV3'];
            const mediaFound = mediaKeys.some(k => wrapped[k]);
            const rawText = text || '';
            const hasPhone = settings.blockPhoneNumbers && /(?:\+?\d[\d .()\-]{7,}\d)/.test(rawText);
            const hasPromo = settings.blockBusinessPromo && /\b(whatsapp|contact|call|business|service|deal|price|order|subscribe|dm me|inbox me|promo|marketing)\b/i.test(rawText);
            if ((settings.textOnly && mediaFound) || (settings.antiLink && /https?:\/\/|www\.|chat\.whatsapp\.com\//i.test(rawText)) || hasPhone || hasPromo) {
              const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
              if (settings.deleteMedia && isAdmin(meta, botJid)) await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
              await sendText(jid, '🔒 This group is text-only. Media, links, phone numbers and business promotions are not allowed. Please send a simple text message.', msg).catch(() => {});
              continue;
            }
          }
          if (isGroup) {
            const gs = groupSettings(jid);
            if (gs.antiSpam) {
              const key = jid + '|' + sender, now = Date.now();
              const arr = (recentMessages.get(key) || []).filter(t => now-t < 8000);
              arr.push(now); recentMessages.set(key, arr);
              if (arr.length >= 6 && !isAdmin(meta,sender)) {
                recentMessages.set(key, []);
                await sendText(jid, '⚠️ Please slow down; anti-spam detected rapid messages.', msg);
                if (isAdmin(meta, sock.user?.id?.split(':')[0] + '@s.whatsapp.net')) {
                  try { await sock.sendMessage(jid,{delete:msg.key}); } catch {}
                }
                continue;
              }
            }
            if (await moderateLink(msg, jid, meta)) continue;
            const bad = settings.blockedWords[jid] || [];
            if (text && bad.some(w => w && text.toLowerCase().includes(w.toLowerCase())) && !isAdmin(meta, sender)) {
              if (isAdmin(meta, sock.user?.id?.split(':')[0] + '@s.whatsapp.net')) await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
              await sendText(jid, '⚠️ Please keep the group respectful and follow its rules.', msg);
              continue;
            }
          }
          if (!isGroup && settings.privateProtection && !text.startsWith(PREFIX)) {
            const now=Date.now(), last=privateReplyAt.get(sender)||0;
            if (now-last > 24*60*60*1000) {
              privateReplyAt.set(sender,now);
              await sendText(jid,'I am not accepting private messages. Please do not message me.',msg).catch(()=>{});
            }
            continue;
          }
          if (!text.startsWith(PREFIX)) {
            if (isGroup && text) {
              const replies = settings.customReplies[jid] || {};
              const answer = replies[text.toLowerCase().trim()];
              if (answer && cooldown('custom:' + jid + ':' + sender, 3000)) await sendText(jid, answer, msg).catch(() => {});
            }
            continue;
          }
          commandCount++;
          const parts = text.slice(PREFIX.length).trim().split(/\s+/);
          const cmd = (parts.shift() || '').toLowerCase(), args = parts;
          const senderIsAdmin = isGroup ? isAdmin(meta, sender) : (OWNER && sender.replace(/\D/g,'').includes(OWNER));
          const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
          const botIsAdmin = isGroup && isAdmin(meta, botJid);
          const reply = t => sendText(jid, t, msg);
          if (cmd === 'ping') await reply('🏓 Pong! NEXBOT Pro is online. Connection: ' + connectionState);
          else if (cmd === 'help' || cmd === 'menu') await reply('⚡ NEXBOT PRO — COMMAND MENU\n' + PREFIX + 'ping | status | help | menu\n' + PREFIX + 'rules | groupinfo | admins\n' + PREFIX + 'kick @user | promote @user | demote @user | tagall\n' + PREFIX + 'warn @user [reason] | warnings @user | clearwarn @user (3 warnings removes member)\n' + PREFIX + 'setrules [text] | subject [name] | description [text]\n' + PREFIX + 'antilink on/off | antispam on/off | welcome on/off\n' + PREFIX + 'addreply trigger | response | delreply trigger | replies\n' + PREFIX + 'badword add word | badword remove word | badwords\n' + PREFIX + 'ai [question] (optional provider key)\nAdmin commands require group-admin rights; the bot must also be a group admin for moderation.');
          else if (cmd === 'rules') await reply('📌 Group rules\n' + (isGroup ? (settings.rules[jid] || '1. Be respectful.\n2. No spam or unsolicited links.\n3. Follow group admin guidance.') : 'Be respectful, avoid spam, and protect your privacy.'));
          else if (cmd === 'groupinfo' && isGroup) await reply('👥 ' + meta.subject + '\\nID: ' + jid + '\\nMembers: ' + meta.participants.length + '\\nAdmins: ' + meta.participants.filter(p=>p.admin).length + '\\nCreated/description details depend on WhatsApp metadata.');
          else if (cmd === 'admins' && isGroup) await sock.sendMessage(jid,{text:'🛡️ Group admins: ' + meta.participants.filter(p=>p.admin).map(p=>'@'+p.id.split('@')[0]).join(', '),mentions:meta.participants.filter(p=>p.admin).map(p=>p.id)},{quoted:msg});
          else if (cmd === 'status') await reply('NEXBOT Pro: ' + connectionState + '\\nMessages: ' + messageCount + '\\nCommands: ' + commandCount + '\\nUptime: ' + Math.floor((Date.now()-startedAt)/1000) + ' seconds');
          else if (cmd === 'privateprotection') {
            if (!OWNER || sender.replace(/\D/g,'') !== OWNER) { await reply('⛔ Owner-only command. Configure BOT_OWNER in Railway variables.'); continue; }
            const value=(args[0]||'').toLowerCase(); if(!['on','off'].includes(value)){await reply('Usage: '+PREFIX+'privateprotection on|off');continue;}
            settings.privateProtection=value==='on'; saveState(); await reply('✅ Private-message protection '+value+'.');
          }
          else if (cmd === 'replies') { const list = settings.customReplies[jid] || {}; await reply('🧩 Custom replies:\n' + (Object.keys(list).length ? Object.keys(list).map(k => k + ' → ' + list[k]).join('\n') : 'No custom replies yet. Add one with ' + PREFIX + 'addreply trigger | response')); }
          else if (cmd === 'addreply' || cmd === 'delreply') {
            if (!isGroup || (!senderIsAdmin && sender.replace(/\\D/g,'') !== OWNER)) { await reply('⛔ Only group admins can manage custom replies in a group.'); continue; }
            const raw = args.join(' '), partsReply = raw.split('|').map(x => x.trim());
            if (cmd === 'addreply') { if (partsReply.length < 2 || !partsReply[0] || !partsReply[1]) { await reply('Usage: ' + PREFIX + 'addreply trigger | response'); continue; } settings.customReplies[jid] = settings.customReplies[jid] || {}; settings.customReplies[jid][partsReply[0].toLowerCase().slice(0,60)] = partsReply.slice(1).join(' | ').slice(0,1000); saveState(); await reply('✅ Custom reply saved.'); }
            else { const trigger = raw.toLowerCase().trim(); if (!settings.customReplies[jid]?.[trigger]) { await reply('No matching trigger found. Use ' + PREFIX + 'replies'); continue; } delete settings.customReplies[jid][trigger]; saveState(); await reply('✅ Custom reply removed.'); }
          }
          else if (cmd === 'badwords' || cmd === 'badword') {
            if (!isGroup || (!senderIsAdmin && sender.replace(/\\D/g,'') !== OWNER)) { await reply('⛔ Only group admins can manage blocked words.'); continue; }
            if (cmd === 'badwords') { await reply('🚫 Blocked words: ' + ((settings.blockedWords[jid] || []).join(', ') || 'none')); continue; }
            const action = (args.shift() || '').toLowerCase(), word = args.join(' ').trim().toLowerCase();
            if (!['add','remove'].includes(action) || !word || word.length > 40 || /[\\r\\n]/.test(word)) { await reply('Usage: ' + PREFIX + 'badword add word OR ' + PREFIX + 'badword remove word'); continue; }
            settings.blockedWords[jid] = settings.blockedWords[jid] || [];
            if (action === 'add') { if (!settings.blockedWords[jid].includes(word)) settings.blockedWords[jid].push(word); }
            else settings.blockedWords[jid] = settings.blockedWords[jid].filter(w => w !== word);
            saveState(); await reply('✅ Blocked-word list updated.');
          }
          else if (cmd === 'ai') {
            const question=args.join(' '); const apiKey=process.env.OPENROUTER_API_KEY;
            if(!question){await reply('Usage: '+PREFIX+'ai your question');continue;}
            if(!apiKey){await reply('AI is not configured. Add an OpenRouter API key in Railway Variables; provider usage may have limits/costs.');continue;}
            if(!cooldown('ai:'+sender,10000)){await reply('Please wait a few seconds before asking AI again.');continue;}
            try { const resp=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.AI_MODEL||'openrouter/auto',messages:[{role:'system',content:'You are NEXBOT, a helpful concise WhatsApp assistant. Follow safety rules.'},{role:'user',content:question}],max_tokens:700})}); const data=await resp.json(); const answer=data.choices?.[0]?.message?.content; await reply(answer ? String(answer).slice(0,3500) : 'AI provider returned no answer. Check key, model and provider limits.'); } catch(e){logger.warn({err:String(e)},'AI request failed');await reply('AI request failed. Please try later.');}
          }
          else if (['kick','promote','demote','tagall','antilink','antispam','welcome','warn','warnings','clearwarn','setrules','subject','description'].includes(cmd)) {
            if (!isGroup) { await reply('This command only works in groups.'); continue; }
            if (!senderIsAdmin && sender.replace(/\D/g,'') !== OWNER) { await reply('⛔ Only group admins can use this command.'); continue; }
            if (!botIsAdmin) { await reply('⚠️ Please make NEXBOT an admin first.'); continue; }
            const targets = parseTargets(msg);
            if (cmd === 'setrules') { const ruleText=args.join(' ').trim(); if(!ruleText){await reply('Usage: '+PREFIX+'setrules your group rules');continue;} settings.rules[jid]=ruleText.slice(0,2000);saveState();await reply('✅ Group rules updated.'); }
            else if (cmd === 'subject' || cmd === 'description') { const value=args.join(' ').trim();if(!value){await reply('Provide new '+cmd+'.');continue;} if(cmd==='subject') await sock.groupUpdateSubject(jid,value.slice(0,100)); else await sock.groupUpdateDescription(jid,value.slice(0,2048)); await reply('✅ Group '+cmd+' updated.'); }
            else if (cmd === 'warn' || cmd === 'warnings' || cmd === 'clearwarn') {
              if(!targets.length){await reply('Mention or reply to a member.');continue;}
              const target=targets[0], key=warnKey(jid,target);
              if(cmd==='warn'){const arr=addWarning(jid,target,sender,args.filter(x=>!x.startsWith('@')).join(' '));await reply('⚠️ Warning added for @'+target.split('@')[0]+'. Total warnings: '+arr.length);if(arr.length>=3){const targetIsAdmin=isAdmin(meta,target);if(!targetIsAdmin && target!==botJid){try{await sock.groupParticipantsUpdate(jid,[target],'remove');delete settings.warnings[key];saveState();await reply('🚨 Three warnings reached. Member removed; warning counter reset.');}catch{await reply('🚨 Three warnings reached, but WhatsApp did not allow removal. Please review manually.');}}else await reply('🚨 Three warnings reached. Admins are protected from automatic removal.');}}
              else if(cmd==='warnings'){const arr=getWarnings(jid,target);await reply('📋 Warnings for @'+target.split('@')[0]+': '+arr.length+'\\n'+arr.map((w,i)=>(i+1)+'. '+w.reason+' ('+w.at.slice(0,10)+')').join('\\n'));}
              else {delete settings.warnings[key];saveState();await reply('✅ Warnings cleared for @'+target.split('@')[0]+'.');}
            }
            else if (cmd === 'kick' || cmd === 'promote' || cmd === 'demote') {
              if (!targets.length) { await reply('Mention the member, for example: ' + PREFIX + cmd + ' @member'); continue; }
              const action = cmd === 'kick' ? 'remove' : cmd;
              await sock.groupParticipantsUpdate(jid, targets, action);
              await reply('✅ ' + cmd + ' action completed for ' + targets.length + ' member(s).');
            } else if (cmd === 'tagall') {
              const mentions = meta.participants.map(p=>p.id);
              await sock.sendMessage(jid, { text: '📣 Attention everyone!\n' + mentions.map(x=>'@'+x.split('@')[0]).join(' '), mentions }, { quoted: msg });
            } else {
              const value = (args[0] || '').toLowerCase();
              if (!['on','off'].includes(value)) { await reply('Usage: ' + PREFIX + cmd + ' on|off'); continue; }
              const field = cmd === 'antilink' ? 'antiLink' : cmd === 'antispam' ? 'antiSpam' : 'welcome';
              settings.groups[jid] = { ...groupSettings(jid), [field]: value === 'on' };
              saveState(); await reply('✅ ' + cmd + ' ' + value + ' for this group.');
            }
          } else if (cmd === 'status') await reply('NEXBOT Pro: ' + connectionState + '\nMessages: ' + messageCount + '\nCommands: ' + commandCount);
        } catch (e) { logger.error({ err:String(e) }, 'Message handler failed'); }
      }
    });
  } catch (e) {
    connectionState = 'error'; lastDisconnect = { error: String(e), at: new Date().toISOString() };
    logger.error({ err:String(e) }, 'Bot startup failed');
    scheduleReconnect('bot startup failed');
  } finally { starting = false; }
}
const server = app.listen(PORT, '0.0.0.0', () => { logger.info({ port:PORT }, 'NEXBOT Pro HTTP server listening'); void startBot(); });
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  connectionState = 'shutting_down';
  logger.info({ signal }, 'NEXBOT Pro graceful shutdown started');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  server.close(() => logger.info('HTTP server closed'));
  try { sock?.end(undefined); } catch (e) { logger.warn({ err:String(e) }, 'WhatsApp socket close failed'); }
  setTimeout(() => process.exit(0), 8000).unref?.();
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

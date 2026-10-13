import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { createEventStore } from './lib/event-store.js';
import { createWorkflowEngine } from './lib/workflow-engine.js';

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
const eventStore = createEventStore(path.join(DATA_DIR, 'events.ndjson'));
const webhookAllowlist = (process.env.WORKFLOW_WEBHOOK_ALLOWLIST || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const workflowEngine = createWorkflowEngine({
  filePath:path.join(DATA_DIR, 'workflows.json'), eventStore, webhookAllowlist,
  sendText:async (context, text) => sendText(context.jid, text, context.quoted),
  aiResponder:async (prompt, question) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('Optional AI provider is not configured.');
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST', headers:{ Authorization:'Bearer ' + apiKey, 'Content-Type':'application/json' },
      body:JSON.stringify({ model:process.env.AI_MODEL || 'openrouter/auto', messages:[{role:'system',content:prompt},{role:'user',content:question}], max_tokens:500 }),
      signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('AI provider returned HTTP ' + response.status);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }
});
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
function makeRateLimiter({ windowMs = 60000, max = 180 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now(), key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) { bucket = { start:now, count:0 }; buckets.set(key,bucket); }
    bucket.count++;
    if (buckets.size > 5000) for (const [k,v] of buckets) if (now-v.start >= windowMs) buckets.delete(k);
    if (bucket.count > max) return res.status(429).json({ error:'Too many requests. Wait a minute and try again.' });
    next();
  };
}
app.use('/api', makeRateLimiter());
const groupActionLimit = makeRateLimiter({ max:30 });

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
    startBot();
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
app.get('/api/events', auth, (req,res) => {
  const { type, since, until } = req.query;
  if ((since && Number.isNaN(Date.parse(since))) || (until && Number.isNaN(Date.parse(until)))) return res.status(400).json({ error:'Invalid date filter. Use ISO date/time.' });
  try { res.json({ events:eventStore.list({ limit:req.query.limit, type, since, until }) }); }
  catch (e) { logger.error({ err:String(e) }, 'Could not read event log'); res.status(500).json({ error:'Could not read event log.' }); }
});
app.get('/api/analytics', auth, (req,res) => {
  const { since, until } = req.query;
  if ((since && Number.isNaN(Date.parse(since))) || (until && Number.isNaN(Date.parse(until)))) return res.status(400).json({ error:'Invalid date filter. Use ISO date/time.' });
  try { res.json({ ...eventStore.summary({ since, until }), processStartedAt:new Date(startedAt).toISOString(), messageCount, commandCount, lastMessageAt }); }
  catch (e) { logger.error({ err:String(e) }, 'Could not summarize events'); res.status(500).json({ error:'Could not summarize event log.' }); }
});
app.get('/api/commands', auth, (_req,res) => res.json({ prefix:PREFIX, commands:[
  {name:'ping',description:'Check bot responsiveness',usage:PREFIX+'ping',permission:'Everyone',enabled:true},
  {name:'help',description:'Show the supported command menu',usage:PREFIX+'help',permission:'Everyone',enabled:true},
  {name:'menu',description:'Alias for help',usage:PREFIX+'menu',permission:'Everyone',enabled:true},
  {name:'status',description:'Show live connection and process counters',usage:PREFIX+'status',permission:'Everyone',enabled:true},
  {name:'rules',description:'Show group rules or default safety guidance',usage:PREFIX+'rules',permission:'Everyone',enabled:true},
  {name:'groupinfo',description:'Show metadata for the current group',usage:PREFIX+'groupinfo',permission:'Group members',enabled:true},
  {name:'admins',description:'List current group admins',usage:PREFIX+'admins',permission:'Group members',enabled:true},
  {name:'addreply',description:'Save a trigger and reply in the current group',usage:PREFIX+'addreply trigger | response',permission:'Group admins',enabled:true},
  {name:'delreply',description:'Remove a saved reply trigger',usage:PREFIX+'delreply trigger',permission:'Group admins',enabled:true},
  {name:'replies',description:'List saved reply triggers',usage:PREFIX+'replies',permission:'Group members',enabled:true},
  {name:'antilink',description:'Toggle link moderation for this group',usage:PREFIX+'antilink on|off',permission:'Group admins',enabled:true},
  {name:'antispam',description:'Toggle anti-spam for this group',usage:PREFIX+'antispam on|off',permission:'Group admins',enabled:true},
  {name:'welcome',description:'Toggle group welcome messages',usage:PREFIX+'welcome on|off',permission:'Group admins',enabled:true},
  {name:'warn',description:'Add a warning to a mentioned member',usage:PREFIX+'warn @member [reason]',permission:'Group admins',enabled:true},
  {name:'warnings',description:'View warning history for a member',usage:PREFIX+'warnings @member',permission:'Group admins',enabled:true},
  {name:'clearwarn',description:'Clear warning history for a member',usage:PREFIX+'clearwarn @member',permission:'Group admins',enabled:true},
  {name:'kick',description:'Remove a member when WhatsApp permissions allow',usage:PREFIX+'kick @member',permission:'Group admins + bot admin',enabled:true},
  {name:'promote',description:'Promote a group member',usage:PREFIX+'promote @member',permission:'Group admins + bot admin',enabled:true},
  {name:'demote',description:'Demote a group admin',usage:PREFIX+'demote @member',permission:'Group admins + bot admin',enabled:true},
  {name:'tagall',description:'Mention group participants',usage:PREFIX+'tagall',permission:'Group admins + bot admin',enabled:true},
  {name:'setrules',description:'Save group rules',usage:PREFIX+'setrules [text]',permission:'Group admins',enabled:true},
  {name:'subject',description:'Update group subject',usage:PREFIX+'subject [name]',permission:'Group admins + bot admin',enabled:true},
  {name:'description',description:'Update group description',usage:PREFIX+'description [text]',permission:'Group admins + bot admin',enabled:true},
  {name:'badword',description:'Add or remove a blocked word',usage:PREFIX+'badword add|remove word',permission:'Group admins',enabled:true},
  {name:'badwords',description:'List blocked words',usage:PREFIX+'badwords',permission:'Group admins',enabled:true},
  {name:'privateprotection',description:'Toggle private-message protection',usage:PREFIX+'privateprotection on|off',permission:'Owner',enabled:true},
  {name:'ai',description:'Ask the configured optional AI provider',usage:PREFIX+'ai [question]',permission:'Everyone; provider configuration required',enabled:true}
] }));
app.get('/api/ai/status', auth, (_req,res) => res.json({ configured:!!process.env.OPENROUTER_API_KEY, provider:'OpenRouter', model:process.env.AI_MODEL || 'openrouter/auto', note:process.env.OPENROUTER_API_KEY ? 'AI provider key is configured; provider limits or charges may apply.' : 'AI is unavailable until an optional provider key is configured.' }));
app.post('/api/reconnect', auth, (_req,res) => {
  if (connected) return res.status(409).json({ error:'WhatsApp is already connected.', state:connectionState });
  if (connectionState === 'logged_out') return res.status(409).json({ error:'WhatsApp session is logged out. Re-pairing is required; existing auth data has not been deleted. Follow the documented recovery steps before changing session files.', state:connectionState });
  scheduleReconnect('manual dashboard retry');
  res.status(202).json({ ok:true, state:connectionState, message:'Reconnect scheduled with backoff.' });
});
app.get('/api/replies', auth, (req,res) => {
  const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : '';
  if (groupId && !groupId.endsWith('@g.us')) return res.status(400).json({ error:'Invalid group ID.' });
  const source = groupId ? (settings.customReplies[groupId] || {}) : {};
  res.json({ groupId, replies:Object.entries(source).map(([trigger,response]) => ({ trigger,response })) });
});
app.post('/api/replies', auth, (req,res) => {
  const { groupId, trigger, response } = req.body || {};
  if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) return res.status(400).json({ error:'Select a valid group first.' });
  if (typeof trigger !== 'string' || !trigger.trim() || trigger.trim().length > 60) return res.status(400).json({ error:'Trigger must contain 1–60 characters.' });
  if (typeof response !== 'string' || !response.trim() || response.trim().length > 1000) return res.status(400).json({ error:'Reply must contain 1–1000 characters.' });
  settings.customReplies[groupId] = settings.customReplies[groupId] || {};
  settings.customReplies[groupId][trigger.trim().toLowerCase()] = response.trim();
  saveState();
  eventStore.add('auto_reply_saved', { category:'group' });
  res.json({ ok:true, trigger:trigger.trim().toLowerCase() });
});
app.delete('/api/replies', auth, (req,res) => {
  const { groupId, trigger } = req.body || {};
  if (typeof groupId !== 'string' || !groupId.endsWith('@g.us') || typeof trigger !== 'string') return res.status(400).json({ error:'Valid groupId and trigger are required.' });
  if (!settings.customReplies[groupId]?.[trigger]) return res.status(404).json({ error:'Reply trigger not found.' });
  delete settings.customReplies[groupId][trigger];
  saveState();
  eventStore.add('auto_reply_deleted', { category:'group' });
  res.json({ ok:true });
});
app.get('/api/workflows', auth, (_req,res) => res.json({ workflows:workflowEngine.list(), webhookAllowlistConfigured:webhookAllowlist.length > 0 }));
app.post('/api/workflows', auth, (req,res) => {
  const result = workflowEngine.save(req.body?.workflow || req.body);
  if (!result.ok) return res.status(400).json({ error:'Workflow validation failed.', errors:result.errors });
  res.json(result);
});
app.patch('/api/workflows/:id', auth, (req,res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error:'enabled must be true or false.' });
  const current = workflowEngine.list().find(w => w.id === req.params.id);
  if (!current) return res.status(404).json({ error:'Workflow not found.' });
  const result = workflowEngine.save({ ...current, enabled:req.body.enabled });
  if (!result.ok) return res.status(400).json({ error:'Workflow validation failed.', errors:result.errors });
  eventStore.add('workflow_toggled', { outcome:req.body.enabled ? 'enabled' : 'paused' });
  res.json(result);
});
app.delete('/api/workflows/:id', auth, (req,res) => {
  if (!workflowEngine.remove(req.params.id)) return res.status(404).json({ error:'Workflow not found.' });
  res.json({ ok:true });
});
app.post('/api/workflows/:id/test', auth, async (req,res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0,2000) : '';
  const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId : '';
  if (groupId && !groupId.endsWith('@g.us')) return res.status(400).json({ error:'Invalid group ID.' });
  const result = await workflowEngine.test(req.params.id, { jid:groupId || 'test@s.whatsapp.net', sender:typeof req.body?.sender === 'string' ? req.body.sender.slice(0,80) : 'test@s.whatsapp.net', text, isGroup:groupId.endsWith('@g.us'), groupName:'Test group', receivedAt:new Date().toISOString() });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ...result, dryRun:true, message:'Test mode does not send WhatsApp messages or call external webhooks.' });
});
app.get('/api/backup', auth, (_req,res) => {
  res.set('Content-Disposition', 'attachment; filename="nexbot-settings-backup.json"');
  res.json({ format:'nexbot-settings-backup-v1', createdAt:new Date().toISOString(), settings, workflows:workflowEngine.list() });
});
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
app.post('/api/group-control', auth, groupActionLimit, async (req,res) => {
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
    eventStore.add('group_action_succeeded', { category:action, outcome:'success' });
    res.json(result);
  } catch (e) {
    eventStore.add('group_action_failed', { category:action, outcome:'failed' });
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
async function sendText(jid, text, quoted) {
  if (!sock || !connected) return;
  const result = await sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
  eventStore.add('reply_sent', { category:jid.endsWith('@g.us') ? 'group' : 'private', outcome:'success' });
  return result;
}
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
      if (qr) { latestQR = qr; connectionState = 'qr'; eventStore.add('connection_changed', { state:'qr_required' }); logger.info('WhatsApp QR available; open protected dashboard to pair.'); }
      if (connection === 'open') { connected = true; latestQR = ''; connectionState = 'connected'; lastDisconnect = null; reconnectAttempts = 0; eventStore.add('connection_changed', { state:'connected' }); logger.info('WhatsApp connected'); }
      if (connection === 'close') {
        connected = false; latestQR = ''; sock = null;
        const code = ld?.error?.output?.statusCode;
        lastDisconnect = { code: code || null, at: new Date().toISOString() };
        eventStore.add('connection_changed', { state:code === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', code:code || 0 });
        if (code === DisconnectReason.loggedOut) {
          connectionState = 'logged_out';
          logger.error({ code }, 'WhatsApp session logged out; manual re-pairing is required');
        } else {
          connectionState = 'disconnected';
          scheduleReconnect('WhatsApp connection closed');
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
          eventStore.add('message_received', { category:isGroup ? 'group' : 'private' });
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
            const workflowHandled = await workflowEngine.runForMessage({ jid, sender, text, isGroup, groupName:meta?.subject || '', receivedAt:new Date().toISOString(), quoted:msg });
            if (workflowHandled) continue;
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
          eventStore.add('command_received', { command:cmd || '(empty)' });
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
    connectionState = 'error'; lastDisconnect = { error: 'Bot startup failed', at: new Date().toISOString() };
    eventStore.add('connection_error', { category:'startup' });
    logger.error({ err:String(e) }, 'Bot startup failed');
    scheduleReconnect('bot startup failed');
  } finally { starting = false; }
}
const server = app.listen(PORT, '0.0.0.0', () => { logger.info({ port:PORT }, 'NEXBOT Pro HTTP server listening'); startBot(); });
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'NEXBOT shutdown requested');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connected = false;
  connectionState = 'stopping';
  const forceExit = setTimeout(() => process.exit(0), 10000);
  forceExit.unref?.();
  try { sock?.end(undefined); } catch (e) { logger.warn({ err:String(e) }, 'WhatsApp socket shutdown warning'); }
  server.close(() => { clearTimeout(forceExit); process.exit(0); });
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

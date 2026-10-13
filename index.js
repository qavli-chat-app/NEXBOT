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
import { hasUrlLikeContent, hasBusinessPromotion, isGroupAdmin, getAdminVerification } from './lib/moderation.js';

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
  if (shuttingDown) return;
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
let settings = { antiLink: true, antiSpam: true, welcome: true, goodbye: false, privateProtection: true, awayMessage:'I am not accepting private messages. Please do not message me.', welcomeMessage:'👋 Welcome @{{user}}! Please read the group rules.', goodbyeMessage:'Goodbye @{{user}}. Take care!', fallbackReplies:{}, replyCooldownSeconds:3, groups: {}, warnings: {}, rules: {}, customReplies: {}, blockedWords: {}, managedGroupId: '', textOnly: true, blockPhoneNumbers: true, blockBusinessPromo: true, deleteMedia: true };
let messageCount = 0, commandCount = 0, lastMessageAt = null;
const recentMessages = new Map(), privateReplyAt = new Map(), commandCooldown = new Map(), processedMessageIds = new Map();
const cooldown = (key, ms) => { const now=Date.now(), prev=commandCooldown.get(key)||0; if(now-prev<ms) return false; commandCooldown.set(key,now); return true; };
try {
  if (fs.existsSync(STATE_FILE)) {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    settings = { ...settings, ...(s.settings || {}), groups: s.settings?.groups || {}, warnings: s.settings?.warnings || {}, rules: s.settings?.rules || {}, customReplies: s.settings?.customReplies || {}, fallbackReplies: s.settings?.fallbackReplies || {}, blockedWords: s.settings?.blockedWords || {}, managedGroupId: s.settings?.managedGroupId || '', awayMessage: typeof s.settings?.awayMessage === 'string' ? s.settings.awayMessage : settings.awayMessage, welcomeMessage: typeof s.settings?.welcomeMessage === 'string' ? s.settings.welcomeMessage : settings.welcomeMessage, goodbyeMessage: typeof s.settings?.goodbyeMessage === 'string' ? s.settings.goodbyeMessage : settings.goodbyeMessage, replyCooldownSeconds: Number.isInteger(s.settings?.replyCooldownSeconds) ? Math.min(60, Math.max(1, s.settings.replyCooldownSeconds)) : settings.replyCooldownSeconds, goodbye: s.settings?.goodbye === true, textOnly: s.settings?.textOnly !== false, blockPhoneNumbers: s.settings?.blockPhoneNumbers !== false, blockBusinessPromo: s.settings?.blockBusinessPromo !== false, deleteMedia: s.settings?.deleteMedia !== false };
  }
} catch (e) { logger.warn({ err: String(e) }, 'Could not load saved settings'); }
// One-time migration: persist the strict moderation policy requested by the owner.
if (settings.moderationPolicyVersion !== 2) {
  settings.antiLink = true;
  settings.textOnly = true;
  settings.blockPhoneNumbers = true;
  settings.blockBusinessPromo = true;
  settings.deleteMedia = true;
  settings.moderationPolicyVersion = 2;
  saveState();
}
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
app.get('/api/status', auth, (_req,res) => res.json({ service:'NEXBOT Pro', state:connectionState, connected, qrAvailable:!!latestQR, commandPrefix:PREFIX, uptimeSeconds:Math.floor((Date.now()-startedAt)/1000), messageCount, commandCount, lastMessageAt, lastDisconnect, settings }));
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
app.post('/api/ai/test', auth, async (req,res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0,1000) : '';
  if (!prompt) return res.status(400).json({ error:'Enter a prompt of 1–1000 characters.' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error:'AI is not configured. Add an optional OPENROUTER_API_KEY in Railway Variables.' });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method:'POST', headers:{ Authorization:'Bearer '+apiKey, 'Content-Type':'application/json' }, body:JSON.stringify({ model:process.env.AI_MODEL || 'openrouter/auto', messages:[{role:'system',content:'You are NEXBOT, a concise and helpful assistant.'},{role:'user',content:prompt}], max_tokens:300 }), signal:AbortSignal.timeout(15000) });
    if (!response.ok) { eventStore.add('ai_request_failed', { category:'test', code:response.status }); return res.status(502).json({ error:'AI provider returned HTTP '+response.status+'. Check provider limits and configuration.' }); }
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) return res.status(502).json({ error:'AI provider returned an empty answer.' });
    eventStore.add('ai_request_succeeded', { category:'test', outcome:'success' });
    res.json({ ok:true, answer:answer.slice(0,2500) });
  } catch (e) { eventStore.add('ai_request_failed', { category:'test', outcome:'failed' }); logger.warn({ err:String(e) }, 'AI test request failed'); res.status(502).json({ error:'AI request timed out or failed. Try again later.' }); }
});
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
app.get('/api/reply-settings', auth, (req,res) => {
  const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : '';
  if (!groupId.endsWith('@g.us')) return res.status(400).json({ error:'Select a valid group.' });
  res.json({ groupId, fallbackReply:settings.fallbackReplies?.[groupId] || '', replyCooldownSeconds:settings.replyCooldownSeconds || 3, exactReplyCount:Object.keys(settings.customReplies[groupId] || {}).length });
});
app.post('/api/reply-settings', auth, (req,res) => {
  const { groupId, fallbackReply, replyCooldownSeconds } = req.body || {};
  if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) return res.status(400).json({ error:'Select a valid group.' });
  if (typeof fallbackReply !== 'string' || fallbackReply.length > 1000) return res.status(400).json({ error:'Fallback reply must be 0–1000 characters.' });
  if (replyCooldownSeconds !== undefined && (!Number.isInteger(replyCooldownSeconds) || replyCooldownSeconds < 1 || replyCooldownSeconds > 60)) return res.status(400).json({ error:'Reply cooldown must be 1–60 seconds.' });
  settings.fallbackReplies = settings.fallbackReplies || {};
  if (fallbackReply.trim()) settings.fallbackReplies[groupId] = fallbackReply.trim();
  else delete settings.fallbackReplies[groupId];
  if (replyCooldownSeconds !== undefined) settings.replyCooldownSeconds = replyCooldownSeconds;
  saveState();
  eventStore.add('fallback_reply_saved', { category:'group', outcome:fallbackReply.trim() ? 'enabled' : 'disabled' });
  res.json({ ok:true, groupId, fallbackReply:settings.fallbackReplies[groupId] || '', replyCooldownSeconds:settings.replyCooldownSeconds });
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
    const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const adminCheckedAt = new Date().toISOString();
    const groups = Object.values(all || {}).map(g => {
      const adminStatus = getAdminVerification(g, botJid);
      const botAdmin = adminStatus === 'verified_admin';
      return {
        id: g.id,
        subject: g.subject || 'Unnamed group',
        size: Array.isArray(g.participants) ? g.participants.length : 0,
        desc: g.desc || '',
        announce: !!g.announce,
        restrict: !!g.restrict,
        isCommunity: !!g.isCommunity,
        botAdmin,
        adminStatus,
        adminCheckedAt,
        participants: (g.participants || []).map(p => ({ id:p.id, name:p.name || p.notify || p.id, admin:p.admin || '' }))
      };
    }).sort((a,b) => a.subject.localeCompare(b.subject));
    res.json({ connected:true, count:groups.length, botJid, adminCheckedAt, groups });
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
  const allowed = ['antiLink','antiSpam','welcome','goodbye','privateProtection'];
  for (const key of allowed) if (typeof req.body?.[key] === 'boolean') settings[key] = req.body[key];
  // Strict owner-requested group policy cannot be switched off from the dashboard/API.
  settings.antiLink = true;
  settings.textOnly = true;
  settings.blockPhoneNumbers = true;
  settings.blockBusinessPromo = true;
  settings.deleteMedia = true;
  for (const key of ['awayMessage','welcomeMessage','goodbyeMessage']) if (typeof req.body?.[key] === 'string' && req.body[key].length <= 1000) settings[key] = req.body[key].trim();
  if (Number.isInteger(req.body?.replyCooldownSeconds) && req.body.replyCooldownSeconds >= 1 && req.body.replyCooldownSeconds <= 60) settings.replyCooldownSeconds = req.body.replyCooldownSeconds;
  if (typeof req.body?.managedGroupId === 'string' && (req.body.managedGroupId === '' || req.body.managedGroupId.endsWith('@g.us'))) settings.managedGroupId = req.body.managedGroupId;
  saveState(); res.json({ ok:true, settings });
});
app.get('/dashboard', (_req,res) => res.sendFile(path.join(process.cwd(), 'dashboard.html')));

const groupDefaults = { antiLink: settings.antiLink, antiSpam: settings.antiSpam, welcome: settings.welcome, goodbye:settings.goodbye };
function groupSettings(id) { return { ...groupDefaults, ...(settings.groups[id] || {}) }; }
function warnKey(groupId, userId) { return groupId + '|' + userId; }
function getWarnings(groupId,userId) { return settings.warnings[warnKey(groupId,userId)] || []; }
function addWarning(groupId,userId,by,reason) { const k=warnKey(groupId,userId); const arr=getWarnings(groupId,userId); arr.push({by,reason:reason||'No reason provided',at:new Date().toISOString()}); settings.warnings[k]=arr.slice(-20); saveState(); return settings.warnings[k]; }
function parseTargets(msg) { return [...new Set([...mentionedJids(msg), ...(msg.message?.extendedTextMessage?.contextInfo?.participant ? [msg.message.extendedTextMessage.contextInfo.participant] : [])])]; }
function isAdmin(meta, jid) { return isGroupAdmin(meta, jid); }
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
  if (!isAdmin(meta, botJid)) { eventStore.add('moderation_action', { category:'link', outcome:'blocked_no_admin' }); logger.warn({ groupId }, 'Anti-link enabled but bot is not admin'); return false; }
  try { await sock.sendMessage(groupId, { delete: msg.key }); eventStore.add('moderation_action', { category:'link', outcome:'deleted' }); await sendText(groupId, '⚠️ Link removed. Please follow group rules.'); return true; }
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
        if (!((action === 'add' && gs.welcome) || (action === 'remove' && settings.goodbye))) return;
        for (const p of participants) {
          const template = action === 'add' ? settings.welcomeMessage : settings.goodbyeMessage;
          const text = String(template || '').replaceAll('{{user}}', p.split('@')[0]).replaceAll('{{group}}', id);
          if (!text.trim()) continue;
          await sock.sendMessage(id, { text, mentions: [p] }).then(() => eventStore.add(action === 'add' ? 'welcome_sent' : 'goodbye_sent', { category:'group', outcome:'success' })).catch(() => eventStore.add(action === 'add' ? 'welcome_sent' : 'goodbye_sent', { category:'group', outcome:'failed' }));
        }
      } catch (e) { logger.warn({ err:String(e) }, 'Welcome handler failed'); }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue;
          const jid = msg.key.remoteJid;
          if (!jid || jid === 'status@broadcast') continue;
          const eventId = msg.key.id ? jid + '|' + msg.key.id : '';
          if (eventId && processedMessageIds.has(eventId)) continue;
          if (eventId) {
            processedMessageIds.set(eventId, Date.now());
            if (processedMessageIds.size > 5000) {
              const cutoff = Date.now() - 10 * 60 * 1000;
              for (const [key, at] of processedMessageIds) if (at < cutoff) processedMessageIds.delete(key);
              while (processedMessageIds.size > 5000) processedMessageIds.delete(processedMessageIds.keys().next().value);
            }
          }
          messageCount++; lastMessageAt = new Date().toISOString();
          const text = getText(msg.message).trim();
          const isGroup = jid.endsWith('@g.us');
          eventStore.add('message_received', { category:isGroup ? 'group' : 'private' });
          let meta = null;
          if (isGroup) { try { meta = await sock.groupMetadata(jid); } catch {} }
          const sender = msg.key.participant || jid;
          if (isGroup) {
            // Enforce text-only moderation in every group, not just a single selected group.
            // Baileys can wrap messages in ephemeral/view-once containers.
            const body = msg.message || {};
            const wrapped = body.ephemeralMessage?.message || body.viewOnceMessage?.message || body.viewOnceMessageV2?.message || body;
            const metadataKeys = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
            const contentKeys = Object.keys(wrapped).filter(k => !metadataKeys.has(k));
            const hasNonText = contentKeys.some(k => !['conversation', 'extendedTextMessage'].includes(k));
            const rawText = getText(wrapped).trim();
            const hasLink = hasUrlLikeContent(rawText)
              || Boolean(wrapped.extendedTextMessage?.contextInfo?.externalAdReply?.sourceUrl);
            const hasPhone = settings.blockPhoneNumbers && /(?:\+?\d[\d .()\-]{7,}\d)/.test(rawText);
            const hasPromo = settings.blockBusinessPromo && hasBusinessPromotion(rawText);
            const violation = (settings.textOnly && hasNonText) || hasLink || hasPhone || hasPromo;
            if (violation) {
              const reason = hasNonText ? 'non-text content' : hasLink ? 'link' : hasPhone ? 'phone number' : 'business promotion';
              const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
              let deleted = false;
              if (settings.deleteMedia && isAdmin(meta, botJid)) {
                try { await sock.sendMessage(jid, { delete: msg.key }); deleted = true; }
                catch (e) { logger.warn({ err:String(e), groupId:jid }, 'Could not delete a text-only rule violation'); }
              }
              const warnings = addWarning(jid, sender, botJid, reason);
              eventStore.add('moderation_action', {
                category:'text_only',
                outcome: deleted ? 'deleted_and_warned' : (!meta ? 'admin_status_unknown_warned' : (isAdmin(meta, botJid) ? 'delete_failed_warned' : 'bot_not_admin_warned'))
              });
              const warningText = '⚠️ @' + sender.split('@')[0] + ': this group allows text messages only. Media, links, phone numbers and business promotions are not allowed. Warning ' + warnings.length + '.';
              await sock.sendMessage(jid, { text:warningText, mentions:[sender] }).catch(() => {});
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
                eventStore.add('moderation_action', { category:'anti_spam', outcome:'triggered' });
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
              eventStore.add('moderation_action', { category:'blocked_word', outcome:'triggered' });
              if (isAdmin(meta, sock.user?.id?.split(':')[0] + '@s.whatsapp.net')) await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
              await sendText(jid, '⚠️ Please keep the group respectful and follow its rules.', msg);
              continue;
            }
          }
          if (!isGroup && settings.privateProtection && !text.startsWith(PREFIX)) {
            const now=Date.now(), last=privateReplyAt.get(sender)||0;
            if (now-last > 24*60*60*1000) {
              privateReplyAt.set(sender,now);
              await sendText(jid, settings.awayMessage || 'I am not accepting private messages. Please do not message me.', msg).catch(()=>{});
            }
            continue;
          }
          if (!text.startsWith(PREFIX)) {
            const workflowHandled = await workflowEngine.runForMessage({ jid, sender, text, isGroup, groupName:meta?.subject || '', receivedAt:new Date().toISOString(), quoted:msg });
            if (workflowHandled) continue;
            if (isGroup && text) {
              const replies = settings.customReplies[jid] || {};
              const normalized = text.toLowerCase().trim();
              const answer = replies[normalized];
              const waitMs = (settings.replyCooldownSeconds || 3) * 1000;
              if (answer && cooldown('custom:' + jid + ':' + sender, waitMs)) {
                await sendText(jid, answer, msg).catch(() => {});
              } else if (!answer && settings.fallbackReplies?.[jid] && cooldown('fallback:' + jid + ':' + sender, waitMs)) {
                await sendText(jid, settings.fallbackReplies[jid], msg).catch(() => {});
              }
            }
            continue;
          }
          commandCount++;
          const parts = text.slice(PREFIX.length).trim().split(/\s+/);
          const cmd = (parts.shift() || '').toLowerCase(), args = parts;
          eventStore.add('command_received', { command:cmd || '(empty)' });
          const senderNumber = sender.split('@')[0].split(':')[0].replace(/\D/g, '');
          const isOwner = Boolean(OWNER && senderNumber === OWNER);
          const senderIsAdmin = isOwner || (isGroup && isAdmin(meta, sender));
          const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
          const botIsAdmin = isGroup && isAdmin(meta, botJid);
          const reply = t => sendText(jid, t, msg);
          if (cmd === 'ping') await reply('🏓 Pong! NEXBOT Pro is online. Connection: ' + connectionState);
          else if (cmd === 'help' || cmd === 'menu') await reply('⚡ NEXBOT PRO — COMMAND MENU\n' + PREFIX + 'ping | status | help | menu\n' + PREFIX + 'rules | groupinfo | admins\n' + PREFIX + 'kick @user | promote @user | makeadmin @user | demote @user | tagall\n' + PREFIX + 'warn @user [reason] | warnings @user | clearwarn @user (3 warnings removes member)\n' + PREFIX + 'setrules [text] | subject [name] | description [text]\n' + PREFIX + 'antilink on/off | antispam on/off | welcome on/off\n' + PREFIX + 'addreply trigger | response | delreply trigger | replies\n' + PREFIX + 'badword add word | badword remove word | badwords\n' + PREFIX + 'ai [question] (optional provider key)\nAdmin commands require group-admin rights; the bot must also be a group admin for moderation.');
          else if (cmd === 'rules') await reply('📌 Group rules\n' + (isGroup ? (settings.rules[jid] || '1. Be respectful.\n2. No spam or unsolicited links.\n3. Follow group admin guidance.') : 'Be respectful, avoid spam, and protect your privacy.'));
          else if (cmd === 'groupinfo' && isGroup) await reply('👥 ' + meta.subject + '\\nID: ' + jid + '\\nMembers: ' + meta.participants.length + '\\nAdmins: ' + meta.participants.filter(p=>p.admin).length + '\\nCreated/description details depend on WhatsApp metadata.');
          else if (cmd === 'admins' && isGroup) await sock.sendMessage(jid,{text:'🛡️ Group admins: ' + meta.participants.filter(p=>p.admin).map(p=>'@'+p.id.split('@')[0]).join(', '),mentions:meta.participants.filter(p=>p.admin).map(p=>p.id)},{quoted:msg});
          else if (cmd === 'status') await reply('NEXBOT Pro: ' + connectionState + '\\nMessages: ' + messageCount + '\\nCommands: ' + commandCount + '\\nUptime: ' + Math.floor((Date.now()-startedAt)/1000) + ' seconds');
          else if (cmd === 'privateprotection') {
            if (!isOwner) { await reply('⛔ Owner-only command. Configure BOT_OWNER in Railway variables.'); continue; }
            const value=(args[0]||'').toLowerCase(); if(!['on','off'].includes(value)){await reply('Usage: '+PREFIX+'privateprotection on|off');continue;}
            settings.privateProtection=value==='on'; saveState(); await reply('✅ Private-message protection '+value+'.');
          }
          else if (cmd === 'replies') { const list = settings.customReplies[jid] || {}; await reply('🧩 Custom replies:\n' + (Object.keys(list).length ? Object.keys(list).map(k => k + ' → ' + list[k]).join('\n') : 'No custom replies yet. Add one with ' + PREFIX + 'addreply trigger | response')); }
          else if (cmd === 'addreply' || cmd === 'delreply') {
            if (!isGroup || (!senderIsAdmin && !isOwner)) { await reply('⛔ Only group admins can manage custom replies in a group.'); continue; }
            const raw = args.join(' '), partsReply = raw.split('|').map(x => x.trim());
            if (cmd === 'addreply') { if (partsReply.length < 2 || !partsReply[0] || !partsReply[1]) { await reply('Usage: ' + PREFIX + 'addreply trigger | response'); continue; } settings.customReplies[jid] = settings.customReplies[jid] || {}; settings.customReplies[jid][partsReply[0].toLowerCase().slice(0,60)] = partsReply.slice(1).join(' | ').slice(0,1000); saveState(); await reply('✅ Custom reply saved.'); }
            else { const trigger = raw.toLowerCase().trim(); if (!settings.customReplies[jid]?.[trigger]) { await reply('No matching trigger found. Use ' + PREFIX + 'replies'); continue; } delete settings.customReplies[jid][trigger]; saveState(); await reply('✅ Custom reply removed.'); }
          }
          else if (cmd === 'badwords' || cmd === 'badword') {
            if (!isGroup || (!senderIsAdmin && sender.replace(/\D/g,'') !== OWNER)) { await reply('⛔ Only group admins can manage blocked words.'); continue; }
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
            try { const resp=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.AI_MODEL||'openrouter/auto',messages:[{role:'system',content:'You are NEXBOT, a helpful concise WhatsApp assistant. Follow safety rules.'},{role:'user',content:question}],max_tokens:700}),signal:AbortSignal.timeout(15000)}); if(!resp.ok){await reply('AI provider returned HTTP '+resp.status+'. Check provider limits and configuration.');continue;} const data=await resp.json(); const answer=data.choices?.[0]?.message?.content; await reply(answer ? String(answer).slice(0,3500) : 'AI provider returned no answer. Check key, model and provider limits.'); } catch(e){logger.warn({err:String(e)},'AI request failed');await reply('AI request failed. Please try later.');}
          }
          else if (['kick','promote','makeadmin','demote','tagall','antilink','antispam','welcome','warn','warnings','clearwarn','setrules','subject','description'].includes(cmd)) {
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
            else if (cmd === 'kick' || cmd === 'promote' || cmd === 'makeadmin' || cmd === 'demote') {
              if (!targets.length) { await reply('Mention the member, for example: ' + PREFIX + cmd + ' @member'); continue; }
              const action = cmd === 'kick' ? 'remove' : cmd === 'makeadmin' ? 'promote' : cmd;
              await sock.groupParticipantsUpdate(jid, targets, action);
              await reply('✅ ' + (cmd === 'makeadmin' ? 'makeadmin (promote)' : cmd) + ' action completed for ' + targets.length + ' member(s).');
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

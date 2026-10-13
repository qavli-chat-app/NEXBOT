import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NODE_TYPES = new Set(['incoming_message','keyword_match','exact_match','contains','sender_condition','group_condition','delay','send_text','label_event','webhook','ai_response','branch','end']);
const clean = (value, max = 1000) => String(value ?? '').slice(0, max);

export function validateWorkflow(workflow, { webhookAllowlist = [] } = {}) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return ['Workflow must be an object.'];
  if (typeof workflow.name !== 'string' || !workflow.name.trim() || workflow.name.trim().length > 80) errors.push('Name must contain 1–80 characters.');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length < 2 || workflow.nodes.length > 50) errors.push('A workflow must have 2–50 nodes.');
  if (!Array.isArray(workflow.edges) || workflow.edges.length > 100) errors.push('Edges must be an array with at most 100 connections.');
  if (errors.length) return errors;

  const ids = new Set();
  let triggers = 0;
  for (const node of workflow.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(node.id)) { errors.push('Each node needs a valid unique ID.'); continue; }
    if (ids.has(node.id)) errors.push('Duplicate node ID: ' + node.id);
    ids.add(node.id);
    if (!NODE_TYPES.has(node.type)) errors.push('Unsupported node type: ' + node.type);
    if (node.type === 'incoming_message') triggers++;
    const c = node.config || {};
    if (['keyword_match','exact_match','contains'].includes(node.type) && (typeof c.value !== 'string' || !c.value.trim())) errors.push(node.id + ': match value is required.');
    if (node.type === 'send_text' && (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 3000)) errors.push(node.id + ': reply text must contain 1–3000 characters.');
    if (node.type === 'delay' && (!Number.isInteger(Number(c.ms)) || Number(c.ms) < 0 || Number(c.ms) > 10000)) errors.push(node.id + ': delay must be 0–10000 milliseconds.');
    if (node.type === 'webhook') {
      try {
        const url = new URL(c.url);
        if (url.protocol !== 'https:' || !webhookAllowlist.includes(url.hostname.toLowerCase())) errors.push(node.id + ': webhook must use HTTPS and a hostname in WORKFLOW_WEBHOOK_ALLOWLIST.');
      } catch { errors.push(node.id + ': a valid webhook URL is required.'); }
    }
    if (node.type === 'ai_response' && typeof c.prompt !== 'string') errors.push(node.id + ': AI prompt must be a string.');
  }
  if (triggers !== 1) errors.push('Exactly one incoming_message trigger is required.');
  for (const edge of workflow.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) errors.push('Every connection must point to existing node IDs.');
    else if (edge.when && !['always','true','false','success','failure'].includes(edge.when)) errors.push('Unsupported connection condition: ' + edge.when);
  }
  const trigger = workflow.nodes.find(n => n?.type === 'incoming_message');
  if (trigger && !workflow.edges.some(e => e.from === trigger.id)) errors.push('Connect the incoming_message trigger to another node.');
  return [...new Set(errors)];
}

export function createWorkflowEngine({ filePath, eventStore, sendText, webhookAllowlist = [], aiResponder } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let workflows = [];
  const aiCooldowns = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) {
      const storedHosts = parsed.flatMap(w => (Array.isArray(w?.nodes) ? w.nodes : []).filter(n => n?.type === 'webhook').map(n => {
        try { return new URL(n.config?.url).hostname.toLowerCase(); } catch { return ''; }
      })).filter(Boolean);
      const loadAllowlist = [...new Set([...webhookAllowlist, ...storedHosts])];
      workflows = parsed.filter(w => validateWorkflow(w, { webhookAllowlist:loadAllowlist }).length === 0);
    }
  } catch (error) { if (error?.code !== 'ENOENT') eventStore?.add('workflow_store_error', { category:'load' }); }

  function persist() {
    const temp = filePath + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(workflows, null, 2), { mode:0o600 });
    fs.renameSync(temp, filePath);
  }

  function list() { return workflows.map(w => structuredClone(w)); }

  function save(input) {
    const errors = validateWorkflow(input, { webhookAllowlist });
    if (errors.length) return { ok:false, errors };
    const id = typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(input.id) ? input.id : randomUUID();
    const next = { id, name:input.name.trim(), enabled:input.enabled === true, nodes:input.nodes, edges:input.edges, updatedAt:new Date().toISOString() };
    const index = workflows.findIndex(w => w.id === id);
    if (index < 0) workflows.push(next); else workflows[index] = next;
    persist();
    eventStore?.add('workflow_saved', { outcome:'success' });
    return { ok:true, workflow:structuredClone(next) };
  }

  function remove(id) {
    const before = workflows.length;
    workflows = workflows.filter(w => w.id !== id);
    if (before === workflows.length) return false;
    persist();
    eventStore?.add('workflow_deleted', { outcome:'success' });
    return true;
  }

  async function execute(workflow, context, { dryRun = false } = {}) {
    const byId = new Map(workflow.nodes.map(n => [n.id,n]));
    const trigger = workflow.nodes.find(n => n.type === 'incoming_message');
    let current = workflow.edges.find(e => e.from === trigger.id && (!e.when || e.when === 'always'))?.to;
    const visited = new Set();
    let steps = 0, handled = false;
    while (current && steps < 50) {
      if (visited.has(current)) throw new Error('Workflow loop detected at node ' + current);
      visited.add(current); steps++;
      const node = byId.get(current);
      if (!node) throw new Error('Missing node: ' + current);
      const c = node.config || {};
      let branch = 'success';
      try {
        if (node.type === 'keyword_match') branch = context.text.toLowerCase().includes(clean(c.value,200).toLowerCase()) ? 'true' : 'false';
        else if (node.type === 'exact_match') branch = context.text.trim().toLowerCase() === clean(c.value,200).trim().toLowerCase() ? 'true' : 'false';
        else if (node.type === 'contains') branch = context.text.toLowerCase().includes(clean(c.value,200).toLowerCase()) ? 'true' : 'false';
        else if (node.type === 'sender_condition') branch = context.sender === c.senderId ? 'true' : 'false';
        else if (node.type === 'group_condition') branch = context.isGroup && (!c.groupId || c.groupId === context.jid) ? 'true' : 'false';
        else if (node.type === 'delay') { if (!dryRun) await new Promise(resolve => setTimeout(resolve, Math.min(10000, Number(c.ms) || 0))); }
        else if (node.type === 'send_text') {
          if (!dryRun) await sendText(context, clean(c.text,3000).replaceAll('{{text}}',context.text).replaceAll('{{sender}}',context.sender).replaceAll('{{group}}',context.groupName || ''));
          handled = true;
        } else if (node.type === 'label_event') eventStore?.add('workflow_label', { category:clean(c.label || 'label',80), outcome:dryRun ? 'test' : 'recorded' });
        else if (node.type === 'webhook') {
          const hostname = new URL(c.url).hostname.toLowerCase();
          if (!webhookAllowlist.includes(hostname)) throw new Error('Webhook host is no longer allowlisted.');
          if (!dryRun) {
            const response = await fetch(c.url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ event:'incoming_message', text:context.text, sender:context.sender, groupId:context.isGroup ? context.jid : null, receivedAt:context.receivedAt }), signal:AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error('Webhook responded with HTTP ' + response.status);
          }
        } else if (node.type === 'ai_response') {
          if (!dryRun) {
            if (typeof aiResponder !== 'function') throw new Error('AI provider is not configured.');
            const cooldownKey = context.sender || context.jid || 'unknown';
            const now = Date.now(), last = aiCooldowns.get(cooldownKey) || 0;
            if (now - last < 10000) throw new Error('AI workflow cooldown active for this sender.');
            aiCooldowns.set(cooldownKey, now);
            const answer = await aiResponder(clean(c.prompt || 'Reply helpfully to this message.',1000), context.text);
            if (answer) { await sendText(context, clean(answer,3000)); handled = true; }
          }
        } else if (node.type === 'branch') branch = c.value ? (context.text.toLowerCase().includes(clean(c.value,200).toLowerCase()) ? 'true' : 'false') : 'true';
        else if (node.type === 'end') break;
      } catch (error) {
        eventStore?.add('workflow_node_failed', { category:node.type, outcome:'failed' });
        const fallback = workflow.edges.find(e => e.from === current && e.when === 'failure');
        if (!fallback) throw error;
        current = fallback.to; continue;
      }
      const next = workflow.edges.find(e => e.from === current && e.when === branch)
        || workflow.edges.find(e => e.from === current && e.when === 'always')
        || (branch === 'success' ? workflow.edges.find(e => e.from === current && !e.when) : null);
      current = next?.to || null;
    }
    if (steps >= 50) throw new Error('Workflow step limit reached.');
    return { handled, steps };
  }

  async function runForMessage(context) {
    let handled = false;
    for (const workflow of workflows.filter(w => w.enabled)) {
      try {
        const result = await execute(workflow, context);
        eventStore?.add('workflow_run', { outcome:'success' });
        handled = handled || result.handled;
      } catch (error) {
        eventStore?.add('workflow_run', { outcome:'failed', category:'execution' });
      }
    }
    return handled;
  }

  async function test(id, context) {
    const workflow = workflows.find(w => w.id === id);
    if (!workflow) return { ok:false, error:'Workflow not found.' };
    try { const result = await execute(workflow, context, { dryRun:true }); return { ok:true, ...result }; }
    catch (error) { return { ok:false, error:clean(error.message,200) }; }
  }

  return { list, save, remove, runForMessage, test };
}

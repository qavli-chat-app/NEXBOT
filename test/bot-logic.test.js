import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasUrlLikeContent,
  hasBusinessPromotion,
  isGroupAdmin,
  getAdminVerification
} from '../lib/moderation.js';
import { validateWorkflow } from '../lib/workflow-engine.js';

test('moderation: detects common URLs and WhatsApp invite links', () => {
  assert.equal(hasUrlLikeContent('Please visit https://example.com'), true);
  assert.equal(hasUrlLikeContent('chat.whatsapp.com/abc123'), true);
  assert.equal(hasUrlLikeContent('hello everyone'), false);
});

test('moderation: detects promotional wording without flagging ordinary chat', () => {
  assert.equal(hasBusinessPromotion('DM me for the price list'), true);
  assert.equal(hasBusinessPromotion('Assalam o alaikum everyone'), false);
});

test('group admin verification handles missing metadata safely', () => {
  assert.equal(isGroupAdmin(null, '123@s.whatsapp.net'), false);
  assert.equal(getAdminVerification(null, '123@s.whatsapp.net'), 'unknown');
  assert.equal(getAdminVerification({ participants: [] }, '123@s.whatsapp.net'), 'not_admin');
});

test('group admin verification recognizes admin and superadmin', () => {
  const meta = { participants: [
    { id: '123@s.whatsapp.net', admin: 'admin' },
    { id: '456@s.whatsapp.net', admin: 'superadmin' },
    { id: '789@s.whatsapp.net', admin: null }
  ] };
  assert.equal(isGroupAdmin(meta, '123@s.whatsapp.net'), true);
  assert.equal(isGroupAdmin(meta, '456@s.whatsapp.net'), true);
  assert.equal(isGroupAdmin(meta, '789@s.whatsapp.net'), false);
  assert.equal(getAdminVerification(meta, '123@s.whatsapp.net'), 'verified_admin');
});

test('workflow validator rejects missing trigger and malformed graphs', () => {
  assert.ok(validateWorkflow({ name: 'Broken', nodes: [], edges: [] }).length > 0);
  assert.ok(validateWorkflow({
    name: 'No trigger',
    nodes: [{ id: 'reply', type: 'send_text', config: { text: 'Hi' } }],
    edges: []
  }).some(error => error.includes('incoming_message')));
});

test('workflow validator accepts a simple valid reply flow', () => {
  const workflow = {
    name: 'Welcome reply',
    nodes: [
      { id: 'incoming', type: 'incoming_message', config: {} },
      { id: 'reply', type: 'send_text', config: { text: 'Hello {{sender}}' } }
    ],
    edges: [{ from: 'incoming', to: 'reply' }]
  };
  assert.deepEqual(validateWorkflow(workflow), []);
});

test('workflow validator blocks unapproved webhook hosts', () => {
  const workflow = {
    name: 'Webhook flow',
    nodes: [
      { id: 'incoming', type: 'incoming_message', config: {} },
      { id: 'hook', type: 'webhook', config: { url: 'https://example.com/hook' } }
    ],
    edges: [{ from: 'incoming', to: 'hook' }]
  };
  assert.ok(validateWorkflow(workflow, { webhookAllowlist: [] }).some(error => error.includes('WORKFLOW_WEBHOOK_ALLOWLIST')));
});

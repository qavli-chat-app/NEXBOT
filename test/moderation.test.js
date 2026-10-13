import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUrlLikeContent, hasBusinessPromotion, isGroupAdmin, getAdminVerification } from '../lib/moderation.js';

test('link detector catches common URL formats and bare domains', () => {
  for (const value of [
    'https://example.com/path',
    'www.example.com',
    'chat.whatsapp.com/AbCd',
    'wa.me/923001234567',
    't.me/example',
    'Visit example.pk today'
  ]) assert.equal(hasUrlLikeContent(value), true, value);
  assert.equal(hasUrlLikeContent('Hello everyone, have a good day.'), false);
});

test('promotion detector catches English and Roman Urdu phrases', () => {
  assert.equal(hasBusinessPromotion('Buy now, limited offer'), true);
  assert.equal(hasBusinessPromotion('Order karein, delivery available'), true);
  assert.equal(hasBusinessPromotion('Online earning ka mauqa'), true);
  assert.equal(hasBusinessPromotion('Assalam o alaikum everyone'), false);
});

test('admin verification distinguishes verified admin, non-admin, and unknown metadata', () => {
  const meta = { participants: [
    { id: '111@s.whatsapp.net', admin: 'admin' },
    { id: '222@s.whatsapp.net', admin: 'superadmin' },
    { id: '333@s.whatsapp.net', admin: null }
  ] };
  assert.equal(isGroupAdmin(meta, '111@s.whatsapp.net'), true);
  assert.equal(isGroupAdmin(meta, '222@s.whatsapp.net'), true);
  assert.equal(isGroupAdmin(meta, '333@s.whatsapp.net'), false);
  assert.equal(getAdminVerification(meta, '111@s.whatsapp.net'), 'verified_admin');
  assert.equal(getAdminVerification(meta, '333@s.whatsapp.net'), 'not_admin');
  assert.equal(getAdminVerification(null, '111@s.whatsapp.net'), 'unknown');
});

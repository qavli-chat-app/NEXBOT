import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUrlLikeContent, hasBusinessPromotion, hasObsceneContent, hasBlockedWordContent, getMessageModerationViolation, getMessageText, isGroupAdmin, getAdminVerification } from '../lib/moderation.js';

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

test('adult/profane detector catches common terms and separator/leet evasion without flagging ordinary words', () => {
  for (const value of ['XXX', 'p.o.r.n', 'p0rn', 'n u d e', 'explicit adult content', 'madarchod', 'f.u.c.k']) {
    assert.equal(hasObsceneContent(value), true, value);
  }
  for (const value of ['class is starting', 'assessment tomorrow', 'Assalam o alaikum everyone', 'the section of a plant is a biology topic']) {
    assert.equal(hasObsceneContent(value), false, value);
  }
});

test('blocked custom words use normalized whole-word matching', () => {
  assert.equal(hasBlockedWordContent('This is BAD-WORD!', ['bad word']), true);
  assert.equal(hasBlockedWordContent('classroom', ['ass']), false);
  assert.equal(hasBlockedWordContent('ordinary greeting', ['xxx']), false);
});

test('strict group moderation detects media and nested WhatsApp message wrappers', () => {
  for (const message of [
    { audioMessage: { ptt:true } },
    { videoMessage: {} },
    { stickerMessage: {} },
    { documentMessage: {} },
    { contactMessage: {} },
    { locationMessage: {} },
    { pollCreationMessage: {} },
    { productMessage: {} },
    { ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: {} } } } }
  ]) {
    assert.equal(getMessageModerationViolation(message)?.reason, 'non-text content');
  }
  assert.equal(getMessageText({ ephemeralMessage: { message: { conversation: 'hello group' } } }), 'hello group');
});

test('strict group moderation catches link, phone, promotion and adult text', () => {
  assert.equal(getMessageModerationViolation({ conversation:'join https://example.com' })?.reason, 'link');
  assert.equal(getMessageModerationViolation({ conversation:'Call me at +923001234567' })?.reason, 'phone number');
  assert.equal(getMessageModerationViolation({ conversation:'Order karein, delivery available' })?.reason, 'business promotion');
  assert.equal(getMessageModerationViolation({ conversation:'xxx content here' })?.reason, 'obscene or adult language');
  assert.equal(getMessageModerationViolation({ conversation:'Assalam o alaikum everyone' }), null);
});

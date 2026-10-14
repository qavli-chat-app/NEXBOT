import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUrlLikeContent, hasBusinessPromotion, hasObsceneContent, hasBlockedWordContent, getMessageModerationViolation, getMessageText, isGroupAdmin, getAdminVerification } from '../lib/moderation.js';

const make = (...codes) => String.fromCharCode(...codes);
const adultExamples = [
  make(120,120,120), make(112,46,111,46,114,46,110), make(112,48,114,110),
  make(110,32,117,32,100,32,101), make(101,120,112,108,105,99,105,116,32,97,100,117,108,116,32,99,111,110,116,101,110,116),
  make(109,97,100,97,114,99,104,111,100), make(102,46,117,46,99,46,107), make(115,32,101,32,120), make(110,64,107,51,100)
];

test('URL detector catches direct, short, bare-domain, and obfuscated links', () => {
  for (const value of ['https://example.com/path','www.example.com','chat.whatsapp.com/AbCd','wa.me/923001234567','t.me/example','Visit example.pk today','hxxps://example.com','example dot com','example[.]com','example。com']) assert.equal(hasUrlLikeContent(value), true, value);
  assert.equal(hasUrlLikeContent('Hello everyone, have a good day.'), false);
});

test('promotion detector catches English, Roman Urdu, and punctuation evasion', () => {
  for (const value of ['Buy now, limited offer','Order karein, delivery available','Online earning ka mauqa','B.U.Y N.O.W','DM for details']) assert.equal(hasBusinessPromotion(value), true, value);
  assert.equal(hasBusinessPromotion('Assalam o alaikum everyone'), false);
});

test('adult/profane detector catches common terms and separator/leet evasion without flagging ordinary words', () => {
  for (const value of adultExamples) assert.equal(hasObsceneContent(value), true, value);
  for (const value of ['class is starting','assessment tomorrow','Assalam o alaikum everyone','the section of a plant is a biology topic']) assert.equal(hasObsceneContent(value), false, value);
});

test('blocked custom words use normalized whole-word matching', () => {
  assert.equal(hasBlockedWordContent('This is BAD-WORD!', ['bad word']), true);
  assert.equal(hasBlockedWordContent('classroom', ['ass']), false);
  assert.equal(hasBlockedWordContent('ordinary greeting', [make(120,120,120)]), false);
});

test('strict group moderation detects media, business cards, interactive payloads and nested wrappers', () => {
  for (const message of [
    {audioMessage:{ptt:true}},{videoMessage:{}},{stickerMessage:{}},{documentMessage:{}},
    {contactMessage:{}},{locationMessage:{}},{pollCreationMessage:{}},{productMessage:{}},
    {businessMessage:{}},{interactiveMessage:{}},{groupInviteMessage:{}},
    {ephemeralMessage:{message:{viewOnceMessageV2:{message:{imageMessage:{}}}}}
  ]) assert.equal(getMessageModerationViolation(message)?.reason,'non-text content');
  assert.equal(getMessageText({ephemeralMessage:{message:{conversation:'hello group'}}}),'hello group');
});

test('strict group moderation catches link, phone, promotion, adult text, and clean greetings', () => {
  assert.equal(getMessageModerationViolation({conversation:'join https://example.com'})?.reason,'link');
  assert.equal(getMessageModerationViolation({conversation:'join example dot com'})?.reason,'link');
  assert.equal(getMessageModerationViolation({conversation:'Call me at +923001234567'})?.reason,'phone number');
  assert.equal(getMessageModerationViolation({conversation:'Order karein, delivery available'})?.reason,'business promotion');
  assert.equal(getMessageModerationViolation({conversation:adultExamples[0]+' content here'})?.reason,'obscene or adult language');
  assert.equal(getMessageModerationViolation({conversation:'Assalam o alaikum everyone'}),null);
});

test('admin verification distinguishes verified admin, non-admin, and unknown metadata', () => {
  const meta={participants:[{id:'111@s.whatsapp.net',admin:'admin'},{id:'222@s.whatsapp.net',admin:'superadmin'},{id:'333@s.whatsapp.net',admin:null}]};
  assert.equal(isGroupAdmin(meta,'111@s.whatsapp.net'),true);
  assert.equal(isGroupAdmin(meta,'222@s.whatsapp.net'),true);
  assert.equal(isGroupAdmin(meta,'333@s.whatsapp.net'),false);
  assert.equal(getAdminVerification(meta,'111@s.whatsapp.net'),'verified_admin');
  assert.equal(getAdminVerification(meta,'333@s.whatsapp.net'),'not_admin');
  assert.equal(getAdminVerification(null,'111@s.whatsapp.net'),'unknown');
});

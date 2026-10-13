import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('bulk group control is bounded and checks admin and target membership per group', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/group-control/bulk'");
  const end = source.indexOf("app.get('/api/qr'", start);
  assert.notEqual(start, -1, 'bulk control endpoint must exist');
  assert.ok(end > start, 'bulk endpoint must end before QR endpoint');
  const endpoint = source.slice(start, end);
  assert.match(endpoint, /groupIds\.length > 20/, 'a batch must be capped at 20 groups');
  assert.match(endpoint, /const allowed = \['promote','demote','announcement','member-messaging','edit-info'\]/);
  assert.match(endpoint, /if \(!isAdmin\(meta, botId\)\)/, 'each group must check bot admin rights');
  assert.match(endpoint, /target_not_member/, 'role actions must reject a target absent from a group');
  assert.match(endpoint, /groupParticipantsUpdate\(groupId, \[target\], action\)/);
  assert.match(endpoint, /group_action_failed/);
});


test('admin verification accepts session JID candidates and device-suffixed JIDs', async () => {
  const source = await import('../lib/moderation.js');
  const meta = { participants: [
    { id:'12345:7@s.whatsapp.net', admin:'admin' },
    { id:'67890@s.whatsapp.net', admin:null }
  ] };
  assert.equal(source.isGroupAdmin(meta, ['99999@s.whatsapp.net','12345@s.whatsapp.net']), true);
  assert.equal(source.getAdminVerification(meta, ['12345:2@s.whatsapp.net']), 'verified_admin');
  assert.equal(source.getAdminVerification(meta, '67890@s.whatsapp.net'), 'not_admin');
});

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

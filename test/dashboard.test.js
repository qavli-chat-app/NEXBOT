import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('dashboard inline JavaScript parses and all required navigation views exist', () => {
  const html = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'dashboard script must exist');
  for (const match of scripts) new vm.Script(match[1]);
  const required = ['command','connection','inbox','workflows','replies','commands','groups','safety','ai','analytics','integrations','logs','settings'];
  for (const view of required) {
    assert.match(html, new RegExp('data-view="' + view + '"'));
    assert.match(html, new RegExp('id="view-' + view + '"'));
  }
  assert.match(html, /All Groups Control Center/);
  assert.match(html, /id="bulkGroupAction"/);
  assert.match(html, /function runBulkGroupAction\(\)/);
  assert.match(html, /\/api\/group-control\/bulk/);
  assert.match(html, /Please confirm this bulk WhatsApp action/);
});

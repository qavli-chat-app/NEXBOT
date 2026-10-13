import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Baileys internal logger is silent to prevent session key material in runtime logs', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /logger:\s*pino\(\{\s*level:\s*'silent'\s*\}\)\.child\(\{\s*module:\s*'baileys'\s*\}\)/);
  assert.doesNotMatch(source, /BAILEYS_LOG_LEVEL/, 'an environment override must not re-enable sensitive Baileys logs');
});

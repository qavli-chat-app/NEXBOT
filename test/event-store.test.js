import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventStore } from '../lib/event-store.js';

test('event store persists safe events and filters newest-first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexbot-events-'));
  try {
    const file = path.join(dir, 'events.ndjson');
    const store = createEventStore(file);
    store.add('message_received', { category: 'group', command: 'ping', secret: 'must-not-persist', text: 'private message body' });
    store.add('command_executed', { command: 'help', outcome: 'success' });
    const rows = store.list({ limit: 10 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].type, 'command_executed');
    assert.equal(rows[1].category, 'group');
    assert.equal('secret' in rows[1], false);
    assert.equal('text' in rows[1], false);
    assert.equal(store.summary().total, 2);
    assert.equal(store.list({ type: 'command_executed' }).length, 1);
    const reloaded = createEventStore(file);
    assert.equal(reloaded.list({ limit: 10 }).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('event store rejects invalid event types and bounds list size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexbot-events-'));
  try {
    const store = createEventStore(path.join(dir, 'events.ndjson'));
    assert.throws(() => store.add('../unsafe'), TypeError);
    for (let i = 0; i < 12; i++) store.add('test_event', { outcome: String(i) });
    assert.equal(store.list({ limit: 5 }).length, 5);
    assert.equal(store.list({ limit: 99999 }).length, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

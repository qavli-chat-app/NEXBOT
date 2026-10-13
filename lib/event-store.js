import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_TYPES = /^[a-z][a-z0-9_.-]{0,49}$/;
const SAFE_FIELDS = new Set(['command', 'outcome', 'state', 'category', 'groupCount', 'durationMs', 'code']);
const cleanString = value => String(value).replace(/[\r\n\t]/g, ' ').slice(0, 120);

export function createEventStore(filePath, { maxEntries = 5000, maxBytes = 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function rotateIfNeeded() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= maxBytes) return;
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-maxEntries);
      const temp = filePath + '.tmp';
      fs.writeFileSync(temp, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
      fs.renameSync(temp, filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function add(type, fields = {}) {
    if (typeof type !== 'string' || !SAFE_TYPES.test(type)) throw new TypeError('Invalid event type');
    const safe = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        safe[key] = typeof value === 'string' ? cleanString(value) : value;
      }
    }
    const event = { id: randomUUID(), type, at: new Date().toISOString(), ...safe };
    const fd = fs.openSync(filePath, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(event) + '\n'); } finally { fs.closeSync(fd); }
    rotateIfNeeded();
    return event;
  }

  function list({ limit = 100, type, since, until } = {}) {
    let rows = [];
    try {
      rows = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (type) rows = rows.filter(row => row.type === type);
    if (since) rows = rows.filter(row => row.at >= since);
    if (until) rows = rows.filter(row => row.at <= until);
    const safeLimit = Math.max(1, Math.min(500, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 100));
    return rows.slice(-safeLimit).reverse();
  }

  function summary({ since, until } = {}) {
    const rows = list({ limit: maxEntries, since, until });
    const counts = {};
    for (const row of rows) counts[row.type] = (counts[row.type] || 0) + 1;
    return { total: rows.length, counts, lastEventAt: rows[0]?.at || null };
  }

  return { add, list, summary };
}

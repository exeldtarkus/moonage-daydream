import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { historyPick, runningStatus } from '../runningStatus';

const q = (sql: string, conn: string, db: string, start: number) => ({ sql, conn, db, start });

test('running status bar: hidden when idle, count + oldest elapsed, one tooltip line per query (oldest first)', () => {
  assert.equal(runningStatus([], 10_000), undefined);
  assert.deepEqual(runningStatus([q('SELECT 1', 'lab', 'shop', 9_000)], 10_000), {
    text: '$(loading~spin) 1 query running · 1s', tooltip: ['SELECT 1 — lab / shop · 1s'],
  });
  assert.deepEqual(runningStatus([q('SELECT *\nFROM b', 'ms', '', 8_000), q('WAITFOR DELAY', 'ms', 'db', 2_500)], 10_000), {
    text: '$(loading~spin) 2 queries running · 7s', tooltip: ['WAITFOR DELAY — ms / db · 7s', 'SELECT * — ms · 2s'],
  });
});

test('history quick pick: status icon + first line, where · when · duration, error message as detail', () => {
  const at = new Date(2026, 10, 3, 9, 5).getTime();
  assert.deepEqual(historyPick({ sql: 'SELECT *\nFROM t', conn: 'lab', db: 'shop', at, durationMs: 12, status: 'ok' }, at + 3 * 60_000), {
    label: '$(pass) SELECT *', description: 'lab / shop · 3 min ago · 12 ms', detail: undefined,
  });
  assert.deepEqual(historyPick({ sql: 'UPDATE x', conn: 'ms', db: '', at, durationMs: 5, status: 'error', message: 'Invalid object name' }, at + 30_000), {
    label: '$(error) UPDATE x', description: 'ms · just now · 5 ms', detail: 'Invalid object name',
  });
  assert.equal(historyPick({ sql: 'x', conn: 'a', db: '', at, durationMs: 1, status: 'cancelled' }, at + 2 * 3600_000).description, 'a · 2 h ago · 1 ms');
  assert.match(historyPick({ sql: 'x', conn: 'a', db: '', at, durationMs: 1, status: 'ok' }, at + 3 * 86_400_000).description, /^a · \d/, 'older: date');
});

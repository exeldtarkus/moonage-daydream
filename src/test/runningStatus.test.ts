import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runningStatus } from '../runningStatus';

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

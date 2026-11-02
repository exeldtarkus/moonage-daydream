import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { DB_INFO_PARTS, dbInfoHtml, type PartResult } from '../dbInfo';

const ok = (columns: string[], rows: unknown[][]): PartResult => ({ columns, rows });
const parts: Record<string, PartResult> = {
  summary: ok(['name', 'state', 'recovery_model', 'collation', 'compatibility_level', 'create_date', 'is_read_only', 'user_access', 'owner'],
    [['shop', 'ONLINE', 'FULL', 'SQL_Latin1_General_CP1_CI_AS', 160, new Date('2026-10-01T08:30:00Z'), false, 'MULTI_USER', 'sa']]),
  objects: ok(['tables', 'views', 'procedures', 'functions'], [[12, 3, 5, 0]]),
  files: ok(['name', 'type', 'physical_name', 'size_mb', 'used_mb', 'max_mb', 'growth'], [
    ['shop', 'ROWS', '/var/opt/mssql/data/shop.mdf', 64, 16, null, '64 MB'],
    ['shop_log', 'LOG', '/var/opt/mssql/data/shop_log.ldf', 8, 2, 2097152, '10 %'],
  ]),
  backups: { error: "The SELECT permission was denied on the object 'backupset', database 'msdb'" },
};

test('db info: one read-only query per section, all from the catalog views', () => {
  assert.deepEqual(DB_INFO_PARTS.map((p) => p.key), ['summary', 'objects', 'files', 'backups']);
  for (const p of DB_INFO_PARTS) assert.doesNotMatch(p.sql, /\b(insert|update|delete|alter|drop|create|exec)\b/i, p.key);
  assert.match(DB_INFO_PARTS.find((p) => p.key === 'backups')!.sql, /msdb\.dbo\.backupset/);
});

test('db info: overview cards, object counts, files with usage bar, unlimited max size', () => {
  const h = dbInfoHtml('csp', { conn: 'local', db: 'shop' }, parts);
  for (const s of ['ONLINE', 'FULL', 'SQL_Latin1_General_CP1_CI_AS', '160', '2026-10-01 08:30', 'MULTI_USER', '>No<', '>sa<']) assert.ok(h.includes(s), s);
  assert.match(h, /<b>12<\/b>\s*<span>tables<\/span>/);
  assert.match(h, /style="width:25%"/); // 16 / 64 MB
  assert.match(h, /unlimited/);
  assert.match(h, /2048 GB|2097152 MB|2 TB/);
});

test('db info: a section without permission shows the message, others still render', () => {
  const h = dbInfoHtml('csp', { conn: 'local', db: 'shop' }, parts);
  assert.match(h, /class="perm"[^>]*>No permission/);
  assert.match(h, /msdb/);
  assert.ok(h.includes('ONLINE'));
  const other = dbInfoHtml('csp', { conn: 'l', db: 'x' }, { ...parts, files: { error: 'Timeout expired' } });
  assert.match(other, /class="fail"[^>]*>Timeout expired/);
});

test('db info: show query per section, open in SQL editor, refresh, text escaped', () => {
  const h = dbInfoHtml('csp', { conn: 'a<b', db: 'shop' }, parts);
  assert.equal((h.match(/<summary>Show query<\/summary>/g) ?? []).length, 4);
  assert.equal((h.match(/data-open="(summary|objects|files|backups)"/g) ?? []).length, 4);
  assert.match(h, /data-open="all"/);
  assert.match(h, /id="refresh"/);
  assert.ok(h.includes('a&lt;b'));
  assert.ok(h.includes('FILEPROPERTY'));
});

test('db info: loading state before the first result', () => {
  const h = dbInfoHtml('csp', { conn: 'l', db: 'shop' }, {});
  assert.match(h, /Loading/);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSqliteFile, sqliteDriver } from '../sqlite';

test('drop table: SQLite script quotes a one-part name', () => {
  assert.equal(sqliteDriver.dropTable!({ schema: 'main', name: 'order"item' }), 'DROP TABLE "order""item";');
});

test('drop table: SQLite end to end on a real file removes the table, its index and trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonage-droplite-'));
  try {
    const file = join(dir, 'lab.db');
    await createSqliteFile(file);
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const run = (sql: string) => sqliteDriver.run(c, '', sql);
    const names = async () => (await run(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)).resultSets[0].rows.map((r) => r[0]);
    await run('CREATE TABLE "my t" (id integer PRIMARY KEY, v text); CREATE TABLE keep (id integer);');
    await run('CREATE INDEX ix_v ON "my t" (v); CREATE TRIGGER tr_v AFTER INSERT ON "my t" BEGIN INSERT INTO keep VALUES (new.id); END;');
    assert.deepEqual(await names(), ['ix_v', 'keep', 'my t', 'tr_v']);
    await run(sqliteDriver.dropTable!({ schema: 'main', name: 'my t' }));
    assert.deepEqual(await names(), ['keep']);
    assert.deepEqual(await sqliteDriver.objects(c, '', 'main', 'table'), [{ schema: 'main', name: 'keep' }], 'file still opens');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

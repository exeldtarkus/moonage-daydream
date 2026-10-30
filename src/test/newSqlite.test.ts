import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTable, drivers, type NewColumn } from '../db';
import { createSqliteFile, sqliteDriver, uniqueConnName } from '../sqlite';

const lite = drivers.sqlite.columnDdl!;
const id: NewColumn = { name: 'id', type: 'integer', nullable: false, pk: true, ai: true };

test('new table: SQLite CREATE TABLE with AUTOINCREMENT inline, UNIQUE, FK, default, nullable column', () => {
  const r = createTable(lite, { schema: 'main', name: 'order"item' }, [
    id,
    { name: 'order_id', type: 'integer', nullable: false, fk: { schema: 'main', table: 'orders', column: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
    { name: 'sku', type: 'varchar(40)', nullable: false, unique: true },
    { name: 'qty', type: 'integer', nullable: false, default: '0' },
    { name: 'note', type: 'text', nullable: true },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    'CREATE TABLE "order""item" (',
    '  "id" integer NOT NULL CONSTRAINT "PK_order""item" PRIMARY KEY AUTOINCREMENT,',
    '  "order_id" integer NOT NULL,',
    '  "sku" varchar(40) NOT NULL,',
    '  "qty" integer NOT NULL DEFAULT 0,',
    '  "note" text,',
    '  CONSTRAINT "UQ_order""item_sku" UNIQUE ("sku"),',
    '  CONSTRAINT "FK_order""item_order_id" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE',
    ');',
  ].join('\n'));
});

test('new table: SQLite composite / non-AI primary key is a PRIMARY KEY clause', () => {
  const r = createTable(lite, { schema: 'main', name: 't' }, [{ name: 'a', type: 'integer', nullable: true, pk: true }, { name: 'b', type: 'text', nullable: false, pk: true }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, ['CREATE TABLE "t" (', '  "a" integer NOT NULL,', '  "b" text NOT NULL,', '  CONSTRAINT "PK_t" PRIMARY KEY ("a", "b")', ');'].join('\n'));
});

test('new table: SQLite auto increment needs integer PRIMARY KEY alone; aiTypes / fkActions', () => {
  const msg = 'auto increment needs integer PRIMARY KEY alone (SQLite)';
  const errs = (rows: NewColumn[]) => createTable(lite, { schema: 'main', name: 't' }, rows).errors;
  assert.deepEqual(errs([{ ...id, pk: false }]), [`id: ${msg}`]);
  assert.deepEqual(errs([id, { name: 'b', type: 'integer', nullable: false, pk: true }]), [`id: ${msg}`]);
  assert.deepEqual(errs([{ ...id, type: 'int' }]), [`id: ${msg}`]);
  assert.deepEqual(errs([{ ...id, type: 'INTEGER' }]), []);
  assert.deepEqual(errs([id, { name: 'n', type: 'text', nullable: false }]), [], 'NOT NULL without default is fine in a new table');
  assert.deepEqual(lite.aiTypes, ['integer']);
  assert.deepEqual(lite.fkActions, ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);
  assert.equal(lite.check!({ name: 'n', type: 'text', nullable: false }), 'a new NOT NULL column needs a default (SQLite)', 'Add column rule kept');
});

test('new table: SQLite end to end on a real file (table_info, foreign_key_list, unique index)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonage-newlite-'));
  try {
    const file = join(dir, 'lab.db');
    await createSqliteFile(file);
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const run = (sql: string) => sqliteDriver.run(c, '', sql);
    const one = async (sql: string) => (await run(sql)).resultSets[0].rows;
    await run(createTable(lite, { schema: 'main', name: 'orders' }, [id]).sql);
    const r = createTable(lite, { schema: 'main', name: 'item' }, [
      id,
      { name: 'order_id', type: 'integer', nullable: true, fk: { schema: 'main', table: 'orders', column: 'id', onDelete: 'SET NULL' } },
      { name: 'sku', type: 'text', nullable: false, unique: true },
      { name: 'qty', type: 'integer', nullable: false, default: '0' },
    ]);
    await run(r.sql);
    assert.deepEqual(await one(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('item') ORDER BY cid`),
      [['id', 'INTEGER', 1, null, 1], ['order_id', 'INTEGER', 0, null, 0], ['sku', 'TEXT', 1, null, 0], ['qty', 'INTEGER', 1, '0', 0]]);
    assert.deepEqual(await one(`SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('item')`), [['orders', 'order_id', 'id', 'SET NULL']]);
    assert.deepEqual(await one(`SELECT "unique", origin FROM pragma_index_list('item')`), [[1, 'u']]);
    await run(`INSERT INTO item (sku) VALUES ('a'), ('b')`);
    assert.deepEqual(await one('SELECT id, qty FROM item ORDER BY id'), [[1, 0], [2, 0]]);
    assert.deepEqual(await one(`SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'`), [['sqlite_sequence']], 'AUTOINCREMENT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new database (SQLite): createSqliteFile writes an empty valid database, never overwrites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonage-newlite-'));
  try {
    const file = join(dir, 'fresh.sqlite');
    await createSqliteFile(file);
    assert.ok(existsSync(file));
    assert.ok(!existsSync(`${file}.moonage-tmp`), 'tmp file renamed');
    const c = { name: 'x', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    assert.deepEqual(await sqliteDriver.objects(c, '', 'main', 'table'), []);
    const before = readFileSync(file);
    await assert.rejects(createSqliteFile(file), /already exists/);
    assert.deepEqual(readFileSync(file), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('new database (SQLite): connection name from the file name, made unique', () => {
  assert.equal(uniqueConnName('/x/shop.db', []), 'shop');
  assert.equal(uniqueConnName('C:\\data\\shop.sqlite3', ['other']), 'shop');
  assert.equal(uniqueConnName('/x/shop.db', ['shop', 'shop (2)']), 'shop (3)');
  assert.equal(uniqueConnName('/x/.db', []), '.db');
});

test('menus: New Database on SQLite connections, New Table on SQLite database and Tables folder', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (cmd: string, v: string) => items.some((it) => it.command === `moonageDaydream.${cmd}`
    && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(v));
  assert.ok(shown('newDatabase', 'conn.on') && shown('newDatabase', 'conn.off'));
  assert.ok(shown('newDatabase', 'conn.mssql.on') && shown('newDatabase', 'conn.live.off') && shown('newDatabase', 'ms.databases'));
  assert.ok(!shown('newDatabase', 'conn.consul.on') && !shown('newDatabase', 'db'));
  assert.ok(shown('newTable', 'db') && shown('newTable', 'folder.table') && shown('newTable', 'db.mssql') && shown('newTable', 'ms.tables'));
  assert.ok(!shown('newTable', 'folder.view') && !shown('newTable', 'conn.on'));
});

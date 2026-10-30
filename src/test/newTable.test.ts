import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTable, drivers, type NewColumn } from '../db';
import { columnsHtml } from '../columnsHtml';
import { msSchemasSql } from '../mssql';
import { PG_SCHEMAS_SQL } from '../postgres';

const ms = drivers.mssql.columnDdl!;
const t = { schema: 'dbo', name: 'order]item' };
const T = '[dbo].[order]]item]';
const id: NewColumn = { name: 'id', type: 'int', nullable: false, pk: true, ai: true };

test('new table: SQL Server CREATE TABLE with identity, defaults, PK, unique, FK (constraint names from the table)', () => {
  const r = createTable(ms, t, [
    id,
    { name: 'order_id', type: 'int', nullable: false, fk: { schema: 'sales', table: 'or]ders', column: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
    { name: 'sku', type: 'nvarchar(40)', nullable: false, unique: true },
    { name: 'qty', type: 'int', nullable: false, default: '0' },
    { name: 'note', type: 'nvarchar(max)', nullable: true },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    `CREATE TABLE ${T} (`,
    '    [id] int IDENTITY(1, 1) NOT NULL',
    '  , [order_id] int NOT NULL',
    '  , [sku] nvarchar(40) NOT NULL',
    '  , [qty] int NOT NULL CONSTRAINT [DF_order]]item_qty] DEFAULT (0)',
    '  , [note] nvarchar(max) NULL',
    '  , CONSTRAINT [PK_order]]item] PRIMARY KEY ([id])',
    '  , CONSTRAINT [UQ_order]]item_sku] UNIQUE ([sku])',
    '  , CONSTRAINT [FK_order]]item_order_id] FOREIGN KEY ([order_id]) REFERENCES [sales].[or]]ders] ([id]) ON DELETE CASCADE',
    ');',
  ].join('\n'));
});

test('new table: composite primary key in grid order, PK columns forced NOT NULL', () => {
  const r = createTable(ms, t, [{ name: 'a', type: 'int', nullable: true, pk: true }, { name: 'b', type: 'int', nullable: false, pk: true }]);
  assert.match(r.sql, /\[a\] int NOT NULL/);
  assert.match(r.sql, /CONSTRAINT \[PK_order]]item] PRIMARY KEY \(\[a\], \[b\]\)/);
});

test('new table: validation (table name, columns, AI integer + only one, FK target, duplicates)', () => {
  assert.deepEqual(createTable(ms, { schema: 'dbo', name: ' ' }, [id]).errors, ['Table name is required']);
  assert.deepEqual(createTable(ms, t, []).errors, ['Add at least one column']);
  assert.deepEqual(createTable(ms, t, [{ ...id, type: 'nvarchar(10)' }]).errors, ['id: auto increment needs an integer type (bigint, int, smallint, tinyint)']);
  assert.deepEqual(createTable(ms, t, [id, { ...id, name: 'id2' }]).errors, ['Only one auto increment column per table']);
  assert.deepEqual(createTable(ms, t, [id, { name: 'x', type: 'int', nullable: true, fk: { schema: 'dbo', table: '', column: '' } }]).errors, ['x: choose the referenced table and column']);
  assert.deepEqual(createTable(ms, t, [id, { name: 'ID', type: 'int', nullable: true }]).errors, ['Duplicate column name: ID']);
  assert.deepEqual(createTable(ms, t, [id, { name: 'n', type: 'nvarchar(9000)', nullable: true }]).errors, ['n: nvarchar: length 1-4000 or max']);
  assert.equal(createTable(ms, t, []).sql, '');
  assert.deepEqual(ms.fkActions, ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT']);
});

test('new table page: create mode has schema / name inputs, Create button, attribute chips; no Refresh / Revert', () => {
  const h = columnsHtml('csp', { conn: 'local', db: 'shop', table: 'New table' }, false, 'create');
  for (const id of ['tableSchema', 'tableName', 'execute', 'openSql', 'addCol', 'grid', 'preview']) assert.match(h, new RegExp(`id="${id}"`), id);
  assert.match(h, /const mode = 'create'/);
  assert.match(h, />Create</);
  assert.doesNotMatch(h, /id="refresh"/);
  assert.doesNotMatch(h, /id="revert"/);
  for (const chip of ['PK', 'AI', 'UQ', 'FK']) assert.match(h, new RegExp(`data-chip="${chip.toLowerCase()}"|'${chip}'`), chip);
  assert.doesNotMatch(columnsHtml('csp', { conn: 'local', db: 'shop', table: 'x' }, false), /id="tableName"/, 'edit mode unchanged');
});

test('menus: New Table on SQL Server databases and the Tables folder', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (viewItem: string) => items.some((it) => it.command === 'moonageDaydream.newTable'
    && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(viewItem));
  assert.ok(shown('db.mssql') && shown('ms.tables'));
  assert.ok(!shown('conn.mssql.on'));
  assert.ok(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === 'moonageDaydream.newTable' && c.title === 'New Table…'));
});

test('new table: schema list comes from the server (empty / user schemas too), system schemas left out', () => {
  assert.ok(drivers.mssql.schemas && drivers.postgres.schemas);
  assert.equal(drivers.mysql.schemas, undefined, 'MySQL: schema = database');
  const ms = msSchemasSql('sh]op');
  assert.match(ms, /FROM \[sh]]op\]\.sys\.schemas/);
  assert.match(ms, /schema_id < 16384/, 'db_* role schemas left out');
  assert.match(ms, /NOT IN \('sys', 'INFORMATION_SCHEMA', 'guest'\)/);
  assert.match(PG_SCHEMAS_SQL, /FROM pg_namespace/);
  assert.match(PG_SCHEMAS_SQL, /NOT LIKE 'pg\\_%'/);
  assert.match(PG_SCHEMAS_SQL, /<> 'information_schema'/);
});

const myd = drivers.mysql.columnDdl!;
test('new table: MySQL CREATE TABLE with AUTO_INCREMENT, PRIMARY KEY, UNIQUE KEY, FK constraint', () => {
  assert.equal(drivers.mariadb.columnDdl, myd);
  const r = createTable(myd, { schema: 'shop', name: 'order`item' }, [
    { ...id },
    { name: 'order_id', type: 'int unsigned', nullable: false, fk: { schema: 'shop', table: 'orders', column: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
    { name: 'sku', type: 'varchar(40)', nullable: false, unique: true },
    { name: 'qty', type: 'int', nullable: false, default: '0' },
    { name: 'note', type: 'text', nullable: true },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    'CREATE TABLE `shop`.`order``item` (',
    '  `id` int NOT NULL AUTO_INCREMENT,',
    '  `order_id` int unsigned NOT NULL,',
    '  `sku` varchar(40) NOT NULL,',
    '  `qty` int NOT NULL DEFAULT 0,',
    '  `note` text NULL,',
    '  PRIMARY KEY (`id`),',
    '  UNIQUE KEY `UQ_order``item_sku` (`sku`),',
    '  CONSTRAINT `FK_order``item_order_id` FOREIGN KEY (`order_id`) REFERENCES `shop`.`orders` (`id`) ON DELETE CASCADE',
    ');',
  ].join('\n'));
  // tanpa schema (database kosong): nama satu bagian, dijalankan di database itu
  assert.match(createTable(myd, { schema: '', name: 't' }, [id]).sql, /^CREATE TABLE `t` \(/);
});

test('new table: MySQL auto increment must be a key, integer types incl. unsigned, FK actions without SET DEFAULT', () => {
  assert.deepEqual(createTable(myd, { schema: '', name: 't' }, [{ name: 'n', type: 'bigint unsigned', nullable: false, ai: true }]).errors,
    ['n: auto increment needs PK or UQ (MySQL)']);
  assert.deepEqual(createTable(myd, { schema: '', name: 't' }, [{ name: 'n', type: 'bigint unsigned', nullable: false, ai: true, unique: true }]).errors, []);
  assert.ok(myd.aiTypes!.includes('int unsigned') && myd.aiTypes!.includes('tinyint'));
  assert.deepEqual(myd.fkActions, ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL']);
});

test('menus: New Table on MySQL / MariaDB / PostgreSQL databases and their Tables folder', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (v: string) => items.some((it) => it.command === 'moonageDaydream.newTable' && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(v));
  assert.ok(shown('db.live') && shown('folder.table'));
  assert.ok(!shown('folder.view'));
});

const pgt = drivers.postgres.columnDdl!;
test('new table: PostgreSQL CREATE TABLE with identity, PK, unique, FK (all five actions)', () => {
  const r = createTable(pgt, { schema: 'sales', name: 'order"item' }, [
    { name: 'id', type: 'integer', nullable: false, pk: true, ai: true },
    { name: 'order_id', type: 'bigint', nullable: false, fk: { schema: 'sales', table: 'orders', column: 'id', onDelete: 'SET DEFAULT', onUpdate: 'RESTRICT' } },
    { name: 'sku', type: 'varchar(40)', nullable: false, unique: true },
    { name: 'qty', type: 'integer', nullable: false, default: '0' },
    { name: 'note', type: 'text', nullable: true },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    'CREATE TABLE "sales"."order""item" (',
    '  "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
    '  "order_id" bigint NOT NULL,',
    '  "sku" varchar(40) NOT NULL,',
    '  "qty" integer NOT NULL DEFAULT 0,',
    '  "note" text NULL,',
    '  CONSTRAINT "PK_order""item" PRIMARY KEY ("id"),',
    '  CONSTRAINT "UQ_order""item_sku" UNIQUE ("sku"),',
    '  CONSTRAINT "FK_order""item_order_id" FOREIGN KEY ("order_id") REFERENCES "sales"."orders" ("id") ON DELETE SET DEFAULT ON UPDATE RESTRICT',
    ');',
  ].join('\n'));
  assert.deepEqual(pgt.aiTypes, ['smallint', 'integer', 'bigint']);
  assert.deepEqual(pgt.fkActions, ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);
  assert.deepEqual(createTable(pgt, { schema: 'public', name: 't' }, [{ name: 'n', type: 'numeric', nullable: false, ai: true }]).errors,
    ['n: auto increment needs an integer type (smallint, integer, bigint)']);
});

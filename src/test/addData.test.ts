import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { drivers, type Column, type DbObject } from '../db';
import { readFileSync } from 'fs';
import { join } from 'path';
import { insertScript } from '../addData';

const cols: Column[] = [
  { name: 'id', type: 'int', nullable: false, generated: true },
  { name: 'name', type: 'nvarchar(50)', nullable: false },
  { name: 'qty', type: 'int', nullable: true },
  { name: 'created', type: 'datetime', nullable: false, default: '(getdate())' },
];
const ms: DbObject = { schema: 'dbo', name: 'item' };

test('add data: SQL Server INSERT skips generated and empty columns, quotes names, literals by type', () => {
  const r = insertScript(drivers.mssql, ms, cols, { name: { value: "O'Neil" }, qty: { value: '5' } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, "INSERT INTO [dbo].[item] ([name], [qty])\nVALUES (N'O''Neil', 5);");
});

test('add data: NULL flag writes NULL, number is validated', () => {
  assert.equal(insertScript(drivers.mssql, ms, cols, { name: { value: 'a' }, qty: { value: '', isNull: true } }).sql,
    'INSERT INTO [dbo].[item] ([name], [qty])\nVALUES (N\'a\', NULL);');
  assert.match(insertScript(drivers.mssql, ms, cols, { name: { value: 'a' }, qty: { value: 'x' } }).errors[0], /qty.*not a number/);
});

test('add data: NOT NULL column without default must be filled, with default may stay empty', () => {
  const r = insertScript(drivers.mssql, ms, cols, {});
  assert.deepEqual(r.errors, ['name is required (NOT NULL, no default)']);
  assert.equal(r.sql, '');
  assert.deepEqual(insertScript(drivers.mssql, ms, cols, { name: { value: 'x' }, created: { value: '' } }).errors, []);
});

test('add data: NULL on a NOT NULL column is refused', () => {
  assert.deepEqual(insertScript(drivers.mssql, ms, cols, { name: { value: '', isNull: true } }).errors, ['name cannot be NULL']);
});

test('add data: no values at all = DEFAULT VALUES (SQL Server, PostgreSQL, SQLite) or () VALUES () (MySQL)', () => {
  const free: Column[] = [{ name: 'id', type: 'int', nullable: true }];
  assert.equal(insertScript(drivers.mssql, ms, free, {}).sql, 'INSERT INTO [dbo].[item] DEFAULT VALUES;');
  assert.equal(insertScript(drivers.postgres, { schema: 'public', name: 'item' }, free, {}).sql, 'INSERT INTO "public"."item" DEFAULT VALUES;');
  assert.equal(insertScript(drivers.sqlite, { schema: 'main', name: 'item' }, free, {}).sql, 'INSERT INTO "item" DEFAULT VALUES;');
  assert.equal(insertScript(drivers.mysql, { schema: 'shop', name: 'item' }, free, {}).sql, 'INSERT INTO `shop`.`item` () VALUES ();');
});

test('add data: PostgreSQL boolean and MySQL backslash literals', () => {
  const b: Column[] = [{ name: 'ok', type: 'boolean', nullable: true }, { name: 't', type: 'text', nullable: true }];
  assert.equal(insertScript(drivers.postgres, { schema: 'public', name: 'x' }, b, { ok: { value: 'true' }, t: { value: 'a\\b' } }).sql,
    'INSERT INTO "public"."x" ("ok", "t")\nVALUES (TRUE, \'a\\b\');');
  assert.equal(insertScript(drivers.mysql, { schema: 'd', name: 'x' }, b, { t: { value: 'a\\b' } }).sql, "INSERT INTO `d`.`x` (`t`)\nVALUES ('a\\\\b');");
});

test('add data: MongoDB insertOne with typed fields', () => {
  const mc: Column[] = [
    { name: '_id', type: 'objectId', nullable: true }, { name: 'name', type: 'string', nullable: true }, { name: 'qty', type: 'int', nullable: true },
    { name: 'ok', type: 'bool', nullable: true }, { name: 'at', type: 'date', nullable: true }, { name: 'tags', type: 'array', nullable: true },
  ];
  const r = insertScript(drivers.mongodb, { schema: 'shop', name: 'or"ders' }, mc,
    { name: { value: 'x' }, qty: { value: '3' }, ok: { value: 'true' }, at: { value: '2026-01-02T03:04:05Z' }, tags: { value: '["a","b"]' }, _id: { value: '' } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, 'db.getCollection("or\\"ders").insertOne({ "name": "x", "qty": 3, "ok": true, "at": ISODate("2026-01-02T03:04:05Z"), "tags": ["a","b"] });');
  assert.match(insertScript(drivers.mongodb, ms, mc, { tags: { value: '[oops' } }).errors[0], /tags.*not valid JSON/);
  assert.equal(insertScript(drivers.mongodb, ms, mc, { name: { value: '', isNull: true } }).sql, 'db.getCollection("item").insertOne({ "name": null });');
});

test('menus: Add Data on table nodes only, hidden from the palette', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (v: string) => items.some((it) => it.command === 'moonageDaydream.addData' && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(v));
  for (const v of ['table', 'table.def', 'table.def.ms.cols']) assert.ok(shown(v), v);
  for (const v of ['view.def', 'tables', 'db', 'folder.table']) assert.ok(!shown(v), v);
  assert.ok(pkg.contributes.menus.commandPalette.some((p: { command: string; when?: string }) => p.command === 'moonageDaydream.addData' && p.when === 'false'));
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTable, drivers, newDatabaseScript, type NewColumn } from '../db';
import { parseShell } from '../mongo';
import { columnsHtml } from '../columnsHtml';

const nd = drivers.mongodb.newDatabase!;
const ddl = drivers.mongodb.columnDdl!;
const id: NewColumn = { name: '_id', type: 'objectId', nullable: false, pk: true };

test('new database (MongoDB): createCollection on the new database, parseShell accepts it', () => {
  const r = newDatabaseScript(nd, ' shop2 ', { collection: ' orders ' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, 'db.createCollection("orders");');
  assert.equal(nd.useNewDatabase, true);
  assert.equal(nd.maxName, 63);
  const [op] = parseShell(r.sql);
  assert.equal(op.method, 'createCollection');
  assert.deepEqual(op.args, ['orders']);
});

test('new database (MongoDB): validation of database and first collection names', () => {
  assert.deepEqual(newDatabaseScript(nd, 'shop', { collection: '' }).errors, ['First collection is required']);
  assert.deepEqual(newDatabaseScript(nd, 'sh.op', { collection: 'a' }).errors, ['Database name cannot contain / \\ . " $ * < > : | ? or spaces']);
  assert.deepEqual(newDatabaseScript(nd, 'shop', { collection: 'system.x' }).errors, ['Collection name cannot start with "system." or contain "$"']);
  assert.deepEqual(newDatabaseScript(nd, 'shop', { collection: 'a$b' }).errors, ['Collection name cannot start with "system." or contain "$"']);
  assert.deepEqual(newDatabaseScript(nd, 'x'.repeat(64), { collection: 'a' }).errors, ['Database name is at most 63 characters']);
});

test('new table (MongoDB): createCollection with $jsonSchema validator + unique index, schema ignored', () => {
  const r = createTable(ddl, { schema: 'db', name: 'orders' }, [
    id,
    { name: 'sku', type: 'string', nullable: false, unique: true },
    { name: 'qty', type: 'int', nullable: false },
    { name: 'note', type: 'string', nullable: true },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    'db.createCollection("orders", { validator: { $jsonSchema: { bsonType: "object", required: ["sku", "qty"], properties: {',
    '  "sku": { bsonType: "string" },',
    '  "qty": { bsonType: "int" },',
    '  "note": { bsonType: "string" }',
    '} } } });',
    'db.getCollection("orders").createIndex({ "sku": 1 }, { unique: true, name: "UQ_orders_sku" });',
  ].join('\n'));
  const ops = parseShell(r.sql);
  assert.equal(ops.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ops[0].args[1])), { validator: { $jsonSchema: { bsonType: 'object', required: ['sku', 'qty'],
    properties: { sku: { bsonType: 'string' }, qty: { bsonType: 'int' }, note: { bsonType: 'string' } } } } });
  assert.equal(ops[1].method, 'createIndex');
});

test('new table (MongoDB): only _id -> plain createCollection; no required list when all optional', () => {
  assert.equal(createTable(ddl, { schema: 'db', name: 'logs' }, [id]).sql, 'db.createCollection("logs");');
  assert.equal(createTable(ddl, { schema: 'db', name: 'l' }, [{ name: 'at', type: 'date', nullable: true }]).sql,
    'db.createCollection("l", { validator: { $jsonSchema: { bsonType: "object", properties: {\n  "at": { bsonType: "date" }\n} } } });');
});

test('new table (MongoDB): validation (default, PK other than _id, AI / FK not supported)', () => {
  const o = { schema: 'db', name: 'c' };
  assert.deepEqual(createTable(ddl, o, [id, { name: 'n', type: 'int', nullable: true, default: '0' }]).errors, ['n: MongoDB has no column defaults (set values when inserting)']);
  assert.deepEqual(createTable(ddl, o, [{ name: 'code', type: 'string', nullable: false, pk: true }]).errors, ['code: only _id is the primary key in MongoDB']);
  assert.deepEqual(createTable(ddl, o, [{ ...id, ai: true }]).errors, ['_id: auto increment is not supported here']);
  assert.deepEqual(createTable(ddl, o, [id, { name: 'u', type: 'objectId', nullable: true, fk: { schema: 'db', table: 'users', column: '_id' } }]).errors,
    ['u: foreign keys are not supported here']);
  assert.equal(ddl.aiTypes, undefined);
  assert.equal(ddl.fkActions, undefined);
});

test('new table page: AI / FK chips only when the load message enables them', () => {
  const h = columnsHtml('csp', { conn: 'm', db: 'shop', table: 'New table' }, false, 'create');
  assert.match(h, /canAi = m\.ai !== false/);
  assert.match(h, /canFk = m\.fk !== false/);
  assert.match(h, /\(canAi \? chip\('ai'/);
  assert.match(h, /\(canFk \? chip\('fk'/);
});

test('menus: New Database / New Table also on MongoDB connections and databases', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (cmd: string, viewItem: string) => items.some((it) => it.command === `moonageDaydream.${cmd}`
    && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(viewItem));
  assert.ok(shown('newDatabase', 'conn.on') && shown('newDatabase', 'conn.off') && shown('newDatabase', 'conn.mssql.on') && shown('newDatabase', 'conn.live.off'));
  assert.ok(!shown('newDatabase', 'conn.consul.on'));
  assert.ok(shown('newTable', 'db') && shown('newTable', 'db.mssql') && shown('newTable', 'db.live') && shown('newTable', 'ms.tables'));
  assert.ok(!shown('newTable', 'conn.on'));
});

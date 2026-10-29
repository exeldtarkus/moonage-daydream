import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { addLimit, editLiteral, maskSql, sqlLiteral, tableRefs, updateScript } from '../sqlContext';
import { toResult } from '../sqlDriver';
import { toRaw as myRaw, typeName } from '../mysql';
import { toRaw as pgRaw } from '../postgres';
import { sqliteDriver, writes } from '../sqlite';
import { toConnection, validate } from '../connectionFormHtml';
import { drivers } from '../db';
import { formatSql } from '../sqlFormat';

test('addLimit: LIMIT / OFFSET at the end, own LIMIT or FOR UPDATE untouched', () => {
  assert.equal(addLimit('SELECT * FROM t;', 100), 'SELECT * FROM t\nLIMIT 100');
  assert.equal(addLimit('SELECT * FROM t -- c', 2000, 1000), 'SELECT * FROM t -- c\nLIMIT 1000 OFFSET 1000');
  assert.equal(addLimit('SELECT * FROM t LIMIT 5', 100), undefined);
  assert.equal(addLimit('SELECT * FROM t FOR UPDATE', 100), undefined);
  assert.equal(addLimit("SELECT 'limit' FROM (SELECT 1 LIMIT 1) x", 10), "SELECT 'limit' FROM (SELECT 1 LIMIT 1) x\nLIMIT 10");
});

test('toResult: server LIMIT vs client cut, MAX_ROWS, limited', () => {
  const raw = { sets: [{ columns: ['a'], types: ['int'], rows: Array.from({ length: 1500 }, (_, i) => [i]) }], affected: [] };
  const server = toResult(raw, Date.now(), 2500, 1000, true).resultSets[0];
  assert.deepEqual([server.total, server.rows.length, server.rows[0][0], server.limited], [2500, 1000, 0, 2500]);
  const client = toResult(raw, Date.now(), 1200, 1000).resultSets[0];
  assert.deepEqual([client.total, client.rows.length, client.rows[0][0], client.limited], [1200, 200, 1000, 1200]);
  const none = toResult(raw, Date.now()).resultSets[0];
  assert.deepEqual([none.total, none.rows.length, none.limited], [1500, 1000, undefined]);
});

test('mysql: multipleStatements results and type names', () => {
  const f = (name: string, columnType: number) => ({ name, columnType });
  const single = myRaw([[1, 'a']], [f('id', 3), f('n', 253)]);
  assert.deepEqual(single.sets[0], { columns: ['id', 'n'], types: ['int', 'varchar'], rows: [[1, 'a']] });
  const multi = myRaw([[[1]], { affectedRows: 2 }], [[f('x', 8)], undefined]);
  assert.deepEqual([multi.sets.length, multi.sets[0].types[0], multi.affected], [1, 'bigint', [2]]);
  assert.deepEqual(myRaw({ affectedRows: 3 }, undefined), { sets: [], affected: [3] });
  assert.equal(typeName({ columnType: 252, characterSet: 63 }), 'blob');
  assert.equal(typeName({ columnType: 252, characterSet: 45 }), 'text');
});

test('postgres: one or many results, type names from OID', () => {
  const sel = { fields: [{ name: 'id', dataTypeID: 23 }], rows: [[1]], rowCount: 1 };
  const ins = { fields: [], rows: [], rowCount: 4 };
  const raw = pgRaw([sel, ins] as never);
  assert.deepEqual(raw, { sets: [{ columns: ['id'], types: ['int4'], rows: [[1]] }], affected: [4] });
});

test('dialect literals and UPDATE script', () => {
  assert.equal(sqlLiteral("a'b\\c", 'mysql'), "'a''b\\\\c'");
  assert.equal(sqlLiteral("a'b", 'postgres'), "'a''b'");
  assert.equal(sqlLiteral(true, 'postgres'), 'TRUE');
  assert.equal(sqlLiteral(new Uint8Array([1, 255]), 'sqlite'), "X'01FF'");
  assert.equal(sqlLiteral(new Uint8Array([1]), 'postgres'), "'\\x01'::bytea");
  assert.equal(editLiteral('1', 'boolean', 'postgres'), 'TRUE');
  assert.equal(editLiteral('7', 'int(11)', 'mysql'), '7');
  assert.throws(() => editLiteral('x', 'int4', 'postgres'), /not a number/);
  const s = updateScript('"public"."t"', ['id', 'n'], ['int4', 'text'], [[1, 'a']], ['id'], [{ row: 0, col: 1, value: 'b' }], (n) => `"${n}"`, 'postgres');
  assert.ok(s.includes(`UPDATE "public"."t"\nSET "n" = 'b'\nWHERE "id" = 1;`) && s.includes('\nBEGIN;\n'), s);
});

test('backtick / double quoted identifiers', () => {
  assert.equal(maskSql('SELECT `a;b` FROM t'), 'SELECT       FROM t');
  assert.deepEqual(tableRefs('SELECT * FROM `shop`.`orders` o JOIN "public"."x" y ON 1=1'),
    [{ parts: ['shop', 'orders'], alias: 'o' }, { parts: ['public', 'x'], alias: 'y' }]);
});

test('connection form: type, SQLite file, default fields', () => {
  const base = { name: 'n', host: 'h', port: '3306', instance: 'X', user: 'root', password: '', database: 'shop', trust: true };
  assert.equal(validate({ ...base, type: 'sqlite', host: '', file: ' ' }, { get: () => undefined }), 'Database file is required');
  assert.equal(validate({ ...base, type: 'nope' }, { get: () => undefined }), 'Unknown database type nope');
  assert.deepEqual(toConnection({ ...base, type: 'sqlite', file: ' /x/a.db ' }), { name: 'n', type: 'sqlite', host: '', port: 0, user: '', database: '', trustServerCertificate: false, file: '/x/a.db' });
  const my = toConnection({ ...base, type: 'mysql' });
  assert.equal(my.instance, undefined, 'mssql-only fields dropped');
  assert.equal(my.port, 3306);
  assert.deepEqual(Object.keys(drivers).sort(), ['mariadb', 'mongodb', 'mssql', 'mysql', 'postgres', 'sqlite']);
});

test('formatter follows the dialect', () => {
  const opts = { keywordCase: 'upper' as const, leadingComma: false, semicolonNewline: false, tabWidth: 2, useTabs: false };
  assert.match(formatSql('select `a` from t limit 1', { ...opts, language: 'mysql' }), /SELECT\n {2}`a`\nFROM\n {2}t\nLIMIT\n {2}1/);
  assert.match(formatSql('select a::int from t', { ...opts, language: 'postgresql' }), /a::int/);
});

test('sqlite driver: run, auto limit, explorer, session commit / rollback on a real file', async () => {
  assert.ok(writes('INSERT INTO t VALUES (1)') && !writes('SELECT 1; PRAGMA table_info(t)'));
  const dir = mkdtempSync(join(tmpdir(), 'moonage-sqlite-'));
  try {
    const file = join(dir, 'shop.db');
    writeFileSync(file, '');
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const d = sqliteDriver;
    const setup = await d.run(c, '', `CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL);
      CREATE VIEW cheap AS SELECT * FROM item WHERE price < 5;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250) INSERT INTO item SELECT i, 'item ' || i, i * 0.5 FROM n;`);
    assert.deepEqual(setup.resultSets, []);
    assert.ok(readFileSync(file).length > 0, 'changes written to the file');

    const r = await d.run(c, '', 'SELECT id, name FROM item ORDER BY id;', undefined, 100);
    assert.deepEqual([r.resultSets[0].rows.length, r.resultSets[0].total, r.resultSets[0].limited, r.resultSets[0].columns], [100, 100, 100, ['id', 'name']]);
    const more = await d.run(c, '', 'SELECT id FROM item ORDER BY id', undefined, 200, 100);
    assert.deepEqual([more.resultSets[0].rows[0][0], more.resultSets[0].rows.length, more.resultSets[0].total], [101, 100, 200]);
    const two = await d.run(c, '', 'SELECT COUNT(*) FROM item; SELECT name FROM cheap ORDER BY id LIMIT 1;');
    assert.deepEqual(two.resultSets.map((s) => s.rows[0][0]), [250, 'item 1']);

    assert.deepEqual(await d.databases(c, ''), ['main']);
    assert.deepEqual(await d.objects(c, '', 'main', 'table'), [{ schema: 'main', name: 'item' }]);
    assert.deepEqual(await d.objects(c, '', 'main', 'view'), [{ schema: 'main', name: 'cheap' }]);
    assert.deepEqual((await d.columns(c, '', 'main', { schema: 'main', name: 'item' })).map((x) => `${x.name}:${x.type}:${x.nullable}`),
      ['id:integer:true', 'name:text:false', 'price:real:true']);
    assert.deepEqual(await d.primaryKey(c, '', 'main', { schema: 'main', name: 'item' }), ['id']);

    const s = await d.session(c, '');
    await s.run("UPDATE item SET name = 'changed' WHERE id = 1");
    assert.ok(s.open);
    await s.rollback();
    assert.equal((await d.run(c, '', 'SELECT name FROM item WHERE id = 1')).resultSets[0].rows[0][0], 'item 1', 'rollback leaves the file');
    await s.run("UPDATE item SET name = 'committed' WHERE id = 1");
    await s.commit();
    await s.close();
    assert.equal((await d.run(c, '', 'SELECT name FROM item WHERE id = 1')).resultSets[0].rows[0][0], 'committed');

    const rows: unknown[][] = [];
    assert.equal(await d.stream(c, '', 'SELECT id FROM item', undefined, { columns: () => undefined, row: (v) => { rows.push(v); } }), 250);
    assert.equal(d.explain?.('SELECT 1', 'estimated'), 'EXPLAIN QUERY PLAN SELECT 1');
    assert.equal(d.explain?.('SELECT 1', 'actual'), undefined);
    await assert.rejects(d.run(c, '', 'SELECT * FROM missing'), /no such table/);
    await assert.rejects(d.run({ ...c, file: join(dir, 'nope.db') }, '', 'SELECT 1'), /not found/);
    assert.ok(!existsSync(`${file}.moonage-tmp`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mongodb: shell text -> commands, documents -> grid', async () => {
  const { parseShell, toSet, cellValue } = await import('../mongo');
  const { ObjectId } = await import('mongodb');
  const ops = parseShell(`const n = 5; // komentar JS
    db.users.find({ age: { $gt: n } }, { name: 1 }).sort({ name: 1 }).limit(n);
    db.getCollection('a.b').countDocuments();
    db.system.views.find();
    db.getName();`);
  assert.deepEqual(ops.map((o) => [o.coll, o.method, o.chain.map((c) => c.method)]),
    [['users', 'find', ['sort', 'limit']], ['a.b', 'countDocuments', []], ['system.views', 'find', []], [undefined, 'getName', []]]);
  assert.deepEqual(ops[0].args, [{ age: { $gt: 5 } }, { name: 1 }]);
  const [q] = parseShell("db.x.find({ _id: ObjectId('64b7f0c2a1b2c3d4e5f60718'), at: ISODate('2025-01-01'), n: /ab+/i, in: [new Date(0)] })");
  const f = q.args[0] as Record<string, unknown>;
  assert.ok(f instanceof Object && f._id instanceof ObjectId && f.at instanceof Date && f.n instanceof RegExp && Array.isArray(f.in) && (f.in as unknown[])[0] instanceof Date, 'host realm values');
  assert.throws(() => parseShell('const x = 1;'), /No MongoDB command/);
  assert.throws(() => parseShell('db.x.find().each()'), /each\(\) is not supported/);
  assert.throws(() => parseShell('while (true) {}'), /timed out/);
  const rs = toSet([{ _id: new ObjectId('64b7f0c2a1b2c3d4e5f60718'), a: 1 }, { b: { c: [1, 2] }, a: null }]);
  assert.deepEqual(rs.columns, ['_id', 'a', 'b']);
  assert.deepEqual(rs.types, ['objectId', 'int', 'object']);
  assert.deepEqual(rs.rows, [['64b7f0c2a1b2c3d4e5f60718', 1, null], [null, null, '{"c":[1,2]}']]);
  assert.equal(cellValue(new Date(0)), '1970-01-01T00:00:00.000Z');
  assert.ok(drivers.mongodb.autoLimitable!(['db.x.find()']) && !drivers.mongodb.autoLimitable!(['db.x.find().limit(1)']));
  assert.equal(drivers.mongodb.formatter, undefined);
});

test('numeric column types of every driver are right aligned', async () => {
  const { NUMERIC } = await import('../resultsHtml');
  for (const t of ['int', 'decimal(12,0)', 'decimal(12, 2)', 'int unsigned', 'int4', 'float8', 'double', 'long', 'numeric']) assert.ok(NUMERIC.test(t), t);
  for (const t of ['varchar(10)', 'interval', 'point', 'nvarchar(max)']) assert.ok(!NUMERIC.test(t), t);
});

test('mongodb completion context', async () => {
  const { mongoContext } = await import('../mongoContext');
  assert.deepEqual(mongoContext('db.'), { kind: 'db', word: '' });
  assert.deepEqual(mongoContext('db.getCo'), { kind: 'db', word: 'getCo' });
  assert.deepEqual(mongoContext('db.orders.fi'), { kind: 'collection', coll: 'orders', word: 'fi' });
  assert.deepEqual(mongoContext('db.system.views.'), { kind: 'collection', coll: 'system.views', word: '' });
  assert.deepEqual(mongoContext('db.getCollection("customers").'), { kind: 'collection', coll: 'customers', word: '' });
  assert.deepEqual(mongoContext('db.getCollection("cu'), { kind: 'collectionName', word: 'cu' });
  assert.deepEqual(mongoContext('db.getCollection("customers").find({}).li'), { kind: 'cursor', word: 'li' });
  assert.deepEqual(mongoContext('db.orders.find({ sta'), { kind: 'field', coll: 'orders', word: 'sta' });
  assert.deepEqual(mongoContext('db.orders.find({ status: "paid", total: { $'), { kind: 'field', coll: 'orders', word: '$' });
  assert.deepEqual(mongoContext('db.getCollection("customers").find({}).sort({ '), { kind: 'field', coll: 'customers', word: '' });
  assert.deepEqual(mongoContext('db.orders.find({}); '), { kind: 'top', word: '' });
  assert.deepEqual(mongoContext('d'), { kind: 'top', word: 'd' });
});

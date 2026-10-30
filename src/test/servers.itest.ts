// Test driver ke server sungguhan (Docker, lihat scripts/test-servers.sh): database "shop" sementara, boleh ditulis.
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { columnChanges, drivers, showColumns, type ColumnRow } from '../db';
import type { ConnectionInfo, DbType } from '../db';
import { updateScript } from '../sqlContext';

const PW = process.env.MOONAGE_TEST_PW ?? '';
const SERVERS: { type: DbType; port: number; user: string; sleep: string }[] = [
  { type: 'mysql', port: 13306, user: 'root', sleep: 'SELECT SLEEP(20)' },
  { type: 'mariadb', port: 13307, user: 'root', sleep: 'SELECT SLEEP(20)' },
  { type: 'postgres', port: 15432, user: 'postgres', sleep: 'SELECT pg_sleep(20)' },
];
const conns: ConnectionInfo[] = [];
after(() => Promise.all(conns.map((c) => drivers[c.type].close(c.name))));

for (const s of SERVERS) {
  const c: ConnectionInfo = { name: `it-${s.type}`, type: s.type, host: '127.0.0.1', port: s.port, user: s.user, database: 'shop', trustServerCertificate: false };
  conns.push(c);
  const d = drivers[s.type];
  const run = (sql: string, limit?: number, skip?: number) => d.run(c, PW, sql, undefined, limit, skip);
  const one = async (sql: string) => (await run(sql)).resultSets[0].rows[0][0];

  test(`${d.label}: query, auto limit, load more, multi statements, dates as text`, async () => {
    const rows = Array.from({ length: 250 }, (_, i) => `(${i + 1}, 'item ${i + 1}', ${(i + 1) / 2}, '2025-01-02 03:04:05')`).join(', ');
    await run(`DROP VIEW IF EXISTS cheap; DROP TABLE IF EXISTS item;
      CREATE TABLE item (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(10,2), created TIMESTAMP NULL);
      CREATE VIEW cheap AS SELECT * FROM item WHERE price < 5;
      INSERT INTO item VALUES ${rows};`);
    const test = (await run(d.testSql)).resultSets[0].rows[0];
    assert.equal(test[1], 'shop');

    const lim = (await run('SELECT * FROM item ORDER BY id;', 100)).resultSets[0];
    assert.deepEqual([lim.rows.length, lim.total, lim.limited, lim.columns], [100, 100, 100, ['id', 'name', 'price', 'created']]);
    assert.equal(lim.rows[0][3], '2025-01-02 03:04:05', 'date not shifted by time zone');
    assert.match(String(lim.types?.[0]), /int/);
    const more = (await run('SELECT id FROM item ORDER BY id', 1100, 100)).resultSets[0];
    assert.deepEqual([more.rows[0][0], more.rows.length, more.total, more.limited], [101, 150, 250, undefined]);
    const own = (await run('SELECT id FROM item ORDER BY id LIMIT 3', 100)).resultSets[0];
    assert.deepEqual(own.rows.map((r) => r[0]), [1, 2, 3]);

    const multi = await run("SELECT COUNT(*) AS n FROM item; UPDATE item SET name = name WHERE id = 1; SELECT name FROM cheap WHERE id = 2;");
    assert.deepEqual(multi.resultSets.map((r) => String(r.rows[0][0])), ['250', 'item 2']);
    assert.equal(multi.rowsAffected.length, 1);
  });

  test(`${d.label}: cancel stops the query on the server`, async () => {
    const ac = new AbortController();
    const t = Date.now();
    setTimeout(() => ac.abort(), 700);
    await assert.rejects(d.run(c, PW, s.sleep, ac.signal));
    assert.ok(Date.now() - t < 8000, `cancel took ${Date.now() - t} ms`);
    assert.equal(String(await one('SELECT 1')), '1', 'pool still usable');
  });

  test(`${d.label}: manual transaction on its own connection (rollback / commit)`, async () => {
    const tx = await d.session(c, PW);
    try {
      await tx.run("UPDATE item SET name = 'tx' WHERE id = 1");
      assert.ok(tx.open);
      assert.equal(await one('SELECT name FROM item WHERE id = 1'), 'item 1', 'other connections do not see uncommitted change');
      await tx.rollback();
      assert.equal(await one('SELECT name FROM item WHERE id = 1'), 'item 1');
      await tx.run("UPDATE item SET name = 'committed' WHERE id = 1");
      await tx.commit();
      assert.ok(!tx.open);
      assert.equal(await one('SELECT name FROM item WHERE id = 1'), 'committed');
    } finally {
      await tx.close();
    }
  });

  test(`${d.label}: manual transaction state from the server (SELECT, script COMMIT, DDL implicit commit, PostgreSQL aborted)`, async () => {
    const tx = await d.session(c, PW);
    try {
      await tx.run('SELECT 1');
      assert.ok(!tx.open, 'SELECT opens no transaction');
      await tx.run("UPDATE item SET name = 'a' WHERE id = 2");
      assert.ok(tx.open, 'UPDATE opens');
      await tx.run('COMMIT');
      assert.ok(!tx.open, 'COMMIT in the script closes the transaction');
      await tx.run("UPDATE item SET name = 'b' WHERE id = 2");
      if (s.type === 'postgres') {
        await assert.rejects(tx.run('SELECT 1/0'));
        assert.ok(tx.open && tx.failed, 'error aborts the transaction');
        await assert.rejects(tx.commit(), /aborted/);
        assert.ok(!tx.open && !tx.failed);
        assert.equal(await one('SELECT name FROM item WHERE id = 2'), 'a', 'aborted transaction rolled back');
      } else {
        await tx.run('CREATE TABLE ddl_commit (a INT)');
        assert.ok(!tx.open, 'DDL commits implicitly');
        assert.equal(await one('SELECT name FROM item WHERE id = 2'), 'b', 'change before the DDL is committed');
        await run('DROP TABLE ddl_commit');
      }
    } finally {
      await tx.close();
    }
  });

  test(`${d.label}: procedure / function / view definition, edit and run scripts`, async () => {
    const proc = { schema: s.type === 'postgres' ? 'public' : 'shop', name: s.type === 'postgres' ? 'bump' : 'get_total' };
    const fn = { schema: proc.schema, name: 'twice' };
    const view = { schema: proc.schema, name: 'cheap' };
    if (s.type === 'postgres') {
      await run("CREATE OR REPLACE FUNCTION twice(a int, b int DEFAULT 1) RETURNS int LANGUAGE sql AS $$ SELECT a * 2 * b $$;\n"
        + 'CREATE OR REPLACE PROCEDURE bump(IN i int, INOUT n int) LANGUAGE plpgsql AS $$ BEGIN n := n + i; END $$;');
      assert.match(await d.definition!(c, PW, 'shop', fn, 'procedure'), /CREATE OR REPLACE FUNCTION public\.twice/);
      const f = await d.runScript!(c, PW, 'shop', fn);
      assert.match(f.sql, /-- , b => NULL -- integer \(has default\)/);
      assert.equal(String((await run(f.sql.replace('a => NULL', 'a => 21'))).resultSets[0].rows[0][0]), '42', 'function with a default');
      const p = await d.runScript!(c, PW, 'shop', proc);
      assert.equal(String((await run(p.sql.replace('i => NULL', 'i => 2').replace('n => NULL', 'n => 40'))).resultSets[0].rows[0][0]), '42', 'CALL with INOUT');
      assert.deepEqual((await d.parameters!(c, PW, 'shop', proc)).map((x) => [x.name, x.mode]), [['i', 'in'], ['n', 'inout']]);
    } else {
      await run('DROP PROCEDURE IF EXISTS get_total; DROP FUNCTION IF EXISTS twice;');
      await run('CREATE PROCEDURE get_total(IN min_id INT, OUT total DECIMAL(12,2))\nBEGIN\n  SELECT SUM(price) INTO total FROM item WHERE id >= min_id;\nEND');
      await run('CREATE FUNCTION twice(a INT) RETURNS INT DETERMINISTIC RETURN a * 2');
      assert.match(await d.definition!(c, PW, 'shop', proc, 'procedure'), /CREATE .*PROCEDURE `get_total`/);
      assert.deepEqual((await d.parameters!(c, PW, 'shop', proc)).map((x) => [x.name, x.mode]), [['min_id', 'in'], ['total', 'out']]);
      const p = await d.runScript!(c, PW, 'shop', proc);
      const out = await run(p.sql.replace('NULL -- min_id', '249 -- min_id'));
      assert.equal(String(out.resultSets.at(-1)!.rows[0][0]), '249.50', 'CALL with OUT variable');
      const f = await d.runScript!(c, PW, 'shop', fn);
      assert.equal(String((await run(f.sql.replace('NULL -- a', '21 -- a'))).resultSets[0].rows[0][0]), '42', 'SELECT function');
      await run(await d.editScript!(c, PW, 'shop', fn, 'procedure'));
    }
    await run(await d.editScript!(c, PW, 'shop', proc, 'procedure')); // edit script recreates the routine
    assert.ok(await d.definition!(c, PW, 'shop', proc, 'procedure'), 'still there after the edit script');
    const v = await d.editScript!(c, PW, 'shop', view, 'view');
    assert.match(v, /CREATE OR REPLACE/);
    await run(v);
    assert.equal(String(await one('SELECT COUNT(*) FROM cheap')), '9', 'view replaced, same rows');
  });

  test(`${d.label}: Columns editor script (show, rename, change, add, drop) on the server`, { skip: !d.columnDdl }, async () => {
    const ddl = d.columnDdl!;
    await run(`DROP TABLE IF EXISTS column_lab; CREATE TABLE column_lab (
      id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(50) COLLATE utf8mb4_bin NOT NULL DEFAULT 'none' COMMENT 'the title',
      qty INT UNSIGNED NOT NULL DEFAULT 0, price DECIMAL(10,2) NULL, flag TINYINT(1) NOT NULL DEFAULT 1, kind ENUM('a b','c') NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
      total DECIMAL(12,2) AS (qty * price));
      INSERT INTO column_lab (title, qty, price) VALUES ('apple', 5, 1.50);`);
    const o = { schema: 'shop', name: 'column_lab' };
    const load = async () => showColumns((await run(ddl.show(o))).resultSets[0]).cols;
    const cols = await load();
    const by = (cs: ColumnRow[], n: string) => cs.find((x) => x.name === n)!;
    assert.deepEqual(by(cols, 'id'), { name: 'id', type: 'int', nullable: false, generated: true });
    assert.deepEqual(by(cols, 'title'), { name: 'title', type: 'varchar(50)', nullable: false, default: "'none'", keep: "COLLATE utf8mb4_bin COMMENT 'the title'" });
    assert.deepEqual(by(cols, 'qty'), { name: 'qty', type: 'int unsigned', nullable: false, default: '0' });
    assert.equal(by(cols, 'flag').type, 'tinyint(1)');
    assert.deepEqual(by(cols, 'kind'), { name: 'kind', type: "enum('a b','c')", nullable: true });
    assert.match(String(by(cols, 'created_at').default), /^current_timestamp\(3\)$/i);
    assert.match(String(by(cols, 'updated_at').keep), /^on update current_timestamp/i);
    assert.ok(by(cols, 'total').generated);

    const rows: ColumnRow[] = cols.map((x) => ({ ...x, orig: x.name }));
    const edit = (n: string, ch: Partial<ColumnRow>) => Object.assign(rows.find((x) => x.orig === n)!, ch);
    edit('id', { name: 'item_id' });
    edit('title', { type: 'varchar(80)' });
    edit('qty', { default: '1' });
    edit('flag', { deleted: true });
    edit('total', { name: 'total2' });
    edit('updated_at', { nullable: true, default: 'NULL' });
    rows.push({ name: 'note', type: 'varchar(20)', nullable: false, default: "'x'" });
    const r = columnChanges(ddl, o, cols, rows);
    assert.deepEqual(r.errors, []);
    assert.equal(r.count, 7);
    await run(r.sql);

    const after = await load();
    assert.deepEqual(after.map((x) => x.name), ['item_id', 'title', 'qty', 'price', 'kind', 'created_at', 'updated_at', 'total2', 'note']);
    assert.ok(by(after, 'item_id').generated, 'auto_increment kept by RENAME COLUMN');
    assert.deepEqual(by(after, 'title'), { ...by(cols, 'title'), type: 'varchar(80)' }, 'collation + comment kept by CHANGE COLUMN');
    assert.equal(by(after, 'qty').default, '1');
    assert.match(String(by(after, 'updated_at').keep), /^on update current_timestamp/i, 'ON UPDATE kept');
    assert.ok(by(after, 'total2').generated);
    assert.deepEqual(by(after, 'note'), { name: 'note', type: 'varchar(20)', nullable: false, default: "'x'", keep: by(after, 'note').keep });
    assert.equal(String(await one('SELECT COUNT(*) FROM column_lab WHERE note = \'x\' AND qty = 5')), '1', 'data kept');
    await run('DROP TABLE column_lab');
  });

  test(`${d.label}: explorer, primary key, explain, export stream, UPDATE script`, async () => {
    assert.ok((await d.databases(c, PW)).includes('shop'));
    const schema = s.type === 'postgres' ? 'public' : 'shop';
    assert.deepEqual(await d.objects(c, PW, 'shop', 'table'), [{ schema, name: 'item' }]);
    assert.deepEqual(await d.objects(c, PW, 'shop', 'view'), [{ schema, name: 'cheap' }]);
    const cols = await d.columns(c, PW, 'shop', { schema, name: 'item' });
    assert.deepEqual(cols.map((x) => x.name), ['id', 'name', 'price', 'created']);
    assert.deepEqual(cols.map((x) => x.nullable), [false, false, true, true]);
    assert.match(cols[1].type, /varchar\(50\)|character varying\(50\)/);
    assert.deepEqual(await d.primaryKey(c, PW, 'shop', { schema, name: 'item' }), ['id']);
    assert.match(d.selectTop('shop', { schema, name: 'item' }, 5), /LIMIT 5;$/);
    assert.equal((await run(d.selectTop('shop', { schema, name: 'item' }, 5))).resultSets[0].rows.length, 5);

    for (const mode of ['estimated', 'actual'] as const) {
      const sql = d.explain!('SELECT * FROM item WHERE id = 3', mode)!;
      assert.ok((await run(sql)).resultSets[0].rows.length > 0, `${mode}: ${sql}`);
    }
    let n = 0;
    assert.equal(await d.stream(c, PW, 'SELECT * FROM item', undefined, { columns: () => undefined, row: () => { n++; } }), 250);
    assert.equal(n, 250);

    const table = s.type === 'postgres' ? `${d.quote('public')}.${d.quote('item')}` : `${d.quote('shop')}.${d.quote('item')}`;
    const script = updateScript(table, ['id', 'name', 'price'], ['int', 'varchar', 'decimal'], [[5, 'item 5', '2.50']], ['id'],
      [{ row: 0, col: 1, value: "it's \\ new" }, { row: 0, col: 2, value: '9.75' }], d.quote, d.dialect);
    const r = await run(`${script}\nSELECT name, price FROM item WHERE id = 5;\nROLLBACK;`);
    assert.deepEqual(r.resultSets[0].rows[0].map(String), ["it's \\ new", '9.75'], script);
    assert.equal(await one('SELECT name FROM item WHERE id = 5'), 'item 5', 'script was rolled back');
  });
}

test('MongoDB: shell queries, auto limit, cancel, explorer, export', async () => {
  const c: ConnectionInfo = { name: 'it-mongodb', type: 'mongodb', host: '127.0.0.1', port: 27018, user: 'root', database: 'shop', trustServerCertificate: false, authSource: 'admin' };
  conns.push(c);
  const d = drivers.mongodb;
  const run = (sql: string, limit?: number, skip?: number) => d.run(c, PW, sql, undefined, limit, skip);
  await run(`db.item.drop(); db.cheap.drop();
    db.item.insertMany(Array.from({ length: 250 }, (_, i) => ({ _id: i + 1, name: 'item ' + (i + 1), price: (i + 1) / 2, tags: ['a', 'b'], created: ISODate('2025-01-02T03:04:05Z') })));
    db.createCollection('cheap', { viewOn: 'item', pipeline: [{ $match: { price: { $lt: 5 } } }] });`);
  assert.deepEqual((await run(d.testSql)).resultSets[0].columns, ['server', 'db']);

  const q = 'db.item.find({ price: { $gte: 1 } }).sort({ _id: 1 })';
  assert.ok(d.autoLimitable!([q]) && !d.autoLimitable!(['db.item.find().limit(5)']) && !d.autoLimitable!(['db.item.countDocuments()']));
  const lim = (await run(q, 100)).resultSets[0];
  assert.deepEqual([lim.rows.length, lim.total, lim.limited, lim.columns], [100, 100, 100, ['_id', 'name', 'price', 'tags', 'created']]);
  assert.deepEqual(lim.rows[0], [2, 'item 2', 1, '["a","b"]', '2025-01-02T03:04:05.000Z']);
  assert.deepEqual(lim.types, ['int', 'string', 'int', 'array', 'date']);
  const more = (await run(q, 1100, 100)).resultSets[0];
  assert.deepEqual([more.rows[0][0], more.rows.length, more.total], [102, 149, 249]);

  const multi = await run(`const min = 3;
    db.item.countDocuments({ price: { $gte: min } });
    db.item.aggregate([{ $group: { _id: null, total: { $sum: '$price' } } }]);
    db.item.distinct('tags');
    db.getCollection('cheap').find({}, { name: 1 }).sort({ _id: -1 }).limit(2);`);
  assert.deepEqual(multi.resultSets.map((r) => r.rows), [[[245]], [[null, 15687.5]], [['a'], ['b']], [[9, 'item 9'], [8, 'item 8']]]);

  const upd = (await run("db.item.updateOne({ _id: 1 }, { $set: { name: 'changed' } })")).resultSets[0];
  assert.equal(upd.rows[0][upd.columns.indexOf('modifiedCount')], 1);
  const one = (await run('db.item.findOne({ _id: 1 }, { name: 1, _id: 0 })')).resultSets[0];
  assert.deepEqual([one.columns, one.rows], [['name'], [['changed']]]);

  const plan = (await run(d.explain!('db.item.find({ _id: 3 })', 'actual')!)).resultSets[0];
  assert.ok(plan.columns.includes('executionStats'), plan.columns.join());

  const ac = new AbortController();
  const t = Date.now();
  setTimeout(() => ac.abort(), 700);
  await assert.rejects(d.run(c, PW, "db.item.find({ $where: 'sleep(200) || true' })", ac.signal));
  assert.ok(Date.now() - t < 8000, `cancel took ${Date.now() - t} ms`);
  const ops = (await run("db.adminCommand({ currentOp: true, 'command.comment': { $regex: '^moonage-' }, 'command.find': 'item' })")).resultSets[0];
  assert.equal(ops.rows[0][ops.columns.indexOf('inprog')], '[]', 'killOp stopped the query on the server');

  assert.ok((await d.databases(c, PW)).includes('shop'));
  assert.deepEqual(await d.objects(c, PW, 'shop', 'table'), [{ schema: 'db', name: 'item' }]);
  assert.deepEqual(await d.objects(c, PW, 'shop', 'view'), [{ schema: 'db', name: 'cheap' }]);
  assert.deepEqual((await d.columns(c, PW, 'shop', { schema: 'db', name: 'item' })).map((x) => `${x.name}:${x.type}`),
    ['_id:int', 'name:string', 'price:double', 'tags:array', 'created:date']);
  assert.equal((await run(d.selectTop('shop', { schema: 'db', name: 'item' }, 5))).resultSets[0].rows.length, 5);
  let n = 0;
  assert.equal(await d.stream(c, PW, 'db.item.find()', undefined, { columns: (cols) => assert.equal(cols[0], '_id'), row: () => { n++; } }), 250);
  assert.equal(n, 250);
  await assert.rejects(d.session(c, PW), /not supported/);
  await assert.rejects(run('db.item.bogus()'), /bogus/);
});

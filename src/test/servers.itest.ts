// Test driver ke server sungguhan (Docker, lihat scripts/test-servers.sh): database "shop" sementara, boleh ditulis.
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { drivers } from '../db';
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

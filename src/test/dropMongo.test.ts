import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { drivers, type DbObject } from '../db';
import { parseShell } from '../mongo';

const m = drivers.mongodb;

test('drop database (MongoDB): db.dropDatabase() run inside the database, system databases listed', () => {
  const dd = m.dropDatabase!;
  assert.equal(dd.script('shop'), 'db.dropDatabase();');
  assert.equal(dd.inside, true);
  assert.deepEqual(dd.system, ['admin', 'local', 'config']);
  const ops = parseShell(dd.script('shop'));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].method, 'dropDatabase');
  assert.equal(ops[0].coll, undefined);
});

test('drop table (MongoDB): getCollection(name).drop(), name JSON-quoted', () => {
  const o: DbObject = { schema: 'db', name: 'or"ders' };
  assert.equal(m.dropTable!(o), 'db.getCollection("or\\"ders").drop();');
  const ops = parseShell(m.dropTable!(o));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].method, 'drop');
  assert.equal(ops[0].coll, 'or"ders');
  assert.equal(m.dropTable!({ schema: 'db', name: 'orders' }), 'db.getCollection("orders").drop();');
});

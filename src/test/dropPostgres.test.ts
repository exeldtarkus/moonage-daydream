import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { drivers } from '../db';

const pg = drivers.postgres;

test('drop database: PostgreSQL forces the drop as one statement, templates are protected', () => {
  const d = pg.dropDatabase!;
  assert.equal(d.script('shop'), 'DROP DATABASE "shop" WITH (FORCE);');
  assert.equal(d.script('my"db'), 'DROP DATABASE "my""db" WITH (FORCE);');
  assert.equal(d.script('x').slice(0, -1).includes(';'), false);
  assert.equal(d.inside, undefined);
  assert.deepEqual(d.system, ['template0', 'template1']);
});

test('drop table: PostgreSQL quotes schema and name, no CASCADE', () => {
  assert.equal(pg.dropTable!({ schema: 'public', name: 'orders' }), 'DROP TABLE "public"."orders";');
  assert.equal(pg.dropTable!({ schema: 's"x', name: 'a"b' }), 'DROP TABLE "s""x"."a""b";');
});

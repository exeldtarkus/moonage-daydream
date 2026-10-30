import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { drivers } from '../db';

for (const key of ['mysql', 'mariadb'] as const) {
  const d = drivers[key];

  test(`drop database (${key}): quoted script, system databases`, () => {
    assert.equal(d.dropDatabase!.script('shop'), 'DROP DATABASE `shop`;');
    assert.equal(d.dropDatabase!.script('my`db'), 'DROP DATABASE `my``db`;');
    assert.deepEqual(d.dropDatabase!.system, ['mysql', 'information_schema', 'performance_schema', 'sys']);
    assert.equal(d.dropDatabase!.inside, undefined);
  });

  test(`drop table (${key}): db.table, one-part name when schema is empty`, () => {
    assert.equal(d.dropTable!({ schema: 'shop', name: 'orders' }), 'DROP TABLE `shop`.`orders`;');
    assert.equal(d.dropTable!({ schema: 'sh`op', name: 'or`ders' }), 'DROP TABLE `sh``op`.`or``ders`;');
    assert.equal(d.dropTable!({ schema: '', name: 'orders' }), 'DROP TABLE `orders`;');
  });
}

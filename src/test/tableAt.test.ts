import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveTableRef, tableAt } from '../sqlContext';

const at = (sql: string, needle: string, shift = 1) => tableAt(sql, sql.indexOf(needle) + shift);

test('tableAt: bracketed 3-part and plain 2-part table names under the cursor', () => {
  const sql = 'SELECT TOP 100 * FROM [BIMA_HERITAGE].[dbo].[TBL_POLICY];';
  assert.deepEqual(at(sql, 'TBL_POLICY'), ['BIMA_HERITAGE', 'dbo', 'TBL_POLICY']);
  assert.deepEqual(at(sql, 'BIMA_HERITAGE'), ['BIMA_HERITAGE', 'dbo', 'TBL_POLICY'], 'cursor on any part of the chain');
  assert.deepEqual(at('SELECT *\nFROM\n    dbo.TBL_POLICY\n;', 'dbo'), ['dbo', 'TBL_POLICY']);
  assert.deepEqual(at('select * from orders o join items i on i.oid = o.id', 'items'), ['items']);
});

test('tableAt: only table references count (columns, aliases, keywords, strings, comments are not tables)', () => {
  const sql = "SELECT o.id FROM orders o WHERE o.name = 'orders' -- orders\n";
  assert.equal(at(sql, 'o.id'), undefined, 'column');
  assert.equal(at(sql, 'FROM', 2), undefined, 'keyword');
  assert.equal(at(sql, " 'orders'", 3), undefined, 'string');
  assert.equal(at(sql, '-- orders', 5), undefined, 'comment');
  assert.equal(at(sql, ' o WHERE', 1), undefined, 'alias');
  assert.deepEqual(at(sql, 'orders o'), ['orders']);
});

test('resolveTableRef: database / schema per dialect, defaults from the file connection', () => {
  assert.deepEqual(resolveTableRef(['BIMA', 'dbo', 'T'], 'mssql', 'cur'), { db: 'BIMA', schema: 'dbo', name: 'T' });
  assert.deepEqual(resolveTableRef(['dbo', 'T'], 'mssql', 'cur'), { db: 'cur', schema: 'dbo', name: 'T' });
  assert.deepEqual(resolveTableRef(['T'], 'mssql', 'cur'), { db: 'cur', schema: undefined, name: 'T' });
  assert.deepEqual(resolveTableRef(['shop', 'T'], 'mysql', 'cur'), { db: 'shop', schema: 'shop', name: 'T' }, 'MySQL: schema = database');
  assert.deepEqual(resolveTableRef(['T'], 'mysql', 'cur'), { db: 'cur', schema: 'cur', name: 'T' });
  assert.deepEqual(resolveTableRef(['s', 'T'], 'postgres', 'cur'), { db: 'cur', schema: 's', name: 'T' });
});

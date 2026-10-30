import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { showColumns } from '../db';

const COLS = ['ordinal', 'column_name', 'data_type', 'nullable', 'default_value', 'ai', 'primary_key', 'pk_name', 'uq_name', 'uq_index',
  'fk_name', 'fk_schema', 'fk_table', 'fk_column', 'fk_delete', 'fk_update', 'gen', 'keys'];

test('showColumns: attribute aliases become row fields and leave the info grid', () => {
  const { cols, info } = showColumns({ columns: COLS, rows: [
    [1, 'id', 'int', 'NO', null, 'YES', 'PK', 'PK_order_item', null, null, null, null, null, null, null, null, null, null],
    [2, 'sku', 'nvarchar(40)', 'NO', null, null, '', null, 'UQ_order_item_sku', '0', null, null, null, null, null, null, null, null],
    [3, 'order_id', 'int', 'NO', null, null, '', null, null, null, 'FK_order_item_order_id', 'dbo', 'orders', 'id', 'CASCADE', 'NO ACTION', null, 'UQ (order_id, sku)'],
  ] });
  assert.deepEqual(cols[0], { name: 'id', type: 'int', nullable: false, ai: true, pk: true, pkName: 'PK_order_item' });
  assert.equal(cols[1].unique, true);
  assert.equal(cols[1].uqName, 'UQ_order_item_sku');
  assert.equal(cols[1].uqIndex, undefined);
  assert.deepEqual(cols[2].fk, { name: 'FK_order_item_order_id', schema: 'dbo', table: 'orders', column: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
  assert.deepEqual(info.columns, ['keys']);
  // MySQL: unique berupa index (bukan constraint)
  assert.equal(showColumns({ columns: ['column_name', 'data_type', 'nullable', 'uq_name', 'uq_index'], rows: [['a', 'int', 'YES', 'uq_a', 1]] }).cols[0].uqIndex, true);
});

test('showColumns: SQL Server identity stays rename-only but shows AI on; generated expression kept', () => {
  const { cols, info } = showColumns({ columns: ['column_name', 'data_type', 'nullable', 'default_value', 'identity', 'gen'], rows: [
    ['id', 'int', 'NO', null, '1, 1', null],
    ['total', 'decimal(12,2)', 'YES', null, null, 'AS (qty * price) VIRTUAL'],
  ] });
  assert.equal(cols[0].generated, true);
  assert.equal(cols[0].ai, true);
  assert.ok(info.columns.includes('identity'));
  assert.equal(cols[1].gen, 'AS (qty * price) VIRTUAL');
  assert.equal(cols[1].generated, undefined);
});

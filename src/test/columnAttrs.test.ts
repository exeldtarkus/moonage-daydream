import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkRows, drivers, showColumns, type ColumnDdl } from '../db';

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

const ms = drivers.mssql.columnDdl!;
const stub: ColumnDdl = { ...ms, aiTypes: ['int'] };
const ot = { schema: 'dbo', name: 'order_item' };

test('checkRows: SET NULL on a NOT NULL FK column is rejected', () => {
  assert.deepEqual(checkRows(stub, ot, [{ name: 'order_id', type: 'int', nullable: false, fk: { schema: 'dbo', table: 'orders', column: 'id', onDelete: 'SET NULL' } }]),
    ['order_id: ON DELETE SET NULL needs a nullable column']);
  assert.deepEqual(checkRows(stub, ot, [{ name: 'order_id', type: 'int', nullable: false, fk: { schema: 'dbo', table: 'orders', column: 'id', onUpdate: 'SET NULL' } }]),
    ['order_id: ON UPDATE SET NULL needs a nullable column']);
  assert.deepEqual(checkRows(stub, ot, [{ name: 'order_id', type: 'int', nullable: true, fk: { schema: 'dbo', table: 'orders', column: 'id', onDelete: 'SET NULL' } }]), []);
});

test('checkRows: identity on an existing column only when setAi exists', () => {
  const rows = [{ name: 'qty', orig: 'qty', type: 'int', nullable: false, ai: true }];
  const original = [{ name: 'qty', type: 'int', nullable: false }];
  assert.deepEqual(checkRows({ ...stub, setAi: undefined }, ot, rows, original), ['qty: identity can only be set on a new column']);
  assert.deepEqual(checkRows({ ...stub, setAi: () => '' }, ot, rows, original), []);
});

test('checkRows: generated constraint names respect nameMax (bytes)', () => {
  const e = checkRows({ ...stub, nameMax: 63 }, { schema: 'dbo', name: 't'.repeat(60) }, [{ name: 'c', type: 'int', nullable: true, unique: true }]);
  assert.equal(e.length, 1);
  assert.match(e[0], /^UQ_t{60}_c: constraint name too long \(max 63\)$/);
  assert.equal(ms.nameMax, 128);
});

test('checkRows: MySQL AI needs a key through aiNeedsKey (also for existing columns in the Columns editor)', () => {
  const my = drivers.mysql.columnDdl!;
  assert.equal(my.aiNeedsKey, true);
  assert.deepEqual(checkRows(my, { schema: '', name: 't' }, [{ name: 'n', type: 'int', nullable: false, ai: true }]), ['n: auto increment needs PK or UQ (MySQL)']);
  assert.deepEqual(checkRows(my, { schema: '', name: 't' }, [{ name: 'n', type: 'int', nullable: false, ai: true, pk: true }]), []);
});

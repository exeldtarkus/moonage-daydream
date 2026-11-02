import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkRows, columnChanges, drivers, showColumns, type ColumnDdl, type ColumnDef, type ColumnRow, type DbObject, type NewColumn } from '../db';

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

const attrDdl = () => Object.assign({ ...stub }, {
  drop: (_obj: DbObject, name: string) => `drop ${name}`,
  edit: (_obj: DbObject, old: ColumnDef, next: ColumnDef) => `edit ${old.name} -> ${next.name}`,
  add: (_obj: DbObject, col: NewColumn, pos?: { after?: string | null; pkCols?: string[] }) =>
    `add ${col.name}${pos?.after === null ? ' FIRST' : pos?.after ? ` after=${pos.after}` : ''}${pos?.pkCols ? ` pkCols=${pos.pkCols.join(',')}` : ''}`,
  dropFk: (_obj: DbObject, name: string) => `dropFk ${name}`,
  dropUnique: (_obj: DbObject, name: string) => `dropUnique ${name}`,
  dropPk: (_obj: DbObject, name?: string) => `dropPk ${name ?? ''}`,
  addPk: (_obj: DbObject, cols: string[], name?: string) => `addPk ${name ?? ''} ${cols.join(',')}`,
  addUnique: (_obj: DbObject, col: string, name?: string) => `addUnique ${name ?? ''} ${col}`,
  addFk: (_obj: DbObject, col: string, fk: ColumnRow['fk']) => `addFk ${fk?.name ?? ''} ${col}`,
  setAi: (_obj: DbObject, col: ColumnDef, on: boolean) => `${on ? 'setAi' : 'dropAi'} ${col.name}`,
});
const col = (name: string, props: Partial<ColumnRow> = {}): ColumnRow => ({ name, type: 'int', nullable: false, ...props });
const title = (step: { kind: string }) => ('title' in step ? step.title : undefined);
const titles = (steps: { kind: string }[]) => steps.map(title);

test('columnChanges: mixed change follows the 12-step order', () => {
  const original = [
    col('id', { pk: true, pkName: 'PK_order_item' }),
    col('order_id', { fk: { name: 'FK_order_item_order_id', schema: 'dbo', table: 'orders', column: 'id' } }),
    col('sku', { unique: true, uqName: 'UQ_order_item_sku' }),
    col('qty'),
    col('note', { nullable: true }),
    col('line_no'),
  ];
  const rows = [
    col('id', { orig: 'id', pk: true, pkName: 'PK_order_item' }),
    col('order_id', { orig: 'order_id' }),
    col('sku', { orig: 'sku', uqName: 'UQ_order_item_sku' }),
    col('quantity', { orig: 'qty' }),
    col('note', { orig: 'note', deleted: true }),
    col('line_no', { orig: 'line_no', pk: true }),
    col('extra', { unique: true, fk: { schema: 'dbo', table: 'orders', column: 'id' } }),
  ];
  const result = columnChanges(attrDdl(), ot, original, rows);
  assert.deepEqual(result.steps.map((step) => step.kind), ['dropKey', 'dropKey', 'dropKey', 'drop', 'edit', 'add', 'addKey', 'addKey', 'addKey']);
  assert.deepEqual(titles(result.steps), [
    'Drop foreign key FK_order_item_order_id',
    'Drop unique UQ_order_item_sku',
    'Drop primary key PK_order_item',
    'Drop note',
    'Change qty to quantity',
    'Add extra',
    'Add primary key PK_order_item (id, line_no)',
    'Add unique UQ_order_item_extra (extra)',
    'Add foreign key FK_order_item_extra (extra) → orders(id)',
  ]);
  for (const step of result.steps) assert.doesNotMatch(step.sql, /DROP[^;]*CASCADE/);
});

test('columnChanges: PK forces Not null and AI clears the default before being set', () => {
  const original = [col('note', { nullable: true }), col('seq', { default: '0' })];
  const rows = [
    col('note', { orig: 'note', nullable: true, pk: true }),
    col('seq', { orig: 'seq', ai: true, default: '0' }),
  ];
  const result = columnChanges(attrDdl(), ot, original, rows);
  assert.deepEqual(result.steps.map((step) => step.kind), ['edit', 'edit', 'addKey', 'ai']);
  assert.ok(result.steps[0].detail?.includes('NULL → NOT NULL'));
  assert.ok(result.steps[1].detail?.includes('default 0 removed'));
  assert.equal(title(result.steps.at(-1)!), 'Set auto increment on seq');
});

test('columnChanges: toggling back and renaming a PK column emit nothing extra', () => {
  const original = [col('id', { pk: true, pkName: 'PK_order_item' }), col('sku')];
  const toggledBack = [col('id', { orig: 'id', pk: true, pkName: 'PK_order_item' }), col('sku', { orig: 'sku' })];
  assert.equal(columnChanges(attrDdl(), ot, original, toggledBack).count, 0);
  const renamed = [col('item_id', { orig: 'id', pk: true, pkName: 'PK_order_item' }), col('sku', { orig: 'sku' })];
  const result = columnChanges(attrDdl(), ot, original, renamed);
  assert.deepEqual(result.steps.map((step) => step.kind), ['edit']);
});

test('columnChanges: rename plus UQ uses the final column name', () => {
  const original = [col('qty')];
  const rows = [col('quantity', { orig: 'qty', unique: true })];
  const result = columnChanges(attrDdl(), ot, original, rows);
  assert.equal(title(result.steps.at(-1)!), 'Add unique UQ_order_item_quantity (quantity)');
});

test('columnChanges: generated row can still get PK, UQ, and FK', () => {
  const original = [col('total', { generated: true, ai: true })];
  const rows = [col('total', { orig: 'total', generated: true, ai: true, pk: true, unique: true,
    fk: { schema: 'dbo', table: 'orders', column: 'id' } })];
  const result = columnChanges(attrDdl(), ot, original, rows);
  assert.deepEqual(result.steps.map((step) => step.kind), ['addKey', 'addKey', 'addKey']);
});

test('columnChanges: dropping a key column follows each database rule', () => {
  const original = [
    col('id', { pk: true, pkName: 'PK_order_item' }),
    col('line_no', { pk: true, uqName: 'UQ_order_item_line_no', unique: true, fk: { name: 'FK_order_item_line_no', schema: 'dbo', table: 'orders', column: 'id' } }),
  ];
  const rows = [col('id', { orig: 'id', pk: true, pkName: 'PK_order_item' }), col('line_no', { orig: 'line_no', deleted: true })];
  const mysql = columnChanges(Object.assign(attrDdl(), { dropKeepsKeys: true }), ot, original, rows);
  assert.deepEqual(titles(mysql.steps), ['Drop foreign key FK_order_item_line_no', 'Drop line_no']);

  const pkOriginal = original.slice(0, 2).map((r) => col(r.name, { pk: true, pkName: r.pkName }));
  const pkRows = [col('id', { orig: 'id', pk: true, pkName: 'PK_order_item' }), col('line_no', { orig: 'line_no', deleted: true })];
  const sqlServer = columnChanges(attrDdl(), ot, pkOriginal, pkRows);
  assert.deepEqual(titles(sqlServer.steps), ['Drop primary key PK_order_item', 'Drop line_no', 'Add primary key PK_order_item (id)']);
});

test('columnChanges: MySQL-like primary key replacement is one step', () => {
  const original = [col('id', { pk: true }), col('line_no')];
  const rows = [col('id', { orig: 'id', pk: true }), col('line_no', { orig: 'line_no', pk: true })];
  const result = columnChanges(Object.assign(attrDdl(), { replacePk: (_obj: DbObject, cols: string[]) => `replacePk ${cols.join(',')}` }), ot, original, rows);
  assert.deepEqual(result.steps.map((step) => step.kind), ['addKey']);
  assert.equal(title(result.steps[0]), 'Replace primary key (id, line_no)');
});

test('columnChanges: new MySQL-like AI column carries its key inline', () => {
  const ddl = Object.assign(attrDdl(), { aiNeedsKey: true });
  const result = columnChanges(ddl, ot, [], [col('seq', { ai: true, pk: true })]);
  assert.deepEqual(result.steps.map((step) => step.kind), ['add']);
  assert.match(result.steps[0].sql, /pkCols=seq/);
});

test('columnChanges: rebuildKeys recreates the primary key around an ALTER COLUMN', () => {
  const original = [col('id', { pk: true, pkName: 'PK__orders__3213' })];
  const rows = [col('id', { orig: 'id', type: 'bigint', pk: true, pkName: 'PK__orders__3213' })];
  const result = columnChanges(Object.assign(attrDdl(), { rebuildKeys: true }), ot, original, rows);
  assert.deepEqual(titles(result.steps), [
    'Drop primary key PK__orders__3213',
    'Change id',
    'Add primary key PK__orders__3213 (id)',
  ]);
  assert.deepEqual(result.steps[2].detail, ['re-created because the column type changes; fails if other tables reference this key or an index uses this column']);
});

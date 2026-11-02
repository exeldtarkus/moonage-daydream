import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkRows, columnChanges, columnsConfirm, drivers, execScript, moveSteps, showColumns, type ColumnDdl, type ColumnDef,
  type ColumnRow, type DbObject, type NewColumn, type QueryResult, type Session } from '../db';
import { splitBatches } from '../mssql';

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
const myd = drivers.mysql.columnDdl!;
const pgd = drivers.postgres.columnDdl!;
const stub: ColumnDdl = { ...ms, aiTypes: ['int'] };
const ot = { schema: 'dbo', name: 'order_item' };
const mo = { schema: 'shop', name: 'order`item' };
const MT = '`shop`.`order``item`';

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

test('moveSteps: single move, move to first, and unchanged order', () => {
  assert.deepEqual(moveSteps(['id', 'order_id', 'line_no', 'sku', 'qty'], ['id', 'order_id', 'line_no', 'qty', 'sku']),
    [{ col: 'qty', after: 'line_no' }]);
  assert.deepEqual(moveSteps(['a', 'b', 'c'], ['c', 'a', 'b']), [{ col: 'c', after: null }]);
  assert.deepEqual(moveSteps(['a', 'b'], ['a', 'b']), []);
});

test('columnChanges: MySQL-like add goes after its grid predecessor, then moves after adds', () => {
  const original = [col('id'), col('sku'), col('qty')];
  const rows = [col('id', { orig: 'id' }), col('sku', { orig: 'sku' }), col('note2'), col('qty', { orig: 'qty' })];
  const ddl = Object.assign(attrDdl(), { move: (_obj: DbObject, c: ColumnDef, after: string | null) => `move ${c.name} after=${after ?? 'FIRST'}` });
  const result = columnChanges(ddl, ot, original, rows);
  assert.equal(result.steps[0].sql, 'add note2 after=sku');
  assert.equal(result.steps.some((step) => step.kind === 'move'), false);
});

test('columnChanges: reordering is ignored without ddl.move', () => {
  const original = [col('id'), col('sku'), col('qty')];
  const rows = [col('qty', { orig: 'qty' }), col('id', { orig: 'id' }), col('sku', { orig: 'sku' })];
  assert.equal(columnChanges(attrDdl(), ot, original, rows).count, 0);
});

test('columnsConfirm: lists drops, shrinking composite keys, rebuild notes, and database note', () => {
  const ddl = Object.assign(attrDdl(), { dropKeepsKeys: true, note: 'N' });
  const steps = [
    { kind: 'dropKey' as const, column: 'order_id', sql: 'dropFk FK_order_item_order_id', title: 'Drop foreign key FK_order_item_order_id' },
    { kind: 'dropKey' as const, column: 'id', sql: 'dropPk', title: 'Drop primary key' },
    { kind: 'move' as const, column: 'qty', sql: 'move qty', title: 'Move qty after sku' },
    { kind: 'addKey' as const, column: 'id, line_no', sql: 'replace PK', title: 'Replace primary key (id, line_no)' },
  ];
  const text = columnsConfirm(ddl, steps, [col('order_id', { orig: 'order_id', deleted: true })], { order_id: 'UQ (order_id, sku)' });
  assert.match(text, /Deleted columns lose their data: order_id\./);
  assert.match(text, /Constraints dropped: FK_order_item_order_id, primary key\./);
  assert.match(text, /UQ \(order_id, sku\) becomes UQ \(sku\)\./);
  assert.match(text, /Moving columns rebuilds the table; on a big table this takes time and locks writes\./);
  assert.match(text, /Changing the primary key rebuilds its index\./);
  assert.ok(text.endsWith('The script in SQL preview is executed and committed.\nN'));
});

test('columnsConfirm: MySQL warns that a composite foreign key blocks dropping a column', () => {
  const ddl = Object.assign(attrDdl(), { dropKeepsKeys: true, rebuildKeys: false });
  const text = columnsConfirm(ddl, [], [col('tenant_id', { orig: 'tenant_id', deleted: true })],
    { tenant_id: 'FK (tenant_id, org_id) → tenant(id, org_id)' });
  assert.match(text, /FK \(tenant_id, org_id\) → tenant\(id, org_id\) blocks the column drop; MySQL refuses it\./);
});

test('execScript: one connection runs, commits, and closes; run failure is preserved', async () => {
  const calls: string[] = [];
  const result: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
  const session = (run: Session['run'] = async () => result, close: Session['close'] = async () => {}) => ({
    run: async (sql: string) => { calls.push('run'); return run(sql); },
    stream: async () => 0,
    open: false,
    commit: async () => { calls.push('commit'); },
    rollback: async () => {},
    close: async () => { calls.push('close'); await close(); },
  } satisfies Session);
  const d = {
    run: async () => { calls.push('pool run'); return result; },
    session: async () => { calls.push('session'); return session(); },
  };
  const conn = { name: 'local', type: 'mssql' as const, host: 'localhost', port: 1433, user: 'user', database: 'db', trustServerCertificate: false };
  await execScript(d, conn, 'pw', 'ALTER TABLE t ADD c int', true);
  assert.deepEqual(calls, ['session', 'run', 'commit', 'close']);

  calls.length = 0;
  const runError = new Error('run failed');
  const failing = { ...d, session: async () => { calls.push('session'); return session(async () => { throw runError; }); } };
  await assert.rejects(execScript(failing, conn, 'pw', 'bad SQL', true), (error) => error === runError);
  assert.deepEqual(calls, ['session', 'run', 'close']);

  calls.length = 0;
  await execScript(d, conn, 'pw', 'SELECT 1', false);
  assert.deepEqual(calls, ['pool run']);
});

test('execScript: close failure is logged and surfaced when there is no earlier error', async () => {
  const { driverLog } = await import('../log');
  const oldLog = driverLog.error;
  const logged: string[] = [];
  driverLog.error = (message) => logged.push(message);
  const result: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
  const closeError = new Error('close failed');
  const session: Session = {
    run: async () => result, stream: async () => 0, open: false, commit: async () => {}, rollback: async () => {},
    close: async () => { throw closeError; },
  };
  const d = { run: async () => result, session: async () => session };
  const conn = { name: 'local', type: 'mssql' as const, host: 'localhost', port: 1433, user: 'user', database: 'db', trustServerCertificate: false };
  try {
    await assert.rejects(execScript(d, conn, 'pw', 'ALTER TABLE t ADD c int', true), (error) => error === closeError);
    assert.match(logged[0], /execScript close - EXCEPTION CAUGHT.*close failed.*stack-trace/);
  } finally {
    driverLog.error = oldLog;
  }
});

test('SQL Server key DDL: exact SQL and odd-name quoting', () => {
  const ms = drivers.mssql.columnDdl!;
  const table = { schema: 'dbo', name: 'or]ders' };
  const target = '[dbo].[or]]ders]';
  assert.equal(ms.addPk!(table, ['a', 'b']), `ALTER TABLE ${target} ADD CONSTRAINT [PK_or]]ders] PRIMARY KEY ([a], [b]);`);
  assert.equal(ms.addPk!(table, ['id'], 'PK__x'), `ALTER TABLE ${target} ADD CONSTRAINT [PK__x] PRIMARY KEY ([id]);`);
  assert.equal(ms.dropPk!(table, 'PK__x'), `ALTER TABLE ${target} DROP CONSTRAINT [PK__x];`);
  assert.equal(ms.addUnique!(table, 'c'), `ALTER TABLE ${target} ADD CONSTRAINT [UQ_or]]ders_c] UNIQUE ([c]);`);
  assert.equal(ms.addUnique!(table, 'c', 'ix', true), `CREATE UNIQUE INDEX [ix] ON ${target} ([c]);`);
  assert.equal(ms.dropUnique!(table, 'UQ_x', false), `ALTER TABLE ${target} DROP CONSTRAINT [UQ_x];`);
  assert.equal(ms.dropUnique!(table, 'ix', true), `DROP INDEX [ix] ON ${target};`);
  assert.equal(ms.addFk!(table, 'order_id', { schema: 'sales', table: 'orders', column: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }),
    `ALTER TABLE ${target} ADD CONSTRAINT [FK_or]]ders_order_id] FOREIGN KEY ([order_id]) REFERENCES [sales].[orders] ([id]) ON DELETE CASCADE;`);
  assert.equal(ms.dropFk!(table, 'FK_x'), `ALTER TABLE ${target} DROP CONSTRAINT [FK_x];`);
  assert.equal(ms.add(table, { name: 'seq', type: 'int', nullable: false, ai: true }),
    `ALTER TABLE ${target} ADD [seq] int IDENTITY(1, 1) NOT NULL;`);
});

test('SQL Server show: key names, single-column keys, and composite key badges', () => {
  const ms = drivers.mssql.columnDdl!;
  const sql = ms.show(ot);
  for (const fragment of ['AS pk_name', 'AS uq_name', 'is_unique_constraint', 'AS fk_name', 'delete_referential_action_desc', 'AS keys', 'has_filter = 0']) {
    assert.ok(sql.includes(fragment), `Missing ${fragment} in ${sql}`);
  }
  assert.equal(ms.setAi, undefined);
  assert.equal(ms.move, undefined);
});

test('SQL Server script runs in one transaction with a NOEXEC guard per batch', () => {
  const ms = drivers.mssql.columnDdl!;
  const table = { schema: 'dbo', name: 'or]ders' };
  const original = [col('qty'), col('price')];
  const rows = [col('quantity', { orig: 'qty', type: 'bigint' }), col('price', { orig: 'price', deleted: true }), col('note', { type: 'int' })];
  const result = columnChanges(ms, table, original, rows);
  assert.ok(result.sql.startsWith('SET XACT_ABORT ON;\nBEGIN TRANSACTION;\nGO\n'));
  assert.ok(result.sql.endsWith('COMMIT TRANSACTION;\nGO\nSET NOEXEC OFF;'));
  const guard = 'IF @@ERROR <> 0 OR @@TRANCOUNT = 0 SET NOEXEC ON;';
  assert.equal(result.sql.split(guard).length - 1, splitBatches(result.steps.map((step) => step.sql).join('\nGO\n')).length);
  assert.ok(!result.steps[0].sql.includes('XACT_ABORT'));
  assert.match(ms.note ?? '', /one transaction/);
});

test('SQL Server rejects identity changes on existing columns', () => {
  const ms = drivers.mssql.columnDdl!;
  const old = [col('qty', { ai: true })];
  const result = columnChanges(ms, ot, old, [col('qty', { orig: 'qty' })]);
  assert.deepEqual(result.errors, ['qty: identity can only be set on a new column']);
});

test('SQL Server drops keys before a key column and re-adds the remaining primary key', () => {
  const ms = drivers.mssql.columnDdl!;
  const original = [
    col('id', { pk: true, pkName: 'PK_or]ders' }),
    col('price', { pk: true, pkName: 'PK_or]ders', unique: true, uqName: 'UQ_or]ders_price',
      fk: { name: 'FK_or]ders_price', schema: 'dbo', table: 'orders', column: 'id' } }),
  ];
  const rows = [col('id', { orig: 'id', pk: true, pkName: 'PK_or]ders' }), col('price', { orig: 'price', deleted: true })];
  const result = columnChanges(ms, { schema: 'dbo', name: 'or]ders' }, original, rows);
  assert.deepEqual(result.steps.map((step) => step.title), [
    'Drop foreign key FK_or]ders_price',
    'Drop unique UQ_or]ders_price',
    'Drop primary key PK_or]ders',
    'Drop price',
    'Add primary key PK_or]ders (id)',
  ]);
  for (const step of result.steps) assert.doesNotMatch(step.sql, /DROP[^;]*CASCADE/);
});

test('MySQL key DDL: exact SQL and identifier quoting', () => {
  assert.equal(myd.addPk!(mo, ['a', 'b']), `ALTER TABLE ${MT} ADD PRIMARY KEY (\`a\`, \`b\`);`);
  assert.equal(myd.dropPk!(mo), `ALTER TABLE ${MT} DROP PRIMARY KEY;`);
  assert.equal(myd.replacePk!(mo, ['id', 'line_no']), `ALTER TABLE ${MT} DROP PRIMARY KEY, ADD PRIMARY KEY (\`id\`, \`line_no\`);`);
  assert.equal(myd.addUnique!(mo, 'sku'), `ALTER TABLE ${MT} ADD UNIQUE KEY \`UQ_order\`\`item_sku\` (\`sku\`);`);
  assert.equal(myd.dropUnique!(mo, 'uq_order_item_order_sku', false), `ALTER TABLE ${MT} DROP INDEX \`uq_order_item_order_sku\`;`);
  assert.equal(myd.dropFk!(mo, 'FK_x'), `ALTER TABLE ${MT} DROP FOREIGN KEY \`FK_x\`;`);
  assert.equal(myd.addFk!(mo, 'order_id', { schema: 'shop', table: 'orders', column: 'id', onDelete: 'CASCADE' }),
    `ALTER TABLE ${MT} ADD CONSTRAINT \`FK_order\`\`item_order_id\` FOREIGN KEY (\`order_id\`) REFERENCES \`shop\`.\`orders\` (\`id\`) ON DELETE CASCADE;`);
});

test('MySQL add: supports column position and inline primary key', () => {
  assert.equal(myd.add(mo, { name: 'note', type: 'varchar(100)', nullable: true }, { after: 'title' }),
    `ALTER TABLE ${MT} ADD COLUMN \`note\` varchar(100) NULL AFTER \`title\`;`);
  assert.equal(myd.add(mo, { name: 'id', type: 'int', nullable: false, ai: true, pk: true }, { after: null, pkCols: ['id'] }),
    `ALTER TABLE ${MT} ADD COLUMN \`id\` int NOT NULL AUTO_INCREMENT FIRST, ADD PRIMARY KEY (\`id\`);`);
});

test('MySQL setAi and move preserve the full column definition', () => {
  assert.equal(myd.setAi!(mo, { name: 'id', type: 'int', nullable: false }, true),
    `ALTER TABLE ${MT} MODIFY COLUMN \`id\` int NOT NULL AUTO_INCREMENT;`);
  assert.equal(myd.move!(mo, { name: 'qty', type: 'int unsigned', nullable: false, default: '0', keep: "COLLATE utf8mb4_bin COMMENT 'x'" }, 'title'),
    `ALTER TABLE ${MT} MODIFY COLUMN \`qty\` int unsigned NOT NULL DEFAULT 0 COMMENT 'x' AFTER \`title\`;`);
  assert.equal(myd.move!(mo, { name: 'id', type: 'int', nullable: false, ai: true }, 'note'),
    `ALTER TABLE ${MT} MODIFY COLUMN \`id\` int NOT NULL AUTO_INCREMENT AFTER \`note\`;`);
  assert.equal(myd.move!(mo, { name: 'total', type: 'decimal(12,2)', nullable: true, gen: 'AS (\`qty\` * \`price\`) VIRTUAL' }, null),
    `ALTER TABLE ${MT} MODIFY COLUMN \`total\` decimal(12,2) AS (\`qty\` * \`price\`) VIRTUAL FIRST;`);
  assert.equal(myd.move!(mo, { name: 'created', type: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP',
    keep: "on update current_timestamp() INVISIBLE COMMENT 'c'" }, null),
  `ALTER TABLE ${MT} MODIFY COLUMN \`created\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP on update current_timestamp() INVISIBLE COMMENT 'c' FIRST;`);
});

test('MySQL edit keeps AUTO_INCREMENT on a type change', () => {
  assert.equal(myd.edit(mo, { name: 'id', type: 'int', nullable: false, ai: true },
    { name: 'id', type: 'bigint', nullable: false, ai: true }),
  `ALTER TABLE ${MT} CHANGE COLUMN \`id\` \`id\` bigint NOT NULL AUTO_INCREMENT;`);
});

test('MySQL show: AI, generated expression, INVISIBLE and key metadata aliases', () => {
  const sql = myd.show(mo);
  for (const fragment of ['AS `ai`', 'AS `gen`', 'INVISIBLE', 'AS `uq_name`', 'referential_constraints', 'AS `keys`']) {
    assert.ok(sql.includes(fragment), `Missing ${fragment} in ${sql}`);
  }
  assert.doesNotMatch(sql, /AS `identity`/);
  assert.match(sql, /LIMIT 1/);
  assert.match(sql, /generation_expression <> ''/);
});

test('MySQL Columns editor replaces the primary key and removes AI before key replacement', () => {
  const original = [col('id', { ai: true, pk: true }), col('line_no')];
  const kept = columnChanges(myd, mo, original, [
    col('id', { orig: 'id', ai: true, pk: true }),
    col('line_no', { orig: 'line_no', pk: true }),
  ]);
  assert.deepEqual(titles(kept.steps), ['Replace primary key (id, line_no)']);

  const replaced = columnChanges(myd, mo, original, [
    col('id', { orig: 'id' }),
    col('line_no', { orig: 'line_no', pk: true }),
  ]);
  assert.deepEqual(titles(replaced.steps), ['Remove auto increment from id', 'Replace primary key (line_no)']);
});

test('MySQL Columns editor emits one move with the complete definition', () => {
  const original = [
    col('id', { pk: true, ai: true }),
    col('line_no'),
    col('sku'),
    col('qty', { nullable: false, default: '1', keep: "COMMENT 'pieces'" }),
  ];
  const rows = [
    col('id', { orig: 'id', pk: true, ai: true }),
    col('line_no', { orig: 'line_no' }),
    col('qty', { orig: 'qty', nullable: false, default: '1', keep: "COMMENT 'pieces'" }),
    col('sku', { orig: 'sku' }),
  ];
  const result = columnChanges(myd, mo, original, rows);
  assert.deepEqual(titles(result.steps), ['Move qty after line_no']);
  assert.match(result.steps[0].sql, /DEFAULT 1 COMMENT 'pieces' AFTER `line_no`/);
});

const po = { schema: 'public', name: 'or"ders' };
const PT = '"public"."or""ders"';

test('PostgreSQL key DDL: exact SQL and identifier quoting', () => {
  assert.equal(pgd.addPk!(po, ['a', 'b']), `ALTER TABLE ${PT} ADD CONSTRAINT "PK_or""ders" PRIMARY KEY ("a", "b");`);
  assert.equal(pgd.dropPk!(po, 'order_item_pkey'), `ALTER TABLE ${PT} DROP CONSTRAINT "order_item_pkey";`);
  assert.equal(pgd.addUnique!(po, 'c'), `ALTER TABLE ${PT} ADD CONSTRAINT "UQ_or""ders_c" UNIQUE ("c");`);
  assert.equal(pgd.dropUnique!(po, 'ix', true), 'DROP INDEX "public"."ix";');
  assert.equal(pgd.dropUnique!(po, 'UQ_x', false), `ALTER TABLE ${PT} DROP CONSTRAINT "UQ_x";`);
  assert.equal(pgd.addFk!(po, 'c', { schema: 'public', table: 'orders', column: 'id', onDelete: 'RESTRICT', onUpdate: 'SET DEFAULT' }),
    `ALTER TABLE ${PT} ADD CONSTRAINT "FK_or""ders_c" FOREIGN KEY ("c") REFERENCES "public"."orders" ("id") ON DELETE RESTRICT ON UPDATE SET DEFAULT;`);
  assert.equal(pgd.dropFk!(po, 'FK_x'), `ALTER TABLE ${PT} DROP CONSTRAINT "FK_x";`);
});

test('PostgreSQL identity DDL: add, set, and remove', () => {
  assert.equal(pgd.add(po, { name: 'seq', type: 'integer', nullable: false, ai: true, default: '1' }),
    `ALTER TABLE ${PT} ADD COLUMN "seq" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL;`);
  assert.equal(pgd.setAi!(po, { name: 'id', type: 'integer', nullable: false }, true),
    `ALTER TABLE ${PT} ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY;`);
  assert.equal(pgd.setAi!(po, { name: 'id', type: 'integer', nullable: false }, false),
    `ALTER TABLE ${PT} ALTER COLUMN "id" DROP IDENTITY;`);
});

test('PostgreSQL show and capabilities expose identity and key metadata', () => {
  const sql = pgd.show(po);
  for (const fragment of ['pg_constraint', 'confdeltype', 'attidentity', 'AS ai', 'identity_mode', 'uq_name', 'fk_name', 'keys']) {
    assert.ok(sql.includes(fragment), `Missing ${fragment} in ${sql}`);
  }
  assert.doesNotMatch(sql, /AS identity\b/);
  assert.equal(pgd.move, undefined);
  assert.match(pgd.note!, /one transaction/i);
  assert.equal(pgd.nameMax, 63);
});

test('PostgreSQL identity on an existing column follows its edit step', () => {
  const original = [col('n', { type: 'integer', nullable: true, default: '0' })];
  const rows = [col('n', { orig: 'n', type: 'integer', nullable: false, ai: true })];
  const result = columnChanges(pgd, po, original, rows);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.steps.map((step) => step.kind), ['edit', 'ai']);
  assert.ok(result.steps[0].detail?.includes('NULL → NOT NULL'));
  assert.ok(result.steps[0].detail?.includes('default 0 removed'));
  assert.equal(result.steps[1].sql, `ALTER TABLE ${PT} ALTER COLUMN "n" ADD GENERATED BY DEFAULT AS IDENTITY;`);
});

test('PostgreSQL drops key constraints before a deleted key column and restores the primary key', () => {
  const original = [
    col('id', { pk: true, pkName: 'order_item_pkey' }),
    col('line_no', { pk: true, pkName: 'order_item_pkey', unique: true, uqName: 'order_item_line_no_key',
      fk: { name: 'order_item_line_no_fkey', schema: 'public', table: 'orders', column: 'id' } }),
  ];
  const rows = [col('id', { orig: 'id', pk: true, pkName: 'order_item_pkey' }), col('line_no', { orig: 'line_no', deleted: true })];
  const result = columnChanges(pgd, po, original, rows);
  assert.deepEqual(titles(result.steps), [
    'Drop foreign key order_item_line_no_fkey',
    'Drop unique order_item_line_no_key',
    'Drop primary key order_item_pkey',
    'Drop line_no',
    'Add primary key PK_or"ders (id)',
  ]);
  for (const step of result.steps) assert.doesNotMatch(step.sql, /DROP[^;]*CASCADE/);
});

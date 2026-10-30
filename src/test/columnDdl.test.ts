import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkColumn, checkType, columnChanges, splitType, type ColumnRow, drivers, objContext, showColumns } from '../db';
import { columnsHtml } from '../columnsHtml';
import { MS_TYPES, fmtType, wrapped } from '../mssql';

const ms = drivers.mssql.columnDdl!;
const t = { schema: 'dbo', name: "or]ders" };
const T = '[dbo].[or]]ders]';

test('column ddl: SQL Server Show lists type, null, default, identity, computed, primary key, collation of the table', () => {
  const sql = ms.show(t);
  assert.match(sql, /FROM sys\.columns c/);
  assert.ok(sql.includes(`OBJECT_ID(N'${T}')`), sql);
  for (const col of ['column_name', 'data_type', 'nullable', 'default_value', 'identity', 'computed', 'primary_key', 'collation']) assert.match(sql, new RegExp(col));
  assert.match(sql, /ORDER BY c\.column_id/);
});

test('column ddl: SQL Server Add = ALTER TABLE ADD, default as a named constraint', () => {
  assert.equal(ms.add(t, { name: 'note', type: 'nvarchar(100)', nullable: true }), `ALTER TABLE ${T} ADD [note] nvarchar(100) NULL;`);
  assert.equal(ms.add(t, { name: 'qty]', type: 'int', nullable: false, default: '0' }),
    `ALTER TABLE ${T} ADD [qty]]] int NOT NULL CONSTRAINT [DF_or]]ders_qty]]] DEFAULT (0);`);
});

test('column ddl: SQL Server Delete drops the column default constraint first, then the column', () => {
  const sql = ms.drop(t, "a'b");
  assert.match(sql, /DECLARE @df sysname = \(SELECT name FROM sys\.default_constraints/);
  assert.ok(sql.includes(`COLUMNPROPERTY(OBJECT_ID(N'${T}'), N'a''b', 'ColumnId')`), sql);
  // EXEC (...) tidak menerima pemanggilan fungsi (QUOTENAME): perintah disusun di variabel lalu sp_executesql
  assert.ok(sql.includes(`IF @df IS NOT NULL BEGIN DECLARE @drop nvarchar(max) = N'ALTER TABLE ${T} DROP CONSTRAINT ' + QUOTENAME(@df); EXEC sp_executesql @drop; END;`), sql);
  assert.ok(sql.trimEnd().endsWith(`ALTER TABLE ${T} DROP COLUMN [a'b];`), sql);
  assert.ok(sql.indexOf('DROP CONSTRAINT') < sql.indexOf('DROP COLUMN'));
});

test('column ddl: SQL Server Edit = sp_rename + ALTER COLUMN, only what changed, in separate batches', () => {
  const old = { name: 'qty', type: 'int', nullable: true };
  assert.match(ms.edit(t, old, { ...old }), /^-- no changes/);
  // rename only
  assert.equal(ms.edit(t, old, { ...old, name: 'quantity' }), `EXEC sp_rename N'${T}.[qty]', N'quantity', 'COLUMN';`);
  // type / null only
  assert.equal(ms.edit(t, old, { ...old, type: 'bigint', nullable: false }), `ALTER TABLE ${T} ALTER COLUMN [qty] bigint NOT NULL;`);
  // rename + type: rename first, ALTER uses the new name, GO between batches
  const both = ms.edit(t, old, { name: 'quantity', type: 'bigint', nullable: true });
  assert.equal(both, `EXEC sp_rename N'${T}.[qty]', N'quantity', 'COLUMN';\nGO\nALTER TABLE ${T} ALTER COLUMN [quantity] bigint NULL;`);
});

test('column ddl: SQL Server Edit with a default: old default dropped before ALTER COLUMN, new default added after', () => {
  const old = { name: 'qty', type: 'int', nullable: false, default: '((0))' };
  // only the default changes
  const d = ms.edit(t, old, { ...old, default: '1' });
  assert.match(d, /DROP CONSTRAINT/);
  assert.ok(d.trimEnd().endsWith(`ALTER TABLE ${T} ADD CONSTRAINT [DF_or]]ders_qty] DEFAULT (1) FOR [qty];`), d);
  assert.doesNotMatch(d, /ALTER COLUMN/);
  // default removed
  const r = ms.edit(t, old, { ...old, default: undefined });
  assert.match(r, /DROP CONSTRAINT/);
  assert.doesNotMatch(r, /ADD CONSTRAINT/);
  // type changes with a bound default (error 5074 otherwise): drop, alter, add the same default back
  const ty = ms.edit(t, old, { ...old, type: 'bigint' });
  const [drop, alter, add] = ['DROP CONSTRAINT', 'ALTER COLUMN [qty] bigint NOT NULL', 'ADD CONSTRAINT [DF_or]]ders_qty] DEFAULT ((0)) FOR [qty]'].map((s) => ty.indexOf(s));
  assert.ok(drop >= 0 && drop < alter && alter < add, ty);
  // equal defaults (same text) = nothing to do
  assert.match(ms.edit(t, old, { ...old }), /^-- no changes/);
});

test('column ddl: default wrapped once in parentheses', () => {
  assert.equal(wrapped('0'), '(0)');
  assert.equal(wrapped('((0))'), '((0))');
  assert.equal(wrapped("(getdate())"), '(getdate())');
  assert.equal(wrapped('(1) + (2)'), '((1) + (2))', 'outer parens closing early are not a wrapper');
  assert.equal(wrapped("N'a'"), "(N'a')");
});

test('column type keeps the scale of datetime2 / time / datetimeoffset (Edit does not change it silently)', () => {
  assert.equal(fmtType('datetime2', 7, 23, 3), 'datetime2(3)');
  assert.equal(fmtType('time', 5, 16, 7), 'time(7)');
  assert.equal(fmtType('datetimeoffset', 10, 34, 7), 'datetimeoffset(7)');
  assert.equal(fmtType('datetime', 8, 23, 3), 'datetime');
});

test('SQL Server data types: complete built-in list for the dropdown, grouped, with size rules', () => {
  const names = MS_TYPES.map((t) => t.name);
  for (const n of ['bigint', 'int', 'smallint', 'tinyint', 'bit', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real',
    'date', 'time', 'datetime2', 'datetimeoffset', 'datetime', 'smalldatetime', 'char', 'varchar', 'text', 'nchar', 'nvarchar', 'ntext',
    'binary', 'varbinary', 'image', 'uniqueidentifier', 'xml', 'sql_variant', 'hierarchyid', 'geometry', 'geography', 'rowversion', 'sysname', 'json', 'vector']) {
    assert.ok(names.includes(n), n);
  }
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.ok(MS_TYPES.every((t) => t.group), 'every type has a group');
  assert.equal(drivers.mssql.columnDdl!.types, MS_TYPES);
});

test('data type: split into base + size, unknown (user-defined) types kept as custom', () => {
  assert.deepEqual(splitType('nvarchar(100)', MS_TYPES), { base: 'nvarchar', args: '100', known: true });
  assert.deepEqual(splitType('decimal(10, 2)', MS_TYPES), { base: 'decimal', args: '10,2', known: true });
  assert.deepEqual(splitType('INT', MS_TYPES), { base: 'int', args: '', known: true });
  assert.deepEqual(splitType('dbo.Phone', MS_TYPES), { base: 'dbo.Phone', args: '', known: false });
});

test('data type: size rules per type (SQL Server limits)', () => {
  const ok = ['int', 'nvarchar(max)', 'varchar(8000)', 'nchar(4000)', 'decimal(38,38)', 'decimal(10)', 'decimal', 'float(53)', 'datetime2(0)', 'time(7)', 'char', 'vector(3)', 'dbo.Phone'];
  for (const t of ok) assert.equal(checkType(t, MS_TYPES), undefined, t);
  assert.match(checkType('int(4)', MS_TYPES)!, /int has no size/);
  assert.match(checkType('nvarchar(4001)', MS_TYPES)!, /nvarchar: length 1-4000 or max/);
  assert.match(checkType('char(max)', MS_TYPES)!, /char: length 1-8000/);
  assert.match(checkType('nvarchar(0)', MS_TYPES)!, /length/);
  assert.match(checkType('decimal(39,2)', MS_TYPES)!, /decimal: precision 1-38, scale 0-precision/);
  assert.match(checkType('decimal(5,6)', MS_TYPES)!, /scale 0-precision/);
  assert.match(checkType('datetime2(8)', MS_TYPES)!, /datetime2: fractional seconds 0-7/);
  assert.match(checkType('float(54)', MS_TYPES)!, /float: precision 1-53/);
  // columns editor ikut memvalidasi tipe
  const rows: ColumnRow[] = [{ name: 'a', type: 'nvarchar(9000)', nullable: true }];
  assert.deepEqual(columnChanges(ms, t, [], rows).errors, ['new column 1: nvarchar: length 1-4000 or max']);
});

test('columns editor: steps for the Pending changes list (kind, column, sql)', () => {
  const o = [{ name: 'qty', type: 'int', nullable: true }, { name: 'price', type: 'int', nullable: true }];
  const r = columnChanges(ms, t, o, [{ ...o[0], orig: 'qty', name: 'quantity' }, { ...o[1], orig: 'price', deleted: true }, { name: 'note', type: 'int', nullable: true }]);
  assert.deepEqual(r.steps.map((s) => [s.kind, s.column, s.to]), [['drop', 'price', undefined], ['edit', 'qty', 'quantity'], ['add', 'note', undefined]]);
  assert.equal(r.sql, r.steps.map((s) => s.sql).join('\nGO\n'));
  // langkah Change menyebut apa yang berubah (nama ada di judul)
  const o2 = [{ name: 'qty', type: 'int', nullable: true, default: '((0))' }];
  const d = (next: Partial<ColumnRow>) => columnChanges(ms, t, o2, [{ ...o2[0], orig: 'qty', ...next }]).steps[0].detail;
  assert.deepEqual(d({ name: 'quantity' }), []);
  assert.deepEqual(d({ type: 'bigint', nullable: false }), ['int → bigint', 'NULL → NOT NULL']);
  assert.deepEqual(d({ default: '1' }), ['default ((0)) → 1']);
  assert.deepEqual(d({ default: '' }), ['default ((0)) removed']);
  assert.deepEqual(columnChanges(ms, t, [{ name: 'a', type: 'int', nullable: false }], [{ name: 'a', orig: 'a', type: 'int', nullable: true, default: '0' }]).steps[0].detail,
    ['NOT NULL → NULL', 'default 0 added']);
});

test('column input: name and type required, default optional', () => {
  assert.equal(checkColumn({ name: ' ', type: 'int', nullable: true }), 'Column name is required');
  assert.equal(checkColumn({ name: 'a', type: '', nullable: true }), 'Data type is required');
  assert.equal(checkColumn({ name: 'a', type: 'int', nullable: false }), undefined);
});

test('explorer: table context says whether the Columns editor is available', () => {
  assert.equal(objContext('table', { def: true, ms: true, cols: true }), 'table.def.ms.cols');
  assert.equal(objContext('table', { def: false, ms: false, cols: false }), 'table');
  assert.equal(objContext('view', { def: true, ms: true, cols: true }), 'view.def.ms', 'views have no column DDL');
});

test('columns editor: Show result -> editable columns (name, type, null, default) + read-only info', () => {
  const rs = { columns: ['ordinal', 'column_name', 'data_type', 'nullable', 'default_value', 'identity', 'computed', 'primary_key'], total: 3,
    rows: [[1, 'id', 'int', 'NO', null, '1, 1', null, 'PK'], [2, 'qty', 'int', 'NO', '((0))', null, null, ''], [3, 'total', 'int', 'YES', null, null, '([qty]*(2))', '']] };
  const { cols, info } = showColumns(rs);
  assert.deepEqual(cols, [
    { name: 'id', type: 'int', nullable: false, generated: true },
    { name: 'qty', type: 'int', nullable: false, default: '((0))' },
    { name: 'total', type: 'int', nullable: true, generated: true },
  ]);
  assert.deepEqual(info.columns, ['identity', 'computed', 'primary_key']);
  assert.deepEqual(info.rows[0], ['1, 1', null, 'PK']);
});

const orig = [
  { name: 'id', type: 'int', nullable: false, generated: true },
  { name: 'qty', type: 'int', nullable: false, default: '((0))' },
  { name: 'price', type: 'decimal(10,2)', nullable: true },
];
const same = (): ColumnRow[] => orig.map((c) => ({ ...c, orig: c.name }));

test('columns editor: no change = empty script', () => {
  assert.deepEqual(columnChanges(ms, t, orig, same()), { sql: '', errors: [], count: 0, steps: [] });
});

test('columns editor: drops, then edits, then adds, one GO batch each (SQL Server)', () => {
  const rows: ColumnRow[] = [...same(), { name: 'note', type: 'nvarchar(100)', nullable: true }];
  rows[1] = { ...rows[1], name: 'quantity' };
  rows[2] = { ...rows[2], deleted: true };
  const r = columnChanges(ms, t, orig, rows);
  assert.deepEqual(r.errors, []);
  assert.equal(r.count, 3);
  assert.equal(r.sql, [ms.drop(t, 'price'), ms.edit(t, orig[1], { ...orig[1], name: 'quantity' }), ms.add(t, { name: 'note', type: 'nvarchar(100)', nullable: true })].join('\nGO\n'));
  // baris baru yang dihapus lagi / kosong tidak ikut
  const r2 = columnChanges(ms, t, orig, [...same(), { name: 'x', type: 'int', nullable: true, deleted: true }, { name: ' ', type: '', nullable: true }]);
  assert.equal(r2.count, 0);
});

test('columns editor: invalid rows block the script (empty name / type, duplicate names)', () => {
  const rows = same();
  rows[1] = { ...rows[1], type: ' ' };
  assert.deepEqual(columnChanges(ms, t, orig, rows).errors, ['qty: Data type is required']);
  const dup = [...same(), { name: 'QTY', type: 'int', nullable: true }];
  assert.deepEqual(columnChanges(ms, t, orig, dup).errors, ['Duplicate column name: QTY']);
  const noName = [...same(), { name: '', type: 'int', nullable: true }];
  assert.deepEqual(columnChanges(ms, t, orig, noName).errors, ['new column 4: Column name is required']);
  assert.equal(columnChanges(ms, t, orig, dup).sql, '');
});

test('columns editor: page has grid, Pending changes list and Execute / Open in SQL Editor / Revert; read-only hides editing', () => {
  const h = columnsHtml('csp-src', { conn: 'local', db: 'shop', table: 'dbo.<orders>' }, false);
  assert.match(h, /Content-Security-Policy[^>]+script-src 'nonce-/);
  assert.ok(h.includes('<h1>dbo.&lt;orders&gt;</h1>'), 'table name is the heading, escaped');
  assert.ok(h.includes('local / shop'), 'connection / database under the heading');
  for (const id of ['grid', 'preview', 'execute', 'openSql', 'revert', 'addCol', 'refresh', 'splitter']) assert.match(h, new RegExp(`id="${id}"`), id);
  assert.match(h, /Pending changes/);
  const ro = columnsHtml('csp-src', { conn: 'x', db: 'y', table: 'z' }, true);
  assert.match(ro, /const readOnly = true/);
  assert.match(ro, /read-only/i);
  assert.doesNotMatch(ro, /id="execute"/);
  assert.doesNotMatch(ro, /id="addCol"/);
});

type Item = { command: string; when?: string; group?: string };
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
const items: Item[] = pkg.contributes.menus['view/item/context'];
const menu = (viewItem: string) => items.filter((it) => {
  const re = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '');
  return (it.when ?? '').includes('view == moonageDaydream.explorer') && !!re && new RegExp(re[1]).test(viewItem);
}).map((it) => it.command.replace('moonageDaydream.', ''));

test('menus: right-click table has one Columns item, other menus kept', () => {
  const m = menu('table.def.ms.cols');
  for (const c of ['editColumns', 'selectTop', 'scriptAs']) assert.ok(m.includes(c), `table: ${c}`);
  assert.equal(m.filter((c) => /Column/.test(c)).length, 1, 'only one column item');
  assert.ok(!menu('view.def.ms').includes('editColumns'), 'view: no Columns');
  assert.ok(!menu('table').includes('editColumns'), 'driver without column ddl: no Columns');
  assert.ok(pkg.contributes.commands.some((x: { command: string; title: string }) => x.command === 'moonageDaydream.editColumns' && x.title === 'Columns'));
  for (const c of ['showColumns', 'addColumn', 'editColumn', 'deleteColumn']) assert.ok(!pkg.contributes.commands.some((x: { command: string }) => x.command === `moonageDaydream.${c}`), `${c} removed`);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkColumn, checkType, columnChanges, splitType, type ColumnRow, drivers, objContext, showColumns } from '../db';
import { columnsHtml } from '../columnsHtml';
import { MS_TYPES, fmtType, wrapped } from '../mssql';
import { sqliteDriver, sqliteRebuild } from '../sqlite';

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

// ---------- MySQL / MariaDB ----------
const my = drivers.mysql.columnDdl!;
const mt = { schema: 'sh`op', name: "or'ders" };
const MT = '`sh``op`.`or\'ders`';

test('column ddl: MySQL and MariaDB share the same column script, new columns start as varchar(100)', () => {
  assert.equal(drivers.mariadb.columnDdl, my);
  assert.equal(my.newType, 'varchar(100)');
  assert.equal(ms.newType, 'nvarchar(100)');
  assert.match(my.note!, /implicit/i, 'confirm mentions DDL commits implicitly');
  assert.equal(my.separator, '\n');
});

test('column ddl: MySQL Show reads information_schema.columns of the table, defaults as SQL expressions (MySQL / MariaDB)', () => {
  const sql = my.show(mt);
  assert.match(sql, /FROM information_schema\.columns/);
  assert.ok(sql.includes("table_schema = 'sh`op' AND table_name = 'or''ders'"), sql);
  for (const col of ['column_name', 'data_type', 'nullable', 'default_value', 'identity', 'generated', 'primary_key', 'collation', 'comment', 'keep']) assert.match(sql, new RegExp(`AS \`?${col}\\b`), col);
  assert.match(sql, /VERSION\(\) LIKE '%MariaDB%'/, 'MariaDB column_default is already an expression');
  assert.match(sql, /ORDER BY ordinal_position/);
});

test('column ddl: MySQL Add / Delete', () => {
  assert.equal(my.add(mt, { name: 'note', type: 'varchar(100)', nullable: true }), `ALTER TABLE ${MT} ADD COLUMN \`note\` varchar(100) NULL;`);
  assert.equal(my.add(mt, { name: 'q`ty', type: 'int', nullable: false, default: '0' }), `ALTER TABLE ${MT} ADD COLUMN \`q\`\`ty\` int NOT NULL DEFAULT 0;`);
  assert.equal(my.drop(mt, 'price'), `ALTER TABLE ${MT} DROP COLUMN \`price\`;`);
});

test('column ddl: MySQL Edit = RENAME COLUMN for a rename only, CHANGE COLUMN otherwise (collation / on update / comment kept)', () => {
  const old = { name: 'title', type: 'varchar(50)', nullable: true, keep: "COLLATE utf8mb4_bin COMMENT 'it''s'" };
  assert.match(my.edit(mt, old, { ...old }), /^-- no changes/);
  // rename saja: atribut lain (auto_increment, generated, comment) tetap
  assert.equal(my.edit(mt, old, { ...old, name: 'name' }), `ALTER TABLE ${MT} RENAME COLUMN \`title\` TO \`name\`;`);
  assert.equal(my.edit(mt, old, { name: 'name', type: 'varchar(80)', nullable: false, default: "'x'" }),
    `ALTER TABLE ${MT} CHANGE COLUMN \`title\` \`name\` varchar(80) COLLATE utf8mb4_bin NOT NULL DEFAULT 'x' COMMENT 'it''s';`);
  // tipe bukan teks: COLLATE tidak dibawa
  assert.equal(my.edit(mt, old, { ...old, type: 'int' }), `ALTER TABLE ${MT} CHANGE COLUMN \`title\` \`title\` int NULL COMMENT 'it''s';`);
  const ts = { name: 'at', type: 'timestamp', nullable: false, default: 'CURRENT_TIMESTAMP', keep: 'on update CURRENT_TIMESTAMP' };
  assert.equal(my.edit(mt, ts, { ...ts, default: undefined }), `ALTER TABLE ${MT} CHANGE COLUMN \`at\` \`at\` timestamp NOT NULL on update CURRENT_TIMESTAMP;`);
});

test('MySQL / MariaDB data types: complete list, grouped, size rules', () => {
  const names = my.types.map((x) => x.name);
  for (const n of ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'int unsigned', 'bigint unsigned', 'decimal', 'float', 'double', 'bit',
    'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob',
    'enum', 'set', 'date', 'time', 'datetime', 'timestamp', 'year', 'json', 'geometry', 'point', 'uuid', 'inet6']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.ok(my.types.every((x) => x.group), 'every type has a group');
  for (const ty of ['int', 'int unsigned', 'tinyint(1)', 'varchar(65535)', 'char(255)', 'decimal(65,30)', 'float(7,4)', 'datetime(6)', 'bit(64)', 'year(4)', "enum('a b','c')", "set('x')"]) {
    assert.equal(checkType(ty, my.types), undefined, ty);
  }
  assert.match(checkType('varchar(65536)', my.types)!, /varchar: length 1-65535/);
  assert.match(checkType('char(256)', my.types)!, /char: length 1-255/);
  assert.match(checkType('decimal(66,2)', my.types)!, /decimal: precision 1-65/);
  assert.match(checkType('datetime(7)', my.types)!, /datetime: fractional seconds 0-6/);
  assert.match(checkType('int(11)', my.types)!, /int has no size/);
  assert.match(checkType('enum()', my.types)!, /enum: list of values/);
  // nilai enum dengan spasi tidak diubah
  assert.deepEqual(splitType("enum('a b', 'c')", my.types), { base: 'enum', args: "'a b', 'c'", known: true });
  assert.deepEqual(splitType('INT UNSIGNED', my.types), { base: 'int unsigned', args: '', known: true });
});

test('columns editor: Show keep (attributes carried by CHANGE COLUMN) goes to the column, not to the info grid', () => {
  const rs = { columns: ['ordinal', 'column_name', 'data_type', 'nullable', 'default_value', 'identity', 'comment', 'keep'],
    rows: [[1, 'id', 'int', 'NO', null, 'auto_increment', '', ''], [2, 'title', 'varchar(50)', 'YES', null, null, 'x', "COMMENT 'x'"]] };
  const { cols, info } = showColumns(rs);
  assert.deepEqual(cols, [{ name: 'id', type: 'int', nullable: false, generated: true }, { name: 'title', type: 'varchar(50)', nullable: true, keep: "COMMENT 'x'" }]);
  assert.deepEqual(info.columns, ['identity', 'comment']);
  const r = columnChanges(my, mt, cols, [{ ...cols[0], orig: 'id' }, { ...cols[1], orig: 'title', type: 'varchar(60)' }, { name: 'n', type: 'int', nullable: true }]);
  assert.equal(r.sql, `ALTER TABLE ${MT} CHANGE COLUMN \`title\` \`title\` varchar(60) NULL COMMENT 'x';\nALTER TABLE ${MT} ADD COLUMN \`n\` int NULL;`);
});

// ---------- PostgreSQL ----------
const pg = drivers.postgres.columnDdl!;
const pt = { schema: 'sa"les', name: "or'ders" };
const PT = '"sa""les"."or\'ders"';

test('column ddl: PostgreSQL basics (separator, new column type, note about one transaction)', () => {
  assert.equal(pg.separator, '\n');
  assert.equal(pg.newType, 'varchar(100)');
  assert.match(pg.note!, /one transaction/i);
});

test('column ddl: PostgreSQL Show reads pg_attribute of the table with short type names, identity, generated, primary key', () => {
  const sql = pg.show(pt);
  assert.match(sql, /FROM pg_attribute a/);
  assert.ok(sql.includes(`to_regclass('${PT.replace(/'/g, "''")}')`), sql);
  for (const col of ['column_name', 'data_type', 'nullable', 'default_value', 'identity', 'generated', 'primary_key', 'collation', 'comment', 'keep']) assert.match(sql, new RegExp(`AS ${col}\\b`), col);
  assert.match(sql, /varchar/);
  assert.match(sql, /timestamptz/);
  assert.match(sql, /ORDER BY a\.attnum/);
});

test('column ddl: PostgreSQL Add / Delete', () => {
  assert.equal(pg.add(pt, { name: 'note', type: 'varchar(100)', nullable: true }), `ALTER TABLE ${PT} ADD COLUMN "note" varchar(100) NULL;`);
  assert.equal(pg.add(pt, { name: 'q"ty', type: 'integer', nullable: false, default: '0' }), `ALTER TABLE ${PT} ADD COLUMN "q""ty" integer NOT NULL DEFAULT 0;`);
  assert.equal(pg.drop(pt, 'price'), `ALTER TABLE ${PT} DROP COLUMN "price";`);
});

test('column ddl: PostgreSQL Edit = RENAME COLUMN, then one ALTER TABLE with TYPE ... USING, SET / DROP NOT NULL, SET / DROP DEFAULT', () => {
  const old = { name: 'qty', type: 'integer', nullable: true, default: '0' };
  assert.match(pg.edit(pt, old, { ...old }), /^-- no changes/);
  assert.equal(pg.edit(pt, old, { ...old, name: 'quantity' }), `ALTER TABLE ${PT} RENAME COLUMN "qty" TO "quantity";`);
  assert.equal(pg.edit(pt, old, { name: 'quantity', type: 'bigint', nullable: false, default: '1' }),
    `ALTER TABLE ${PT} RENAME COLUMN "qty" TO "quantity";\nALTER TABLE ${PT} ALTER COLUMN "quantity" TYPE bigint USING "quantity"::bigint, ALTER COLUMN "quantity" SET NOT NULL, ALTER COLUMN "quantity" SET DEFAULT 1;`);
  assert.equal(pg.edit(pt, { ...old, nullable: false }, { ...old, default: undefined }),
    `ALTER TABLE ${PT} ALTER COLUMN "qty" DROP NOT NULL, ALTER COLUMN "qty" DROP DEFAULT;`);
  // collation non-default dibawa saat tipe teks berubah, tidak untuk tipe bukan teks
  const t = { name: 'title', type: 'varchar(50)', nullable: true, keep: 'COLLATE "C"' };
  assert.equal(pg.edit(pt, t, { ...t, type: 'varchar(80)' }), `ALTER TABLE ${PT} ALTER COLUMN "title" TYPE varchar(80) COLLATE "C" USING "title"::varchar(80);`);
  assert.equal(pg.edit(pt, t, { ...t, type: 'integer' }), `ALTER TABLE ${PT} ALTER COLUMN "title" TYPE integer USING "title"::integer;`);
});

test('PostgreSQL data types: complete list, grouped, size rules', () => {
  const names = pg.types.map((x) => x.name);
  for (const n of ['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'smallserial', 'serial', 'bigserial', 'money', 'boolean',
    'char', 'varchar', 'text', 'bytea', 'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'xml',
    'inet', 'cidr', 'macaddr', 'bit', 'varbit', 'tsvector', 'point']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.ok(pg.types.every((x) => x.group), 'every type has a group');
  for (const ty of ['integer', 'varchar', 'varchar(10485760)', 'numeric(1000,0)', 'numeric', 'timestamptz(6)', 'double precision', 'integer[]', 'public.mood']) {
    assert.equal(checkType(ty, pg.types), undefined, ty);
  }
  assert.match(checkType('varchar(10485761)', pg.types)!, /varchar: length 1-10485760/);
  assert.match(checkType('numeric(1001,2)', pg.types)!, /numeric: precision 1-1000/);
  assert.match(checkType('timestamp(7)', pg.types)!, /timestamp: fractional seconds 0-6/);
  assert.match(checkType('integer(4)', pg.types)!, /integer has no size/);
  assert.ok(pg.types.find((x) => x.name === 'serial')!.note!.match(/add/i), 'serial is only for new columns');
});

// ---------- SQLite ----------
const lite = drivers.sqlite.columnDdl!;
const lt = { schema: 'main', name: 'it"em' };
const LT = '"it""em"';

test('column ddl: SQLite basics (one transaction around the script, note mentions the rebuild)', () => {
  assert.equal(lite.newType, 'text');
  assert.match(lite.note!, /one transaction/i);
  assert.match(lite.note!, /rebuild/i);
  assert.equal(lite.wrap!('X;'), 'BEGIN;\nX;\nCOMMIT;');
  const sql = lite.show(lt);
  assert.match(sql, /pragma_table_xinfo\('it"em'\)/);
  for (const col of ['column_name', 'data_type', 'nullable', 'default_value', 'primary_key', 'generated', 'keep']) assert.match(sql, new RegExp(`AS ${col}\\b`), col);
});

test('column ddl: SQLite Add / Delete / rename, NOT NULL column needs a default', () => {
  assert.equal(lite.add(lt, { name: 'note', type: 'text', nullable: true }), `ALTER TABLE ${LT} ADD COLUMN "note" text;`);
  assert.equal(lite.add(lt, { name: 'qty', type: 'integer', nullable: false, default: '0' }), `ALTER TABLE ${LT} ADD COLUMN "qty" integer NOT NULL DEFAULT 0;`);
  assert.equal(lite.drop(lt, 'price'), `ALTER TABLE ${LT} DROP COLUMN "price";`);
  const old = { name: 'qty', type: 'integer', nullable: true };
  assert.equal(lite.edit(lt, old, { ...old, name: 'quantity' }), `ALTER TABLE ${LT} RENAME COLUMN "qty" TO "quantity";`);
  assert.match(lite.edit(lt, old, { ...old, type: 'real' }), /^-- "qty": .*rebuild/);
  const e = columnChanges(lite, lt, [], [{ name: 'n', type: 'integer', nullable: false }]).errors;
  assert.deepEqual(e, ['new column 1: a new NOT NULL column needs a default (SQLite)']);
});

test('SQLite rebuild: only the changed column definitions are rewritten, other constraints / options kept', () => {
  const create = `CREATE TABLE "item" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT 'a, (b)' COLLATE NOCASE,
    qty INTEGER CONSTRAINT q_nn NOT NULL DEFAULT (0) CHECK (qty >= 0), [price] REAL, UNIQUE (name), FOREIGN KEY (qty) REFERENCES other(id)) STRICT`;
  const bundle = JSON.stringify({ create, extras: ['CREATE INDEX ix_item_qty ON item (qty)', 'CREATE TRIGGER t1 AFTER INSERT ON item BEGIN SELECT 1; END'] });
  const sql = sqliteRebuild({ schema: 'main', name: 'item' }, bundle, ['id', 'name', 'qty', 'price'],
    [{ name: 'qty', type: 'bigint', nullable: true, default: '1' }, { name: 'name', type: 'varchar(80)', nullable: false, default: "'x'" }, { name: 'price', type: 'numeric', nullable: false }]);
  assert.equal(sql, [
    `CREATE TABLE "item__moonage_new" (id INTEGER PRIMARY KEY AUTOINCREMENT, name varchar(80) COLLATE NOCASE NOT NULL DEFAULT 'x',
    qty bigint CHECK (qty >= 0) DEFAULT 1, [price] numeric NOT NULL, UNIQUE (name), FOREIGN KEY (qty) REFERENCES other(id)) STRICT;`,
    'INSERT INTO "item__moonage_new" ("id", "name", "qty", "price") SELECT "id", "name", "qty", "price" FROM "item";',
    'DROP TABLE "item";',
    // legacy: RENAME TO tidak memeriksa ulang view yang menunjuk tabel lama (sudah di-drop)
    'PRAGMA legacy_alter_table = ON;',
    'ALTER TABLE "item__moonage_new" RENAME TO "item";',
    'PRAGMA legacy_alter_table = OFF;',
    'CREATE INDEX ix_item_qty ON item (qty);',
    'CREATE TRIGGER t1 AFTER INSERT ON item BEGIN SELECT 1; END;',
  ].join('\n'));
});

test('SQLite data types: affinities + common names, size rules', () => {
  const names = lite.types.map((x) => x.name);
  for (const n of ['integer', 'real', 'text', 'blob', 'numeric', 'int', 'bigint', 'boolean', 'varchar', 'char', 'decimal', 'double', 'date', 'datetime']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.ok(lite.types.every((x) => x.group && x.note), 'group + affinity note');
  for (const ty of ['INTEGER', 'varchar(255)', 'decimal(10,2)', 'text', 'my_type']) assert.equal(checkType(ty, lite.types), undefined, ty);
});

test('SQLite Columns editor end to end on a real file: rename, rebuild, drop, add; index / trigger / view kept; failure leaves the file unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonage-cols-'));
  try {
    const file = join(dir, 'lab.db');
    writeFileSync(file, '');
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const run = (sql: string) => sqliteDriver.run(c, '', sql);
    await run(`CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'none' COLLATE NOCASE, qty INTEGER DEFAULT 0 CHECK (qty >= 0),
        price REAL, flag INTEGER, total REAL GENERATED ALWAYS AS (qty * price) VIRTUAL);
      CREATE INDEX ix_item_name ON item (name);
      CREATE TABLE log (n INTEGER);
      CREATE TRIGGER item_ins AFTER INSERT ON item BEGIN INSERT INTO log VALUES (1); END;
      CREATE VIEW cheap AS SELECT id, name FROM item WHERE price < 5;
      INSERT INTO item (name, qty, price) VALUES ('apple', 5, 1.5), ('banana', 0, NULL);`);
    const o = { schema: 'main', name: 'item' };
    const load = async () => showColumns((await run(lite.show(o))).resultSets[0]).cols;
    const cols = await load();
    const strip = (x: ColumnRow) => ({ ...x, keep: undefined });
    assert.deepEqual(cols.map(strip), [
      { name: 'id', type: 'INTEGER', nullable: true, keep: undefined },
      { name: 'name', type: 'TEXT', nullable: false, default: "'none'", keep: undefined },
      { name: 'qty', type: 'INTEGER', nullable: true, default: '0', keep: undefined },
      { name: 'price', type: 'REAL', nullable: true, keep: undefined },
      { name: 'flag', type: 'INTEGER', nullable: true, keep: undefined },
      { name: 'total', type: 'REAL', nullable: true, generated: true, keep: undefined },
    ]);
    const rows: ColumnRow[] = cols.map((x) => ({ ...x, orig: x.name }));
    const edit = (n: string, ch: Partial<ColumnRow>) => Object.assign(rows.find((x) => x.orig === n)!, ch);
    edit('name', { name: 'title', type: 'varchar(80)' });
    edit('qty', { type: 'bigint', default: '1' });
    edit('flag', { deleted: true });
    rows.push({ name: 'note', type: 'text', nullable: false, default: "'x'" });
    const r = columnChanges(lite, o, cols, rows);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.steps.map((s) => [s.kind, s.column]), [['rebuild', 'item'], ['drop', 'flag'], ['edit', 'name'], ['edit', 'qty'], ['add', 'note']]);
    await run(r.sql);
    const after = await load();
    assert.deepEqual(after.map((x) => `${x.name} ${x.type} ${x.nullable} ${x.default ?? ''}`),
      ['id INTEGER true ', "title varchar(80) false 'none'", 'qty bigint true 1', 'price REAL true ', 'total REAL true ', "note TEXT false 'x'"]);
    const one = async (sql: string) => (await run(sql)).resultSets[0]?.rows;
    assert.deepEqual(await one("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') ORDER BY name"), [['cheap'], ['item_ins'], ['ix_item_name']]);
    assert.deepEqual(await one('SELECT id, title, qty, total, note FROM item ORDER BY id'), [[1, 'apple', 5, 7.5, 'x'], [2, 'banana', 0, null, 'x']]);
    assert.deepEqual(await one('SELECT title FROM cheap'), [['apple']]);
    assert.deepEqual(await one("SELECT title FROM item WHERE title = 'APPLE'"), [['apple']], 'COLLATE NOCASE kept');

    // gagal di tengah (price NULL -> NOT NULL): tidak ada yang berubah
    const bad = after.map((x): ColumnRow => ({ ...x, orig: x.name }));
    Object.assign(bad.find((x) => x.orig === 'qty')!, { name: 'q' });
    Object.assign(bad.find((x) => x.orig === 'price')!, { nullable: false });
    const before = readFileSync(file);
    await assert.rejects(run(columnChanges(lite, o, after, bad).sql), /NOT NULL/);
    assert.ok(readFileSync(file).equals(before), 'file unchanged after a failing script');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- MongoDB ----------
const mg = drivers.mongodb.columnDdl!;
const mc = { schema: 'db', name: 'or"ders' };
const MC = 'db.getCollection("or\\"ders")';

test('column ddl: MongoDB basics (BSON types, no transaction note, every script is valid mongosh text)', async () => {
  const { parseShell } = await import('../mongo');
  assert.equal(mg.newType, 'string');
  assert.match(mg.note!, /no schema/i);
  const names = mg.types.map((x) => x.name);
  for (const n of ['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId', 'array', 'object', 'binData', 'null']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length);
  const show = mg.show(mc);
  assert.ok(show.startsWith(`${MC}.aggregate([`), show);
  assert.match(show, /\$sample: \{ size: 100 \}/);
  for (const col of ['column_name', 'data_type', 'nullable', 'default_value', 'present', 'identity']) assert.match(show, new RegExp(`${col}:`), col);
  for (const sql of [show, mg.add(mc, { name: 'note', type: 'string', nullable: false, default: '"x"' }), mg.drop(mc, 'price'),
    mg.edit(mc, { name: 'qty', type: 'string', nullable: true }, { name: 'quantity', type: 'int', nullable: false, default: '0' })]) {
    assert.ok(parseShell(sql).length > 0, sql);
  }
});

test('column ddl: MongoDB Add / Delete = updateMany with $set / $unset', () => {
  assert.equal(mg.add(mc, { name: 'note', type: 'string', nullable: true }), `${MC}.updateMany({ "note": { $exists: false } }, { $set: { "note": null } });`);
  assert.equal(mg.add(mc, { name: 'qty', type: 'int', nullable: false, default: 'NumberInt(0)' }), `${MC}.updateMany({ "qty": { $exists: false } }, { $set: { "qty": NumberInt(0) } });`);
  assert.equal(mg.drop(mc, 'price'), `${MC}.updateMany({ "price": { $exists: true } }, { $unset: { "price": "" } });`);
});

test('column ddl: MongoDB Edit = $rename, $convert pipeline (failed conversion -> null), fill default', () => {
  const old = { name: 'qty', type: 'string', nullable: true };
  assert.match(mg.edit(mc, old, { ...old }), /^\/\/ no changes/);
  assert.equal(mg.edit(mc, old, { name: 'quantity', type: 'int', nullable: false, default: '0' }), [
    `${MC}.updateMany({ "qty": { $exists: true } }, { $rename: { "qty": "quantity" } });`,
    `${MC}.updateMany({ "quantity": { $exists: true } }, [{ $set: { "quantity": { $convert: { input: "$quantity", to: "int", onError: null, onNull: null } } } }]);`,
    `${MC}.updateMany({ $or: [{ "quantity": { $exists: false } }, { "quantity": null }] }, { $set: { "quantity": 0 } });`,
  ].join('\n'));
  // default saja (boleh null): hanya dokumen tanpa field
  assert.equal(mg.edit(mc, old, { ...old, default: '"n/a"' }), `${MC}.updateMany({ "qty": { $exists: false } }, { $set: { "qty": "n/a" } });`);
  // NOT NULL -> NULL: tidak ada constraint, tidak ada perintah
  assert.match(mg.edit(mc, { ...old, nullable: false }, old), /^\/\/ .*no constraint/);
});

test('columns editor: MongoDB validation (convertible type, field name, Not null needs a default); untouched mixed types are fine', () => {
  const orig = [{ name: '_id', type: 'objectId', nullable: false, generated: true }, { name: 'tag', type: 'int|string', nullable: true }];
  const base = (): ColumnRow[] => orig.map((c) => ({ ...c, orig: c.name }));
  assert.deepEqual(columnChanges(mg, mc, orig, base()).errors, []);
  const e = (rows: ColumnRow[]) => columnChanges(mg, mc, orig, rows).errors;
  assert.deepEqual(e([...base(), { name: 'a.b', type: 'string', nullable: true }]), ['new column 3: field name cannot contain "." or start with "$"']);
  assert.deepEqual(e([...base(), { name: 'n', type: 'int', nullable: false }]), ['new column 3: Not null needs a default (value for documents without the field)']);
  const rows = base();
  rows[1] = { ...rows[1], type: 'array' };
  assert.deepEqual(e(rows), ['tag: cannot convert existing values to array (use string, int, long, double, decimal, bool, date or objectId)']);
  rows[1] = { ...rows[1], type: 'string', nullable: false };
  assert.deepEqual(e(rows), ['tag: Not null needs a default (value for documents without the field)']);
});

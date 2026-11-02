import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkKeys, columnChanges, createTable, drivers, keyName, type ColumnRow, type NewColumn, type TableKey } from '../db';

const t = { schema: 'dbo', name: 'item' };
const cols: NewColumn[] = [
  { name: 'a', type: 'int', nullable: false },
  { name: 'b', type: 'int', nullable: false },
  { name: 'c', type: 'int', nullable: true },
];
const uq = (names: string[]): TableKey => ({ kind: 'unique', cols: names });
const fk = (names: string[], target: string[], extra: Partial<NonNullable<TableKey['ref']>> = {}): TableKey =>
  ({ kind: 'fk', cols: names, ref: { schema: 'dbo', table: 'parent', columns: target, ...extra } });

test('checkKeys: rejects empty, unknown, duplicate, mismatched and SET NULL on NOT NULL', () => {
  const ddl = drivers.mssql.columnDdl!;
  assert.match(checkKeys(ddl, t, cols, [uq([])])[0], /at least one column/);
  assert.match(checkKeys(ddl, t, cols, [uq(['zzz'])])[0], /unknown column zzz/);
  assert.match(checkKeys(ddl, t, cols, [uq(['a', 'a'])])[0], /twice/);
  assert.match(checkKeys(ddl, t, cols, [fk(['a', 'b'], ['x'])])[0], /same number of columns/);
  assert.match(checkKeys(ddl, t, cols, [{ kind: 'fk', cols: ['a'] }])[0], /referenced table/);
  assert.match(checkKeys(ddl, t, cols, [fk(['a', 'b'], ['x', 'y'], { onDelete: 'SET NULL' })])[0], /SET NULL needs nullable/);
  assert.match(checkKeys(ddl, t, cols, [uq(['a', 'b']), uq(['b', 'a'])])[0], /Duplicate/);
  assert.deepEqual(checkKeys(ddl, t, cols, [uq(['a', 'b']), fk(['a', 'c'], ['x', 'y'], { onDelete: 'CASCADE' })]), []);
});

test('keyName: UQ_/FK_ + table + columns, hashed suffix beyond nameMax', () => {
  assert.equal(keyName(t, 'unique', ['a', 'b'], 128), 'UQ_item_a_b');
  const long = keyName(t, 'fk', ['a'.repeat(40), 'b'.repeat(40)], 64);
  assert.ok(long.length <= 64 && long.startsWith('FK_item_'));
  assert.equal(long, keyName(t, 'fk', ['a'.repeat(40), 'b'.repeat(40)], 64));
});

test('createTable: composite UNIQUE and FK in all SQL drivers', () => {
  const keys = [uq(['a', 'b']), fk(['a', 'b'], ['x', 'y'], { onDelete: 'CASCADE' })];
  const expect: Record<string, RegExp[]> = {
    mssql: [/CONSTRAINT \[UQ_item_a_b\] UNIQUE \(\[a\], \[b\]\)/, /CONSTRAINT \[FK_item_a_b\] FOREIGN KEY \(\[a\], \[b\]\) REFERENCES \[dbo\]\.\[parent\] \(\[x\], \[y\]\) ON DELETE CASCADE/],
    mysql: [/UNIQUE KEY `UQ_item_a_b` \(`a`, `b`\)/, /FOREIGN KEY \(`a`, `b`\) REFERENCES .*\(`x`, `y`\) ON DELETE CASCADE/],
    postgres: [/UNIQUE \("a", "b"\)/, /FOREIGN KEY \("a", "b"\) REFERENCES .*\("x", "y"\) ON DELETE CASCADE/],
    sqlite: [/UNIQUE \("a", "b"\)/, /FOREIGN KEY \("a", "b"\) REFERENCES "parent" \("x", "y"\) ON DELETE CASCADE/],
  };
  for (const [name, res] of Object.entries(expect)) {
    const r = createTable(drivers[name as 'mssql'].columnDdl!, t, cols, keys);
    assert.deepEqual(r.errors, [], name);
    for (const re of res) assert.match(r.sql, re, name);
  }
});

test('createTable: key errors block the script', () => {
  const r = createTable(drivers.mssql.columnDdl!, t, cols, [uq(['nope'])]);
  assert.equal(r.sql, '');
  assert.match(r.errors[0], /unknown column nope/);
});

test('key DDL: column lists in all SQL drivers', () => {
  const ref = { schema: 'dbo', table: 'parent', columns: ['x', 'y'], onDelete: 'CASCADE' };
  assert.equal(drivers.mssql.columnDdl!.addUnique!(t, ['a', 'b'], 'UQ_ab'), 'ALTER TABLE [dbo].[item] ADD CONSTRAINT [UQ_ab] UNIQUE ([a], [b]);');
  assert.equal(drivers.mssql.columnDdl!.addFk!(t, ['a', 'b'], ref, 'FK_ab'),
    'ALTER TABLE [dbo].[item] ADD CONSTRAINT [FK_ab] FOREIGN KEY ([a], [b]) REFERENCES [dbo].[parent] ([x], [y]) ON DELETE CASCADE;');
  assert.match(drivers.mysql.columnDdl!.addUnique!(t, ['a', 'b'], 'UQ_ab'), /ADD UNIQUE KEY `UQ_ab` \(`a`, `b`\);$/);
  assert.match(drivers.mysql.columnDdl!.addFk!(t, ['a', 'b'], ref, 'FK_ab'), /FOREIGN KEY \(`a`, `b`\) REFERENCES `dbo`\.`parent` \(`x`, `y`\) ON DELETE CASCADE;$/);
  assert.match(drivers.postgres.columnDdl!.addUnique!(t, ['a', 'b'], 'UQ_ab'), /ADD CONSTRAINT "UQ_ab" UNIQUE \("a", "b"\);$/);
  assert.match(drivers.postgres.columnDdl!.addFk!(t, ['a', 'b'], ref, 'FK_ab'), /FOREIGN KEY \("a", "b"\) REFERENCES "dbo"\."parent" \("x", "y"\) ON DELETE CASCADE;$/);
  // nama default satu kolom tetap sama
  assert.equal(drivers.mssql.columnDdl!.addUnique!(t, ['a']), 'ALTER TABLE [dbo].[item] ADD CONSTRAINT [UQ_item_a] UNIQUE ([a]);');
});

const row = (name: string, props: Partial<ColumnRow> = {}): ColumnRow => ({ name, type: 'int', nullable: false, orig: name, ...props });
const ms = drivers.mssql.columnDdl!;
const orig = [row('a'), row('b'), row('c', { nullable: true })];
const oldUq: TableKey = { kind: 'unique', name: 'UQ_old', cols: ['a', 'b'] };
const oldFk: TableKey = { kind: 'fk', name: 'FK_old', cols: ['a', 'b'], ref: { schema: 'dbo', table: 'parent', columns: ['x', 'y'] } };

test('columnChanges keys: unchanged keys make no steps; rename keeps the key', () => {
  assert.equal(columnChanges(ms, t, orig.map(stripOrig), orig, [oldUq, oldFk], [oldUq, oldFk]).count, 0);
  const rows = [row('a', { name: 'a2' }), row('b'), row('c', { nullable: true })];
  const r = columnChanges(ms, t, orig.map(stripOrig), rows, [{ ...oldUq, cols: ['a2', 'b'] }, { ...oldFk, cols: ['a2', 'b'] }], [oldUq, oldFk]);
  assert.deepEqual(r.steps.map((s) => s.kind), ['edit']);
});

test('columnChanges keys: add / drop / change in safe order with names', () => {
  const nu: TableKey = { kind: 'unique', cols: ['b', 'c'] };
  const changedFk = { ...oldFk, ref: { ...oldFk.ref!, onDelete: 'CASCADE' } };
  const r = columnChanges(ms, t, orig.map(stripOrig), orig, [nu, changedFk], [oldUq, oldFk]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.steps.map((s) => s.title), [
    'Drop foreign key FK_old',
    'Drop unique UQ_old',
    'Add unique UQ_item_b_c (b, c)',
    'Add foreign key FK_old (a, b) → parent(x, y) ON DELETE CASCADE',
  ]);
  assert.match(r.sql, /ADD CONSTRAINT \[UQ_item_b_c\] UNIQUE \(\[b\], \[c\]\)/);
});

test('columnChanges keys: type change of a member re-creates the key (SQL Server)', () => {
  const rows = [row('a', { type: 'bigint' }), row('b'), row('c', { nullable: true })];
  const r = columnChanges(ms, t, orig.map(stripOrig), rows, [oldUq], [oldUq]);
  assert.deepEqual(r.steps.map((s) => s.title), ['Drop unique UQ_old', 'Change a', 'Add unique UQ_old (a, b)']);
});

test('columnChanges keys: deleting a member column or touching a read-only key is blocked', () => {
  const rows = [row('a', { deleted: true }), row('b'), row('c', { nullable: true })];
  assert.match(columnChanges(ms, t, orig.map(stripOrig), rows, [oldUq], [oldUq]).errors.join(), /unknown column a/);
  const ro: TableKey = { kind: 'unique', name: 'IX_filtered', cols: ['a', 'b'], index: true, readOnly: true };
  const r = columnChanges(ms, t, orig.map(stripOrig), rows, [ro], [ro]);
  assert.match(r.errors.join(), /IX_filtered.*read-only/);
  // read-only yang tidak tersentuh: tidak ada langkah
  assert.equal(columnChanges(ms, t, orig.map(stripOrig), orig, [ro], [ro]).count, 0);
});

test('columnChanges keys: drivers without key DDL reject key changes', () => {
  const r = columnChanges(drivers.sqlite.columnDdl!, t, orig.map(stripOrig), orig, [oldUq], []);
  assert.match(r.errors.join(), /not supported/);
});

function stripOrig(r: ColumnRow): ColumnRow {
  const { orig: _orig, ...rest } = r;
  return rest;
}

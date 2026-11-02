import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkKeys, columnChanges, createTable, drivers, execScript, keyName, readKeys, showColumns, type ColumnRow, type NewColumn, type TableKey } from '../db';

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
const sqliteDriver = drivers.sqlite;
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
  const r = columnChanges({ ...ms, addUnique: undefined }, t, orig.map(stripOrig), orig, [oldUq], []);
  assert.match(r.errors.join(), /not supported/);
});

function stripOrig(r: ColumnRow): ColumnRow {
  const { orig: _orig, ...rest } = r;
  return rest;
}

test('readKeys: groups member rows into ordered keys, read-only and index flags', () => {
  const columns = ['key_name', 'kind', 'is_index', 'read_only', 'col_name', 'ord', 'ref_schema', 'ref_table', 'ref_column', 'on_delete', 'on_update'];
  const rows = [
    ['UQ_ab', 'unique', 0, 0, 'b', 2, null, null, null, null, null],
    ['UQ_ab', 'unique', 0, 0, 'a', 1, null, null, null, null, null],
    ['IX_f', 'unique', 1, '1', 'a', 1, null, null, null, null, null],
    ['IX_f', 'unique', 1, '1', 'c', 2, null, null, null, null, null],
    ['FK_x', 'fk', 0, 0, 'a', 1, 'dbo', 'parent', 'x', 'NO ACTION', 'CASCADE'],
    ['FK_x', 'fk', 0, 0, 'b', 2, 'dbo', 'parent', 'y', 'NO ACTION', 'CASCADE'],
  ];
  assert.deepEqual(readKeys({ columns, rows }), [
    { kind: 'unique', name: 'UQ_ab', cols: ['a', 'b'] },
    { kind: 'unique', name: 'IX_f', cols: ['a', 'c'], index: true, readOnly: true },
    { kind: 'fk', name: 'FK_x', cols: ['a', 'b'], ref: { schema: 'dbo', table: 'parent', columns: ['x', 'y'], onUpdate: 'CASCADE' } },
  ]);
});

test('keys query: SQL drivers read composite keys of the table', () => {
  for (const [name, table] of [['mssql', "N'[dbo].[item]'"], ['mysql', "'item'"], ['postgres', `'"dbo"."item"'`]] as const) {
    const sql = drivers[name].columnDdl!.keys!(t);
    for (const alias of ['key_name', 'kind', 'is_index', 'read_only', 'col_name', 'ord', 'ref_schema', 'ref_table', 'ref_column', 'on_delete', 'on_update']) {
      assert.match(sql, new RegExp(`\\b${alias}\\b`), `${name} ${alias}`);
    }
    assert.ok(sql.includes(table), name);
  }
});

test('SQLite keys end to end on a real file: read, add / drop by rebuild, CHECK / COLLATE / index kept, bad data rolls back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonage-keys-'));
  try {
    const file = join(dir, 'lab.db');
    writeFileSync(file, '');
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const run = (sql: string) => sqliteDriver.run(c, '', sql);
    const lite = drivers.sqlite.columnDdl!;
    await run(`CREATE TABLE parent (x INTEGER NOT NULL, y INTEGER NOT NULL, UNIQUE (x, y));
      CREATE TABLE item (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, name TEXT COLLATE NOCASE CHECK (length(name) < 20),
        CONSTRAINT UQ_ab UNIQUE (a, b), CONSTRAINT FK_ab FOREIGN KEY (a, b) REFERENCES parent (x, y) ON DELETE CASCADE);
      CREATE UNIQUE INDEX ix_part ON item (b, name) WHERE name IS NOT NULL;
      CREATE INDEX ix_name ON item (name);
      INSERT INTO parent VALUES (1, 1), (2, 2);
      INSERT INTO item (a, b, name) VALUES (1, 1, 'one'), (2, 2, 'two');`);
    const o = { schema: 'main', name: 'item' };
    const keysNow = async () => readKeys((await run(lite.keys!(o))).resultSets[0]);
    const k0 = await keysNow();
    assert.deepEqual(k0.map((k) => [k.kind, k.cols.join(','), !!k.readOnly, k.ref?.table ?? '', k.ref?.onDelete ?? '']), [
      ['unique', 'b,name', true, '', ''],
      ['unique', 'a,b', false, '', ''],
      ['fk', 'a,b', false, 'parent', 'CASCADE'],
    ]);
    const cols = showColumns((await run(lite.show(o))).resultSets[0]).cols;
    const rows: ColumnRow[] = cols.map((x) => ({ ...x, orig: x.name }));
    // UQ (a, b) dihapus, UQ (b, a) + FK baru tanpa aksi; CHECK / COLLATE / index lain tetap
    const next: TableKey[] = [...k0.filter((k) => k.readOnly), { kind: 'unique', cols: ['b', 'a'] },
      { kind: 'fk', cols: ['a', 'b'], ref: { schema: 'main', table: 'parent', columns: ['x', 'y'] } }];
    const r = columnChanges(lite, o, cols, rows, next, k0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.steps.map((s) => s.kind), ['rebuild']);
    await execScript(sqliteDriver, c, '', r.sql, false);
    const k1 = await keysNow();
    assert.deepEqual(k1.map((k) => [k.kind, k.cols.join(','), k.ref?.onDelete ?? '']), [
      ['unique', 'b,name', ''], ['unique', 'b,a', ''], ['fk', 'a,b', '']]);
    const ddl = String((await run("SELECT group_concat(sql, ';') FROM sqlite_master WHERE tbl_name = 'item'")).resultSets[0].rows[0][0]);
    assert.match(ddl, /COLLATE NOCASE CHECK \(length\(name\) < 20\)/);
    assert.match(ddl, /CREATE INDEX ix_name/);
    assert.match(ddl, /CONSTRAINT "UQ_item_b_a" UNIQUE \("b", "a"\)/);
    assert.equal((await run('SELECT COUNT(*) FROM item')).resultSets[0].rows[0][0], 2);
    // FK baru ke baris yang tidak ada: foreign_key_check menggagalkan transaksi, file tidak berubah
    await run('PRAGMA foreign_keys = OFF; INSERT INTO item (a, b, name) VALUES (9, 9, \'orphan\')');
    const snapshot = async () => JSON.stringify([(await run('SELECT type, name, sql FROM sqlite_master ORDER BY name')).resultSets[0].rows,
      (await run('SELECT * FROM item ORDER BY id')).resultSets[0].rows]);
    const before = await snapshot();
    const k2 = await keysNow();
    const cols2 = showColumns((await run(lite.show(o))).resultSets[0]).cols;
    const r2 = columnChanges(lite, o, cols2, cols2.map((x) => ({ ...x, orig: x.name })),
      [...k2.filter((k) => k.kind === 'unique'), { kind: 'fk', cols: ['a', 'b'], ref: { schema: 'main', table: 'parent', columns: ['x', 'y'], onDelete: 'CASCADE' } }], k2);
    await assert.rejects(execScript(sqliteDriver, c, '', r2.sql, false), /foreign_key_check_failed/);
    assert.equal(await snapshot(), before);
    // perubahan key + perubahan kolom sekaligus ditolak (rebuild dari definisi asal)
    const mixed = cols2.map((x) => ({ ...x, orig: x.name, ...(x.name === 'id' ? { name: 'item_id' } : {}) }));
    assert.match(columnChanges(lite, o, cols2, mixed, [...k2, { kind: 'unique', cols: ['item_id', 'a'] }], k2).errors.join(), /separately/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkKeys, createTable, drivers, keyName, type NewColumn, type TableKey } from '../db';

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

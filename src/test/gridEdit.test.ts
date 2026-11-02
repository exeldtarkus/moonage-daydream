import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changeStatements } from '../sqlContext';

const q = (n: string) => `[${n}]`;
const columns = ['id', 'name', 'qty'];
const types = ['int', 'nvarchar', 'int'];
const rows: unknown[][] = [[1, 'a', 5], [2, "b'x", null], [3, 'c', 7]];

test('grid edit: delete rows by primary key, NULL key uses IS NULL', () => {
  const s = changeStatements('t', columns, types, rows, ['id'], { deletes: [2, 0] }, q, 'mssql');
  assert.deepEqual(s, ['DELETE FROM t WHERE [id] = 1;', 'DELETE FROM t WHERE [id] = 3;']);
  const n = changeStatements('t', ['k'], ['int'], [[null]], ['k'], { deletes: [0] }, q, 'mssql');
  assert.deepEqual(n, ['DELETE FROM t WHERE [k] IS NULL;']);
});

test('grid edit: new rows skip empty cells, NULL keyword = NULL, no cells = DEFAULT VALUES', () => {
  const s = changeStatements('t', columns, types, rows, ['id'], { inserts: [['', "O'Neil", 'NULL'], ['', '', ''], ['9', 'z', '']] }, q, 'mssql');
  assert.deepEqual(s, [
    "INSERT INTO t ([name], [qty]) VALUES (N'O''Neil', NULL);",
    'INSERT INTO t DEFAULT VALUES;',
    "INSERT INTO t ([id], [name]) VALUES (9, N'z');",
  ]);
  assert.deepEqual(changeStatements('t', ['a'], ['int'], [], ['a'], { inserts: [['']] }, (n) => `\`${n}\``, 'mysql'), ['INSERT INTO t () VALUES ();']);
});

test('grid edit: invalid number in a new row is rejected', () => {
  assert.throws(() => changeStatements('t', columns, types, rows, ['id'], { inserts: [['x', '', '']] }, q, 'mssql'), /not a number/);
});

test('grid edit: order is updates, deletes, inserts; edits on deleted rows are dropped', () => {
  const s = changeStatements('t', columns, types, rows, ['id'], { edits: [{ row: 0, col: 1, value: 'z' }, { row: 1, col: 1, value: 'y' }], deletes: [1], inserts: [['', 'n', '']] }, q, 'mssql');
  assert.deepEqual(s, [
    "UPDATE t\nSET [name] = N'z'\nWHERE [id] = 1;",
    'DELETE FROM t WHERE [id] = 2;',
    "INSERT INTO t ([name]) VALUES (N'n');",
  ]);
});

test('grid edit: nothing to do or a table without the key column in the result is refused', () => {
  assert.deepEqual(changeStatements('t', columns, types, rows, ['id'], {}, q, 'mssql'), []);
  assert.throws(() => changeStatements('t', ['name'], ['x'], [['a']], ['id'], { deletes: [0] }, q, 'mssql'), /Primary key column id/);
});

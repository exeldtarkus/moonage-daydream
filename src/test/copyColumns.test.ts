import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { columnsJson, createTable, drivers, type ColumnRow, type TableKey } from '../db';

const cols: ColumnRow[] = [
  { name: 'id', type: 'int', nullable: false, pk: true, ai: true, orig: 'id' },
  { name: 'code', type: 'varchar(20)', nullable: false, unique: true, uqName: 'UQ_t_code', keep: 'COLLATE X', orig: 'code' },
  { name: 'note', type: 'varchar(100)', nullable: true, default: "('n')", orig: 'note' },
];
const info = { columns: ['comment', 'collation'], rows: [['pk col', null], [null, 'CI_AS'], ['free text', null]] };
const keys: TableKey[] = [{ kind: 'unique', name: 'UQ_t_code_note', cols: ['code', 'note'] }];

test('columnsJson: every column with type, nullability, default, key flags and the extra info columns; table keys included', () => {
  const j = JSON.parse(columnsJson({ schema: 'dbo', name: 't' }, cols, info, keys));
  assert.equal(j.table, 'dbo.t');
  assert.equal(j.columns.length, 3);
  assert.deepEqual(j.columns[0], { position: 1, name: 'id', type: 'int', nullable: false, primaryKey: true, autoIncrement: true, comment: 'pk col' });
  assert.deepEqual(j.columns[1], { position: 2, name: 'code', type: 'varchar(20)', nullable: false, unique: true, collate: 'COLLATE X', collation: 'CI_AS' });
  assert.deepEqual(j.columns[2], { position: 3, name: 'note', type: 'varchar(100)', nullable: true, default: "('n')", comment: 'free text' });
  assert.deepEqual(j.keys, [{ kind: 'unique', name: 'UQ_t_code_note', columns: ['code', 'note'] }]);
});

test('columnsJson: foreign keys carry the target and actions; no schema = plain table name', () => {
  const j = JSON.parse(columnsJson({ schema: '', name: 't' }, [{ name: 'oid', type: 'int', nullable: true, fk: { schema: 'dbo', table: 'orders', column: 'id', onDelete: 'CASCADE' } }],
    { columns: [], rows: [[]] }, []));
  assert.equal(j.table, 't');
  assert.deepEqual(j.columns[0].foreignKey, { schema: 'dbo', table: 'orders', column: 'id', onDelete: 'CASCADE' });
  assert.deepEqual(j.keys, []);
});

test('copy as script: columns read from the server make a valid CREATE TABLE', () => {
  const r = createTable(drivers.mssql.columnDdl!, { schema: 'dbo', name: 't' }, cols, keys);
  assert.deepEqual(r.errors, []);
  assert.match(r.sql, /CREATE TABLE \[dbo\]\.\[t\]/);
  assert.match(r.sql, /\[id\]/);
});

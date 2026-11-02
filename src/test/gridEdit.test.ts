import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changeStatements } from '../sqlContext';
import { render } from '../resultsHtml';
import { mongoChanges, mongoFindCollection } from '../mongo';

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

test('grid edit: result that cannot be edited shows the reason and disabled buttons', () => {
  const result = { resultSets: [{ columns: ['a'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 1 };
  const html = render('csp', 't', { result, source: { uri: 'u', sql: 'select a from t' }, editBlock: 't has no primary key' });
  assert.match(html, /class="editbar off" title="Editing is off: t has no primary key"/);
  assert.match(html, /<button class="addrow"[^>]*disabled/);
  assert.match(html, /<button class="delrow"[^>]*disabled/);
  assert.doesNotMatch(html, /data-edit="1"/);
  const ok = render('csp', 't', { result, source: { uri: 'u', sql: 'select a from t' } });
  assert.match(ok, /data-edit="1"/);
  assert.doesNotMatch(ok, /<button class="addrow"[^>]*disabled/);
});

const mcols = ['_id', 'name', 'qty', 'price', 'flag', 'created', 'tags'];
const mtypes = ['objectId', 'string', 'int', 'double', 'bool', 'date', 'array'];
const mrows: unknown[][] = [['6ae45ff8adf789979eb7a4f4', 'apple', 5, 1.5, true, '2026-01-02T03:04:05.000Z', '["red"]']];
const C = 'db.getCollection("shop")';

test('grid edit MongoDB: update / delete by _id, values follow the BSON type of the column', () => {
  const s = mongoChanges('shop', mcols, mtypes, mrows, {
    edits: [{ row: 0, col: 1, value: 'pear' }, { row: 0, col: 2, value: '7' }, { row: 0, col: 4, value: 'false' }, { row: 0, col: 5, value: '2026-02-01' }, { row: 0, col: 6, value: '["a",1]' }],
  });
  assert.deepEqual(s, [`${C}.updateOne({ "_id": ObjectId("6ae45ff8adf789979eb7a4f4") }, { $set: { "name": "pear", "qty": 7, "flag": false, "created": ISODate("2026-02-01"), "tags": ["a",1] } });`]);
  assert.deepEqual(mongoChanges('shop', mcols, mtypes, mrows, { deletes: [0] }), [`${C}.deleteOne({ "_id": ObjectId("6ae45ff8adf789979eb7a4f4") });`]);
  assert.deepEqual(mongoChanges('shop', mcols, mtypes, mrows, { edits: [{ row: 0, col: 3, value: null }] }), [`${C}.updateOne({ "_id": ObjectId("6ae45ff8adf789979eb7a4f4") }, { $set: { "price": null } });`]);
});

test('grid edit MongoDB: new documents skip empty cells, NULL = null, all empty = {}', () => {
  const s = mongoChanges('shop', mcols, mtypes, mrows, { inserts: [['', "O'Neil", '3', '', '', '', ''], ['', '', 'NULL', '', '', '', ''], ['', '', '', '', '', '', '']] });
  assert.deepEqual(s, [`${C}.insertOne({ "name": "O'Neil", "qty": 3 });`, `${C}.insertOne({ "qty": null });`, `${C}.insertOne({});`]);
});

test('grid edit MongoDB: wrong values, _id edits and results without _id are refused', () => {
  assert.throws(() => mongoChanges('shop', mcols, mtypes, mrows, { edits: [{ row: 0, col: 2, value: 'x' }] }), /not a number/);
  assert.throws(() => mongoChanges('shop', mcols, mtypes, mrows, { edits: [{ row: 0, col: 4, value: 'yes' }] }), /true or false/);
  assert.throws(() => mongoChanges('shop', mcols, mtypes, mrows, { edits: [{ row: 0, col: 6, value: '[1,' }] }), /JSON/);
  assert.throws(() => mongoChanges('shop', mcols, mtypes, mrows, { edits: [{ row: 0, col: 0, value: 'x' }] }), /_id cannot be edited/);
  assert.throws(() => mongoChanges('shop', ['name'], ['string'], [['a']], { deletes: [0] }), /_id field must be part of the result/);
});

test('grid edit MongoDB: only find() on one collection is an editable source', () => {
  assert.equal(mongoFindCollection('db.getCollection("shop").find({}).limit(100);'), 'shop');
  assert.equal(mongoFindCollection('db.orders.find({ qty: { $gt: 1 } }).sort({ _id: -1 })'), 'orders');
  assert.equal(mongoFindCollection('db.orders.aggregate([])'), undefined);
  assert.equal(mongoFindCollection('db.orders.find({}); db.items.find({})'), undefined);
  assert.equal(mongoFindCollection('db.orders.find({'), undefined);
});

test('grid edit MongoDB: result has no SQL WHERE toolbar but keeps the edit bar', () => {
  const result = { resultSets: [{ columns: ['_id'], types: ['objectId'], rows: [['6ae45ff8adf789979eb7a4f4']], total: 1 }], rowsAffected: [], messages: [], durationMs: 1 };
  const html = render('csp', 't', { result, source: { uri: 'u', sql: 'db.shop.find({})', mongo: true } });
  assert.doesNotMatch(html, /<form class="where"/);
  assert.match(html, /data-edit="1"/);
  assert.match(render('csp', 't', { result, source: { uri: 'u', sql: 'select 1 from t' } }), /<form class="where"/);
});

test('grid edit: rows marked for deletion are red, also while selected', () => {
  const result = { resultSets: [{ columns: ['a'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 1 };
  const html = render('csp', 't', { result, source: { uri: 'u', sql: 'select a from t' } });
  const rule = /tbody tr\.todelete td, tbody tr\.todelete\.sel td \{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(rule, /background: [^;]*--vscode-errorForeground[^;]*!important/);
  assert.match(rule, /color: var\(--vscode-errorForeground[^;]*!important/);
  assert.match(rule, /text-decoration: line-through/);
});

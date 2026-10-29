import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MS_DB, MS_SERVER, MS_TABLE, MS_TREE, MS_VIEW, permissionHint } from '../mssqlTree';

const labels = (ids: string[]) => ids.map((id) => MS_TREE[id].label);

test('mssql tree: server level like SSMS / mssql extension (Databases, Security, Server Objects, SQL Server Agent)', () => {
  assert.deepEqual(labels(MS_SERVER), ['Databases', 'Security', 'Server Objects', 'SQL Server Agent']);
  assert.deepEqual(labels(MS_TREE.databases.folders!), ['System Databases']);
  assert.deepEqual(labels(MS_TREE.security.folders!), ['Logins', 'Server Roles', 'Credentials', 'Cryptographic Providers', 'Audits', 'Server Audit Specifications']);
  assert.deepEqual(labels(MS_TREE.serverObjects.folders!), ['Endpoints', 'Linked Servers', 'Triggers']);
  assert.deepEqual(labels(MS_TREE.agent.folders!), ['Jobs']);
});

test('mssql tree: System Databases separated from user databases', () => {
  assert.equal(MS_TREE.databases.databases, true);
  assert.equal(MS_TREE.systemDatabases.databases, true);
  assert.match(MS_TREE.databases.sql!(''), /database_id > 4 AND is_distributor = 0/);
  assert.match(MS_TREE.systemDatabases.sql!(''), /database_id <= 4 OR is_distributor = 1/);
});

test('mssql tree: database and table levels', () => {
  assert.deepEqual(labels(MS_DB), ['Tables', 'Views', 'Synonyms', 'Programmability', 'Security']);
  assert.deepEqual(labels(MS_TREE.tables.folders!), ['System Tables']);
  assert.deepEqual(labels(MS_TREE.views.folders!), ['System Views']);
  assert.deepEqual(labels(MS_TREE.programmability.folders!), ['Stored Procedures', 'Functions', 'Database Triggers', 'Types', 'Sequences']);
  assert.deepEqual(labels(MS_TREE.functions.folders!), ['Table-valued Functions', 'Scalar-valued Functions', 'Aggregate Functions']);
  assert.deepEqual(labels(MS_TREE.dbSecurity.folders!), ['Users', 'Roles', 'Schemas']);
  assert.deepEqual(labels(MS_TABLE), ['Columns', 'Keys', 'Constraints', 'Triggers', 'Indexes', 'Statistics']);
  assert.deepEqual(labels(MS_VIEW), ['Columns', 'Triggers', 'Indexes', 'Statistics']);
  // objek yang bisa Select Top / Show / Edit / Run
  assert.deepEqual(['tables', 'systemTables', 'views', 'systemViewsInSchema', 'procedures', 'tvf', 'scalarFunctions', 'dbTriggers', 'tTriggers'].map((id) => MS_TREE[id].item?.obj),
    ['table', 'table', 'view', 'view', 'procedure', 'function', 'function', 'trigger', 'trigger']);
});

test('mssql tree: every folder exists, queries are qualified with the database and take the object as @full', () => {
  for (const [id, f] of Object.entries(MS_TREE)) {
    for (const sub of f.folders ?? []) assert.ok(MS_TREE[sub], `${id} -> ${sub}`);
    assert.ok(f.sql || f.folders || f.columns, `${id} has content`);
  }
  for (const id of [...MS_DB, 'systemTables', 'systemViews', 'procedures', 'tvf', 'scalarFunctions', 'aggregateFunctions', 'dbTriggers', 'types', 'sequences', 'users', 'roles', 'schemas', 'synonyms']) {
    const sql = MS_TREE[id].sql?.('My ]DB');
    if (sql) assert.ok(sql.includes('[My ]]DB].sys.'), `${id}: ${sql}`);
  }
  for (const id of MS_TABLE) {
    const sql = MS_TREE[id].sql?.('Shop');
    if (sql) assert.match(sql, /OBJECT_ID\(@full\)/, id);
  }
  assert.match(MS_TREE.tvf.sql!('Shop'), /'IF', 'TF'/);
  assert.match(MS_TREE.scalarFunctions.sql!('Shop'), /'FN'/);
  assert.match(MS_TREE.linkedServers.sql!(''), /is_linked = 1/);
  assert.match(MS_TREE.logins.sql!(''), /NOT LIKE '##%'/, 'internal ## logins hidden');
});

test('mssql tree: permission errors become a hint naming the permission, other errors stay errors', () => {
  const denied = (number: number) => Object.assign(new Error('denied'), { number });
  assert.match(permissionHint('jobs', denied(229))!, /No permission.*SQLAgentReaderRole/);
  assert.match(permissionHint('jobs', denied(916))!, /msdb/);
  assert.match(permissionHint('audits', denied(300))!, /VIEW SERVER STATE|ALTER ANY SERVER AUDIT/);
  assert.match(permissionHint('agent', denied(297))!, /VIEW SERVER STATE/);
  assert.match(permissionHint('logins', denied(229))!, /No permission/, 'default hint');
  assert.match(permissionHint('monitor', denied(300))!, /VIEW SERVER STATE/, 'Live Monitor');
  assert.equal(permissionHint('jobs', new Error('Connection lost')), undefined, 'not a permission error');
  assert.equal(permissionHint('jobs', denied(208)), undefined, 'invalid object is a real error');
});

test('mssql tree: SQL Server Agent shows the service status; System Views grouped by schema', () => {
  assert.match(MS_TREE.agent.sql!(''), /sys\.dm_server_services/);
  assert.equal(MS_TREE.systemViews.item?.children, 'systemViewsInSchema');
  assert.match(MS_TREE.systemViews.sql!('Shop'), /DISTINCT/);
  assert.match(MS_TREE.systemViewsInSchema.sql!('Shop'), /s\.name = @full/);
  assert.equal(MS_TREE.systemViewsInSchema.item?.obj, 'view');
});

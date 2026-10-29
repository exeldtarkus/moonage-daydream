import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changingStatement, readOnlyBlocked } from '../sqlContext';
import { confirmAutoCommit } from '../db';
import type { ConnectionInfo } from '../db';

test('changingStatement: first statement that changes data (the one shown in the Auto-commit confirmation)', () => {
  assert.equal(changingStatement('mssql', ['SELECT 1', 'UPDATE dbo.orders SET status = 1 WHERE id = 7', 'DELETE FROM t']), 'UPDATE dbo.orders SET status = 1 WHERE id = 7');
  assert.equal(changingStatement('mssql', ['SELECT * FROM t', 'DECLARE @a INT = 1', 'SET @a = 2', 'WITH x AS (SELECT 1 AS a) SELECT a FROM x']), undefined, 'reads only');
  for (const st of ['INSERT INTO t VALUES (1)', 'MERGE t USING s ON 1 = 0 WHEN NOT MATCHED THEN INSERT (a) VALUES (1)', 'TRUNCATE TABLE t', 'DROP TABLE t', 'EXEC dbo.p', 'SELECT * INTO #t FROM t']) {
    assert.equal(changingStatement('mssql', [st]), st, st);
  }
  assert.equal(changingStatement('mongodb', ['db.orders.find({})']), undefined);
  assert.equal(changingStatement('mongodb', ['db.orders.updateOne({ _id: 1 }, { $set: { a: 1 } })']), 'db.orders.updateOne({ _id: 1 }, { $set: { a: 1 } })');
  assert.match(readOnlyBlocked('mssql', ['UPDATE t SET a = 1'])!, /read-only.*UPDATE t SET a = 1/, 'read-only still uses the same rule');
});

test('confirmAutoCommit: on by default, group setting, connection setting wins', () => {
  const c = (o: Partial<ConnectionInfo> = {}): ConnectionInfo => ({ name: 'n', type: 'mssql', host: 'h', port: 1, user: 'u', database: 'd', trustServerCertificate: true, ...o });
  assert.equal(confirmAutoCommit(c(), {}), true, 'default on');
  assert.equal(confirmAutoCommit(c({ group: 'dev' }), { dev: { confirmAutoCommit: false } }), false, 'off for the group');
  assert.equal(confirmAutoCommit(c({ group: 'dev', confirmAutoCommit: true }), { dev: { confirmAutoCommit: false } }), true, 'connection on wins over group off');
  assert.equal(confirmAutoCommit(c({ group: 'prod', confirmAutoCommit: false }), { prod: { confirmAutoCommit: true } }), false, 'connection off wins');
  assert.equal(confirmAutoCommit(c({ group: 'other' }), { dev: { confirmAutoCommit: false } }), true, 'other groups untouched');
});

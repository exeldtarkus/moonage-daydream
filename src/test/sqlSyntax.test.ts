import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { syntaxIssues } from '../sqlSyntax';

test('syntax: the screenshot case is marked in the second statement, the valid first one is not', async () => {
  const sql = 'SELECT\n    TOP 100 *\nFROM\n    [BIMA_HERITAGE].[dbo].[TBL_POLICY]\n;\n\nSELECT  *\nFROM    tbl dbo.TBL_POLICY_DETAIL\nwhere ;\n';
  const issues = await syntaxIssues(sql, 'mssql');
  assert.equal(issues.length, 1);
  const i = issues[0];
  assert.ok(i.start > sql.indexOf('tbl dbo') && i.end <= sql.indexOf('where'), `marked inside "tbl dbo.TBL_POLICY_DETAIL": ${sql.slice(i.start, i.end)}`);
  assert.match(i.message, /^SQL syntax error: unexpected "\."/);
});

test('syntax: an empty WHERE is marked on the last word; valid statements of each dialect are not', async () => {
  const sql = 'SELECT * FROM orders o JOIN order_item i ON i.order_id = o.id WHERE;';
  const [i] = await syntaxIssues(sql, 'mysql');
  assert.equal(sql.slice(i.start, i.end), 'WHERE');
  assert.match(i.message, /unexpected end of statement/);
  assert.deepEqual(await syntaxIssues('SELECT * FROM `shop`.`orders` LIMIT 100;\nUPDATE orders SET code = \'x\' WHERE id = 1;', 'mysql'), []);
  assert.deepEqual(await syntaxIssues('WITH c AS (SELECT 1 a) SELECT * FROM c;\nSELECT * FROM t WITH (NOLOCK) WHERE id = 1;', 'mssql'), []);
  assert.deepEqual(await syntaxIssues('SELECT * FROM public.column_lab LIMIT 10;', 'postgres'), []);
  assert.deepEqual(await syntaxIssues('SELECT * FROM item WHERE qty > 0;', 'sqlite'), []);
});

test('syntax: statements the parser does not cover are skipped (procedures, MERGE, ...), unknown dialect checks nothing', async () => {
  const ms = 'CREATE PROCEDURE dbo.p @a int AS BEGIN SET NOCOUNT ON; SELECT @a; END;\nMERGE dbo.t AS t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.a = s.a;\n-- comment first\nEXEC sp_who2;';
  assert.deepEqual(await syntaxIssues(ms, 'mssql'), []);
  assert.deepEqual(await syntaxIssues('SELECT * FROM t WHERE;', undefined), []);
  assert.deepEqual(await syntaxIssues('db.orders.find({})', 'mongodb'), []);
});

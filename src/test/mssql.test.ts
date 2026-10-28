import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fmtType, q, splitBatches } from '../mssql';
import { cell, render } from '../resultsHtml';
import { formatSql, leadingCommas } from '../sqlFormat';
import { ident, identifierChain, maskSql, parallelSafe, preview, splitStatements, statementAt, tableRefs, autoLimitable } from '../sqlContext';

test('splitBatches splits on GO lines only', () => {
  assert.deepEqual(splitBatches('select 1\nGO\nselect 2\n  go 5  \r\nselect 3\ngo -- end\n'), ['select 1', 'select 2', 'select 3']);
  assert.deepEqual(splitBatches('select good from t\nselect 1 -- GO'), ['select good from t\nselect 1 -- GO']);
  assert.deepEqual(splitBatches('\nGO\n'), []);
});

test('cell formats values and escapes', () => {
  assert.equal(cell(null), '<span class="null">NULL</span>');
  assert.equal(cell('<b>'), '&lt;b&gt;');
  assert.equal(cell(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(cell(Buffer.from([1, 255])), '0x01FF');
  assert.equal(cell(12.5), '12.5');
});

test('render shows result sets, messages and errors', () => {
  const html = render('csp', 'local', { result: {
    resultSets: [{ columns: ['id', 'a<b'], rows: [[1, null]], total: 1 }, { columns: ['x'], rows: [], total: 0 }, { columns: ['y'], rows: [[1], [2]], total: 5000 }],
    rowsAffected: [1, 0], messages: ['hello'], durationMs: 7,
  } });
  assert.ok(html.includes('Result 1 <span>1 row(s)<') && html.includes('Result 2 <span>0 row(s)<'));
  assert.ok(html.includes('Result 3 <span>5000 row(s) (showing first 2)'));
  assert.ok(html.includes('<th>a&lt;b</th>') && html.includes('hello') && html.includes('Done in 7 ms'));
  const upd = render('csp', 'local', { result: { resultSets: [], rowsAffected: [2, 3], messages: [], durationMs: 1 } });
  assert.ok(upd.includes('5 row(s) affected'));
  assert.ok(render('csp', 'local', { error: 'Login failed <x>' }).includes('Login failed &lt;x&gt;'));
});

test('render loading shows spinner', () => {
  const html = render('csp', 'conn / db', { loading: true });
  assert.ok(html.includes('class="spin"') && html.includes('Running query') && html.includes('<div class="sub">conn / db</div>'));
});

test('render loading cancel button, disabled once cancelling', () => {
  const run = render('csp', 't', { loading: true, uri: 'file:///a.sql' });
  assert.ok(run.includes('href="command:moonageDaydream.cancelQuery?%5B%22file%3A%2F%2F%2Fa.sql%22%5D"') && run.includes('Running query'));
  const off = render('csp', 't', { loading: true, uri: 'file:///a.sql', cancelling: true });
  assert.ok(off.includes('Cancelling query') && off.includes('aria-disabled="true"') && !off.includes('href="command:'));
});

test('fmtType and q', () => {
  assert.equal(fmtType('nvarchar', 100, 0, 0), 'nvarchar(50)');
  assert.equal(fmtType('varchar', -1, 0, 0), 'varchar(max)');
  assert.equal(fmtType('decimal', 9, 10, 2), 'decimal(10,2)');
  assert.equal(fmtType('int', 4, 10, 0), 'int');
  assert.equal(q('a]b'), '[a]]b]');
});

test('identifierChain parses cross-database prefixes', () => {
  assert.deepEqual(identifierChain('SELECT * FROM AG'), { parts: [], word: 'AG' });
  assert.deepEqual(identifierChain('SELECT * FROM SalesDb.'), { parts: ['SalesDb'], word: '' });
  assert.deepEqual(identifierChain('FROM SalesDb.dbo.Ord'), { parts: ['SalesDb', 'dbo'], word: 'Ord' });
  assert.deepEqual(identifierChain('FROM [My DB]..AG'), { parts: ['My DB', ''], word: 'AG' });
  assert.deepEqual(identifierChain('JOIN a.b.c.d'), { parts: ['b', 'c'], word: 'd' });
  assert.deepEqual(identifierChain('x = [Ord'), { parts: [], word: 'Ord' });
  assert.equal(ident('Orders'), 'Orders');
  assert.equal(ident('My DB'), '[My DB]');
  assert.equal(ident('2024'), '[2024]');
});

test('splitStatements / parallelSafe', () => {
  const sql = "-- head\nSELECT ';' AS a, [x;y] FROM t; /* ; */\nselect top 10* from dbo.T2;\n-- only comment;\n";
  const s = splitStatements(sql);
  assert.deepEqual(s, ["-- head\nSELECT ';' AS a, [x;y] FROM t;", '/* ; */\nselect top 10* from dbo.T2;']);
  assert.equal(parallelSafe(s), true);
  assert.equal(parallelSafe(['SELECT 1;']), false, 'single statement');
  assert.equal(parallelSafe(['DECLARE @a INT = 1;', 'SELECT @a;']), false);
  assert.equal(parallelSafe(['SELECT * INTO #t FROM a;', 'SELECT * FROM #t;']), false);
  assert.equal(parallelSafe(["SELECT '@x #y into';", 'SELECT @@ROWCOUNT;']), true, 'inside strings / @@ is fine');
  assert.equal(parallelSafe(['SELECT 1;', 'UPDATE t SET a = 1;']), false);
  assert.equal(preview('-- c\nSELECT  *\n FROM t;'), 'SELECT * FROM t;');
  assert.equal(maskSql("a 'it''s' b").length, "a 'it''s' b".length);
  assert.equal(maskSql("a 'it''s' b"), 'a         b');
});

test('statementAt picks the statement under the cursor', () => {
  const sql = '-- c\nSELECT TOP 20\n    name\nFROM sys.objects;\n\nSELECT\n    COUNT(*) AS n\nFROM sys.objects;\n';
  const first = '-- c\nSELECT TOP 20\n    name\nFROM sys.objects;';
  const second = 'SELECT\n    COUNT(*) AS n\nFROM sys.objects;';
  assert.equal(statementAt(sql, 0), first);
  assert.equal(statementAt(sql, sql.indexOf('name')), first);
  assert.equal(statementAt(sql, sql.indexOf(';') + 1), first, 'right after ;');
  assert.equal(statementAt(sql, sql.indexOf(';') + 2), first, 'blank line between');
  assert.equal(statementAt(sql, sql.indexOf('COUNT')), second);
  assert.equal(statementAt(sql, sql.length), second, 'end of file');
  assert.equal(statementAt("SELECT 'a;b'\nGO\nSELECT 2", 20), 'SELECT 2', 'GO separates, ; in string ignored');
  assert.equal(statementAt("SELECT 'a;b'\nGO\nSELECT 2", 3), "SELECT 'a;b'");
  assert.equal(statementAt('SELECT 1', 4), 'SELECT 1', 'no separator');
});

test('tableRefs finds FROM / JOIN tables and aliases', () => {
  assert.deepEqual(tableRefs('SELECT  *\nFROM    dbo.Orders\nwhere ;'), [{ parts: ['dbo', 'Orders'], alias: undefined }]);
  assert.deepEqual(
    tableRefs('select * from SalesDb..Orders o join [My DB].dbo.[Order Lines] AS l on l.id = o.id where'),
    [{ parts: ['SalesDb', '', 'Orders'], alias: 'o' }, { parts: ['My DB', 'dbo', 'Order Lines'], alias: 'l' }],
  );
  assert.deepEqual(tableRefs("select 'from x' from T"), [{ parts: ['T'], alias: undefined }], 'from inside string ignored');
  assert.deepEqual(tableRefs('select * from SalesDb.'), []);
});

test('formatSql: uppercase keywords, leading commas, strings untouched', () => {
  const s = { keywordCase: 'upper' as const, leadingComma: true, semicolonNewline: true, tabWidth: 4, useTabs: false };
  assert.equal(
    formatSql("select name, object_id, 'a,b' as x from sys.objects where kind = 'U' and name like 'x,%'", s),
    "SELECT\n    name\n    , object_id\n    , 'a,b' AS x\nFROM\n    sys.objects\nWHERE\n    kind = 'U'\n    AND name LIKE 'x,%'",
  );
  assert.equal(formatSql('select a, b from t', { ...s, leadingComma: false, keywordCase: 'lower' }), 'select\n    a,\n    b\nfrom\n    t');
  assert.equal(
    formatSql("select * from dbo.Orders left join dbo.OrderLines on a = b where 1=1 and order_no = 'x'; select 1;", s),
    "SELECT\n    *\nFROM\n    dbo.Orders\n    LEFT JOIN dbo.OrderLines ON a = b\nWHERE\n    1 = 1\n    AND order_no = 'x'\n;\n\nSELECT\n    1\n;",
  );
  assert.equal(formatSql('select 1;', { ...s, semicolonNewline: false }), 'SELECT\n    1;');
  assert.equal(leadingCommas('SELECT\n  a, -- c,\n  b'), 'SELECT\n  a -- c,\n  , b', 'code comma moved, comma inside comment kept');
});

test('autoLimitable: only a single SELECT without TOP / FETCH / INTO', () => {
  assert.equal(autoLimitable(['SELECT  *\nFROM    dbo.Orders']), true);
  assert.equal(autoLimitable(['WITH x AS (SELECT 1 a) SELECT * FROM x;']), true);
  assert.equal(autoLimitable(['select top 10 * from t']), false);
  assert.equal(autoLimitable(['select * from t order by a offset 0 rows fetch next 5 rows only']), false);
  assert.equal(autoLimitable(['select * into #t from t']), false);
  assert.equal(autoLimitable(['update t set a = 1']), false);
  assert.equal(autoLimitable(["select 'top' as x from t"]), true, 'TOP inside a string does not count');
  assert.equal(autoLimitable(['select 1;', 'select 2;']), false, 'multiple statements: not limited');
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { fmtType, q, retryableConnectError, retryOnce, splitBatches } from '../mssql';
import { cell, render } from '../resultsHtml';
import { formatSql, leadingCommas } from '../sqlFormat';
import { ident, identifierChain, maskSql, parallelSafe, preview, splitStatements, statementAt, tableRefs, autoLimitable, missingSemicolons, addWhere } from '../sqlContext';

test('splitBatches splits on GO lines only', () => {
  assert.deepEqual(splitBatches('select 1\nGO\nselect 2\n  go 5  \r\nselect 3\ngo -- end\n'), ['select 1', 'select 2', 'select 3']);
  assert.deepEqual(splitBatches('select good from t\nselect 1 -- GO'), ['select good from t\nselect 1 -- GO']);
  assert.deepEqual(splitBatches('\nGO\n'), []);
});

test('cell formats values and escapes', () => {
  assert.equal(cell(null), '<span class="null">(null)</span>');
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
  assert.ok(html.includes('<span class="ty"></span>a&lt;b<span class="hb">') && html.includes('hello') && html.includes('Done in 7 ms'));
  assert.ok(html.includes('<td class="num">1</td>') && html.includes('Rows: <b class="count" data-total="2">5000</b>') && html.includes('</svg><b>7ms</b>'), 'numbers right-aligned, footer');
  const typed = render('csp', 't', { result: { resultSets: [{ columns: ['n', 's'], types: ['int', 'nvarchar'], rows: [], total: 0 }], rowsAffected: [], messages: [], durationMs: 1 } });
  assert.ok(typed.includes('<th data-c="0" class="num" title="int"><span class="ty">#</span>n<span class="hb">') && typed.includes('<span class="ty">abc</span>s'), 'type icons');
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

test('missingSemicolons marks the last token of unterminated statements', () => {
  const at = (sql: string) => missingSemicolons(sql).map((r) => sql.slice(r.start, r.end));
  assert.deepEqual(at('SELECT 1;\nSELECT *\nFROM t -- note;\n'), ['t']);
  assert.deepEqual(at("SELECT 'a;'\nGO\nSELECT 2;\nGO"), ["'a;'"]);
  assert.deepEqual(at('SELECT 1;\n-- only comment\n'), []);
  assert.deepEqual(at('select *\nfrom dbo.Orders\nwhere a = 1'), ['1']);
});

test('addWhere adds the filter to the top-level SELECT', () => {
  assert.equal(addWhere('SELECT * FROM t;', "a LIKE 'RF%'"), "SELECT * FROM t\nWHERE a LIKE 'RF%'");
  assert.equal(addWhere('SELECT * FROM t WHERE x = 1 OR y = 2 ORDER BY a', 'b > 3'), 'SELECT * FROM t WHERE (x = 1 OR y = 2)\n    AND (b > 3)\nORDER BY a');
  assert.equal(addWhere('SELECT a, COUNT(*) FROM t GROUP BY a', 'a <> 0'), 'SELECT a, COUNT(*) FROM t\nWHERE a <> 0\nGROUP BY a');
  assert.equal(
    addWhere('WITH c AS (SELECT * FROM s WHERE k = 1) SELECT * FROM c', 'z = 9'),
    'WITH c AS (SELECT * FROM s WHERE k = 1) SELECT * FROM c\nWHERE z = 9', 'WHERE inside CTE untouched');
  assert.equal(addWhere("SELECT 'where' AS w FROM t -- order by\n", 'q = 1'), "SELECT 'where' AS w FROM t -- order by\nWHERE q = 1", 'keywords in strings / comments ignored');
  assert.equal(addWhere('SELECT * FROM t', '  '), 'SELECT * FROM t', 'empty filter = original');
  assert.throws(() => addWhere('SELECT a FROM t UNION SELECT a FROM u', 'a = 1'), /UNION/);
  assert.throws(() => addWhere('SELECT 1', 'a = 1'), /FROM/);
});

test('render: WHERE toolbar for single SELECT source, nonce script', () => {
  const r = { resultSets: [{ columns: ['a'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 1 };
  const html = render('csp', 't', { result: r, source: { uri: 'file:///a.sql', sql: 'SELECT a FROM t', where: "a = 'x\"y'" } });
  assert.ok(html.includes('<form class="where"><label>WHERE</label>') && html.includes('value="a = \'x&quot;y\'"') && html.includes('class="clear"'));
  const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html)?.[1];
  assert.ok(nonce && html.includes(`<script nonce="${nonce}">`), 'CSP nonce matches script');
  assert.ok(!render('csp', 't', { result: r }).includes('class="where"'), 'no source: no WHERE bar');
});

test('connect retry: one retry on timeout / instance lookup, not on login failure', async () => {
  assert.ok(retryableConnectError({ code: 'ETIMEOUT', message: 'Failed to connect to h\\i in 15000ms' }));
  assert.ok(retryableConnectError({ code: 'EINSTLOOKUP', message: 'Port for UAT not found in h' }));
  assert.ok(!retryableConnectError({ code: 'ELOGIN', message: "Login failed for user 'x'." }));
  let n = 0;
  assert.equal(await retryOnce(async () => (++n === 1 ? Promise.reject({ code: 'ETIMEOUT' }) : 'ok'), retryableConnectError), 'ok');
  assert.equal(n, 2);
  n = 0;
  await assert.rejects(retryOnce(async () => { n++; throw { code: 'ELOGIN' }; }, retryableConnectError));
  assert.equal(n, 1, 'login failure is not retried (no account lockout)');
});

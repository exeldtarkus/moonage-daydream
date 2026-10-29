import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { alterScript, backupScript, createTableScript, execScript, fmtType, fnScript, jobScript, killScript, paramDefaults, restoreScript, scriptAs, poolConfig, q, retryableConnectError, retryOnce, splitBatches } from '../mssql';
import { cell, render } from '../resultsHtml';
import { formatSql, leadingCommas } from '../sqlFormat';
import { affectedStatements, readOnlyBlocked, txEndStatement, ident, identifierChain, maskSql, parallelSafe, preview, readOnly, splitStatements, statementAt, statementSegments, tableRefs, autoLimitable, missingSemicolons, addWhere, editLiteral, sqlLiteral, updateScript } from '../sqlContext';

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
  assert.ok(typed.includes('<th data-c="0" data-name="n" data-type="int" class="num" title="int"><span class="ty">#</span>n<span class="hb">') && typed.includes('<span class="ty">abc</span>s'), 'type icons');
  assert.ok(render('csp', 'local', { error: 'Login failed <x>' }).includes('Login failed &lt;x&gt;'));
});

test('render: rows affected of every non-SELECT statement, also next to SELECT results', () => {
  const sel = { columns: ['a'], rows: [[1]], total: 1 };
  const both = render('csp', 'local', { result: { resultSets: [sel], rowsAffected: [1], messages: [], durationMs: 1 } });
  assert.ok(both.includes('Result 1') && both.includes('1 row(s) affected'), 'SELECT + UPDATE: UPDATE result shown');
  const two = render('csp', 'local', { result: { resultSets: [], rowsAffected: [2, 3], messages: [], durationMs: 1 } });
  assert.ok(two.includes('2 row(s) affected\n3 row(s) affected') && !two.includes('5 row(s)'), 'one line per statement, in order');
  const ddl = render('csp', 'local', { result: { resultSets: [], rowsAffected: [], messages: [], durationMs: 1 } });
  assert.ok(ddl.includes('Commands completed successfully.') && !ddl.includes('0 row(s) affected'), 'DDL / EXEC without rows');
  const printed = render('csp', 'local', { result: { resultSets: [], rowsAffected: [], messages: ['hello'], durationMs: 1 } });
  assert.ok(printed.includes('hello') && !printed.includes('Commands completed'), 'PRINT output is the result');
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

test('tableRefs finds the UPDATE target (SET / WHERE columns)', () => {
  assert.deepEqual(tableRefs('UPDATE dbo.Orders SET  WHERE '), [{ parts: ['dbo', 'Orders'], alias: undefined }]);
  assert.deepEqual(tableRefs('update [Sales DB]..Orders\nset x = 1\nwhere '), [{ parts: ['Sales DB', '', 'Orders'], alias: undefined }]);
  assert.deepEqual(tableRefs('UPDATE TOP (10) Orders SET a = 1'), [{ parts: ['Orders'], alias: undefined }], 'UPDATE TOP (n)');
});

test('tableRefs: UPDATE / DELETE alias target resolves to the FROM table only', () => {
  assert.deepEqual(tableRefs('UPDATE o SET o.x = 1 FROM dbo.Orders o JOIN Lines l ON l.id = o.id WHERE '),
    [{ parts: ['dbo', 'Orders'], alias: 'o' }, { parts: ['Lines'], alias: 'l' }]);
  assert.deepEqual(tableRefs('DELETE o FROM dbo.Orders o WHERE '), [{ parts: ['dbo', 'Orders'], alias: 'o' }]);
});

test('tableRefs finds the INSERT target (column list)', () => {
  assert.deepEqual(tableRefs('INSERT INTO SalesDb.dbo.Orders ('), [{ parts: ['SalesDb', 'dbo', 'Orders'], alias: undefined }]);
  assert.deepEqual(tableRefs('insert Orders (a, b) values (1, 2)'), [{ parts: ['Orders'], alias: undefined }], 'INTO is optional');
  assert.deepEqual(tableRefs('INSERT INTO Archive (id) SELECT id FROM Orders WHERE '),
    [{ parts: ['Archive'], alias: undefined }, { parts: ['Orders'], alias: undefined }], 'INSERT ... SELECT');
});

test('tableRefs finds the DELETE target with or without FROM', () => {
  assert.deepEqual(tableRefs('DELETE dbo.Orders WHERE '), [{ parts: ['dbo', 'Orders'], alias: undefined }]);
  assert.deepEqual(tableRefs('DELETE FROM dbo.Orders WHERE '), [{ parts: ['dbo', 'Orders'], alias: undefined }]);
  assert.deepEqual(tableRefs('DELETE TOP (5) FROM Orders OUTPUT deleted.id WHERE '), [{ parts: ['Orders'], alias: undefined }], 'TOP (n), OUTPUT is no alias');
  assert.deepEqual(tableRefs("SELECT 'update x set' FROM T"), [{ parts: ['T'], alias: undefined }], 'keywords inside strings ignored');
});

test('tableRefs: UPDATE that is not a statement target (FOR UPDATE, ON ... UPDATE) is no table', () => {
  assert.deepEqual(tableRefs('SELECT * FROM t FOR UPDATE NOWAIT'), [{ parts: ['t'], alias: undefined }], 'edit grid needs exactly one table');
  assert.deepEqual(tableRefs('SELECT * FROM t FOR UPDATE OF t SKIP LOCKED'), [{ parts: ['t'], alias: undefined }]);
  assert.deepEqual(tableRefs('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2'), [{ parts: ['t'], alias: undefined }]);
});

test('tableRefs finds FROM / JOIN tables and aliases', () => {
  assert.deepEqual(tableRefs('SELECT  *\nFROM    dbo.Orders\nwhere ;'), [{ parts: ['dbo', 'Orders'], alias: undefined }]);
  assert.deepEqual(
    tableRefs('select * from SalesDb..Orders o join [My DB].dbo.[Order Lines] AS l on l.id = o.id where'),
    [{ parts: ['SalesDb', '', 'Orders'], alias: 'o' }, { parts: ['My DB', 'dbo', 'Order Lines'], alias: 'l' }],
  );
  assert.deepEqual(tableRefs("select 'from x' from T"), [{ parts: ['T'], alias: undefined }], 'from inside string ignored');
  assert.deepEqual(tableRefs('select * from SalesDb.'), []);
  assert.deepEqual(tableRefs('select * from dbo.Orders o, SalesDb..Lines AS l, Items where o.id = l.id'), [
    { parts: ['dbo', 'Orders'], alias: 'o' }, { parts: ['SalesDb', '', 'Lines'], alias: 'l' }, { parts: ['Items'], alias: undefined },
  ], 'FROM a, b, c');
  assert.deepEqual(tableRefs("select a, b from t where x in ('p', 'q')"), [{ parts: ['t'], alias: undefined }], 'commas after FROM list are not tables');
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

test('edit grid: literals and UPDATE script by primary key', () => {
  assert.equal(sqlLiteral("O'Neil"), "N'O''Neil'");
  assert.equal(sqlLiteral(new Date(Date.UTC(2025, 0, 2, 3, 4, 5, 6))), "'2025-01-02T03:04:05.006'");
  assert.equal(sqlLiteral(new Uint8Array([1, 255])), '0x01FF');
  assert.equal(editLiteral(' 12.5 ', 'decimal'), '12.5');
  assert.throws(() => editLiteral('12a', 'int'), /not a number/);
  assert.equal(editLiteral('true', 'bit'), '1');
  assert.equal(editLiteral('NULL', 'varchar'), 'NULL');
  const script = updateScript('[db].[dbo].[Orders]', ['id', 'name', 'qty'], ['int', 'nvarchar', 'int'],
    [[1, 'a', 3], [2, "b'c", 4]], ['ID'], [{ row: 1, col: 1, value: "x'y" }, { row: 1, col: 2, value: '7' }, { row: 0, col: 2, value: null }]);
  assert.ok(script.includes("UPDATE [db].[dbo].[Orders]\nSET [qty] = NULL\nWHERE [id] = 1;"), script);
  assert.ok(script.includes("SET [name] = N'x''y', [qty] = 7\nWHERE [id] = 2;"));
  assert.ok(script.includes('BEGIN TRAN;') && script.includes('-- COMMIT;') && !/^COMMIT/m.test(script), 'never commits by itself');
  assert.throws(() => updateScript('t', ['name'], ['nvarchar'], [['a']], ['id'], [{ row: 0, col: 0, value: 'b' }]), /must be part of the SELECT/);
  assert.throws(() => updateScript('t', ['id'], ['int'], [[1]], ['id'], [{ row: 0, col: 0, value: '2' }]), /cannot be edited/);
});

test('poolConfig: SQL login vs Windows (NTLM)', () => {
  const base = { name: 'n', type: 'mssql' as const, host: 'h', port: 1433, user: 'u', database: '', trustServerCertificate: true };
  const sqlLogin = poolConfig(base, 'pw');
  assert.equal(sqlLogin.user, 'u');
  assert.equal(sqlLogin.authentication, undefined);
  const win = poolConfig({ ...base, auth: 'windows', domain: 'CORP' }, 'pw');
  assert.deepEqual(win.authentication, { type: 'ntlm', options: { domain: 'CORP', userName: 'u', password: 'pw' } });
  assert.equal(win.user, undefined);
});

test('poolConfig: no request timeout (mssql default 15 s), long queries stop via Cancel', () => {
  const c = poolConfig({ name: 'n', type: 'mssql', host: 'h', port: 1433, user: 'u', database: '', trustServerCertificate: true }, 'pw');
  assert.equal(c.requestTimeout, 0);
});

test('readOnly: plain SELECT / WITH only (manual transaction mode does not BEGIN TRAN for them)', () => {
  assert.ok(readOnly(['SELECT order_no, status\nFROM dbo.orders\nWHERE order_no = \'10001\';']));
  assert.ok(readOnly(['WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'select * from t']));
  assert.ok(readOnly(["SELECT 'update x; delete y' AS s -- insert z"]), 'keywords inside strings / comments');
  assert.ok(!readOnly([]), 'nothing to run');
  assert.ok(!readOnly(['UPDATE t SET a = 1']));
  assert.ok(!readOnly(['SELECT 1', 'DELETE FROM t']), 'mixed script');
  assert.ok(!readOnly(['WITH x AS (SELECT id FROM t) DELETE FROM x']), 'CTE + DML');
  assert.ok(!readOnly(['SELECT * INTO #t FROM t']), 'SELECT INTO creates a table');
  assert.ok(!readOnly(['SELECT * FROM t WITH (UPDLOCK, ROWLOCK)']), 'lock hints are held until commit / rollback');
  assert.ok(!readOnly(['SELECT * FROM t WITH (HOLDLOCK)']) && !readOnly(['SELECT * FROM t (XLOCK)']));
  assert.ok(!readOnly(['EXEC dbo.proc']) && !readOnly(['DECLARE @a INT']) && !readOnly(['SET XACT_ABORT ON']));
});

test('affectedStatements: each rows-affected count belongs to its INSERT / UPDATE / DELETE statement', () => {
  const sel = 'SELECT order_no FROM dbo.orders WHERE order_no = 1';
  const upd = "UPDATE dbo.orders SET status = 'IF' WHERE order_no = 1";
  assert.deepEqual(affectedStatements([sel, upd], 1), [{ n: 2, sql: upd }], 'SELECT + UPDATE');
  assert.deepEqual(affectedStatements(['INSERT INTO t VALUES (1)', sel, 'delete from t where a = 1', 'WITH x AS (SELECT 1 AS a) MERGE t USING x ON 1 = 0 WHEN NOT MATCHED THEN INSERT (a) VALUES (x.a)'], 3)
    .map((x: { n: number } | undefined) => x?.n), [1, 3, 4], 'INSERT, DELETE, CTE + MERGE in order');
  assert.deepEqual(affectedStatements(['CREATE TABLE #t (a INT)', 'SELECT 1 AS a INTO #u', 'DROP TABLE #t'], 1).map((x: { n: number } | undefined) => x?.n), [2], 'SELECT INTO reports a count, DDL none');
  assert.deepEqual(affectedStatements([upd, 'EXEC dbo.proc'], 3), [undefined, undefined, undefined], 'EXEC: counts cannot be matched, no labels');
  assert.deepEqual(affectedStatements([upd, upd], 1), [undefined], 'count mismatch (SET NOCOUNT, trigger, error): no labels');
  assert.deepEqual(affectedStatements([upd], 0), []);
});

test('render: rows affected under a "Statement n" heading with its SQL, blocks separated', () => {
  const upd = "UPDATE dbo.orders SET status = 'IF' WHERE order_no = '10001'";
  const html = render('csp', 'local', { result: {
    resultSets: [{ columns: ['a'], rows: [[1]], total: 1 }], rowsAffected: [1], affected: [{ n: 2, sql: upd }], messages: [], durationMs: 1,
  } });
  assert.ok(html.includes(`Statement 2 <span>${preview(upd)}</span>`), 'heading names the UPDATE');
  assert.ok(html.includes('<div class="aff">1 row(s) affected</div>'));
  assert.equal((html.match(/<div class="blk">/g) ?? []).length, 2, 'Result 1 and Statement 2 are separate blocks');
  const plain = render('csp', 'local', { result: { resultSets: [], rowsAffected: [2, 3], affected: [undefined, undefined], messages: [], durationMs: 1 } });
  assert.ok(plain.includes('2 row(s) affected\n3 row(s) affected') && !plain.includes('<h3>Statement'), 'unmatched counts stay unlabelled');
});

test('readOnlyBlocked: read-only connections run only statements that do not change data', () => {
  for (const ok of [['SELECT * FROM t WITH (NOLOCK)'], ['WITH x AS (SELECT 1 AS a) SELECT * FROM x'], ['DECLARE @id INT = 5', 'SELECT * FROM t WHERE id = @id'],
    ['SET @x = 1'], ['SHOW TABLES'], ['describe t'], ["SELECT 'drop table t' AS s -- delete"], ['SELECT * FROM t WITH (UPDLOCK)']]) {
    assert.equal(readOnlyBlocked('mssql', ok), undefined, ok.join('; '));
  }
  assert.match(readOnlyBlocked('mssql', ['SELECT 1', "UPDATE dbo.orders SET status = 'IF'"])!, /read-only.*UPDATE dbo\.orders/);
  for (const bad of ['INSERT INTO t VALUES (1)', 'DELETE FROM t', 'MERGE t USING s ON 1=1 WHEN MATCHED THEN DELETE', 'TRUNCATE TABLE t', 'DROP TABLE t',
    'ALTER TABLE t ADD c INT', 'CREATE TABLE t (a INT)', 'EXEC dbo.proc', 'SELECT * INTO #t FROM t', 'WITH x AS (SELECT 1 AS a) DELETE FROM x',
    'GRANT SELECT ON t TO u', 'SET GLOBAL max_connections = 10', 'SET XACT_ABORT ON']) {
    assert.ok(readOnlyBlocked('mssql', [bad]), bad);
  }
  assert.equal(readOnlyBlocked('mongodb', ['db.orders.find({ a: 1 }).limit(5)']), undefined);
  assert.equal(readOnlyBlocked('mongodb', ['db.orders.aggregate([{ $match: {} }])']), undefined);
  assert.equal(readOnlyBlocked('mongodb', ['db.orders.countDocuments({})']), undefined);
  for (const bad of ['db.orders.insertOne({ a: 1 })', 'db.orders.updateMany({}, { $set: { a: 1 } })', 'db.orders.deleteOne({})', 'db.orders.drop()',
    'db.orders.findOneAndUpdate({}, {})', 'db.orders.aggregate([{ $out: "x" }])', 'db.orders.aggregate([{ $merge: { into: "x" } }])', 'db.createCollection("x")']) {
    assert.ok(readOnlyBlocked('mongodb', [bad]), bad);
  }
});

test('txEndStatement: COMMIT / ROLLBACK in the script that ended the transaction', () => {
  assert.equal(txEndStatement(['COMMIT;']), 'commit');
  assert.equal(txEndStatement(["UPDATE t SET a = 1", 'commit tran']), 'commit');
  assert.equal(txEndStatement(['COMMIT TRANSACTION', 'SELECT 1']), 'commit', 'SELECT after the COMMIT');
  assert.equal(txEndStatement(['ROLLBACK;']), 'rollback');
  assert.equal(txEndStatement(['COMMIT', 'BEGIN TRAN', 'ROLLBACK WORK']), 'rollback', 'last one wins');
  assert.equal(txEndStatement(["SELECT 'commit' AS c -- rollback"]), undefined, 'strings / comments');
  assert.equal(txEndStatement(['UPDATE t SET a = 1', 'SELECT 1/0']), undefined, 'ended by the server (error)');
});

test('alterScript: object definition -> CREATE OR ALTER (comments before CREATE kept)', () => {
  assert.equal(alterScript('CREATE PROCEDURE dbo.p AS SELECT 1'), 'CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1');
  assert.equal(alterScript('-- note: create view x\n/* CREATE */\ncreate   view [dbo].[v] AS SELECT 1 AS a'), '-- note: create view x\n/* CREATE */\nCREATE OR ALTER VIEW [dbo].[v] AS SELECT 1 AS a');
  assert.equal(alterScript('CREATE PROC p AS RETURN'), 'CREATE OR ALTER PROC p AS RETURN');
  assert.equal(alterScript('CREATE OR ALTER VIEW v AS SELECT 1'), 'CREATE OR ALTER VIEW v AS SELECT 1', 'already CREATE OR ALTER');
  assert.equal(alterScript('ALTER PROCEDURE p AS SELECT 1'), 'CREATE OR ALTER PROCEDURE p AS SELECT 1');
  assert.throws(() => alterScript('SELECT 1'), /not a CREATE VIEW \/ PROCEDURE/);
});

test('execScript: EXEC with every parameter, OUTPUT declared and selected, defaults noted', () => {
  assert.equal(execScript('Shop', { schema: 'sales', name: 'top customers' }, []), 'EXEC [Shop].[sales].[top customers];');
  assert.equal(execScript('Shop', { schema: 'dbo', name: 'get_orders' }, [
    { name: '@customer_id', type: 'int', output: false, hasDefault: false },
    { name: '@from', type: 'datetime2', output: false, hasDefault: true },
    { name: '@total', type: 'decimal(12,2)', output: true, hasDefault: false },
  ]), [
    'DECLARE @total decimal(12,2);',
    'EXEC [Shop].[dbo].[get_orders]',
    '    @customer_id = NULL -- int',
    '  , @from = DEFAULT -- datetime2 (has default)',
    '  , @total = @total OUTPUT -- decimal(12,2)',
    ';',
    'SELECT @total AS [@total];',
  ].join('\n'));
});

test('paramDefaults: parameters with a default value, read from the procedure header (sys.parameters does not tell)', () => {
  assert.deepEqual([...paramDefaults("CREATE PROCEDURE dbo.p @a int, @b varchar(10) = 'x,y', @c decimal(12,2) = NULL OUTPUT AS SELECT @a = 1")], ['@b', '@c'], 'body after AS ignored');
  assert.deepEqual([...paramDefaults('CREATE PROC p (@A INT = 5, @b INT) AS RETURN')], ['@a'], 'parenthesized list, case-insensitive');
  assert.deepEqual([...paramDefaults('create proc p @a AS int = 1 AS select 1')], ['@a'], 'param AS type');
  assert.deepEqual([...paramDefaults("CREATE PROCEDURE p\n  -- @x int = 1 (comment)\n  @y int\nWITH RECOMPILE\nAS SELECT 1")], [], 'comments ignored');
  assert.deepEqual([...paramDefaults('CREATE PROCEDURE p AS SELECT 1')], []);
});

test('txEndStatement: MySQL / MariaDB DDL commits implicitly, PostgreSQL / SQL Server DDL does not', () => {
  assert.equal(txEndStatement(['UPDATE t SET a = 1', 'CREATE TABLE x (a INT)'], 'mysql'), 'implicit');
  assert.equal(txEndStatement(['ALTER TABLE t ADD c INT', 'COMMIT'], 'mysql'), 'commit', 'explicit COMMIT after the DDL');
  assert.equal(txEndStatement(['COMMIT', 'drop table x'], 'mysql'), 'implicit');
  assert.equal(txEndStatement(['TRUNCATE TABLE t'], 'mysql'), 'implicit');
  assert.equal(txEndStatement(['CREATE TABLE x (a INT)'], 'postgres'), undefined);
  assert.equal(txEndStatement(['CREATE TABLE x (a INT)']), undefined, 'SQL Server default');
  assert.equal(txEndStatement(['CREATE TEMPORARY TABLE x (a INT)'], 'mysql'), undefined, 'temporary tables do not commit');
});

test('statements: routine bodies stay whole (SQL Server to GO, MySQL BEGIN ... END, PostgreSQL $$ ... $$)', () => {
  const ms = 'CREATE OR ALTER PROCEDURE dbo.p @a INT AS\nSET NOCOUNT ON;\nSELECT @a AS a;\nGO\nSELECT 2;';
  assert.deepEqual(splitStatements(splitBatches(ms)[0], 'mssql'), ['CREATE OR ALTER PROCEDURE dbo.p @a INT AS\nSET NOCOUNT ON;\nSELECT @a AS a;'], 'T-SQL: whole batch');
  assert.deepEqual(statementSegments(ms, 'mssql').map((s: { start: number; end: number }) => ms.slice(s.start, s.end).split('\n')[0]), ['CREATE OR ALTER PROCEDURE dbo.p @a INT AS', 'SELECT 2;'], 'lens: one per routine');
  assert.equal(statementAt(ms, ms.indexOf('SELECT @a'), 'mssql').split('\n').length, 3, 'cursor inside the body runs the whole routine');
  assert.deepEqual(splitStatements('CREATE VIEW v AS SELECT 1 AS a;\nSELECT 2;', 'mssql'), ['CREATE VIEW v AS SELECT 1 AS a;\nSELECT 2;'], 'T-SQL view also ends at GO');
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2;', 'mssql'), ['SELECT 1;', 'SELECT 2;'], 'other statements unchanged');

  const my = 'CREATE DEFINER=`root`@`%` PROCEDURE p(IN a INT)\nBEGIN\n  DECLARE x INT;\n  IF a > 0 THEN SET x = 1; END IF;\n  SELECT CASE WHEN a > 1 THEN 2 ELSE 3 END;\n  WHILE x < 3 DO SET x = x + 1; END WHILE;\nEND;\nSELECT 2;';
  assert.deepEqual(splitStatements(my, 'mysql').map((s) => s.slice(0, 16)), ['CREATE DEFINER=`', 'SELECT 2;'], 'MySQL: BEGIN ... END with IF / CASE / WHILE inside');
  assert.deepEqual(splitStatements('CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1; SELECT f();', 'mysql'), ['CREATE FUNCTION f() RETURNS INT DETERMINISTIC RETURN 1;', 'SELECT f();'], 'no BEGIN: first ;');
  assert.equal(statementSegments(my, 'mysql').length, 2);

  const pg = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT $body$ a;b $body$;';
  assert.deepEqual(splitStatements(pg), ['CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;', 'SELECT $body$ a;b $body$;'], 'dollar-quoted strings');
  assert.ok(!maskSql('SELECT $x$ FROM t; $x$').includes('FROM'), 'masked like a string');
});

test('alterScript: functions and triggers (table and database triggers)', () => {
  assert.equal(alterScript('CREATE FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN 1 END'), 'CREATE OR ALTER FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN 1 END');
  assert.equal(alterScript('CREATE TRIGGER trg_db ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;'), 'CREATE OR ALTER TRIGGER trg_db ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;');
});

test('fnScript: scalar function = SELECT f(...) AS [result], table-valued = SELECT * FROM f(...)', () => {
  const ps = [
    { name: '@a', type: 'int', output: false, hasDefault: false },
    { name: '@b', type: 'int', output: false, hasDefault: true },
  ];
  assert.equal(fnScript('Shop', { schema: 'dbo', name: 'twice' }, ps, false),
    'SELECT [Shop].[dbo].[twice](\n    NULL -- @a int\n  , DEFAULT -- @b int (has default)\n) AS [result];');
  assert.equal(fnScript('Shop', { schema: 'dbo', name: 'f_tvf' }, [ps[0]], true), 'SELECT * FROM [Shop].[dbo].[f_tvf](\n    NULL -- @a int\n);');
  assert.equal(fnScript('Shop', { schema: 'dbo', name: 'now_utc' }, [], false), 'SELECT [Shop].[dbo].[now_utc]() AS [result];');
  assert.equal(fnScript('Shop', { schema: 'dbo', name: 'all_rows' }, [], true), 'SELECT * FROM [Shop].[dbo].[all_rows]();');
});

test('scriptAs: SELECT / INSERT / UPDATE / DELETE / DROP / CREATE TABLE from columns and primary key', () => {
  const t = { schema: 'dbo', name: 'orders' };
  const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'code', type: 'varchar(10)', nullable: true }];
  assert.equal(scriptAs('select', t, 'table', cols, ['id']), 'SELECT TOP (1000)\n    [id]\n  , [code]\nFROM [dbo].[orders];');
  assert.equal(scriptAs('insert', t, 'table', cols, ['id']),
    'INSERT INTO [dbo].[orders] (\n    [id]\n  , [code]\n)\nVALUES (\n    NULL -- id int\n  , NULL -- code varchar(10)\n);');
  assert.equal(scriptAs('update', t, 'table', cols, ['id']), 'UPDATE [dbo].[orders]\nSET\n    [code] = NULL -- varchar(10)\nWHERE\n    [id] = NULL -- int\n;');
  assert.equal(scriptAs('delete', t, 'table', cols, ['id']), 'DELETE FROM [dbo].[orders]\nWHERE\n    [id] = NULL -- int\n;');
  assert.equal(scriptAs('delete', t, 'table', cols, []), 'DELETE FROM [dbo].[orders]\nWHERE\n    <condition>\n;', 'no primary key: condition to fill in');
  assert.equal(scriptAs('drop', t, 'table', cols, ['id']), 'DROP TABLE [dbo].[orders];');
  assert.equal(scriptAs('drop', { schema: 'dbo', name: 'p' }, 'procedure', [], []), 'DROP PROCEDURE [dbo].[p];');
  assert.equal(scriptAs('drop', { schema: '', name: 'trg_db' }, 'trigger', [], []), 'DROP TRIGGER [trg_db] ON DATABASE;', 'database trigger');
  assert.equal(scriptAs('create', t, 'table', cols, ['id']),
    'CREATE TABLE [dbo].[orders] (\n    [id] int NOT NULL\n  , [code] varchar(10) NULL\n  , CONSTRAINT [PK_orders] PRIMARY KEY ([id])\n);');
});

test('server scripts: job start / stop, kill session (validated), backup / restore', () => {
  assert.equal(jobScript('start', "nightly 'etl'"), "EXEC msdb.dbo.sp_start_job @job_name = N'nightly ''etl''';");
  assert.equal(jobScript('stop', 'x'), "EXEC msdb.dbo.sp_stop_job @job_name = N'x';");
  assert.equal(killScript('57'), 'KILL 57;');
  assert.throws(() => killScript('57; DROP TABLE t'), /session id/);
  assert.throws(() => killScript('0'), /session id/);
  assert.equal(backupScript('Shop', '/var/opt/mssql/data/', '20261029_1530'),
    "BACKUP DATABASE [Shop]\nTO DISK = N'/var/opt/mssql/data/Shop_20261029_1530.bak'\nWITH COPY_ONLY, INIT, CHECKSUM, STATS = 10;");
  assert.equal(backupScript("O'Brien", 'C:\\Backup', 'x'), "BACKUP DATABASE [O'Brien]\nTO DISK = N'C:\\Backup\\O''Brien_x.bak'\nWITH COPY_ONLY, INIT, CHECKSUM, STATS = 10;");
  assert.match(restoreScript('Shop', '/b/Shop.bak'), /^-- 1\. check the backup.*\nRESTORE FILELISTONLY FROM DISK = N'\/b\/Shop\.bak';\n.*\n-- RESTORE DATABASE \[Shop\] FROM DISK = N'\/b\/Shop\.bak' WITH REPLACE, RECOVERY, STATS = 10;$/s);
});

test('scriptAs: INSERT / UPDATE skip identity, computed and rowversion columns (SELECT keeps them)', () => {
  const t = { schema: 'dbo', name: 'orders' };
  const cols = [
    { name: 'id', type: 'int', nullable: false, generated: true },
    { name: 'code', type: 'varchar(10)', nullable: true },
    { name: 'total', type: 'decimal(12,2)', nullable: true },
    { name: 'total_tax', type: 'decimal(13,2)', nullable: true, generated: true },
    { name: 'ver', type: 'timestamp', nullable: false, generated: true },
  ];
  assert.equal(scriptAs('insert', t, 'table', cols, ['id']),
    'INSERT INTO [dbo].[orders] (\n    [code]\n  , [total]\n)\nVALUES (\n    NULL -- code varchar(10)\n  , NULL -- total decimal(12,2)\n);');
  assert.equal(scriptAs('update', t, 'table', cols, ['id']),
    'UPDATE [dbo].[orders]\nSET\n    [code] = NULL -- varchar(10)\n  , [total] = NULL -- decimal(12,2)\nWHERE\n    [id] = NULL -- int\n;');
  assert.match(scriptAs('select', t, 'table', cols, ['id']), /\[total_tax\]\n  , \[ver\]\nFROM/);
});

test('createTableScript: identity, computed, default, collation, PK / unique / check, then foreign keys and indexes', () => {
  const sql = createTableScript({
    schema: 'dbo', name: 'orders',
    columns: [
      { name: 'id', type: 'int', nullable: false, identity: { seed: '1', increment: '1' } },
      { name: 'code', type: 'varchar(10)', nullable: true, collation: 'Latin1_General_BIN' },
      { name: 'qty', type: 'int', nullable: false, default: { name: 'df_qty', definition: '((0))' } },
      { name: 'total', type: 'decimal(12,2)', nullable: true },
      { name: 'total_tax', type: 'decimal(13,2)', nullable: true, computed: { definition: '([total]*(1.1))', persisted: true } },
      { name: 'customer_id', type: 'int', nullable: true },
    ],
    keys: [
      { name: 'pk_orders', primary: true, clustered: true, columns: [{ name: 'id', desc: false }] },
      { name: 'uq_code', primary: false, clustered: false, columns: [{ name: 'code', desc: true }] },
    ],
    checks: [{ name: 'ck_qty', definition: '([qty]>=(0))' }],
    foreignKeys: [{ name: 'fk_orders_customer', columns: ['customer_id'], refSchema: 'sales', refTable: 'customer', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO_ACTION' }],
    indexes: [{ name: 'ix_orders_customer', unique: false, clustered: false, columns: [{ name: 'customer_id', desc: false }], included: ['total'], filter: '([customer_id] IS NOT NULL)' }],
  });
  assert.equal(sql, [
    'CREATE TABLE [dbo].[orders] (',
    '    [id] int IDENTITY(1, 1) NOT NULL',
    '  , [code] varchar(10) COLLATE Latin1_General_BIN NULL',
    '  , [qty] int NOT NULL CONSTRAINT [df_qty] DEFAULT ((0))',
    '  , [total] decimal(12,2) NULL',
    '  , [total_tax] AS ([total]*(1.1)) PERSISTED',
    '  , [customer_id] int NULL',
    '  , CONSTRAINT [pk_orders] PRIMARY KEY CLUSTERED ([id] ASC)',
    '  , CONSTRAINT [uq_code] UNIQUE NONCLUSTERED ([code] DESC)',
    '  , CONSTRAINT [ck_qty] CHECK ([qty]>=(0))',
    ');',
    'ALTER TABLE [dbo].[orders] ADD CONSTRAINT [fk_orders_customer] FOREIGN KEY ([customer_id]) REFERENCES [sales].[customer] ([id]) ON DELETE CASCADE;',
    'CREATE NONCLUSTERED INDEX [ix_orders_customer] ON [dbo].[orders] ([customer_id] ASC) INCLUDE ([total]) WHERE ([customer_id] IS NOT NULL);',
  ].join('\n'));
  assert.equal(createTableScript({ schema: 's', name: 't', columns: [{ name: 'a', type: 'int', nullable: true }], keys: [], checks: [], foreignKeys: [], indexes: [] }),
    'CREATE TABLE [s].[t] (\n    [a] int NULL\n);', 'minimal table');
});

// Test "real" di Extension Development Host dengan profil VS Code user (koneksi & password yang sudah tersimpan).
// run: npm run test:real   (hanya SELECT; laporan di ~/.claude/bg-logs/moonage-real-test.log)
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Location } from '../../results';
import type { Node } from '../../explorer';

const OUT = join(homedir(), '.claude', 'bg-logs');
const REPORT = join(OUT, 'moonage-real-test.log');
const CONN = process.env.MOONAGE_TEST_CONN ?? 'test-db';
/**
 * nama database / tabel milik server test, di luar git (test-extention/local/ di-ignore):
 * {"db": "<db dengan tabel kecil>", "table": "<tabel kecil di dbo>", "bigDb": "<db>", "bigTable": "<tabel besar di dbo, ~1 juta baris>"}
 */
const LOCAL_CONFIG = join(__dirname, '..', '..', '..', 'test-extention', 'local', 'real-test.json');
const L = (() => {
  try {
    return JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')) as { db: string; table: string; bigDb: string; bigTable: string };
  } catch (e) {
    throw new Error(`real test butuh ${LOCAL_CONFIG}: ${e instanceof Error ? e.message : e}`);
  }
})();
const QUERY = 'SELECT TOP 5 name, create_date FROM sys.databases;\nSELECT @@VERSION AS version;';

const say = (s: string) => appendFileSync(REPORT, `${new Date().toISOString()} ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resultTabColumn(): number | undefined {
  for (const g of vscode.window.tabGroups.all) {
    for (const t of g.tabs) {
      if (t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('moonageDaydream.results')) return g.viewColumn;
    }
  }
  return undefined;
}

const errOf = (nodes: Node[]) => nodes.find((n) => n.kind === 'msg' && n.error);

/** Explorer: database → folder → objek → kolom, lalu "Select Top 100" pada tabel pertama yang ketemu (SELECT saja). */
/** SQL Files: New SQL File di folder sementara, tampilan tree & flat, lalu folder dihapus */
async function sqlFilesTest(m: typeof import('../../extension')) {
  const { sqlFileName } = require('../../sqlFiles') as typeof import('../../sqlFiles');
  assert.equal(sqlFileName(' a\\b '), 'a/b.sql');
  assert.equal(sqlFileName('x.SQL'), 'x.SQL');
  assert.ok(typeof sqlFileName('../x') !== 'string' && typeof sqlFileName('') !== 'string', 'reject .. and empty');

  say(`workspace: ${vscode.workspace.name} folders=${vscode.workspace.workspaceFolders?.map((f) => f.uri.toString()).join(', ')}`);
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return say('SKIP sql files: dev window has no folder open (npm run dev -- <folder>)');
  const dir = vscode.Uri.joinPath(root.uri, '__moonage_test__');
  const flat0 = m.sqlFiles.flat;
  try {
    const uri = await vscode.commands.executeCommand<vscode.Uri>('moonageDaydream.newSqlFile', { kind: 'folder', root, rel: '' }, '__moonage_test__/sub/q1');
    assert.ok(uri && uri.path.endsWith('/__moonage_test__/sub/q1.sql'), `created ${uri?.path}`);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString(), 'new file opened');
    await vscode.commands.executeCommand('moonageDaydream.newSqlFile', { kind: 'folder', root, rel: '__moonage_test__/sub' }, 'q2');

    await m.sqlFiles.setFlat(false);
    const top = await m.sqlFiles.getChildren();
    const testDir = top.find((n) => n.kind === 'folder' && n.rel === '__moonage_test__');
    assert.ok(testDir, `tree has __moonage_test__ (${top.length} top nodes)`);
    const sub = await m.sqlFiles.getChildren(testDir);
    assert.deepEqual(sub.map((n) => (n.kind === 'folder' ? n.rel : '')), ['__moonage_test__/sub']);
    const files = await m.sqlFiles.getChildren(sub[0]);
    assert.deepEqual(files.map((n) => (n.kind === 'file' ? n.uri.path.split('/').pop() : '')), ['q1.sql', 'q2.sql']);

    await m.sqlFiles.setFlat(true);
    const flat = await m.sqlFiles.getChildren();
    assert.ok(flat.every((n) => n.kind === 'file'), 'flat has only files');
    const q2 = flat.find((n) => n.kind === 'file' && n.uri.path.endsWith('/sub/q2.sql'))!;
    const item = m.sqlFiles.getTreeItem(q2);
    assert.ok(String(item.description).startsWith('__moonage_test__/sub'), `flat description ${item.description}`);
    say(`PASS sql files: tree __moonage_test__/sub -> q1.sql, q2.sql; flat ${flat.length} file(s), "${item.description}"`);
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    await m.sqlFiles.setFlat(flat0);
    m.sqlFiles.refresh();
  }
}

/** 2 SELECT paralel: yang cepat tampil duluan, yang lambat tetap loading lalu di-cancel sendiri (hanya SELECT) */
async function parallelTest(m: typeof import('../../extension')) {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `SELECT 1 AS fast;\nSELECT * FROM ${L.bigDb}.dbo.${L.bigTable};` });
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  const run = vscode.commands.executeCommand('moonageDaydream.runQuery');
  let html = '';
  for (let i = 0; i < 40 && !/Query 1 <span>[^<]*· \d+ ms/.test(html); i++) {
    await sleep(250);
    html = resultHtml(m);
  }
  assert.match(html, /Query 1 <span>SELECT 1 AS fast; · \d+ ms/, 'fast statement shown first');
  assert.match(html, /Query 2 <span>[^<]*· running/, 'slow statement still loading');
  assert.ok(html.includes(encodeURIComponent(',1]')), 'per-statement Cancel button for query 2');
  const t = Date.now();
  await vscode.commands.executeCommand('moonageDaydream.cancelQuery', doc.uri.toString(), 1);
  assert.ok(resultHtml(m).includes('Cancelling query'), 'query 2 shows Cancelling');
  await run;
  html = resultHtml(m);
  assert.ok(html.includes('Query cancelled.') && /2 queries done in \d+ ms · 1 failed/.test(html), 'query 2 cancelled, summary shown');
  assert.equal(m.history.list()[0].status, 'cancelled');
  say(`PASS parallel: query 1 shown while query 2 running; cancel query 2 in ${Date.now() - t} ms`);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

/** autocomplete: database, schema, tabel lintas database (hanya baca metadata) */
async function completionTest(m: typeof import('../../extension')) {
  const prefix = L.table.slice(0, 2);
  const lines = ['SELECT * FROM ', `SELECT * FROM ${L.db}.`, `SELECT * FROM ${L.db}.dbo.${prefix}`, `SELECT * FROM ${L.db}..${prefix}`];
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: lines.join('\n') });
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  m.completion.clear();
  const labels = async (line: number) => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, lines[line].length));
    return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  };
  const dbs = await labels(0);
  assert.ok(dbs.includes(L.db) && dbs.includes(L.bigDb), `databases in ${dbs.length} items`);
  const schemas = await labels(1);
  assert.ok(schemas.includes('dbo'), `schemas after DB.: ${schemas.slice(0, 5)}`);
  const tables = await labels(2);
  assert.ok(tables.includes(L.table), `tables after DB.dbo.: ${tables.length}`);
  assert.ok((await labels(3)).includes(L.table), 'DB..table defaults to dbo');
  say(`PASS completion: ${dbs.length} items at FROM, DB. -> ${schemas.length} schema(s), DB.dbo. -> ${tables.length} table/view(s)`);
}

async function explorerTest(m: typeof import('../../extension')) {
  const ex = m.explorer;
  const conn = (await ex.getChildren()).find((n) => n.kind === 'conn' && n.c.name === CONN)!;
  const dbs = await ex.getChildren(conn);
  assert.ok(!errOf(dbs) && dbs.length && dbs.every((n) => n.kind === 'db'), `databases: ${JSON.stringify(errOf(dbs))}`);
  say(`explorer databases=${dbs.length}`);
  for (const db of dbs.slice(0, 10)) {
    const [tables, views, procs] = await Promise.all((await ex.getChildren(db)).map((f) => ex.getChildren(f)));
    for (const list of [tables, views, procs]) assert.ok(!errOf(list), `objects in ${db.kind === 'db' && db.db}: ${JSON.stringify(errOf(list))}`);
    const t = tables.find((n) => n.kind === 'obj');
    if (!t || t.kind !== 'obj') continue;
    const cols = await ex.getChildren(t);
    assert.ok(!errOf(cols) && cols[0]?.kind === 'col', `columns of ${t.obj.name}`);
    say(`explorer ${t.db}: tables=${tables.length} views=${views.length} procs=${procs.length}; ${t.obj.schema}.${t.obj.name} columns=${cols.length} first=${cols[0].kind === 'col' && cols[0].label} (${cols[0].kind === 'col' && cols[0].description})`);
    await vscode.commands.executeCommand('moonageDaydream.selectTop', t);
    await sleep(1500);
    const html = (m.results.location === 'panel' ? m.results.view?.webview.html : m.results.panel?.webview.html) ?? '';
    assert.ok(!html.includes('class="err"') && html.includes('Result 1'), `select top: ${html.match(/class="err">([^<]*)/)?.[1]}`);
    say(`PASS explorer + select top 100 (${vscode.window.activeTextEditor?.document.getText()})`);
    return;
  }
  throw new Error('no user table found in the first 10 databases');
}

const resultHtml = (m: typeof import('../../extension')) =>
  (m.results.location === 'panel' ? m.results.view?.webview.html : m.results.panel?.webview.html) ?? '';

/** dua file .sql dengan database berbeda: CodeLens + DB_NAME() mengikuti binding masing-masing file */
async function fileBindingTest(m: typeof import('../../extension')) {
  const conn = (await m.explorer.getChildren()).find((n) => n.kind === 'conn' && n.c.name === CONN)!;
  const dbs = (await m.explorer.getChildren(conn)).flatMap((n) => (n.kind === 'db' ? [n.db] : []));
  const pair = ['master', dbs.find((d) => !['master', 'model', 'msdb', 'tempdb'].includes(d)) ?? 'tempdb'];
  for (const db of pair) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT DB_NAME() AS current_db;' });
    await m.conns.bind(doc.uri.toString(), { conn: CONN, db });
    await vscode.window.showTextDocument(doc);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
    const titles = lenses.filter((l) => l.command?.command.startsWith('moonageDaydream.')).map((l) => l.command!.title);
    assert.deepEqual(titles, ['$(play) Execute', `$(server) ${CONN}`, `$(database) ${db}`], `codelens ${JSON.stringify(titles)}`);
    await vscode.commands.executeCommand('moonageDaydream.runQuery');
    await sleep(1000);
    assert.ok(resultHtml(m).includes(`<td>${db}</td>`), `DB_NAME() should be ${db}: ${resultHtml(m).match(/class="err">([^<]*)/)?.[1] ?? 'other db'}`);
    say(`PASS file binding ${db} (codelens: ${titles.join(' | ')})`);
  }
}

const firstLens = async (uri: vscode.Uri) =>
  (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri))
    .find((l) => l.command?.command.startsWith('moonageDaydream.'))?.command?.title;

/** cancel: WAITFOR (read-only) dihentikan di server, batch berikutnya tidak jalan, run ulang membatalkan run lama */
async function cancelTest(m: typeof import('../../extension')) {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: "WAITFOR DELAY '00:00:20';\nSELECT 'should-not-run' AS x;" });
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);

  const first = vscode.commands.executeCommand('moonageDaydream.runQuery');
  await sleep(1500);
  assert.equal(await firstLens(doc.uri), '$(debug-stop) Cancel', 'lens shows Cancel while running');
  assert.ok(resultHtml(m).includes('class="spin"') && resultHtml(m).includes('href="command:moonageDaydream.cancelQuery'), 'results show spinner + Cancel while running');
  say('PASS results spinner while running');
  const second = vscode.commands.executeCommand('moonageDaydream.runQuery'); // run ulang: run pertama harus dibatalkan
  let t = Date.now();
  await first;
  assert.ok(Date.now() - t < 5000, `re-run cancels the old run quickly (${Date.now() - t} ms)`);
  say(`PASS re-run cancelled previous run in ${Date.now() - t} ms`);

  await sleep(1000);
  const items = m.runningView.getChildren();
  assert.equal(items.length, 1, 'running view lists the query');
  const item = m.runningView.getTreeItem(items[0]);
  say(`running view: "${item.label}" ${item.description}`);
  t = Date.now();
  await vscode.commands.executeCommand('moonageDaydream.cancelRunning', items[0]); // tombol cancel di Running Queries
  const cancelling = m.runningView.getTreeItem(items[0]);
  assert.ok(String(cancelling.description).startsWith('Cancelling…') && cancelling.contextValue === 'cancelling', `cancelling state: ${cancelling.description}`);
  say(`cancelling shown: "${cancelling.description}"`);
  assert.ok(resultHtml(m).includes('Cancelling query') && !resultHtml(m).includes('href="command:'), 'results: Cancelling query, button disabled');
  await second;
  assert.equal(m.runningView.getChildren().length, 0, 'running view empty after cancel');
  const took = Date.now() - t;
  assert.ok(took < 5000, `cancel returns quickly (${took} ms)`);
  const html = resultHtml(m);
  assert.ok(html.includes('Query cancelled.') && !html.includes('should-not-run'), 'cancelled, next batch not run');
  assert.equal(m.running.size, 0, 'no running query left');
  assert.equal(await firstLens(doc.uri), '$(play) Execute', 'lens back to Execute');
  say(`PASS cancel in ${took} ms`);

  const { drivers } = require('../../db') as typeof import('../../db');
  const c = { ...m.conns.get(CONN)!, database: 'master' };
  const r = await drivers.mssql.run(c, await m.conns.password(CONN),
    "SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS can_see_all, COUNT(*) AS waitfor_left FROM sys.dm_exec_requests WHERE wait_type = 'WAITFOR' AND session_id <> @@SPID");
  const [canSeeAll, left] = r.resultSets[0].rows[0] as number[];
  say(`server check: VIEW SERVER STATE=${canSeeAll}, WAITFOR requests still running=${left}`);
  if (canSeeAll) assert.equal(left, 0, 'no WAITFOR left on server');
}

/** kasus user: SELECT * dari tabel besar lalu cancel (hanya SELECT). run: npm run test:real -- big */
async function bigCancelTest(m: typeof import('../../extension')) {
  const { drivers } = require('../../db') as typeof import('../../db');
  const c = { ...m.conns.get(CONN)!, database: L.bigDb };
  const pw = await m.conns.password(CONN);
  const meta = await drivers.mssql.run(c, pw,
    `SELECT SUM(p.rows) AS row_count FROM sys.partitions p WHERE p.object_id = OBJECT_ID('dbo.${L.bigTable}') AND p.index_id IN (0, 1)`);
  say(`${L.bigTable} rows (metadata)=${meta.resultSets[0].rows[0][0]}`);

  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `select * from ${L.bigTable};` });
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: L.bigDb });
  await vscode.window.showTextDocument(doc);
  const mb = () => Math.round(process.memoryUsage().rss / 1e6);
  const rss0 = mb();
  const t0 = Date.now();
  let maxLag = 0;
  let tick = Date.now();
  const lagTimer = setInterval(() => { // jeda event loop extension host = seberapa lama klik user (IPC) bisa antre
    maxLag = Math.max(maxLag, Date.now() - tick - 100);
    tick = Date.now();
  }, 100);
  const p = vscode.commands.executeCommand('moonageDaydream.runQuery');
  await sleep(10000);
  say(`after 10s: running=${m.running.size} rss=${mb()}MB (start ${rss0}MB) maxEventLoopLag=${maxLag}ms`);
  const t = Date.now();
  await vscode.commands.executeCommand('moonageDaydream.cancelQuery', doc.uri);
  const done = await Promise.race([p.then(() => true), sleep(60000).then(() => false)]);
  assert.ok(mb() - rss0 < 300, 'memory stays bounded while streaming');
  say(`cancel -> finished=${done} in ${Date.now() - t} ms (total ${Date.now() - t0} ms) rss=${mb()}MB running=${m.running.size}`);
  say(`result: ${resultHtml(m).match(/<div class="top">([^<]*)/)?.[1]} ${resultHtml(m).match(/class="err">([^<]*)/)?.[1] ?? ''}`);
  clearInterval(lagTimer);
  say(`maxEventLoopLag total=${maxLag}ms`);
  assert.ok(done, 'cancel finished within 60s');
  assert.ok(maxLag < 500, `extension host stays responsive while streaming (max lag ${maxLag} ms)`);
}

/** history mencatat status run sebelumnya; Run Again dari history; form koneksi + Test (SELECT @@SERVERNAME) */
async function historyAndFormTest(m: typeof import('../../extension'), since: number) {
  const mine = m.history.list().filter((e) => e.at >= since);
  const statuses = new Set(mine.map((e) => e.status));
  assert.ok(statuses.has('ok') && statuses.has('cancelled'), `history statuses: ${[...statuses]}`);
  say(`PASS history: ${mine.length} entries (${[...statuses].join(', ')}), newest "${m.history.getTreeItem(mine[0]).label}"`);

  const ok = mine.find((e) => e.status === 'ok' && e.sql.includes('DB_NAME()'))!;
  await vscode.commands.executeCommand('moonageDaydream.runHistory', ok);
  await sleep(1000);
  assert.equal(vscode.window.activeTextEditor?.document.getText(), ok.sql, 'history opened in editor');
  assert.ok(resultHtml(m).includes(`<td>${ok.db}</td>`), 'run again uses the same database');
  say(`PASS run again from history (${ok.conn} / ${ok.db})`);

  const { testConnection } = require('../../connectionForm') as typeof import('../../connectionForm');
  const c = m.conns.get(CONN)!;
  const r = await testConnection(c, await m.conns.password(CONN), { error: say } as unknown as vscode.LogOutputChannel);
  assert.ok(r.ok, r.message);
  await vscode.commands.executeCommand('moonageDaydream.editConnection', { kind: 'conn', c });
  await sleep(500);
  const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => x.label === `Edit: ${CONN}`);
  assert.ok(tab, 'edit connection form opened');
  await vscode.window.tabGroups.close(tab);
  say(`PASS connection form opened; Test -> ${r.message}`);
}

export async function run(only?: string): Promise<void> {
  if (only === 'big') {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(REPORT, '');
    const m = require('../../extension') as typeof import('../../extension');
    const hist0 = m.history.list();
    try {
      await bigCancelTest(m);
      say('DONE failed=0');
    } catch (e) {
      say(`FAIL big: ${e instanceof Error ? e.message : e}`);
      say('DONE failed=1');
    } finally {
      await (m.history as unknown as { state: vscode.Memento }).state.update('queryHistory', hist0);
    }
    return;
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(REPORT, '');
  const ext = vscode.extensions.getExtension('exeltarkus.moonage-daydream')!;
  await ext.activate();
  const m = require('../../extension') as typeof import('../../extension');
  const original = m.results.location;
  const hist0 = m.history.list();
  const since = Date.now();
  let failed = 0;
  try {
    const names = m.conns.list().map((c) => c.name);
    say(`connections: ${names.join(', ') || '(none)'}`);
    assert.ok(names.includes(CONN), `connection "${CONN}" not found`);
    await m.conns.setActive(CONN);

    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: QUERY });
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

    for (const loc of ['panel', 'right', 'left'] as Location[]) {
      try {
        await m.results.setLocation(loc);
        await vscode.commands.executeCommand('moonageDaydream.runQuery');
        await sleep(1500);
        const html = (loc === 'panel' ? m.results.view?.webview.html : m.results.panel?.webview.html) ?? '';
        assert.ok(!html.includes('class="err"'), `query error: ${html.match(/class="err">([^<]*)/)?.[1]}`);
        assert.ok(html.includes('Query 1') && html.includes('Query 2') && /2 queries done in/.test(html), 'two SELECTs rendered (parallel)');
        const col = resultTabColumn();
        const edCol = editor.viewColumn!;
        if (loc === 'panel') {
          assert.equal(col, undefined, 'no results tab in editor area');
          assert.ok(m.results.view?.visible, 'panel view visible');
        } else {
          assert.ok(col !== undefined && (loc === 'right' ? col > edCol : col < edCol), `results tab column ${col} vs editor ${edCol}`);
        }
        assert.equal(vscode.window.activeTextEditor?.document, doc, 'focus back on the sql editor');
        say(`PASS ${loc} (results column=${col ?? 'panel'}, editor column=${edCol})`);
      } catch (e) {
        failed++;
        say(`FAIL ${loc}: ${e instanceof Error ? e.message : e}`);
      }
    }

    try {
      await cancelTest(m);
    } catch (e) {
      failed++;
      say(`FAIL cancel: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await fileBindingTest(m);
    } catch (e) {
      failed++;
      say(`FAIL file binding: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await historyAndFormTest(m, since);
    } catch (e) {
      failed++;
      say(`FAIL history/form: ${e instanceof Error ? e.message : e}`);
    }

    try {
      await explorerTest(m);
    } catch (e) {
      failed++;
      say(`FAIL explorer: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await parallelTest(m);
    } catch (e) {
      failed++;
      say(`FAIL parallel: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await completionTest(m);
    } catch (e) {
      failed++;
      say(`FAIL completion: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await sqlFilesTest(m);
    } catch (e) {
      failed++;
      say(`FAIL sql files: ${e instanceof Error ? e.message : e}`);
    }
  } catch (e) {
    failed++;
    say(`FAIL setup: ${e instanceof Error ? e.stack : e}`);
  } finally {
    await m.results.setLocation(original);
    // kembalikan history user (tanpa entri dari test ini)
    await (m.history as unknown as { state: vscode.Memento }).state.update('queryHistory', hist0);
    say(`DONE failed=${failed}`);
  }
}

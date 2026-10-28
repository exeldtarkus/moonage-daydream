// Test "real" di Extension Development Host dengan profil VS Code user (koneksi & password yang sudah tersimpan).
// run: npm run test:real   (hanya SELECT; laporan di ~/.claude/bg-logs/moonage-real-test.log)
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
const FIXTURES = join(__dirname, '..', '..', '..', 'test-extention', 'local', 'real-test');

/** file .sql tetap di test-extention/local/real-test (dipakai ulang tiap run, isi ditulis ulang hanya bila berubah) supaya test tidak membuat tab Untitled baru */
async function fixture(name: string, content: string): Promise<vscode.TextDocument> {
  const file = join(FIXTURES, `${name}.sql`);
  mkdirSync(FIXTURES, { recursive: true });
  if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  // editan user yang belum disimpan tidak pernah dibuang: test berhenti dengan pesan jelas
  if (doc.isDirty) throw new Error(`${name}.sql punya perubahan yang belum disimpan di editor; simpan / tutup dulu`);
  if (doc.getText() !== content) {
    // file baru ditulis ulang tapi editor yang terbuka belum memuat isi barunya: muat ulang dari disk (aman, tidak dirty)
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  return doc;
}

const untitledTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
  .flatMap((t) => (t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'untitled' ? [t.input.uri] : []));
/** tab Untitled milik user sebelum test mulai: tidak pernah disentuh */
let userUntitled = new Set<string>();

/** tutup tab Untitled yang dibuka test (Select Top / Run Again) tanpa dialog Save; Untitled milik user dibiarkan */
async function closeUntitled(): Promise<void> {
  for (const uri of untitledTabs()) {
    if (userUntitled.has(uri.toString())) continue;
    await vscode.window.showTextDocument(uri, { preview: false });
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

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
    // tutup hanya tab file test ini (closeAllEditors memunculkan dialog Save untuk tab Untitled user)
    await vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.path.includes('/__moonage_test__/')));
    await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    await m.sqlFiles.setFlat(flat0);
    m.sqlFiles.refresh();
  }
}

/** tanpa blok: hanya statement di kursor; diblok: yang diblok (2 SELECT -> paralel) */
async function cursorTest(m: typeof import('../../extension')) {
  const sql = '-- 2 result set\nSELECT TOP 20\n    name\n    , type_desc\nFROM sys.objects;\n\nSELECT\n    COUNT(*) AS total_objects\nFROM sys.objects;\n';
  const doc = await fixture('cursor', sql);
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  const editor = await vscode.window.showTextDocument(doc);
  const at = (needle: string) => doc.positionAt(sql.indexOf(needle));
  const runAndWait = async () => {
    await vscode.commands.executeCommand('moonageDaydream.runQuery');
    return resultHtml(m);
  };
  editor.selection = new vscode.Selection(at('COUNT'), at('COUNT'));
  let html = await runAndWait();
  assert.ok(html.includes('total_objects') && !html.includes('type_desc') && !html.includes('Query 1'), 'cursor on 2nd: only 2nd runs');
  editor.selection = new vscode.Selection(at('name'), at('name'));
  html = await runAndWait();
  assert.ok(html.includes('type_desc') && !html.includes('total_objects'), 'cursor on 1st: only 1st runs');
  editor.selection = new vscode.Selection(at('SELECT TOP'), doc.positionAt(sql.length));
  html = await runAndWait();
  assert.ok(html.includes('Query 1') && html.includes('Query 2') && html.includes('total_objects') && html.includes('type_desc'), 'selection of both: parallel');
  say('PASS cursor: only statement under cursor runs; selecting both runs both in parallel');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

/** 2 SELECT paralel: yang cepat tampil duluan, yang lambat tetap loading lalu di-cancel sendiri (hanya SELECT) */
async function parallelTest(m: typeof import('../../extension')) {
  const doc = await fixture('parallel', `SELECT 1 AS fast;\nSELECT TOP 5000000 * FROM ${L.bigDb}.dbo.${L.bigTable};`);
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  const run = vscode.commands.executeCommand('moonageDaydream.runQuery', { all: true });
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

/** auto limit: SELECT * tabel besar tanpa TOP -> 100 baris, query dihentikan di server (hanya SELECT) */
async function autoLimitTest(m: typeof import('../../extension')) {
  const doc = await fixture('auto-limit', `SELECT  *\nFROM    dbo.${L.bigTable}\n`);
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: L.bigDb });
  await vscode.window.showTextDocument(doc);
  const t = Date.now();
  await vscode.commands.executeCommand('moonageDaydream.runQuery');
  const html = resultHtml(m);
  assert.ok(html.includes('100 row(s) · auto limit 100') && !html.includes('class="err"'), `auto limit: ${html.match(/<h3>[^\n]*/)?.[0] ?? html.match(/class="err">([^<]*)/)?.[1]}`);
  assert.equal((html.match(/<tr><td class="n">/g) ?? []).length, 100, '100 rows rendered');
  say(`PASS auto limit: SELECT * without TOP -> 100 rows in ${Date.now() - t} ms`);
}

/** linter: statement tanpa ; diberi error merah + Quick Fix "Add ;" (file dikembalikan sesudahnya) */
async function lintTest(m: typeof import('../../extension')) {
  const doc = await fixture('lint', 'SELECT 1;\nSELECT *\nFROM sys.objects\nWHERE name = \'x\'\n');
  await vscode.window.showTextDocument(doc);
  const diags = m.lint.get(doc.uri) ?? [];
  assert.equal(diags.length, 1, `one diagnostic: ${diags.length}`);
  assert.equal(diags[0].severity, vscode.DiagnosticSeverity.Error);
  assert.equal(doc.getText(diags[0].range), "'x'");
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, diags[0].range);
  const fix = actions.find((a) => a.title === 'Add ;');
  assert.ok(fix?.edit, 'quick fix Add ;');
  await vscode.workspace.applyEdit(fix.edit);
  assert.equal((m.lint.get(doc.uri) ?? []).length, 0, 'diagnostic gone after fix');
  assert.ok(doc.getText().includes("'x';"));
  await vscode.commands.executeCommand('workbench.action.files.revert');
  say(`PASS lint: missing ; -> red error on "'x'", Quick Fix "Add ;" clears it`);
}

/** Ctrl+Enter: keybinding user memanggil dbcode.editor.execute; tanpa DBCode command itu menjalankan query Moonage */
async function ctrlEnterTest(m: typeof import('../../extension')) {
  if (!m.ownRunner()) return say('SKIP ctrl+enter: DBCode ada di jendela ini, Ctrl+Enter milik DBCode');
  const doc = await fixture('ctrl-enter', 'SELECT 42 AS answer;\n');
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('dbcode.editor.execute');
  assert.ok(/<td class="num">42<\/td>/.test(resultHtml(m)), 'dbcode.editor.execute alias runs the Moonage query');
  say('PASS ctrl+enter: dbcode.editor.execute (no DBCode in this window) -> Moonage runQuery');
}

/** toolbar WHERE: statement asal dijalankan ulang di server dengan filter, filter kosong = query asal (hanya SELECT) */
async function whereTest(m: typeof import('../../extension')) {
  const doc = await fixture('where', 'SELECT name, database_id\nFROM sys.databases\nORDER BY name;\n');
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('moonageDaydream.runQuery');
  const rows = () => (resultHtml(m).match(/<tr><td class="n">/g) ?? []).length;
  const all = rows();
  assert.ok(resultHtml(m).includes('<form class="where">') && all > 1, `WHERE bar + ${all} rows`);
  assert.ok(resultHtml(m).includes('data-pane="cols"') && resultHtml(m).includes('data-pane="insp"') && resultHtml(m).includes('data-name="database_id"'), 'Columns / Inspector side panel');
  await m.applyWhere("name = 'master'");
  assert.equal(rows(), 1, 'filtered on the server');
  assert.ok(resultHtml(m).includes(`value="name = 'master'"`) && resultHtml(m).includes('<td>master</td>'), 'filter kept in the input');
  await m.applyWhere("name LIKE 'm%'"); // filter baru mengganti, bukan menumpuk
  assert.ok(rows() >= 2, `replaced filter: ${rows()} rows (master, model, msdb)`);
  await m.applyWhere('');
  assert.equal(rows(), all, 'empty filter runs the original query');
  say(`PASS WHERE toolbar: ${all} rows -> name = 'master' 1 row -> LIKE 'm%' ${'replaced'} -> clear ${all} rows`);
}

/** export: All Data di-stream dari server (lewat auto limit), WHERE aktif ikut, Current Selection, Excel (hanya SELECT) */
async function exportTest(m: typeof import('../../extension')) {
  const dir = join(FIXTURES, 'export');
  mkdirSync(dir, { recursive: true });
  const file = (n: string) => vscode.Uri.file(join(dir, n));
  try {
    const doc = await fixture('export', 'SELECT name, object_id, create_date\nFROM sys.all_objects;\n');
    await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('moonageDaydream.runQuery');
    assert.ok(resultHtml(m).includes('auto limit 100'), 'grid shows 100 rows (auto limit)');
    const { drivers } = require('../../db') as typeof import('../../db');
    const c = m.conns.get(CONN)!;
    const pw = await m.conns.password(CONN);
    const count = async (where = '') => Number((await drivers.mssql.run({ ...c, database: 'master' }, pw, `SELECT COUNT(*) FROM sys.all_objects ${where}`)).resultSets[0].rows[0][0]);
    const total = await count();

    const all = await m.exportResult({ type: 'export', set: 0, scope: 'all', format: 'json' }, file('all.json'));
    const json = JSON.parse(readFileSync(file('all.json').fsPath, 'utf8'));
    assert.ok(all === total && json.length === total && 'create_date' in json[0], `all data ${all} / ${json.length} = COUNT ${total}`);

    const sel = await m.exportResult({ type: 'export', set: 0, scope: 'sel', rows: [0, 2], cols: [0, 2], format: 'markdown' }, file('sel.md'));
    const md = readFileSync(file('sel.md').fsPath, 'utf8').trim().split('\n');
    assert.ok(sel === 2 && md.length === 4 && md[0] === '| name | create_date |', `selection markdown: ${md[0]}`);

    const xl = await m.exportResult({ type: 'export', set: 0, scope: 'all', format: 'xlsx' }, file('all.xlsx'));
    assert.ok(xl === total && readFileSync(file('all.xlsx').fsPath).readUInt32LE(0) === 0x04034b50 && !existsSync(file('all.xlsx').fsPath + '.sheet.tmp'), 'xlsx written');

    await m.applyWhere("name LIKE 'sys%'");
    const filtered = await m.exportResult({ type: 'export', set: 0, scope: 'all', format: 'csv' }, file('where.csv'));
    const want = await count("WHERE name LIKE 'sys%'");
    const lines = readFileSync(file('where.csv').fsPath, 'utf8').trim().split('\r\n').length - 1;
    assert.ok(filtered === want && lines === want, `WHERE kept: ${filtered} / ${lines} = ${want}`);
    say(`PASS export: all data ${all} rows (grid 100), selection 2 rows markdown, xlsx ${xl} rows, WHERE csv ${filtered} rows`);

    // copy ke clipboard (isi clipboard user dikembalikan sesudahnya)
    const clip0 = await vscode.env.clipboard.readText();
    try {
      await m.applyWhere('');
      const copied = await m.exportResult({ type: 'copy', set: 0, scope: 'sel', rows: [0, 1], cols: [0, 1], format: 'tsv', header: false }, 'clipboard');
      const tsv = (await vscode.env.clipboard.readText()).trimEnd().split('\r\n');
      assert.ok(copied === 2 && tsv.length === 2 && tsv[0].split('\t').length === 2, `Ctrl+C TSV: copied=${copied} ${JSON.stringify(tsv)} current=${Object.keys(m.results.current?.outcome ?? {})}`);
      const allCopied = await m.exportResult({ type: 'copy', set: 0, scope: 'all', format: 'json' }, 'clipboard');
      const clipJson = JSON.parse(await vscode.env.clipboard.readText());
      assert.ok(allCopied === total && clipJson.length === total, `copy all data JSON ${clipJson.length} = ${total}`);
      assert.equal(await m.exportResult({ type: 'copy', set: 0, scope: 'all', format: 'xlsx' }, 'clipboard'), undefined, 'xlsx cannot be copied');
      say(`PASS copy: selection TSV 2 rows (no header), all data JSON ${allCopied} rows to clipboard`);
    } finally {
      await vscode.env.clipboard.writeText(clip0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** CodeLens per statement + Explain (estimated, tidak dijalankan) / Analyze (actual, hanya SELECT, rollback) */
async function planTest(m: typeof import('../../extension')) {
  const sql = "SELECT name, type_desc\nFROM sys.objects\nWHERE name LIKE 'sys%';\n\nSELECT COUNT(*) AS n\nFROM sys.all_objects;\n";
  const doc = await fixture('plan', sql);
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
  const exec = lenses.filter((l) => l.command?.command === 'moonageDaydream.runStatement');
  assert.deepEqual(exec.map((l) => l.range.start.line), [0, 4], 'Execute lens above each statement');
  assert.equal(lenses.filter((l) => l.command?.command === 'moonageDaydream.analyze').length, 2, 'Analyze for SELECT statements');

  await vscode.commands.executeCommand(exec[1].command!.command, ...exec[1].command!.arguments!);
  let html = resultHtml(m);
  assert.ok(html.includes('>n<') || html.includes('</span>n<'), 'Execute lens ran only the 2nd statement');
  assert.ok(!html.includes('type_desc'), 'first statement not run');

  const explain = lenses.find((l) => l.command?.command === 'moonageDaydream.explain' && l.range.start.line === 0)!;
  await vscode.commands.executeCommand(explain.command!.command, ...explain.command!.arguments!);
  html = resultHtml(m);
  assert.ok(html.includes('Explain (estimated plan, not executed)') && html.includes('<table class="plan">') && !html.includes('Actual rows'), `estimated plan: ${html.match(/class="(?:top|err)">([^<]*)/g)?.join(' | ') ?? html.slice(0, 300)}`);
  const ops = (html.match(/<td class="op"/g) ?? []).length;

  const analyze = lenses.find((l) => l.command?.command === 'moonageDaydream.analyze' && l.range.start.line === 4)!;
  await vscode.commands.executeCommand(analyze.command!.command, ...analyze.command!.arguments!);
  html = resultHtml(m);
  assert.ok(html.includes('Analyze (actual plan, transaction rolled back)') && html.includes('Actual rows') && html.includes('Query returned 1 row(s)'), 'actual plan');

  // Analyze menjalankan query: selain SELECT ditolak sebelum ke server (tidak ada yang dijalankan)
  const dml = await fixture('plan-dml', 'UPDATE dbo.NoSuchTable SET a = 1 WHERE 1 = 0;\n');
  await m.conns.bind(dml.uri.toString(), { conn: CONN, db: 'master' });
  const before = resultHtml(m);
  await m.explainQuery('actual', dml.uri, 0, dml.getText().length);
  assert.equal(resultHtml(m), before, 'Analyze refused for UPDATE');
  say(`PASS plan: lenses on lines 0 and 4, Execute 2nd statement only, Explain ${ops} operator(s), Analyze actual rows, Analyze refused for UPDATE`);
}

/** Pin: snapshot hasil di tab sendiri, pin kedua di sebelahnya (side by side), tidak tertimpa run baru; export dari pin pakai snapshot */
async function pinTest(m: typeof import('../../extension')) {
  const doc = await fixture('pin', 'SELECT DB_NAME() AS db_name;\n');
  const run = async (db: string) => {
    await m.conns.bind(doc.uri.toString(), { conn: CONN, db });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('moonageDaydream.runQuery');
  };
  try {
    await run('master');
    await vscode.commands.executeCommand('moonageDaydream.pinResults');
    await run('msdb');
    await vscode.commands.executeCommand('moonageDaydream.pinResults');
    const [a, b] = m.results.pinned;
    assert.ok(a && b, `two pins (${m.results.pinned.length})`);
    assert.ok(a.panel.webview.html.includes('<td>master</td>') && b.panel.webview.html.includes('<td>msdb</td>'), 'each pin keeps its own result');
    assert.ok(!a.panel.webview.html.includes('<form class="where">') && !a.panel.webview.html.includes('class="pinbtn"'), 'pin: no WHERE bar / Pin button');
    await run('tempdb'); // run baru tidak menimpa pin
    assert.ok(a.panel.viewColumn && b.panel.viewColumn && a.panel.viewColumn !== b.panel.viewColumn, `side by side columns ${a.panel.viewColumn} / ${b.panel.viewColumn}`);
    assert.ok(a.panel.webview.html.includes('<td>master</td>') && resultHtml(m).includes('<td>tempdb</td>'), 'pins unchanged after a new run');
    const clip0 = await vscode.env.clipboard.readText();
    try {
      await m.exportResult({ type: 'copy', set: 0, scope: 'all', format: 'tsv', header: false }, 'clipboard', a.outcome);
      assert.equal((await vscode.env.clipboard.readText()).trim(), 'master', 'export from a pin uses the pin snapshot');
    } finally {
      await vscode.env.clipboard.writeText(clip0);
    }
    say(`PASS pin: master + msdb pinned side by side (columns ${a.panel.viewColumn}/${b.panel.viewColumn}), unchanged after tempdb run, copy from pin = master`);
  } finally {
    [...m.results.pinned].forEach((p) => p.panel.dispose());
  }
}

/** transaksi manual: BEGIN TRAN otomatis, Commit / Rollback, kembali ke auto-commit (hanya SELECT @@TRANCOUNT) */
async function txTest(m: typeof import('../../extension')) {
  const doc = await fixture('tx', 'SELECT @@TRANCOUNT AS tc;\n');
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  const key = doc.uri.toString();
  const tc = async () => {
    await vscode.commands.executeCommand('moonageDaydream.runQuery');
    return /<td class="num">(\d+)<\/td>/.exec(resultHtml(m))?.[1];
  };
  const titles = async () => (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri)).map((l) => l.command?.title ?? '');
  try {
    assert.ok((await titles()).includes('$(unlock) Auto-commit'), 'default auto-commit lens');
    assert.equal(await tc(), '0', 'auto-commit: no transaction');
    await vscode.commands.executeCommand('moonageDaydream.toggleTransactionMode', doc.uri, 'manual');
    assert.equal(await tc(), '1', 'manual: transaction open');
    await tc();
    const t = await titles();
    assert.ok(t.includes('$(lock) TX open (2)') && t.includes('$(check) Commit') && t.includes('$(discard) Rollback'), `tx lenses ${t}`);
    await vscode.commands.executeCommand('moonageDaydream.commitTransaction', doc.uri);
    assert.equal(m.txs.get(key)?.session.open, false, 'committed');
    assert.equal(await tc(), '1', 'next run opens a new transaction');
    await vscode.commands.executeCommand('moonageDaydream.rollbackTransaction', doc.uri);
    assert.equal(m.txs.get(key)?.session.open, false, 'rolled back');
    await vscode.commands.executeCommand('moonageDaydream.toggleTransactionMode', doc.uri, 'auto');
    assert.equal(await tc(), '0', 'back to auto-commit');
    assert.ok(!m.txs.has(key), 'session closed');
    say('PASS transaction: auto tc=0 -> manual tc=1, TX open (2) lenses, commit, new tx, rollback, auto tc=0');
  } finally {
    await vscode.commands.executeCommand('moonageDaydream.toggleTransactionMode', doc.uri, 'auto');
  }
}

/** Load more: auto limit 100 -> +1000 per klik sampai semua baris (ORDER BY: tanpa duplikat), tombol hilang saat habis */
async function moreTest(m: typeof import('../../extension')) {
  const doc = await fixture('more', 'SELECT name, object_id\nFROM sys.all_objects\nORDER BY object_id;\n');
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('moonageDaydream.runQuery');
  const rs = () => { const o = m.results.current!.outcome; return 'result' in o ? o.result.resultSets[0] : undefined; };
  assert.ok(rs()?.rows.length === 100 && resultHtml(m).includes('class="morebtn"'), 'auto limit 100 + Load more');
  const sizes: number[] = [];
  for (let i = 0; i < 5 && resultHtml(m).includes('class="morebtn"'); i++) {
    await m.loadMore({ type: 'more', set: 0 });
    sizes.push(rs()!.rows.length);
  }
  const ids = rs()!.rows.map((r) => r[1]);
  const { drivers } = require('../../db') as typeof import('../../db');
  const total = Number((await drivers.mssql.run({ ...m.conns.get(CONN)!, database: 'master' }, await m.conns.password(CONN), 'SELECT COUNT(*) FROM sys.all_objects')).resultSets[0].rows[0][0]);
  assert.equal(ids.length, total, `all rows loaded ${sizes.join(' -> ')} = ${total}`);
  assert.equal(new Set(ids).size, ids.length, 'no duplicates');
  assert.ok(!resultHtml(m).includes('class="morebtn"') && (resultHtml(m).match(/<tr><td class="n">/g) ?? []).length === total, 'button gone, all rows rendered');
  say(`PASS load more: 100 -> ${sizes.join(' -> ')} rows (= COUNT ${total}), no duplicates`);
}

/** edit grid -> script UPDATE (BEGIN TRAN, WHERE PK) di tab baru; script hanya diperiksa, TIDAK dijalankan */
async function editTest(m: typeof import('../../extension')) {
  const { drivers } = require('../../db') as typeof import('../../db');
  const c = { ...m.conns.get(CONN)!, database: L.db };
  const pw = await m.conns.password(CONN);
  const pick = (await drivers.mssql.run(c, pw, `SELECT TOP 1 s.name, t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1) ORDER BY t.name`)).resultSets[0].rows[0] as string[];
  assert.ok(pick, 'a table with a primary key');
  const [schema, table] = pick;
  const pk = await drivers.mssql.primaryKey(c, pw, L.db, { schema, name: table });
  const doc = await fixture('edit', `SELECT TOP 5 * FROM [${schema}].[${table}];\n`);
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: L.db });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('moonageDaydream.runQuery');
  const o = m.results.current!.outcome;
  const rs = 'result' in o ? o.result.resultSets[0] : undefined;
  assert.ok(rs && rs.rows.length && resultHtml(m).includes('data-edit="1"'), 'editable grid');
  const col = rs.columns.findIndex((x) => !pk.some((k) => k.toLowerCase() === x.toLowerCase()));
  const script = await m.editScript({ type: 'edits', set: 0, edits: [{ row: 0, col, value: 'moonage-edit-test' }] });
  const text = script?.getText() ?? '';
  try {
    assert.ok(text.includes('BEGIN TRAN;') && text.includes(`UPDATE [${L.db}].[${schema}].[${table}]`) && text.includes(`[${rs.columns[col]}] = `)
      && pk.every((k) => text.includes(`[${k}]`)) && !/^COMMIT/m.test(text), `script: ${text.slice(0, 300)}`);
    assert.equal(m.conns.binding(script!.uri.toString())?.db, L.db, 'script tab bound to the same database');
  } finally {
    if (script) await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); // tidak disimpan / dijalankan
  }
  // tanpa satu tabel (JOIN) -> ditolak, tidak ada tab baru
  const join = await fixture('edit-join', 'SELECT TOP 2 o.name, s.name AS s FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id;\n');
  await m.conns.bind(join.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(join);
  await vscode.commands.executeCommand('moonageDaydream.runQuery');
  assert.equal(await m.editScript({ type: 'edits', set: 0, edits: [{ row: 0, col: 0, value: 'x' }] }), undefined, 'JOIN refused');
  say(`PASS edit grid: UPDATE script for ${schema}.${table} (PK ${pk.join(', ')}) generated, not executed; JOIN refused`);
}

/** Format Document: keyword huruf besar + koma di depan (tanpa koneksi DB) */
async function formatTest(m: typeof import('../../extension')) {
  const doc = await fixture('format', "select name, object_id from sys.objects where name like 'a,%'\n");
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 4, insertSpaces: true });
  // VS Code mengembalikan edit minimal (beberapa potongan): terapkan semua di memori, dari belakang ke depan
  let out = doc.getText();
  for (const e of [...(edits ?? [])].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))) {
    out = out.slice(0, doc.offsetAt(e.range.start)) + e.newText + out.slice(doc.offsetAt(e.range.end));
  }
  assert.equal(out.replace(/\r\n/g, '\n'), "SELECT\n    name\n    , object_id\nFROM\n    sys.objects\nWHERE\n    name LIKE 'a,%'\n", `formatted: ${JSON.stringify(out)}`);
  say('PASS format document (uppercase keywords, leading commas)');

  // command Ctrl+Alt+F (tidak tergantung default formatter di settings user); isi file dikembalikan sesudahnya
  const editor = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('moonageDaydream.formatSql');
  assert.equal(doc.getText().replace(/\r\n/g, '\n'), out.replace(/\r\n/g, '\n'), 'Ctrl+Alt+F formats the document');
  await vscode.commands.executeCommand('workbench.action.files.revert');
  assert.ok(!editor.document.isDirty);
  say('PASS format command Ctrl+Alt+F');
  const fmtId = vscode.workspace.getConfiguration('editor', { languageId: 'sql' }).get<string>('defaultFormatter');
  const expectOwn = !fmtId || fmtId === 'exeltarkus.moonage-daydream' || !vscode.extensions.getExtension(fmtId);
  assert.equal(m.ownFormatter, expectOwn, `Shift+Alt+F owner (defaultFormatter=${fmtId})`);
  say(`PASS Shift+Alt+F -> ${m.ownFormatter ? 'Moonage' : fmtId} (defaultFormatter=${fmtId ?? '-'})`);
}

/** autocomplete: database, schema, tabel lintas database (hanya baca metadata) */
async function completionTest(m: typeof import('../../extension')) {
  const prefix = L.table.slice(0, 2);
  const lines = ['SELECT * FROM ', `SELECT * FROM ${L.db}.`, `SELECT * FROM ${L.db}.dbo.${prefix}`, `SELECT * FROM ${L.db}..${prefix}`];
  const doc = await fixture('completion-tables', lines.join('\n'));
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

  // kolom: WHERE tanpa alias (database file = L.db, tabel tanpa schema) dan `alias.` lintas database
  const { drivers } = require('../../db') as typeof import('../../db');
  const c = { ...m.conns.get(CONN)!, database: L.db };
  const cols = (await drivers.mssql.columns(c, await m.conns.password(CONN), L.db, { schema: 'dbo', name: L.table })).map((x) => x.name);
  const colDoc = await fixture('completion-columns', `SELECT  *\nFROM    ${L.table}\nwhere ;\nSELECT * FROM ${L.db}..${L.table} t WHERE t.`);
  await m.conns.bind(colDoc.uri.toString(), { conn: CONN, db: L.db });
  const at = async (line: number, ch: number) => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', colDoc.uri, new vscode.Position(line, ch));
    return list.items.filter((i) => i.kind === vscode.CompletionItemKind.Field).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  };
  const afterWhere = await at(2, 6);
  assert.ok(cols.length && cols.every((x) => afterWhere.includes(x)), `columns after WHERE: ${afterWhere.length}/${cols.length}`);
  const afterAlias = await at(3, colDoc.lineAt(3).text.length);
  assert.ok(cols.every((x) => afterAlias.includes(x)), `columns after alias: ${afterAlias.length}/${cols.length}`);
  // nama sama persis tapi beda huruf besar / kecil (ketik huruf kecil dan huruf besar): item itu dipilih dan paling atas
  for (const typed of [L.bigTable.toLowerCase(), L.bigTable.toUpperCase()]) {
    const exactDoc = await fixture(`completion-exact-${typed === typed.toLowerCase() ? 'lower' : 'upper'}`, `SELECT * FROM ${L.bigDb}.dbo.${typed}`);
    await m.conns.bind(exactDoc.uri.toString(), { conn: CONN, db: L.bigDb });
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', exactDoc.uri, new vscode.Position(0, exactDoc.lineAt(0).text.length));
    const top = [...list.items].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))[0];
    const topLabel = typeof top.label === 'string' ? top.label : top.label.label;
    assert.ok(top.preselect && topLabel.toLowerCase() === typed.toLowerCase(), `exact match first for "${typed}": ${topLabel}`);
    const fold = (t: string) => (typed === typed.toUpperCase() ? t.toUpperCase() : t.toLowerCase());
    assert.ok(list.items.every((i) => i.filterText === fold(i.filterText!)), `filterText follows typed case "${typed}"`);
    say(`PASS completion exact match: typed "${typed}" -> "${topLabel}" preselected first of ${list.items.length}`);
  }
  // keyword / fungsi SQL + kolom dari FROM a, b (koma)
  const kw = (await labels(0));
  assert.ok(kw.includes('WHERE') && kw.includes('LEFT JOIN') && kw.includes('ISNULL'), 'keywords and functions');
  const commaDoc = await fixture('completion-comma', `SELECT * FROM ${L.table} a, sys.objects o WHERE o.\nSELECT * FROM ${L.table} a, sys.objects o WHERE a.`);
  await m.conns.bind(commaDoc.uri.toString(), { conn: CONN, db: L.db });
  const fields = async (line: number) => (await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', commaDoc.uri, new vscode.Position(line, commaDoc.lineAt(line).text.length)))
    .items.filter((i) => i.kind === vscode.CompletionItemKind.Field).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  const oCols = await fields(0);
  const aCols = await fields(1);
  assert.ok(oCols.includes('object_id') && !oCols.includes(cols[0]), `o. -> sys.objects columns (${oCols.length})`);
  assert.ok(cols.every((x) => aCols.includes(x)), `a. -> first table columns (${aCols.length})`);
  say(`PASS completion keywords (WHERE, LEFT JOIN, ISNULL) + FROM a, b: o. -> ${oCols.length} cols, a. -> ${aCols.length} cols`);
  say(`PASS completion columns: WHERE -> ${afterWhere.length} column(s), alias t. -> ${afterAlias.length} column(s)`);
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
    await vscode.commands.executeCommand('moonageDaydream.newQueryForDb', { kind: 'db', c: t.c, db: t.db });
    const nq = vscode.window.activeTextEditor!.document;
    assert.ok(nq.isUntitled && nq.languageId === 'sql' && !nq.getText(), 'new empty sql tab');
    assert.equal(await firstLens(nq.uri), '$(play) Execute');
    const nqLens = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', nq.uri)).map((l) => l.command?.title);
    assert.ok(nqLens.includes(`$(database) ${t.db}`) && nqLens.includes(`$(server) ${t.c.name}`), `new sql lens ${nqLens}`);
    say(`PASS new sql file from database ${t.db} (codelens: ${nqLens.join(' | ')})`);
    await closeUntitled(); // Select Top membuka tab Untitled baru (fitur), ditutup tanpa dialog Save
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
    const doc = await fixture(`file-binding-${db}`, 'SELECT DB_NAME() AS current_db;');
    await m.conns.bind(doc.uri.toString(), { conn: CONN, db });
    await vscode.window.showTextDocument(doc);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
    const titles = lenses.filter((l) => l.command?.command.startsWith('moonageDaydream.')).map((l) => l.command!.title);
    assert.deepEqual(titles, ['$(play) Execute', '$(list-tree) Explain', '$(pulse) Analyze', `$(server) ${CONN}`, `$(database) ${db}`, '$(unlock) Auto-commit'], `codelens ${JSON.stringify(titles)}`);
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
  const doc = await fixture('cancel-waitfor', "WAITFOR DELAY '00:00:20';\nSELECT 'should-not-run' AS x;");
  await m.conns.bind(doc.uri.toString(), { conn: CONN, db: 'master' });
  await vscode.window.showTextDocument(doc);

  const first = vscode.commands.executeCommand('moonageDaydream.runQuery', { all: true });
  await sleep(1500);
  assert.equal(await firstLens(doc.uri), '$(debug-stop) Cancel', 'lens shows Cancel while running');
  assert.ok(resultHtml(m).includes('class="spin"') && resultHtml(m).includes('href="command:moonageDaydream.cancelQuery'), 'results show spinner + Cancel while running');
  say('PASS results spinner while running');
  const second = vscode.commands.executeCommand('moonageDaydream.runQuery', { all: true }); // run ulang: run pertama harus dibatalkan
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

  const doc = await fixture('big-cancel', `select top 5000000 * from ${L.bigTable};`);
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
  await closeUntitled(); // Run Again membuka SQL history di tab Untitled baru (fitur)

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
  userUntitled = new Set(untitledTabs().map((u) => u.toString()));
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

    const doc = await fixture('locations', QUERY);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

    for (const loc of ['panel', 'right', 'left'] as Location[]) {
      try {
        await m.results.setLocation(loc);
        await vscode.commands.executeCommand('moonageDaydream.runQuery', { all: true });
        await sleep(1500);
        const html = (loc === 'panel' ? m.results.view?.webview.html : m.results.panel?.webview.html) ?? '';
        assert.ok(!html.includes('class="err"'), `query error: ${html.match(/class="err">([^<]*)/)?.[1]}`);
        assert.ok(html.includes('Query 1') && html.includes('Query 2') && /2 queries done in/.test(html), 'two SELECTs rendered (parallel)');
        assert.ok(html.includes('<span class="ty">dt</span>create_date') && html.includes('<span class="ty">abc</span>name'), 'column type icons from SQL Server');
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
      await autoLimitTest(m);
    } catch (e) {
      failed++;
      say(`FAIL auto limit: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await editTest(m);
    } catch (e) {
      failed++;
      say(`FAIL edit: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await moreTest(m);
    } catch (e) {
      failed++;
      say(`FAIL load more: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await txTest(m);
    } catch (e) {
      failed++;
      say(`FAIL transaction: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await pinTest(m);
    } catch (e) {
      failed++;
      say(`FAIL pin: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await planTest(m);
    } catch (e) {
      failed++;
      say(`FAIL plan: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await exportTest(m);
    } catch (e) {
      failed++;
      say(`FAIL export: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await whereTest(m);
    } catch (e) {
      failed++;
      say(`FAIL where: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await ctrlEnterTest(m);
    } catch (e) {
      failed++;
      say(`FAIL ctrl+enter: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await lintTest(m);
    } catch (e) {
      failed++;
      say(`FAIL lint: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await formatTest(m);
    } catch (e) {
      failed++;
      say(`FAIL format: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await cursorTest(m);
    } catch (e) {
      failed++;
      say(`FAIL cursor: ${e instanceof Error ? e.message : e}`);
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

import * as vscode from 'vscode';
import { Connections } from './connections';
import { Explorer, Node } from './explorer';
import { History, HistoryEntry, RunningQuery, RunningView } from './activity';
import { openConnectionForm } from './connectionForm';
import { ConnectionInfo, PAGE_ROWS, Session, address, drivers, schemaOf } from './db';
import { Results, LOCATIONS, ResultMessage, VIEW_ID } from './results';
import { CLIPBOARD_MAX_ROWS, ExportFormat, FORMATS, memorySink, openSink, Sink } from './exporter';
import { SqlFiles, SqlNode, newSqlFile } from './sqlFiles';
import { SqlCompletion } from './completion';
import { driverLog } from './log';
import { formatSql } from './sqlFormat';
import type { Outcome, Source } from './resultsHtml';
import { splitBatches } from './mssql';
import { addWhere, updateScript, tableRefs, autoLimitable, missingSemicolons, parallelSafe, singleSelect, splitStatements, statementAt, statementSegments } from './sqlContext';
import { parsePlan } from './plan';

let log: vscode.LogOutputChannel;
export let conns: Connections;
let status: vscode.StatusBarItem;
export let results: Results;
export let explorer: Explorer;
const lensChanged = new vscode.EventEmitter<void>();
/** query yang sedang berjalan per file (uri) */
export const running = new Map<string, RunningQuery>();
export let runningView: RunningView;
export let history: History;
export let sqlFiles: SqlFiles;
export let completion: SqlCompletion;
/** Shift+Alt+F memakai formatter Moonage (default formatter [sql] kosong / Moonage / extension-nya tidak ada di jendela ini) */
export let ownFormatter = false;
export const lint = vscode.languages.createDiagnosticCollection('moonageDaydream');
const LINT_SOURCE = 'Moonage';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

export function activate(ctx: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Moonage Daydream', { log: true });
  driverLog.error = (m) => log.error(m);
  conns = new Connections(ctx);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'moonageDaydream.selectConnection';
  explorer = new Explorer(conns, log);
  updateFormatterContext(ctx);
  vscode.workspace.textDocuments.forEach(lintDoc);
  updateDbcodeAlias();
  sqlFiles = new SqlFiles(ctx.globalState, conns, log);
  completion = new SqlCompletion(conns, fileConn, log);
  updateStatus();
  status.show();
  results = new Results(ctx);
  results.onMessage = (m, o) => (m.type === 'where' ? applyWhere(m.where ?? '', m.part)
    : m.type === 'export' ? exportResult(m, undefined, o)
    : m.type === 'copy' ? exportResult(m, 'clipboard', o)
    : m.type === 'planXml' ? openPlanXml(o)
    : m.type === 'pin' ? results.pin()
    : m.type === 'more' ? loadMore(m)
    : m.type === 'edits' ? editScript(m) : undefined);
  runningView = new RunningView(running);
  history = new History(ctx.globalState);

  if (ctx.extensionMode === vscode.ExtensionMode.Development) {
    // npm run test:real membuka URI ini: test real di jendela dev (profil user, koneksi tersimpan); extensionTestsPath tidak bisa saat VS Code lain terbuka
    ctx.subscriptions.push(vscode.window.registerUriHandler({
      handleUri: (u) => {
        if (u.path === '/real-test') return require('./test/real').run(u.query || undefined);
        // npm run dev: jendela dev yang sudah terbuka hanya di-reload VS Code (workspace lama tetap), pindahkan ke folder yang diminta
        const folder = u.path === '/open-folder' && new URLSearchParams(u.query).get('folder');
        if (folder && vscode.workspace.workspaceFolders?.[0]?.uri.path !== folder) {
          return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceReuseWindow: true });
        }
      },
    }));
  }
  ctx.subscriptions.push(
    log,
    status,
    runningView,
    vscode.window.registerTreeDataProvider('moonageDaydream.running', runningView),
    vscode.window.registerTreeDataProvider('moonageDaydream.history', history),
    vscode.window.registerTreeDataProvider('moonageDaydream.sqlFiles', sqlFiles),
    vscode.commands.registerCommand('moonageDaydream.sqlFilesFlat', () => sqlFiles.setFlat(true)),
    vscode.commands.registerCommand('moonageDaydream.sqlFilesTree', () => sqlFiles.setFlat(false)),
    vscode.commands.registerCommand('moonageDaydream.refreshSqlFiles', () => sqlFiles.refresh()),
    vscode.commands.registerCommand('moonageDaydream.newSqlFile', async (n?: SqlNode, name?: string) => {
      try {
        return await newSqlFile(sqlFiles, n, name);
      } catch (e) {
        log.error(`newSqlFile - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        vscode.window.showErrorMessage(`New SQL file failed: ${errMsg(e)}`);
      }
    }),
    sqlWatcher(),
    vscode.commands.registerCommand('moonageDaydream.cancelRunning', (q?: RunningQuery) => q && cancel(q)),
    vscode.commands.registerCommand('moonageDaydream.cancelAllQueries', () => running.forEach(cancel)),
    vscode.commands.registerCommand('moonageDaydream.openHistory', (e?: HistoryEntry) => e && openHistory(e)),
    vscode.commands.registerCommand('moonageDaydream.runHistory', async (e?: HistoryEntry) => {
      if (e && (await openHistory(e))) await runQuery({ all: true });
    }),
    vscode.commands.registerCommand('moonageDaydream.copyHistory', (e?: HistoryEntry) => e && vscode.env.clipboard.writeText(e.sql)),
    vscode.commands.registerCommand('moonageDaydream.removeHistory', (e?: HistoryEntry) => e && history.remove(e)),
    vscode.commands.registerCommand('moonageDaydream.clearHistory', async () => {
      const ok = await vscode.window.showWarningMessage('Clear all query history?', { modal: true }, 'Clear');
      if (ok) await history.clear();
    }),
    vscode.commands.registerCommand('moonageDaydream.addConnection', () => editConnection()),
    vscode.commands.registerCommand('moonageDaydream.editConnection', async (n?: Node) => {
      const c = connOf(n) ?? (await pickConnection('Edit connection'));
      if (c) await editConnection(c);
    }),
    vscode.commands.registerCommand('moonageDaydream.removeConnection', async (n?: Node) => {
      const c = connOf(n) ?? (await pickConnection('Remove connection'));
      if (!c) return;
      const ok = await vscode.window.showWarningMessage(`Remove connection "${c.name}"?`, { modal: true }, 'Remove');
      if (ok !== 'Remove') return;
      await closePool(c);
      await conns.remove(c.name);
      updateStatus();
    }),
    vscode.commands.registerCommand('moonageDaydream.selectConnection', async (n?: Node) => {
      const c = connOf(n) ?? (await pickConnection('Select active connection'));
      if (c) {
        await conns.setActive(c.name);
        updateStatus();
      }
    }),
    vscode.commands.registerCommand('moonageDaydream.runQuery', runQuery),
    vscode.commands.registerCommand('moonageDaydream.runStatement', runStatement),
    vscode.commands.registerCommand('moonageDaydream.pinResults', () => results.pin()),
    vscode.commands.registerCommand('moonageDaydream.toggleTransactionMode', (u?: vscode.Uri | string, mode?: 'auto' | 'manual') => setTransactionMode(u, mode)),
    vscode.commands.registerCommand('moonageDaydream.commitTransaction', (u?: vscode.Uri | string) => endTransaction('commit', u)),
    vscode.commands.registerCommand('moonageDaydream.rollbackTransaction', (u?: vscode.Uri | string) => endTransaction('rollback', u)),
    vscode.workspace.onDidCloseTextDocument(onCloseTx),
    vscode.commands.registerCommand('moonageDaydream.explain', (u?: vscode.Uri | string, a?: number, b?: number) => explainQuery('estimated', u, a, b)),
    vscode.commands.registerCommand('moonageDaydream.analyze', (u?: vscode.Uri | string, a?: number, b?: number) => explainQuery('actual', u, a, b)),
    vscode.commands.registerCommand('moonageDaydream.cancelQuery', cancelQuery),
    vscode.commands.registerCommand('moonageDaydream.setFileConnection', setFileConnection),
    vscode.commands.registerCommand('moonageDaydream.setFileDatabase', setFileDatabase),
    // Ctrl+Alt+F: format langsung tanpa lewat default formatter (settings user bisa menunjuk formatter lain, mis. DBCode)
    vscode.commands.registerTextEditorCommand('moonageDaydream.formatSql', (editor, builder) => {
      const doc = editor.document;
      const range = editor.selection.isEmpty ? new vscode.Range(0, 0, doc.lineCount, 0) : editor.selection;
      const edits = formatEdits(doc, range, { tabSize: Number(editor.options.tabSize) || 4, insertSpaces: editor.options.insertSpaces !== false });
      edits.forEach((e) => builder.replace(e.range, e.newText)); // builder hanya valid selama callback (sinkron)
    }),
    lint,
    vscode.workspace.onDidOpenTextDocument(lintDoc),
    vscode.workspace.onDidChangeTextDocument((e) => lintDoc(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => lint.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('moonageDaydream.lint') && vscode.workspace.textDocuments.forEach(lintDoc)),
    vscode.languages.registerCodeActionsProvider({ language: 'sql' }, { provideCodeActions: semicolonFixes }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('editor.defaultFormatter') && updateFormatterContext(ctx)),
    vscode.extensions.onDidChange(() => {
      updateFormatterContext(ctx);
      updateDbcodeAlias();
    }),
    { dispose: () => dbcodeAlias?.dispose() },
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, {
      provideDocumentFormattingEdits: (doc, o) => formatEdits(doc, new vscode.Range(0, 0, doc.lineCount, 0), o),
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql' }, {
      provideDocumentRangeFormattingEdits: (doc, range, o) => formatEdits(doc, range, o),
    }),
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completion, '.', '"', "'", '$'),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, { onDidChangeCodeLenses: lensChanged.event, provideCodeLenses }),
    vscode.window.onDidChangeActiveTextEditor(updateFileStatus),
    vscode.window.registerWebviewViewProvider(VIEW_ID, results),
    vscode.window.registerTreeDataProvider('moonageDaydream.explorer', explorer),
    vscode.commands.registerCommand('moonageDaydream.refreshExplorer', (n?: Node) => {
      completion.clear(); // tabel baru juga muncul di autocomplete
      explorer.refresh(n);
    }),
    vscode.commands.registerCommand('moonageDaydream.newQueryForDb', async (n?: Node) => {
      if (n?.kind !== 'db') return;
      // tab SQL baru yang langsung terikat ke koneksi + database ini (CodeLens: conn | db)
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
      await conns.bind(doc.uri.toString(), { conn: n.c.name, db: n.db });
      await vscode.window.showTextDocument(doc);
      updateFileStatus();
    }),
    vscode.commands.registerCommand('moonageDaydream.selectTop', async (n?: Node) => {
      if (n?.kind !== 'obj') return;
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: drivers[n.c.type].selectTop(n.db, n.obj, 100) });
      await conns.bind(doc.uri.toString(), { conn: n.c.name, db: n.db });
      await vscode.window.showTextDocument(doc);
      await runQuery();
    }),
    vscode.commands.registerCommand('moonageDaydream.moveResults', async () => {
      const picked = await vscode.window.showQuickPick(
        LOCATIONS.map((l) => ({ ...l, description: l.id === results.location ? '(current)' : '' })),
        { title: 'Show query results in' },
      );
      if (picked) await results.setLocation(picked.id);
    }),
  );
}

export async function deactivate() {
  for (const q of running.values()) q.ac.abort();
  // transaksi manual yang masih terbuka tidak pernah di-commit diam-diam: rollback
  for (const [key, tx] of txs) await closeTx(key, tx, 'rollback');
  for (const c of conns?.list() ?? []) await closePool(c);
}

/** .sql dibuat / dihapus / di-rename (termasuk dari luar VS Code): scan ulang SQL Files */
function sqlWatcher(): vscode.Disposable {
  const w = vscode.workspace.createFileSystemWatcher('**/*.sql', false, true, false);
  const refresh = () => sqlFiles.refresh();
  return vscode.Disposable.from(w, w.onDidCreate(refresh), w.onDidDelete(refresh), vscode.workspace.onDidChangeWorkspaceFolders(refresh));
}

/** linter: statement tanpa `;` (sebelum GO / akhir file) diberi tanda di token terakhirnya; severity dari setting lint.semicolon */
function lintDoc(doc: vscode.TextDocument) {
  if (doc.languageId !== 'sql') return;
  const level = vscode.workspace.getConfiguration('moonageDaydream.lint', doc).get<string>('semicolon', 'error');
  if (level === 'off') return lint.delete(doc.uri);
  const severity = level === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
  lint.set(doc.uri, missingSemicolons(doc.getText()).map((r) => Object.assign(
    new vscode.Diagnostic(new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), 'Statement is not terminated with ;', severity),
    { source: LINT_SOURCE, code: 'missing-semicolon' },
  )));
}

/** Quick Fix "Add ;" untuk diagnostic missing-semicolon */
function semicolonFixes(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
  return ctx.diagnostics.filter((d) => d.source === LINT_SOURCE && d.code === 'missing-semicolon').map((d) => {
    const fix = new vscode.CodeAction('Add ;', vscode.CodeActionKind.QuickFix);
    fix.edit = new vscode.WorkspaceEdit();
    fix.edit.insert(doc.uri, d.range.end, ';');
    fix.diagnostics = [d];
    fix.isPreferred = true;
    return fix;
  });
}

const DBCODE = 'dbcode.dbcode';
let dbcodeAlias: vscode.Disposable | undefined;

/**
 * Ctrl+Enter user (keybindings.json -> dbcode.editor.execute) menang atas keybinding extension.
 * Jendela tanpa DBCode: daftarkan command dengan id itu yang menjalankan query Moonage; ada DBCode: lepas, DBCode yang jalan.
 */
function updateDbcodeAlias() {
  const own = ownRunner();
  void vscode.commands.executeCommand('setContext', 'moonageDaydream.ownRunner', own);
  if (!own) {
    dbcodeAlias?.dispose();
    dbcodeAlias = undefined;
  } else if (!dbcodeAlias) {
    try {
      dbcodeAlias = vscode.commands.registerCommand('dbcode.editor.execute', () => runQuery());
    } catch (e) {
      log.error(`updateDbcodeAlias - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    }
  }
  log.info(`Ctrl+Enter for sql: ${own ? 'Moonage' : 'DBCode'}`);
}

/** Ctrl+Enter dipakai Moonage bila DBCode tidak ada di jendela ini */
export const ownRunner = () => !vscode.extensions.getExtension(DBCODE);

/**
 * Shift+Alt+F: formatter default [sql] di settings user (mis. DBCode) dipakai bila extension-nya ada di jendela ini;
 * kalau tidak ada (mis. jendela dev tanpa DBCode), kosong, atau Moonage: keybinding Moonage yang aktif.
 */
function updateFormatterContext(ctx: vscode.ExtensionContext) {
  const id = vscode.workspace.getConfiguration('editor', { languageId: 'sql' }).get<string>('defaultFormatter');
  ownFormatter = !id || id.toLowerCase() === ctx.extension.id.toLowerCase() || !vscode.extensions.getExtension(id);
  void vscode.commands.executeCommand('setContext', 'moonageDaydream.ownFormatter', ownFormatter);
  log.info(`formatter for sql: ${ownFormatter ? 'Moonage' : id}`);
}

/** Format Document / Selection (Shift+Alt+F): T-SQL, keyword + posisi koma dari setting moonageDaydream.format.* */
function formatEdits(doc: vscode.TextDocument, range: vscode.Range, o: vscode.FormattingOptions): vscode.TextEdit[] {
  const cfg = vscode.workspace.getConfiguration('moonageDaydream.format', doc);
  const r = doc.validateRange(range);
  const text = doc.getText(r);
  if (!text.trim()) return [];
  try {
    const c = fileConn(doc.uri);
    const language = c ? drivers[c.type].formatter : 'transactsql';
    if (!language) {
      vscode.window.showInformationMessage(`Formatting is not available for ${drivers[c!.type].label}`);
      return [];
    }
    const out = formatSql(text, {
      language,
      keywordCase: cfg.get('keywordCase', 'upper'), leadingComma: cfg.get('leadingComma', true), semicolonNewline: cfg.get('semicolonNewline', true), tabWidth: o.tabSize, useTabs: !o.insertSpaces,
    });
    // seluruh dokumen: akhiri dengan satu newline; selection: pertahankan newline akhir bila ada
    const tail = r.end.line === doc.lineCount - 1 || /\r?\n$/.test(text) ? doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' : '';
    const eolOut = doc.eol === vscode.EndOfLine.CRLF ? out.replace(/\n/g, '\r\n') : out;
    return [vscode.TextEdit.replace(r, eolOut + tail)];
  } catch (e) {
    log.error(`formatEdits - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showWarningMessage(`SQL format failed: ${errMsg(e)}`);
    return [];
  }
}

const connOf = (n?: Node) => (n?.kind === 'conn' ? n.c : undefined);

/** dipanggil setiap daftar / koneksi aktif berubah */
function updateStatus() {
  explorer.refresh();
  updateFileStatus();
}

const sqlUri = () => {
  const d = vscode.window.activeTextEditor?.document;
  return d?.languageId === 'sql' ? d.uri : undefined;
};

/** koneksi untuk file: binding file, kalau belum ada pakai koneksi aktif; database binding menimpa default koneksi */
function fileConn(uri: vscode.Uri | undefined): ConnectionInfo | undefined {
  const b = uri && conns.binding(uri.toString());
  const c = conns.get(b?.conn ?? conns.active);
  return c && b?.db ? { ...c, database: b.db } : c;
}

/** status bar + CodeLens mengikuti file .sql yang sedang aktif */
function updateFileStatus() {
  lensChanged.fire();
  sqlFiles?.redraw(); // deskripsi koneksi / database per file di SQL Files
  const uri = sqlUri();
  const c = fileConn(uri);
  const tx = uri && txs.get(uri.toString());
  status.text = `$(database) ${c ? `${c.name}${c.database ? ` / ${c.database}` : ''}` : 'No connection'}${tx?.session.open ? ` · $(lock) TX open (${tx.statements})` : ''}`;
  status.backgroundColor = tx?.session.open ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  status.tooltip = c ? `${drivers[c.type].label} ${c.user}@${address(c)}/${c.database} (click to switch)` : 'Select a connection';
  status.command = uri ? 'moonageDaydream.setFileConnection' : 'moonageDaydream.selectConnection';
}

/** CodeLens: di atas tiap statement Execute | Explain | Analyze (Analyze hanya SELECT); statement pertama juga koneksi | database */
function provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const c = fileConn(doc.uri);
  const q = running.get(doc.uri.toString());
  // shortcut: file sangat besar (> 20000 baris) hanya dapat CodeLens di baris pertama
  const segs = doc.lineCount <= 20000 ? statementSegments(doc.getText()) : [];
  const at = (offset: number) => {
    const line = doc.positionAt(offset).line;
    return new vscode.Range(line, 0, line, 0);
  };
  const first = segs.length ? at(segs[0].start) : new vscode.Range(0, 0, 0, 0);
  const lenses: vscode.CodeLens[] = [];
  if (q) {
    lenses.push(new vscode.CodeLens(first, q.cancelling
      ? { title: '$(loading~spin) Cancelling…', command: 'moonageDaydream.cancelQuery', arguments: [doc.uri] }
      : { title: '$(debug-stop) Cancel', command: 'moonageDaydream.cancelQuery', arguments: [doc.uri] }));
  } else if (!segs.length) {
    lenses.push(new vscode.CodeLens(first, { title: '$(play) Execute', command: 'moonageDaydream.runQuery' }));
  }
  segs.forEach((seg, i) => {
    const r = at(seg.start);
    const args = [doc.uri, seg.start, seg.end];
    if (!q) {
      lenses.push(new vscode.CodeLens(r, { title: '$(play) Execute', command: 'moonageDaydream.runStatement', arguments: args, tooltip: 'Run this statement' }));
      if (canExplain(c, 'estimated')) lenses.push(new vscode.CodeLens(r, { title: '$(list-tree) Explain', command: 'moonageDaydream.explain', arguments: args, tooltip: 'Estimated execution plan (the statement is not executed)' }));
      if (canExplain(c, 'actual') && singleSelect([doc.getText(new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)))])) {
        lenses.push(new vscode.CodeLens(r, { title: '$(pulse) Analyze', command: 'moonageDaydream.analyze', arguments: args, tooltip: 'Actual execution plan (runs the SELECT inside a rolled back transaction)' }));
      }
    }
    if (i === 0) pushConn(lenses, r, doc, c);
  });
  if (!segs.length) pushConn(lenses, first, doc, c);
  return lenses;
}

/** driver punya plan SQL Server, atau statement EXPLAIN untuk mode itu (SQLite: tanpa Analyze) */
const canExplain = (c: ConnectionInfo | undefined, mode: 'estimated' | 'actual') => {
  const d = c && drivers[c.type];
  return !d || !!d.plan || !!d.explain?.('SELECT 1', mode);
};

function pushConn(lenses: vscode.CodeLens[], r: vscode.Range, doc: vscode.TextDocument, c: ConnectionInfo | undefined) {
  lenses.push(new vscode.CodeLens(r, { title: `$(server) ${c?.name ?? 'Select connection'}`, command: 'moonageDaydream.setFileConnection', arguments: [doc.uri] }));
  lenses.push(new vscode.CodeLens(r, { title: `$(database) ${c?.database || 'default database'}`, command: 'moonageDaydream.setFileDatabase', arguments: [doc.uri] }));
  // transaksi: mode (klik = ganti), Commit / Rollback selama transaksi manual terbuka
  const key = doc.uri.toString();
  const tx = txs.get(key);
  const manual = txMode(key) === 'manual';
  if (c && drivers[c.type].transactions === false) return;
  lenses.push(new vscode.CodeLens(r, {
    title: manual ? (tx?.session.open ? `$(lock) TX open (${tx.statements})` : '$(lock) Manual commit') : '$(unlock) Auto-commit',
    command: 'moonageDaydream.toggleTransactionMode', arguments: [doc.uri], tooltip: 'Transaction mode for this file (click to switch Auto-commit / Manual)',
  }));
  if (manual && tx?.session.open) {
    lenses.push(new vscode.CodeLens(r, { title: '$(check) Commit', command: 'moonageDaydream.commitTransaction', arguments: [doc.uri] }));
    lenses.push(new vscode.CodeLens(r, { title: '$(discard) Rollback', command: 'moonageDaydream.rollbackTransaction', arguments: [doc.uri] }));
  }
}

/**
 * cancel query file ini (default: file aktif). Tanpa argumen dan file aktif tidak sedang menjalankan query: cancel semua.
 * Dengan argumen (CodeLens / tombol Cancel di hasil, berupa Uri atau string uri): hanya file itu.
 */
function cancelQuery(arg?: vscode.Uri | string, index?: number) {
  const uri = arg ?? sqlUri();
  const mine = uri && running.get(uri.toString());
  if (mine && index !== undefined && mine.parts?.[index]) {
    // tombol Cancel satu statement pada run paralel: statement lain tetap berjalan
    log.info(`cancel statement ${index + 1} after ${Date.now() - mine.start} ms: ${mine.conn} / ${mine.db}`);
    mine.parts[index].abort();
    results.markCancelling(mine.uri, index);
  } else if (mine) cancel(mine);
  else if (!arg) running.forEach(cancel);
}

/** abort + tampilkan loading "Cancelling…" (CodeLens, Running Queries, notifikasi) sampai server benar-benar berhenti */
function cancel(q: RunningQuery) {
  log.info(`cancel requested after ${Date.now() - q.start} ms${q.cancelling ? ' (already cancelling)' : ''}: ${q.conn} / ${q.db}`);
  if (q.cancelling) return;
  q.cancelling = true;
  q.ac.abort();
  results.markCancelling(q.uri);
  lensChanged.fire();
  runningView.refresh();
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Cancelling query on ${q.db ? `${q.conn} / ${q.db}` : q.conn}…` },
    () => q.done ?? Promise.resolve(),
  );
}

async function setFileConnection(uri: vscode.Uri | undefined = sqlUri()) {
  const c = await pickConnection('Connection for this file');
  if (!c) return;
  if (uri) await conns.bind(uri.toString(), { conn: c.name });
  await conns.setActive(c.name); // file baru ikut koneksi terakhir yang dipilih
  updateStatus();
}

async function setFileDatabase(uri: vscode.Uri | undefined = sqlUri()) {
  const c = fileConn(uri);
  if (!uri || !c) return setFileConnection(uri);
  let dbs: string[];
  try {
    dbs = await drivers[c.type].databases(c, await conns.password(c.name));
  } catch (e) {
    log.error(`setFileDatabase - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Moonage Daydream: cannot list databases of ${c.name}: ${errMsg(e)}`);
    return;
  }
  const db = await vscode.window.showQuickPick(
    dbs.map((d) => ({ label: d, description: d === c.database ? '(current)' : '' })),
    { title: `Database for this file (${c.name})` },
  );
  if (!db) return;
  await conns.bind(uri.toString(), { conn: c.name, db: db.label });
  updateFileStatus();
}

async function closePool(c: ConnectionInfo) {
  try {
    await drivers[c.type].close(c.name);
  } catch (e) {
    log.error(`closePool - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
  }
}

async function pickConnection(title: string): Promise<ConnectionInfo | undefined> {
  const list = conns.list();
  if (!list.length) {
    const add = await vscode.window.showInformationMessage('No connection yet.', 'Add Connection');
    if (add) editConnection();
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name, description: `${drivers[c.type].label} · ${c.user}@${address(c)}/${c.database}`, c })),
    { title },
  );
  return picked?.c;
}

function editConnection(old?: ConnectionInfo) {
  openConnectionForm(conns, log, saveConnection, old);
}

async function saveConnection(c: ConnectionInfo, password: string, old?: ConnectionInfo) {
  if (old) await closePool(old);
  await conns.save(c, password, old?.name);
  if (!old || !conns.active) await conns.setActive(c.name);
  updateStatus();
}

/** buka SQL dari history di editor baru, terikat ke koneksi + database yang sama */
async function openHistory(e: HistoryEntry): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: e.sql });
  if (conns.get(e.conn)) await conns.bind(doc.uri.toString(), { conn: e.conn, db: e.db || undefined });
  await vscode.window.showTextDocument(doc);
  updateFileStatus();
  return true;
}

/**
 * Blok teks: jalankan yang diblok. Tanpa blok: hanya statement di kursor (`;` / `GO`).
 * `{ all: true }` (Run Again di History): seluruh isi file. Argumen lain (mis. Uri dari tombol editor/title) diabaikan.
 */
async function runQuery(opts?: unknown) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const text = !editor.selection.isEmpty ? doc.getText(editor.selection)
    : (opts as { all?: unknown } | undefined)?.all === true ? doc.getText()
    : statementAt(doc.getText(), doc.offsetAt(editor.selection.active));
  if (!text.trim()) return;
  await execute(doc, text);
}

/**
 * toolbar WHERE di hasil: statement asal (bukan yang sudah difilter) dijalankan ulang dengan kondisi baru;
 * part = query ke-n pada run paralel. Kondisi kosong = statement asal.
 */
export async function applyWhere(where: string, part?: number) {
  const o = results.current?.outcome;
  const src: Source | undefined = !o ? undefined
    : 'parts' in o ? (part !== undefined && o.parts[part] ? { uri: o.uri, sql: o.parts[part].sql } : undefined)
    : 'source' in o ? o.source : undefined;
  if (!src) return;
  let sql: string;
  try {
    sql = addWhere(src.sql, where);
  } catch (e) {
    log.error(`applyWhere - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(errMsg(e));
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(src.uri));
  await execute(doc, sql, { uri: src.uri, sql: src.sql, where: where.trim() || undefined });
}

/**
 * Export dari panel hasil. scope sel = baris terpilih (data yang sudah dimuat); all = semua data:
 * statement asal (+ filter WHERE aktif) dijalankan ulang tanpa limit dan di-stream ke file; tanpa statement asal = baris yang dimuat.
 * target: 'clipboard' = Copy (format teks, All Data dibatasi CLIPBOARD_MAX_ROWS); Uri diisi test (tanpa dialog Save).
 * Mengembalikan jumlah baris yang ditulis.
 */
export async function exportResult(m: ResultMessage, target?: vscode.Uri | 'clipboard', outcome?: Outcome): Promise<number | undefined> {
  const o = outcome ?? results.current?.outcome; // outcome: tab pin (snapshot) asal pesan
  if (!o || m.set === undefined) return;
  const part = 'parts' in o && m.part !== undefined ? o.parts[m.part] : undefined;
  const single = part ? part.o : o;
  if (!('result' in single)) return;
  const rs = single.result.resultSets[m.set];
  if (!rs) return;
  const src: Source | undefined = part && 'parts' in o ? { uri: o.uri, sql: part.sql } : 'source' in single ? single.source : undefined;
  const toClipboard = target === 'clipboard';
  const format = (m.format && m.format in FORMATS ? m.format : 'csv') as ExportFormat;
  if (toClipboard && format === 'xlsx') return void vscode.window.showWarningMessage('Excel cannot be copied to the clipboard; use Save');
  const cols = m.cols?.length ? m.cols : rs.columns.map((_, i) => i);
  const pick = (row: unknown[]) => cols.map((i) => row[i]);
  const fromServer = m.scope !== 'sel' && !!src && m.set === 0 && (rs.total > rs.rows.length || !!rs.limited);
  const base = src ? vscode.Uri.parse(src.uri) : undefined;
  const dir = (base && vscode.workspace.getWorkspaceFolder(base)?.uri) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const uri = toClipboard ? undefined : target ?? await vscode.window.showSaveDialog({
    defaultUri: dir && vscode.Uri.joinPath(dir, `result.${FORMATS[format].ext}`),
    filters: { [FORMATS[format].label]: [FORMATS[format].ext] },
    title: `Export ${m.scope === 'sel' ? `${m.rows?.length ?? 0} selected row(s)` : 'all data'} as ${FORMATS[format].label}`,
  });
  if (!uri && !toClipboard) return;
  const quiet = target !== undefined && !toClipboard; // test: tanpa dialog / notifikasi
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${toClipboard ? 'Copying' : 'Exporting'} ${FORMATS[format].label}…`, cancellable: true },
    async (progress, token) => {
      const names = cols.map((i) => rs.columns[i]);
      const mem = toClipboard ? await memorySink(format as Exclude<ExportFormat, 'xlsx'>, names, m.header !== false) : undefined;
      const sink: Sink = mem ?? await openSink(format, uri!.fsPath, names);
      let n = 0;
      try {
        if (m.scope === 'sel') {
          for (const i of m.rows ?? []) if (rs.rows[i]) n++, await sink.row(pick(rs.rows[i]));
        } else if (fromServer) {
          const c = fileConn(base!);
          if (!c) throw new Error('Connection for this result no longer exists');
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          const sql = src!.where ? addWhere(src!.sql, src!.where) : src!.sql;
          n = await drivers[c.type].stream(c, await conns.password(c.name), sql, ac.signal, {
            columns: () => undefined,
            row: (v) => {
              if (++n % 10000 === 0) progress.report({ message: `${n.toLocaleString()} rows` });
              if (toClipboard && n > CLIPBOARD_MAX_ROWS) throw new Error(`More than ${CLIPBOARD_MAX_ROWS.toLocaleString()} rows: too many for the clipboard, use Save`);
              return sink.row(pick(v));
            },
          });
        } else {
          for (const row of rs.rows) n++, await sink.row(pick(row));
        }
        await sink.end();
      } catch (e) {
        await sink.abort();
        log.error(`exportResult - EXCEPTION CAUGHT | ${toClipboard ? '(clipboard) ' : ''}${token.isCancellationRequested ? '(cancelled by user) ' : ''}${errMsg(e)} - stack-trace: ${errStack(e)}`);
        if (!token.isCancellationRequested && !quiet) vscode.window.showErrorMessage(`${toClipboard ? 'Copy' : 'Export'} failed: ${errMsg(e)}`);
        if (quiet) throw e;
        return undefined;
      }
      const partial = m.scope !== 'sel' && !fromServer && rs.total > rs.rows.length;
      if (mem) {
        await vscode.env.clipboard.writeText(mem.text());
        log.info(`copy ${format} ${n} rows to clipboard${partial ? ' (loaded rows only)' : ''}`);
        vscode.window.setStatusBarMessage(`$(copy) Copied ${n.toLocaleString()} row(s) as ${FORMATS[format].label}${partial ? ' (loaded rows only)' : ''}`, 4000);
        return n;
      }
      log.info(`export ${format} ${n} rows -> ${uri!.fsPath}${partial ? ' (loaded rows only)' : ''}`);
      if (!quiet) {
        void vscode.window.showInformationMessage(
          `Exported ${n.toLocaleString()} row(s) to ${uri!.fsPath}${partial ? ` (loaded rows only: ${rs.total} rows in result)` : ''}`, 'Open',
        ).then((a) => a && vscode.commands.executeCommand(format === 'xlsx' ? 'revealFileInOS' : 'vscode.open', uri!));
      }
      return n;
    },
  );
}

/** sesi transaksi manual per file (key = uri) */
export const txs = new Map<string, { session: Session; conn: string; db: string; statements: number }>();
const txModes = new Map<string, 'auto' | 'manual'>();
/** mode transaksi file: pilihan per file, default dari setting transaction.mode */
export const txMode = (key: string) =>
  txModes.get(key) ?? vscode.workspace.getConfiguration('moonageDaydream.transaction').get<'auto' | 'manual'>('mode', 'auto');

async function txFor(key: string, c: ConnectionInfo, pw: string) {
  const cur = txs.get(key);
  if (cur && cur.conn === c.name && cur.db === c.database) return cur;
  if (cur?.session.open) throw new Error(`Commit or rollback the open transaction on ${cur.conn} / ${cur.db} before switching connection / database`);
  if (cur) await closeTx(key, cur, 'rollback');
  const tx = { session: await drivers[c.type].session(c, pw), conn: c.name, db: c.database, statements: 0 };
  txs.set(key, tx);
  return tx;
}

async function closeTx(key: string, tx: { session: Session }, how: 'commit' | 'rollback') {
  try {
    await (how === 'commit' ? tx.session.commit() : tx.session.rollback());
  } finally {
    await tx.session.close().catch((e: unknown) => log.error(`closeTx - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`));
    if (txs.get(key) === tx) txs.delete(key);
  }
}

/** Commit / Rollback transaksi manual file ini; sesi tetap siap (transaksi baru dibuka di run berikutnya) */
export async function endTransaction(how: 'commit' | 'rollback', uriArg?: vscode.Uri | string) {
  const key = (uriArg ? (typeof uriArg === 'string' ? uriArg : uriArg.toString()) : sqlUri()?.toString()) ?? '';
  const tx = txs.get(key);
  if (!tx?.session.open) return void vscode.window.showInformationMessage('No open transaction for this file.');
  if (running.has(key)) return void vscode.window.showWarningMessage('A query is still running in this transaction; wait or cancel it first.');
  try {
    await (how === 'commit' ? tx.session.commit() : tx.session.rollback());
    log.info(`transaction ${how} (${tx.statements} statement(s)): ${tx.conn} / ${tx.db}`);
    vscode.window.setStatusBarMessage(`$(check) Transaction ${how === 'commit' ? 'committed' : 'rolled back'} (${tx.statements} statement(s))`, 4000);
    tx.statements = 0;
  } catch (e) {
    log.error(`endTransaction ${how} - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`${how} failed: ${errMsg(e)}`);
  }
  updateFileStatus();
}

/** ganti mode Auto-commit / Manual untuk file ini; Manual -> Auto dengan transaksi terbuka harus commit / rollback dulu */
export async function setTransactionMode(uriArg?: vscode.Uri | string, mode?: 'auto' | 'manual') {
  const key = (uriArg ? (typeof uriArg === 'string' ? uriArg : uriArg.toString()) : sqlUri()?.toString()) ?? '';
  if (!key) return;
  const next = mode ?? (txMode(key) === 'auto' ? 'manual' : 'auto');
  const tx = txs.get(key);
  if (next === 'auto' && tx?.session.open) {
    const pick = await vscode.window.showWarningMessage(`Transaction is open (${tx.statements} statement(s)). Commit or roll back before switching to auto-commit?`, { modal: true }, 'Commit', 'Rollback');
    if (!pick) return;
    await endTransaction(pick === 'Commit' ? 'commit' : 'rollback', key);
  }
  if (next === 'auto' && tx) await closeTx(key, tx, 'rollback');
  txModes.set(key, next);
  updateFileStatus();
}

/** file ditutup dengan transaksi terbuka: tanya Commit / Rollback (tidak dijawab = rollback) */
async function onCloseTx(doc: vscode.TextDocument) {
  const key = doc.uri.toString();
  const tx = txs.get(key);
  if (!tx) return;
  let how: 'commit' | 'rollback' = 'rollback';
  if (tx.session.open) {
    const pick = await vscode.window.showWarningMessage(
      `${doc.fileName.split(/[\\/]/).pop()} was closed with an open transaction (${tx.statements} statement(s)) on ${tx.conn} / ${tx.db}.`, 'Commit', 'Rollback');
    how = pick === 'Commit' ? 'commit' : 'rollback';
  }
  await closeTx(key, tx, how).catch((e: unknown) => log.error(`onCloseTx - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`));
  log.info(`transaction ${how} on close: ${tx.conn} / ${tx.db}`);
}

/** daftarkan query yang berjalan untuk file key (Running Queries, CodeLens Cancel); run lama di file itu dibatalkan. end() wajib dipanggil */
function startRun(key: string, c: ConnectionInfo, text: string) {
  const prev = running.get(key);
  if (prev) cancel(prev); // jalankan ulang file yang masih jalan: query lama dihentikan
  const ac = new AbortController();
  const q: RunningQuery = { ac, uri: key, conn: c.name, db: c.database, sql: text, start: Date.now() };
  let finish = () => {};
  q.done = new Promise<void>((r) => (finish = r));
  running.set(key, q);
  lensChanged.fire();
  runningView.refresh();
  const end = () => {
    finish();
    if (running.get(key) === q) running.delete(key);
    lensChanged.fire();
    runningView.refresh();
  };
  return { q, ac, end };
}

/** teks yang dijalankan: offset start/end (CodeLens per statement), blok terpilih, atau statement di kursor */
async function targetText(uriArg?: vscode.Uri | string, start?: number, end?: number): Promise<{ doc: vscode.TextDocument; text: string } | undefined> {
  const doc = uriArg ? await vscode.workspace.openTextDocument(typeof uriArg === 'string' ? vscode.Uri.parse(uriArg) : uriArg) : vscode.window.activeTextEditor?.document;
  if (!doc) return;
  if (start !== undefined && end !== undefined) return { doc, text: doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))) };
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== doc) return { doc, text: '' };
  return { doc, text: editor.selection.isEmpty ? statementAt(doc.getText(), doc.offsetAt(editor.selection.active)) : doc.getText(editor.selection) };
}

/** CodeLens Execute di atas statement: jalankan statement itu saja */
async function runStatement(uriArg?: vscode.Uri | string, start?: number, end?: number) {
  const t = await targetText(uriArg, start, end);
  if (t?.text.trim()) await execute(t.doc, t.text);
}

/**
 * Explain = estimated plan (query tidak dijalankan, aman untuk statement apa pun).
 * Analyze = actual plan: query dijalankan, jadi hanya untuk SELECT; tetap di dalam transaksi yang di-rollback.
 */
export async function explainQuery(mode: 'estimated' | 'actual', uriArg?: vscode.Uri | string, start?: number, end?: number) {
  const t = await targetText(uriArg, start, end);
  if (!t?.text.trim()) return;
  const stmts = splitBatches(t.text).flatMap(splitStatements);
  if (mode === 'actual' && !stmts.every((st) => singleSelect([st]))) {
    vscode.window.showWarningMessage('Analyze runs the query, so it is only available for SELECT. Use Explain for other statements.');
    return;
  }
  const c = fileConn(t.doc.uri) ?? (await pickConnection('Select connection'));
  if (!c) return;
  const key = t.doc.uri.toString();
  const title = `${c.database ? `${c.name} / ${c.database}` : c.name} · ${mode === 'estimated' ? 'Explain' : 'Analyze'}`;
  const run = startRun(key, c, t.text);
  await results.show(title, { loading: true, uri: key });
  let outcome: Outcome;
  try {
    const d = drivers[c.type];
    const pw = await conns.password(c.name);
    if (d.plan) {
      const r = await d.plan(c, pw, t.text, mode, run.ac.signal);
      outcome = { plan: r.xml.flatMap(parsePlan), mode, xml: r.xml, durationMs: r.result.durationMs, rows: mode === 'actual' ? r.result.resultSets.map((rs) => rs.total) : undefined };
    } else {
      // MySQL / PostgreSQL / SQLite: EXPLAIN per statement, hasilnya tampil sebagai grid
      if (!canExplain(c, mode)) throw new Error(`${mode === 'actual' ? 'Analyze' : 'Explain'} is not available for ${d.label}`);
      const sql = stmts.map((st) => d.explain?.(st.replace(/;\s*$/, ''), mode)).join(';\n');
      outcome = { result: await d.run(c, pw, sql, run.ac.signal) };
    }
  } catch (e) {
    log.error(`explainQuery ${mode} - EXCEPTION CAUGHT | ${c.name}${run.ac.signal.aborted ? ' (cancelled by user)' : ''}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    outcome = { error: run.ac.signal.aborted ? 'Query cancelled.' : errMsg(e) };
  } finally {
    run.end();
  }
  if (running.has(key)) return; // diganti run yang lebih baru
  await results.show(title, outcome);
}

/**
 * Edit grid -> script UPDATE di tab baru (BEGIN TRAN, WHERE primary key); tidak pernah dijalankan otomatis.
 * Syarat: statement asal SELECT dari satu tabel yang punya primary key, kolom PK ikut di-SELECT.
 */
export async function editScript(m: ResultMessage): Promise<vscode.TextDocument | undefined> {
  const o = results.current?.outcome;
  if (!o || !m.edits?.length) return;
  const part = 'parts' in o && m.part !== undefined ? o.parts[m.part] : undefined;
  const single = part ? part.o : o;
  if (!('result' in single)) return;
  const rs = single.result.resultSets[m.set ?? 0];
  const src: Source | undefined = part && 'parts' in o ? { uri: o.uri, sql: part.sql } : 'source' in single ? single.source : undefined;
  const c = src && fileConn(vscode.Uri.parse(src.uri));
  try {
    if (!rs || !src || !c) throw new Error('Editing needs the result of a single SELECT');
    const refs = tableRefs(src.sql);
    if (refs.length !== 1) throw new Error('Editing needs a SELECT from exactly one table (no JOIN)');
    const parts = refs[0].parts;
    const name = parts[parts.length - 1];
    const d = drivers[c.type];
    // MySQL: `db.tabel` (schema = database); lainnya `db.schema.tabel` / `schema.tabel`
    const db = parts.length === 3 || (d.dialect === 'mysql' && parts.length === 2) ? parts[0] : c.database || d.defaultDb;
    const pw = await conns.password(c.name);
    const schema = d.dialect === 'mysql' ? db : (parts.length >= 2 && parts[parts.length - 2])
      || (await d.objects(c, pw, db, 'table')).find((x) => x.name.toLowerCase() === name.toLowerCase())?.schema || schemaOf(c, db);
    const pk = await d.primaryKey(c, pw, db, { schema, name });
    if (!pk.length) throw new Error(`${schema}.${name} has no primary key, so rows cannot be identified safely`);
    const q = d.quote;
    const table = d.dialect === 'mssql' ? `${q(db)}.${q(schema)}.${q(name)}` : d.dialect === 'mysql' ? `${q(db)}.${q(name)}`
      : d.dialect === 'postgres' ? `${q(schema)}.${q(name)}` : q(name);
    const script = updateScript(table, rs.columns, rs.types ?? [], rs.rows, pk, m.edits, q, d.dialect);
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: script });
    await conns.bind(doc.uri.toString(), { conn: c.name, db: c.database || undefined });
    await vscode.window.showTextDocument(doc, { preview: false });
    log.info(`edit script: ${m.edits.length} cell(s) on ${db}.${schema}.${name}`);
    return doc;
  } catch (e) {
    log.error(`editScript - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Cannot generate UPDATE script: ${errMsg(e)}`);
  }
}

/**
 * Load more: statement asal (+ WHERE aktif) dijalankan ulang, baris yang sudah dimuat dilewati, PAGE_ROWS berikutnya ditambahkan.
 * shortcut: urutan baris hanya stabil dengan ORDER BY; tanpa itu SQL Server boleh mengembalikan urutan lain.
 */
export async function loadMore(m: ResultMessage): Promise<number | undefined> {
  const o = results.current?.outcome;
  if (!o || m.set !== 0) return;
  const part = 'parts' in o && m.part !== undefined ? o.parts[m.part] : undefined;
  const single = part ? part.o : o;
  if (!('result' in single)) return;
  const rs = single.result.resultSets[0];
  const src: Source | undefined = part && 'parts' in o ? { uri: o.uri, sql: part.sql } : 'source' in single ? single.source : undefined;
  const c = src && fileConn(vscode.Uri.parse(src.uri));
  if (!rs || !src || !c) return;
  const offset = rs.rows.length;
  try {
    const sql = src.where ? addWhere(src.sql, src.where) : src.sql;
    const next = (await drivers[c.type].run(c, await conns.password(c.name), sql, undefined, offset + PAGE_ROWS, offset)).resultSets[0];
    rs.rows.push(...(next?.rows ?? []));
    if (rs.limited) {
      rs.total = next?.total ?? rs.total; // auto limit: total = baris yang terbaca sejauh ini
      rs.limited = next?.limited ? offset + PAGE_ROWS : undefined;
    }
    log.info(`load more: +${next?.rows.length ?? 0} rows (now ${rs.rows.length})`);
    return next?.rows.length ?? 0;
  } catch (e) {
    log.error(`loadMore - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Load more failed: ${errMsg(e)}`);
  } finally {
    results.refresh();
  }
}

/** tombol Open XML di hasil plan: XML asli di tab baru */
async function openPlanXml(outcome?: Outcome) {
  const o = outcome ?? results.current?.outcome;
  if (!o || !('plan' in o)) return;
  const doc = await vscode.workspace.openTextDocument({ language: 'xml', content: o.xml.join('\n\n') });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** jalankan text untuk file doc (koneksi / database dari binding file); source = statement asal untuk filter WHERE */
async function execute(doc: vscode.TextDocument, text: string, source?: Source) {
  const uri = doc.uri;
  const c = fileConn(uri) ?? (await pickConnection('Select connection to run on'));
  if (!c) return;
  if (!conns.binding(uri.toString())) {
    await conns.bind(uri.toString(), { conn: c.name }); // file terikat ke koneksi saat pertama kali dijalankan
    if (conns.active !== c.name) await conns.setActive(c.name);
    updateFileStatus();
  }

  const key = uri.toString();
  const { q, ac, end } = startRun(key, c, text);
  log.info(`runQuery start: ${c.name} / ${c.database}`);
  const title = c.database ? `${c.name} / ${c.database}` : c.name;
  // beberapa SELECT tanpa variabel / #temp: tiap statement di koneksi sendiri, hasil tampil begitu statement itu selesai
  const stmts = splitBatches(text).flatMap(splitStatements);
  // satu SELECT: toolbar WHERE aktif (dasarnya statement asal, bukan versi yang sudah difilter)
  const src = source ?? (singleSelect(stmts) ? { uri: key, sql: stmts[0] } : undefined);
  const manual = txMode(key) === 'manual'; // transaksi manual: satu sesi, selalu berurutan
  let outcome: Outcome = !manual && parallelSafe(stmts)
    ? { parts: stmts.map((sql) => ({ sql, o: { loading: true } })), uri: key, start: q.start }
    : { loading: true, uri: key };
  await results.show(title, outcome); // spinner sampai hasil (atau error / cancel) menggantikannya

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Running query on ${title}…` },
      async () => {
        const pw = await conns.password(c.name);
        const o = outcome;
        const autoLimit = vscode.workspace.getConfiguration('moonageDaydream.query', doc).get('autoLimit', 100);
        // satu SELECT tanpa TOP: ambil autoLimit baris pertama lalu hentikan di server
        const limitFor = (stmts: string[]) => (autoLimit > 0 && (drivers[c.type].autoLimitable ?? autoLimitable)(stmts) ? autoLimit : undefined);
        if (!('parts' in o)) {
          if (manual) {
            const tx = await txFor(key, c, pw);
            outcome = { result: await tx.session.run(text, ac.signal, limitFor(stmts)), source: src };
            if (tx.session.open) tx.statements++;
            else vscode.window.showWarningMessage('The transaction was rolled back by the server (error or cancel).');
            return;
          }
          outcome = { result: await drivers[c.type].run(c, pw, text, ac.signal, limitFor(stmts)), source: src };
          return;
        }
        const acs = (q.parts = o.parts.map(() => new AbortController()));
        ac.signal.addEventListener('abort', () => acs.forEach((a) => a.abort()));
        await Promise.all(o.parts.map(async (part, i) => {
          try {
            part.o = { result: await drivers[c.type].run(c, pw, part.sql, acs[i].signal, limitFor([part.sql])) };
          } catch (e) {
            log.error(`runQuery part ${i + 1} - EXCEPTION CAUGHT | ${c.name}${acs[i].signal.aborted ? ' (cancelled by user)' : ''}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
            part.o = { error: acs[i].signal.aborted ? 'Query cancelled.' : errMsg(e) };
          }
          results.repaint(key);
        }));
        o.end = Date.now();
      },
    );
  } catch (e) {
    log.error(`runQuery - EXCEPTION CAUGHT | ${c.name}${ac.signal.aborted ? ' (cancelled by user)' : ''}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    outcome = { error: ac.signal.aborted ? 'Query cancelled.' : errMsg(e), source: src };
  } finally {
    log.info(`runQuery end after ${Date.now() - q.start} ms${ac.signal.aborted ? ' (cancelled)' : ''}: ${c.name} / ${c.database}`);
    end();
    if (manual) updateFileStatus(); // status TX open (n) / lens Commit Rollback
  }
  const errors = 'parts' in outcome ? outcome.parts.flatMap((p) => ('error' in p.o ? [p.o.error] : [])) : 'error' in outcome ? [outcome.error] : [];
  await history.add({
    sql: text, conn: c.name, db: c.database, at: q.start, durationMs: Date.now() - q.start,
    status: !errors.length ? 'ok' : errors.every((e) => e === 'Query cancelled.') ? 'cancelled' : 'error',
    message: errors.find((e) => e !== 'Query cancelled.') ?? errors[0],
  });
  if (running.has(key)) return; // sudah diganti run yang lebih baru: hasilnya yang ditampilkan
  if ('parts' in outcome) results.repaint(key); // panel sudah tampil sejak awal; cukup perbarui status akhir
  else await results.show(title, outcome);
}

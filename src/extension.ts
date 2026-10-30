import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Connections } from './connections';
import { ConnDecorations, Explorer, Node } from './explorer';
import { History, HistoryEntry, RunningQuery, RunningView } from './activity';
import { openConnectionForm } from './connectionForm';
import { ColumnDef, ColumnRow, ConnectionInfo, PAGE_ROWS, columnChanges, showColumns, QueryResult, ResultSet, Session, address, confirmAutoCommit, newDatabaseScript, drivers, idleConnections, openSession, schemaOf } from './db';
import { Results, LOCATIONS, ResultMessage, VIEW_ID } from './results';
import { CLIPBOARD_MAX_ROWS, ExportFormat, FORMATS, memorySink, openSink, Sink } from './exporter';
import { SqlFiles, SqlNode, deleteSqlNode, duplicateSqlFile, newSqlFile, nodeUri, renameSqlNode, sqlFilesDnd } from './sqlFiles';
import { SqlCompletion } from './completion';
import { driverLog } from './log';
import { ConnBanner } from './connBanner';
import { CONN_COLORS, colorLabel, isConnColor } from './connColor';
import type { ConnColor } from './connColor';
import { formatSql } from './sqlFormat';
import type { Outcome, Source } from './resultsHtml';
import { columnsHtml } from './columnsHtml';
import { newDbHtml } from './newDbHtml';
import { ACTIVITY_SQL, DB_INFO_SQL, SERVER_INFO_SQL, backupScript, jobScript, killScript, restoreScript, scriptAs, splitBatches } from './mssql';
import { addWhere, affectedStatements, changingStatement, preview, readOnlyBlocked, txEndStatement, updateScript, tableRefs, autoLimitable, missingSemicolons, parallelSafe, readOnly, singleSelect, splitStatements, statementAt, statementSegments } from './sqlContext';
import { parsePlan } from './plan';
import { monitorKit } from './monitorKits';
import { ConsulFs, backupWriter, deleteConsulKey, newConsulKey, openConsulKey } from './consulView';
import { ConsulClient, consulTarget, dashboardData, deleteKv, detectFormat, kvChildren, saveKv } from './consul';
import { consulDashboardHtml } from './consulDashHtml';
import { monitorHtml } from './monitorHtml';
import { permissionHint } from './mssqlTree';
import { importDbcode } from './connString';

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
export let banner: ConnBanner;
let connDecorations: ConnDecorations;
let sqlFilesView: vscode.TreeView<SqlNode>;
export let completion: SqlCompletion;
/** Shift+Alt+F memakai formatter Moonage (default formatter [sql] kosong / Moonage / extension-nya tidak ada di jendela ini) */
export let ownFormatter = false;
export const lint = vscode.languages.createDiagnosticCollection('moonageDaydream');
const LINT_SOURCE = 'Moonage';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

let extCtx: vscode.ExtensionContext;

export function activate(ctx: vscode.ExtensionContext) {
  extCtx = ctx;
  log = vscode.window.createOutputChannel('Moonage Daydream', { log: true });
  driverLog.error = (m) => log.error(m);
  conns = new Connections(ctx);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'moonageDaydream.selectConnection';
  explorer = new Explorer(conns, log, ctx.extensionUri);
  explorer.connected = isConnected;
  ctx.subscriptions.push(conns.used.event(touchConn), idleWatcher());
  connDecorations = new ConnDecorations(conns);
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
    // pemicu lewat file (tidak tergantung jendela VS Code yang aktif, URI bisa salah alamat): isi file = nama test (kosong = semua)
    const trigger = path.join(ctx.extensionPath, 'docs', 'main', 'temp', 'real-test.trigger');
    const poll = setInterval(() => {
      if (!fs.existsSync(trigger)) return;
      try {
        const only = fs.readFileSync(trigger, 'utf8').trim();
        fs.rmSync(trigger, { force: true });
        void require('./test/real').run(only || undefined);
      } catch (e) {
        log.error(`real-test trigger - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      }
    }, 1000);
    ctx.subscriptions.push({ dispose: () => clearInterval(poll) });
    // npm run dev: koneksi Docker lokal untuk test manual (file ter-ignore git, [{ conn, password }]); hanya ditambah bila belum ada
    const seed = path.join(ctx.extensionPath, 'docs', 'main', 'temp', 'dev-connections.json');
    if (fs.existsSync(seed)) {
      try {
        for (const s of JSON.parse(fs.readFileSync(seed, 'utf8')) as { conn: ConnectionInfo; password: string }[]) {
          if (!conns.get(s.conn.name)) void conns.save(s.conn, s.password).then(() => { log.info(`dev connection added: ${s.conn.name}`); explorer.refresh(); });
        }
      } catch (e) {
        log.error(`dev-connections - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      }
    }
  }
  ctx.subscriptions.push(
    log,
    status,
    runningView,
    vscode.window.registerTreeDataProvider('moonageDaydream.running', runningView),
    vscode.window.registerTreeDataProvider('moonageDaydream.history', history),
    (sqlFilesView = vscode.window.createTreeView('moonageDaydream.sqlFiles', { treeDataProvider: sqlFiles, dragAndDropController: sqlFilesDnd(sqlFiles, conns, log), canSelectMany: true })),
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
    // klik kanan / F2 / Delete di SQL Files: node dari menu, atau item terpilih bila dari keybinding
    ...([
      ['renameSqlFile', 'Rename', (n: SqlNode) => renameSqlNode(sqlFiles, conns, n)],
      ['duplicateSqlFile', 'Duplicate', (n: SqlNode) => duplicateSqlFile(sqlFiles, conns, n)],
      ['deleteSqlFile', 'Delete', (n: SqlNode) => deleteSqlNode(sqlFiles, conns, n)],
      ['copySqlFilePath', 'Copy path', (n: SqlNode) => vscode.env.clipboard.writeText(nodeUri(n).fsPath)],
      ['copySqlFileRelativePath', 'Copy relative path', (n: SqlNode) => vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(nodeUri(n)))],
      ['openSqlFileToSide', 'Open to the side', (n: SqlNode) => vscode.window.showTextDocument(nodeUri(n), { viewColumn: vscode.ViewColumn.Beside })],
      ['revealSqlFile', 'Reveal in Explorer', (n: SqlNode) => vscode.commands.executeCommand('revealInExplorer', nodeUri(n))],
    ] as [string, string, (n: SqlNode) => Thenable<unknown>][]).map(([id, what, f]) => vscode.commands.registerCommand(`moonageDaydream.${id}`, async (n?: SqlNode) => {
      const node = n ?? sqlFilesView.selection[0];
      if (!node) return;
      try {
        return await f(node);
      } catch (e) {
        log.error(`${id} - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        vscode.window.showErrorMessage(`${what} failed: ${errMsg(e)}`);
      }
    })),
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
    vscode.commands.registerCommand('moonageDaydream.addConnection', (n?: Node) => editConnection(undefined, n?.kind === 'group' ? n.group : undefined)),
    vscode.commands.registerCommand('moonageDaydream.importDbcode', importFromDbcode),
    vscode.commands.registerCommand('moonageDaydream.autoCommitConfirm', autoCommitConfirmCommand),
    vscode.commands.registerCommand('moonageDaydream.connect', (n?: Node) => n?.kind === 'conn' && connectCommand(n.c)),
    vscode.commands.registerCommand('moonageDaydream.disconnect', (n?: Node) => n?.kind === 'conn' && disconnect(n.c)),
    // Consul: value KV sebagai file moonage-consul:// (Ctrl+S = simpan), New / Delete Key, Dashboard
    vscode.workspace.registerFileSystemProvider('moonage-consul', consulFs = new ConsulFs(ctx, conns, log, () => explorer.refresh())),
    vscode.commands.registerCommand('moonageDaydream.consulOpenKey', (n?: Node) => n?.kind === 'kv' && openConsulKey(n.c, n.key).catch((e: unknown) => {
      log.error(`consulOpenKey - EXCEPTION CAUGHT | ${n.c.name} / ${n.key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      vscode.window.showErrorMessage(`Open key failed: ${errMsg(e)}`);
    })),
    vscode.commands.registerCommand('moonageDaydream.consulNewKey', (n?: Node) => (n?.kind === 'conn' || n?.kind === 'kv') && newConsulKey(consulFs, n.c, n.kind === 'kv' ? n.key : '')),
    vscode.commands.registerCommand('moonageDaydream.consulDeleteKey', async (n?: Node) => {
      if (n?.kind === 'kv' && (await deleteConsulKey(ctx, conns, log, n.c, n.key))) explorer.refresh();
    }),
    vscode.commands.registerCommand('moonageDaydream.consulDashboard', (n?: Node) => (n?.kind === 'consulDash' || n?.kind === 'conn') && consulDashboard(n.c)),
    vscode.commands.registerCommand('moonageDaydream.editConnection', async (n?: Node) => {
      const c = connOf(n) ?? (await pickConnection('Edit connection'));
      if (c) await editConnection(c);
    }),
    vscode.commands.registerCommand('moonageDaydream.removeConnection', async (n?: Node) => {
      const c = connOf(n) ?? (await pickConnection('Remove connection'));
      if (!c) return;
      const ok = await vscode.window.showWarningMessage(`Delete connection "${c.name}"?`, { modal: true, detail: 'The saved password is removed too. Files bound to it fall back to the active connection.' }, 'Delete');
      if (ok !== 'Delete') return;
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
    (banner = new ConnBanner()),
    vscode.window.onDidChangeVisibleTextEditors(() => banner.update(fileConn)),
    // label ikut baris teratas yang terlihat: tetap kelihatan saat scroll
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => e.textEditor.document.languageId === 'sql' && banner.update(fileConn, e.textEditor)),
    vscode.window.registerFileDecorationProvider(connDecorations),
    // garis warna mengikuti jumlah baris; label ikut akhir baris pertama
    vscode.workspace.onDidChangeTextDocument((e) => e.document.languageId === 'sql' && banner.update(fileConn)),
    vscode.window.registerWebviewViewProvider(VIEW_ID, results),
    vscode.window.registerTreeDataProvider('moonageDaydream.explorer', explorer),
    vscode.commands.registerCommand('moonageDaydream.renameConnection', (n?: Node, name?: string) => renameConnection(n, name)),
    vscode.commands.registerCommand('moonageDaydream.changeConnectionColor', (n?: Node, color?: string) => changeConnectionColor(n, color)),
    vscode.commands.registerCommand('moonageDaydream.moveConnectionToGroup', (n?: Node, pick?: string) => moveToGroup(n, pick)),
    vscode.commands.registerCommand('moonageDaydream.renameGroup', (n?: Node, name?: string) => renameGroup(n, name)),
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
    vscode.commands.registerCommand('moonageDaydream.showDefinition', (n?: Node) => objectScript(n, 'show')),
    vscode.commands.registerCommand('moonageDaydream.editObject', (n?: Node) => objectScript(n, 'edit')),
    vscode.commands.registerCommand('moonageDaydream.runProcedure', (n?: Node) => objectScript(n, 'run')),
    vscode.commands.registerCommand('moonageDaydream.scriptAs', scriptAsCommand),
    vscode.commands.registerCommand('moonageDaydream.editColumns', columnsEditor),
    vscode.commands.registerCommand('moonageDaydream.startJob', (n?: Node) => jobCommand(n, 'start')),
    vscode.commands.registerCommand('moonageDaydream.stopJob', (n?: Node) => jobCommand(n, 'stop')),
    vscode.commands.registerCommand('moonageDaydream.activityMonitor', (n?: Node) => n?.kind === 'conn' && openScript(n.c, 'master', ACTIVITY_SQL, true)),
    vscode.commands.registerCommand('moonageDaydream.killSession', killCommand),
    vscode.commands.registerCommand('moonageDaydream.newDatabase', newDatabase),
    vscode.commands.registerCommand('moonageDaydream.liveMonitor', liveMonitor),
    vscode.commands.registerCommand('moonageDaydream.serverInfo', (n?: Node) => n?.kind === 'conn' && openScript(n.c, 'master', SERVER_INFO_SQL, true)),
    vscode.commands.registerCommand('moonageDaydream.databaseInfo', (n?: Node) => n?.kind === 'db' && openScript(n.c, n.db, DB_INFO_SQL, true)),
    vscode.commands.registerCommand('moonageDaydream.backupDatabase', (n?: Node) => backupCommand(n, 'backup')),
    vscode.commands.registerCommand('moonageDaydream.restoreDatabase', (n?: Node) => backupCommand(n, 'restore')),
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
  lint.set(doc.uri, missingSemicolons(doc.getText(), dialectOf(doc.uri)).map((r) => Object.assign(
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
  connDecorations?.refresh(); // warna koneksi bisa diubah
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
  banner?.update(fileConn); // "you are using connection …" + warna koneksi di editor
  sqlFiles?.redraw(); // deskripsi koneksi / database per file di SQL Files
  const uri = sqlUri();
  const c = fileConn(uri);
  const tx = uri && txs.get(uri.toString());
  status.text = `$(database) ${c ? `${c.name}${c.database ? ` / ${c.database}` : ''}` : 'No connection'}${tx?.session.open ? ` · $(lock) TX open (${tx.statements})` : ''}`;
  status.backgroundColor = tx?.session.open ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  status.tooltip = c ? `${drivers[c.type].label} ${c.user}@${address(c)}/${c.database} (click to switch)` : 'Select a connection';
  status.command = uri ? 'moonageDaydream.setFileConnection' : 'moonageDaydream.selectConnection';
}

/** CodeLens: di atas tiap statement Execute | Explain | Analyze (Analyze hanya SELECT) | koneksi | database | mode transaksi */
function provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const c = fileConn(doc.uri);
  const q = running.get(doc.uri.toString());
  // shortcut: file sangat besar (> 20000 baris) hanya dapat CodeLens di baris pertama
  const segs = doc.lineCount <= 20000 ? statementSegments(doc.getText(), c && drivers[c.type].dialect) : [];
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
  segs.forEach((seg) => {
    const r = at(seg.start);
    const args = [doc.uri, seg.start, seg.end];
    if (!q) {
      lenses.push(new vscode.CodeLens(r, { title: '$(play) Execute', command: 'moonageDaydream.runStatement', arguments: args, tooltip: 'Run this statement' }));
      if (canExplain(c, 'estimated')) lenses.push(new vscode.CodeLens(r, { title: '$(list-tree) Explain', command: 'moonageDaydream.explain', arguments: args, tooltip: 'Estimated execution plan (the statement is not executed)' }));
      if (canExplain(c, 'actual') && singleSelect([doc.getText(new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)))])) {
        lenses.push(new vscode.CodeLens(r, { title: '$(pulse) Analyze', command: 'moonageDaydream.analyze', arguments: args, tooltip: 'Actual execution plan (runs the SELECT inside a rolled back transaction)' }));
      }
    }
    pushConn(lenses, r, doc, c); // koneksi | database | mode transaksi di setiap statement
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
    title: manual ? (tx?.session.failed ? '$(error) TX aborted (rollback needed)' : tx?.session.open ? `$(lock) TX open (${tx.statements})` : '$(lock) Manual commit') : '$(unlock) Auto-commit',
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

/** klik kanan koneksi -> Rename: nama baru (unik); password, binding file dan koneksi aktif ikut (Connections.save dengan oldName) */
export async function renameConnection(n?: Node, input?: string): Promise<void> {
  const c = connOf(n);
  if (!c) return;
  try {
    const name = input ?? (await vscode.window.showInputBox({
      title: `Rename connection ${c.name}`, value: c.name,
      validateInput: (v) => (!v.trim() ? 'Name is required' : v.trim() !== c.name && conns.get(v.trim()) ? `"${v.trim()}" is already used` : undefined),
    }));
    if (name === undefined || !name.trim() || name.trim() === c.name) return;
    if (conns.get(name.trim())) throw new Error(`"${name.trim()}" is already used`);
    const pw = await conns.password(c.name);
    await closePool(c); // pool di-cache per nama koneksi
    await conns.save({ ...c, name: name.trim() }, pw, c.name);
    updateStatus();
  } catch (e) {
    log.error(`renameConnection - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Rename connection failed: ${errMsg(e)}`);
  }
}

/** klik kanan koneksi -> Change Color: daftar warna (bulatan berwarna) + No color; color diisi test */
export async function changeConnectionColor(n?: Node, color?: string): Promise<void> {
  const c = connOf(n);
  if (!c) return;
  try {
    let picked: string | undefined = color;
    if (picked === undefined) {
      const items = [
        { label: 'No color', value: '', iconPath: new vscode.ThemeIcon('circle-slash'), description: c.color ? '' : 'current' },
        ...(Object.keys(CONN_COLORS) as ConnColor[]).map((k) => ({
          label: colorLabel(k), value: k as string, iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(CONN_COLORS[k])), description: c.color === k ? 'current' : '',
        })),
      ];
      picked = (await vscode.window.showQuickPick(items, { title: `Color of ${c.name}`, placeHolder: 'Shown in Connections and in the editor' }))?.value;
    }
    if (picked === undefined) return;
    if (picked && !isConnColor(picked)) throw new Error(`Unknown color ${picked}`);
    const { color: _old, ...rest } = c;
    await conns.save(picked ? { ...rest, color: picked as ConnColor } : rest, await conns.password(c.name), c.name);
    updateStatus();
  } catch (e) {
    log.error(`changeConnectionColor - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Change color failed: ${errMsg(e)}`);
  }
}

/** klik kanan koneksi -> Move to Group: group yang ada, group baru, atau tanpa group; pick diisi test (tanpa quick pick) */
export async function moveToGroup(n?: Node, pick?: string): Promise<void> {
  const c = connOf(n);
  if (!c) return;
  try {
    const NEW = '$(add) New group…', NONE = '$(close) No group';
    let group = pick ?? (await vscode.window.showQuickPick([...conns.groups().filter((g) => g !== c.group), NEW, ...(c.group ? [NONE] : [])],
      { title: `Move ${c.name} to group` }));
    if (group === NEW) group = await vscode.window.showInputBox({ title: 'New group', placeHolder: 'e.g. prod, non-prod', validateInput: (v) => (v.trim() ? undefined : 'Name is required') });
    if (group === undefined) return;
    await conns.setGroup([c.name], group === NONE ? undefined : group);
    explorer.refresh();
  } catch (e) {
    log.error(`moveToGroup - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Move to group failed: ${errMsg(e)}`);
  }
}

/** klik kanan folder group -> Rename Group (semua koneksi di dalamnya); nama group yang sudah ada = digabung */
export async function renameGroup(n?: Node, name?: string): Promise<void> {
  if (n?.kind !== 'group') return;
  try {
    const to = name ?? (await vscode.window.showInputBox({ title: `Rename group ${n.group}`, value: n.group, validateInput: (v) => (v.trim() ? undefined : 'Name is required') }));
    if (to === undefined || to.trim() === n.group) return;
    await conns.setGroup(conns.list().filter((c) => c.group === n.group).map((c) => c.name), to);
    explorer.refresh();
  } catch (e) {
    log.error(`renameGroup - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Rename group failed: ${errMsg(e)}`);
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
    list.map((c) => ({ label: c.name, description: `${c.group ? `[${c.group}] ` : ''}${drivers[c.type].label} · ${c.user}@${address(c)}/${c.database}`, c })),
    { title },
  );
  return picked?.c;
}

/**
 * view / procedure dari explorer -> tab SQL baru terikat ke koneksi + database objek itu:
 * show = definisi (CREATE ...), edit = script CREATE OR ALTER, run = script EXEC dengan parameter (tanpa parameter langsung dijalankan).
 * Script edit / run dengan parameter tidak pernah dijalankan otomatis.
 */
/** tab SQL baru terikat ke koneksi + database; run = langsung dijalankan (query baca: activity / info) */
async function openScript(c: ConnectionInfo, db: string, content: string, run = false) {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await conns.bind(doc.uri.toString(), { conn: c.name, db });
  await vscode.window.showTextDocument(doc, { preview: false });
  updateFileStatus();
  if (run) await runQuery();
}

/** Script as CREATE / ALTER / DROP / SELECT / INSERT / UPDATE / DELETE (SQL Server): tab baru, tidak dijalankan */
async function scriptAsCommand(n?: Node) {
  if (n?.kind !== 'obj') return;
  const d = drivers[n.c.type];
  const data = n.objKind === 'table' || n.objKind === 'view';
  const actions = [...(n.objKind === 'table' ? ['CREATE'] : ['CREATE', 'ALTER']), 'DROP', ...(data ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : [])]
    .filter((a) => !(a === 'INSERT' || a === 'UPDATE' || a === 'DELETE') || n.objKind === 'table');
  const action = await vscode.window.showQuickPick(actions, { title: `Script ${n.obj.schema ? `${n.obj.schema}.` : ''}${n.obj.name} as` });
  if (!action) return;
  try {
    const pw = await conns.password(n.c.name);
    let content: string;
    if (action === 'ALTER') content = await d.editScript!(n.c, pw, n.db, n.obj, n.objKind);
    else if (action === 'CREATE' && n.objKind !== 'table') content = await d.definition!(n.c, pw, n.db, n.obj, n.objKind);
    else if (action === 'CREATE' && d.createTableScript) content = await d.createTableScript(n.c, pw, n.db, n.obj);
    else {
      const [cols, pk] = data ? await Promise.all([d.columns(n.c, pw, n.db, n.obj), n.objKind === 'table' ? d.primaryKey(n.c, pw, n.db, n.obj) : Promise.resolve([])]) : [[], []];
      content = scriptAs(action.toLowerCase() as Parameters<typeof scriptAs>[0], n.obj, n.objKind, cols, pk);
    }
    await openScript(n.c, n.db, content);
  } catch (e) {
    log.error(`scriptAs ${action} - EXCEPTION CAUGHT | ${n.c.name} / ${n.db} / ${n.obj.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Script as ${action} failed: ${errMsg(e)}`);
  }
}

/** editor Columns per tabel (satu tab per koneksi / database / tabel) */
const columnPanels = new Map<string, vscode.WebviewPanel>();

/**
 * klik kanan tabel -> Columns: grid kolom bisa diedit, script ALTER tampil di SQL preview (seperti DBeaver);
 * Execute menjalankan script setelah konfirmasi, Open in SQL Editor = tab SQL tanpa dijalankan.
 */
function columnsEditor(n?: Node) {
  if (n?.kind !== 'obj' || !drivers[n.c.type].columnDdl) return;
  const { c: conn, db, obj } = n;
  const d = drivers[conn.type];
  const ddl = d.columnDdl!;
  const table = `${obj.schema ? `${obj.schema}.` : ''}${obj.name}`;
  const key = `${conn.name}\u0000${db}\u0000${table}`;
  const open = columnPanels.get(key);
  if (open) return open.reveal();
  const panel = trackPanel(conn.name, vscode.window.createWebviewPanel('moonageDaydream.columns', `Columns: ${table}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  columnPanels.set(key, panel);
  panel.onDidDispose(() => columnPanels.delete(key));
  panel.webview.html = columnsHtml(panel.webview.cspSource, { conn: conn.name, db, table }, !!conn.readOnly);
  const c = { ...conn, database: db }; // script memakai nama dua bagian: dijalankan di database tabel
  let original: ColumnDef[] = [];
  const post = (m: unknown) => void panel.webview.postMessage(m);
  async function load() {
    try {
      post({ type: 'status', text: 'Loading…' });
      const rs = (await d.run(c, await conns.password(conn.name), ddl.show(obj))).resultSets[0];
      const { cols, info } = showColumns(rs ?? { columns: [], rows: [] });
      original = cols;
      post({ type: 'load', cols, info, types: ddl.types, newType: ddl.newType });
    } catch (e) {
      log.error(`columnsEditor load - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${table}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      post({ type: 'status', text: `Load failed: ${errMsg(e)}`, error: true });
    }
  }
  panel.webview.onDidReceiveMessage(async (m: { type: string; rows?: ColumnRow[] }) => {
    if (m.type === 'ready' || m.type === 'refresh') return load();
    const r = columnChanges(ddl, obj, original, m.rows ?? []);
    if (m.type === 'change') return post({ type: 'script', ...r });
    if (!r.sql) return;
    if (m.type === 'open') return openScript(conn, db, r.sql);
    if (m.type !== 'execute' || conn.readOnly) return;
    const drops = (m.rows ?? []).filter((x) => x.deleted && x.orig).map((x) => x.orig);
    const ok = await vscode.window.showWarningMessage(`Apply ${r.count} column change(s) to ${table} on ${conn.name} / ${db}?`,
      { modal: true, detail: `${drops.length ? `Deleted columns lose their data: ${drops.join(', ')}.\n` : ''}The script in SQL preview is executed and committed.${ddl.note ? `\n${ddl.note}` : ''}` }, 'Execute');
    if (!ok) return;
    try {
      post({ type: 'status', text: 'Executing…' });
      await d.run(c, await conns.password(conn.name), r.sql);
      log.info(`columnsEditor execute: ${conn.name} / ${db} / ${table}: ${r.count} change(s)`);
      await load();
      post({ type: 'status', text: `Saved ${r.count} change(s)` });
      explorer.refresh();
    } catch (e) {
      log.error(`columnsEditor execute - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${table}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      post({ type: 'status', text: `Execute failed: ${errMsg(e)}`, error: true });
      vscode.window.showErrorMessage(`Columns: execute failed: ${errMsg(e)}`);
    }
  });
}

/** SQL Server Agent: start / stop job setelah konfirmasi */
async function jobCommand(n: Node | undefined, action: 'start' | 'stop') {
  if (n?.kind !== 'item') return;
  const ok = await vscode.window.showWarningMessage(`${action === 'start' ? 'Start' : 'Stop'} job "${n.label}" on ${n.c.name}?`, { modal: true }, action === 'start' ? 'Start' : 'Stop');
  if (!ok) return;
  try {
    await drivers[n.c.type].run(n.c, await conns.password(n.c.name), jobScript(action, n.label));
    log.info(`job ${action}: ${n.c.name} / ${n.label}`);
    vscode.window.showInformationMessage(`Job "${n.label}" ${action === 'start' ? 'started' : 'stop requested'}.`);
    explorer.refresh();
  } catch (e) {
    log.error(`jobCommand ${action} - EXCEPTION CAUGHT | ${n.c.name} / ${n.label}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`${action === 'start' ? 'Start' : 'Stop'} job failed: ${errMsg(e)}`);
  }
}

/** form New Database per koneksi (dibuka lagi = tab yang sama di-reveal) */
const newDbPanels = new Map<string, vscode.WebviewPanel>();

/** klik kanan koneksi / folder Databases -> New Database…: form tab, script live, Create (konfirmasi) atau Open in SQL Editor */
function newDatabase(n?: Node) {
  if ((n?.kind !== 'conn' && !(n?.kind === 'mfolder' && n.folder === 'databases')) || !drivers[n.c.type].newDatabase) return;
  const conn = n.c;
  const d = drivers[conn.type];
  const nd = d.newDatabase!;
  const open = newDbPanels.get(conn.name);
  if (open) return open.reveal();
  const panel = trackPanel(conn.name, vscode.window.createWebviewPanel('moonageDaydream.newDatabase', `New Database: ${conn.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  newDbPanels.set(conn.name, panel);
  panel.onDidDispose(() => newDbPanels.delete(conn.name));
  panel.webview.html = newDbHtml(panel.webview.cspSource, { conn: conn.name, type: d.label }, !!conn.readOnly);
  const post = (m: unknown) => void panel.webview.postMessage(m);
  // daftar pilihan bisa ribuan baris (collation SQL Server ~5500): stream tanpa batas MAX_ROWS
  const run = async (sql: string) => {
    const rows: unknown[][] = [];
    await d.stream(conn, await conns.password(conn.name), sql, undefined, { columns: () => undefined, row: (v) => { rows.push(v); } });
    return { resultSets: [{ rows }] };
  };
  panel.webview.onDidReceiveMessage(async (m: { type: string; name?: string; values?: Record<string, string> }) => {
    if (m.type === 'ready') {
      const fields = await Promise.all(nd.fields.map(async ({ items, ...f }) => {
        try {
          return { ...f, items: items ? await items(run) : [] };
        } catch (e) {
          // daftar dari server gagal (mis. izin): isian tetap bisa diketik bebas
          log.error(`newDatabase options - EXCEPTION CAUGHT | ${conn.name} / ${f.key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
          return { ...f, items: [] };
        }
      }));
      return post({ type: 'init', fields });
    }
    const name = (m.name ?? '').trim();
    const r = newDatabaseScript(nd, name, m.values ?? {});
    if (m.type === 'change') return post({ type: 'script', ...r });
    if (!r.sql) return;
    if (m.type === 'open') return openScript(conn, conn.database || d.defaultDb, r.sql);
    if (m.type !== 'create' || conn.readOnly) return;
    const ok = await vscode.window.showWarningMessage(`Create database ${name} on ${conn.name}?`, { modal: true, detail: r.sql }, 'Create');
    if (!ok) return;
    try {
      post({ type: 'status', text: 'Creating…' });
      await d.run(conn, await conns.password(conn.name), r.sql);
      log.info(`newDatabase: ${conn.name} / ${name}`);
      explorer.refresh();
      vscode.window.showInformationMessage(`Database ${name} created on ${conn.name}.`);
      panel.dispose();
    } catch (e) {
      log.error(`newDatabase execute - EXCEPTION CAUGHT | ${conn.name} / ${name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      post({ type: 'status', text: `Create failed: ${errMsg(e)}`, error: true });
      vscode.window.showErrorMessage(`New Database failed: ${errMsg(e)}`);
    }
  });
}

/** KILL session (SQL Server) setelah konfirmasi; id dari input, divalidasi angka */
async function killCommand(n?: Node) {
  if (n?.kind !== 'conn') return;
  const id = await vscode.window.showInputBox({ title: `Kill session on ${n.c.name}`, prompt: 'Session id (session_id in Activity Monitor)', validateInput: (v) => {
    try { killScript(v); return undefined; } catch (e) { return errMsg(e); } // pesan validasi di input box, bukan error
  } });
  if (!id) return;
  const ok = await vscode.window.showWarningMessage(`Kill session ${id} on ${n.c.name}? Its open transaction is rolled back.`, { modal: true }, 'Kill');
  if (!ok) return;
  try {
    await drivers[n.c.type].run(n.c, await conns.password(n.c.name), killScript(id));
    log.info(`kill session ${id}: ${n.c.name}`);
    vscode.window.showInformationMessage(`Session ${id} killed.`);
  } catch (e) {
    log.error(`killCommand - EXCEPTION CAUGHT | ${n.c.name} / ${id}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Kill session failed: ${errMsg(e)}`);
  }
}

/** Live Monitor (SQL Server): grafik + tabel dari MONITOR_SQL tiap interval; tidak menumpuk request, berhenti saat tab tersembunyi / ditutup */
function liveMonitor(n?: Node) {
  if (n?.kind !== 'conn' && n?.kind !== 'db') return;
  const node = n;
  const found = monitorKit(node.c.type);
  if (!found) return void vscode.window.showInformationMessage(`Live Monitor is not available for ${drivers[node.c.type].label}`);
  const kit = found; // tetap ter-narrow di dalam fungsi tick
  // klik kanan database = monitoring database itu saja; koneksi = seluruh server
  const db = node.kind === 'db' ? node.db : undefined;
  const parts = kit.parts(db);
  const title = db ? `${node.c.name} / ${db}` : node.c.name;
  // SQL Server: DMV dibaca dari master; MySQL / PostgreSQL: database koneksi (statistik server tetap terbaca)
  const c = node.c.type === 'mssql' ? { ...node.c, database: 'master' } : node.c;
  const d = drivers[node.c.type];
  const panel = trackPanel(node.c.name, vscode.window.createWebviewPanel('moonageDaydream.monitor', `Monitor: ${title}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  panel.webview.html = monitorHtml(panel.webview.cspSource, title, db !== undefined, kit);
  let interval = 5000;
  let paused = false;
  let disposed = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  let prev: { res: Record<string, ResultSet[] | Error>; t: number } | undefined;
  const schedule = () => {
    if (!disposed && !timer) timer = setTimeout(tick, interval);
  };
  async function tick() {
    timer = undefined;
    if (disposed) return;
    if (paused || !panel.visible || busy) return schedule(); // tersembunyi / pause: tidak ada query ke server
    busy = true;
    try {
      const pw = await conns.password(node.c.name);
      const res: Record<string, ResultSet[] | Error> = {};
      for (const part of parts) {
        try {
          res[part.id] = (await d.run(c, pw, part.sql)).resultSets;
        } catch (e) {
          if (!part.optional) throw e;
          // bagian opsional (performance_schema / pg_stat_statements tidak aktif): pesan di tab-nya, grafik tetap jalan
          log.error(`liveMonitor ${part.id} - EXCEPTION CAUGHT | ${node.c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
          res[part.id] = e instanceof Error ? e : new Error(String(e));
        }
      }
      const t = Date.now();
      const s = kit.sample(res, t, prev, db);
      prev = { res, t };
      void panel.webview.postMessage({ type: 'sample', ...s });
    } catch (e) {
      log.error(`liveMonitor - EXCEPTION CAUGHT | ${node.c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'error', message: (node.c.type === 'mssql' && permissionHint('monitor', e)) || errMsg(e) });
    } finally {
      busy = false;
      schedule();
    }
  }
  const restart = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    void tick();
  };
  panel.onDidChangeViewState(() => panel.visible && !paused && restart());
  panel.onDidDispose(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
  panel.webview.onDidReceiveMessage(async (m: { type: string; ms?: number; paused?: boolean; id?: string; tab?: string }) => {
    if (m.type === 'interval' && m.ms) {
      interval = Math.min(60000, Math.max(1000, m.ms));
      restart();
    } else if (m.type === 'pause') {
      paused = !!m.paused;
      if (!paused) restart();
    } else if (m.type === 'open' && m.tab && kit.query(m.tab, db)) {
      await openScript(node.c, c.database, kit.query(m.tab, db)!, true);
    } else if (m.type === 'kill' && m.id) {
      const ok = await vscode.window.showWarningMessage(`Kill session ${m.id} on ${node.c.name}? Its open transaction is rolled back.`, { modal: true }, 'Kill');
      if (!ok) return;
      try {
        await d.run(c, await conns.password(node.c.name), kit.kill(m.id));
        log.info(`kill session ${m.id} (live monitor): ${node.c.name}`);
        restart();
      } catch (e) {
        log.error(`liveMonitor kill - EXCEPTION CAUGHT | ${node.c.name} / ${m.id}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        vscode.window.showErrorMessage(`Kill session failed: ${errMsg(e)}`);
      }
    }
  });
  void tick();
}

/** Consul Dashboard: ringkasan cluster (saat dibuka / Refresh) + KV (Key & Value): browse folder, view nilai & metadata, edit, save, add, delete */
function consulDashboard(c: ConnectionInfo) {
  const panel = trackPanel(c.name, vscode.window.createWebviewPanel('moonageDaydream.consulDashboard', `Consul: ${c.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  panel.webview.html = consulDashboardHtml(panel.webview.cspSource, c.database ? `${c.name} / ${c.database}` : c.name);
  let cachedClient: ConsulClient | undefined;
  const getClient = async () => {
    if (!cachedClient) cachedClient = new ConsulClient(consulTarget(c), await conns.password(c.name));
    return cachedClient;
  };

  async function cluster() {
    try {
      void panel.webview.postMessage({ type: 'cluster', data: await dashboardData(await getClient()) });
    } catch (e) {
      log.error(`consulDashboard cluster - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'clusterError', message: errMsg(e) });
    }
  }

  /** KV browse: list folders + keys satu level di bawah prefix secara instan (1 request) */
  async function kvBrowse(prefix: string) {
    try {
      const client = await getClient();
      const allKeys = await client.keys(prefix);
      const { folders, keys: leafKeys } = kvChildren(allKeys, prefix);
      void panel.webview.postMessage({ type: 'kv', prefix, folders, keys: leafKeys.map((key) => ({ key, value: '' })) });
    } catch (e) {
      log.error(`consulDashboard kvBrowse - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'kvError', message: errMsg(e) });
    }
  }

  /** KV get value: ambil satu key dengan metadata lengkap saat diklik */
  async function kvGetValue(key: string) {
    try {
      const client = await getClient();
      const entry = await client.get(key);
      if (!entry) {
        void panel.webview.postMessage({ type: 'kvValue', key, error: `Key "${key}" not found` });
        return;
      }
      const format = detectFormat(entry.value);
      const size = Buffer.byteLength(entry.value, 'utf8');
      void panel.webview.postMessage({
        type: 'kvValue', key: entry.key, value: entry.value, flags: entry.flags, modifyIndex: entry.modifyIndex, session: entry.session,
        format, size: size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`,
      });
    } catch (e) {
      log.error(`consulDashboard kvGetValue - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'kvValue', key, error: errMsg(e) });
    }
  }

  /** KV save: simpan perubahan / buat key baru dengan validasi format, backup, dan CAS */
  async function kvSave(key: string, value: string, cas: number, isNew?: boolean) {
    if (c.readOnly) {
      void panel.webview.postMessage({ type: 'kvSaveResult', success: false, key, error: `Connection "${c.name}" is read-only` });
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Save "${key}" to Consul?`, {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\n${isNew ? 'New key.' : 'The current value is backed up first.'} The change is applied at once (Consul has no transactions).`,
    }, 'Save');
    if (ok !== 'Save') {
      void panel.webview.postMessage({ type: 'kvSaveResult', success: false, key, error: 'Save cancelled' });
      return;
    }
    try {
      const client = await getClient();
      const r = await saveKv(client, key, value, cas, backupWriter(extCtx, c.name, key));
      const updated = await client.get(key);
      const size = Buffer.byteLength(value, 'utf8');
      const format = detectFormat(value);
      void panel.webview.postMessage({
        type: 'kvSaveResult',
        success: true,
        key,
        modifyIndex: updated?.modifyIndex ?? 0,
        size: size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`,
        format,
        isNew: !!isNew,
      });
      explorer.refresh();
      vscode.window.showInformationMessage(`Saved "${key}" to Consul.${r.backup ? ` Backup: ${r.backup}` : ''}`);
    } catch (e) {
      log.error(`consulDashboard kvSave - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      vscode.window.showErrorMessage(`Save failed: ${errMsg(e)}`);
      void panel.webview.postMessage({ type: 'kvSaveResult', success: false, key, error: errMsg(e) });
    }
  }

  /** KV delete: hapus key setelah konfirmasi dan backup */
  async function handleKvDelete(key: string) {
    if (c.readOnly) {
      vscode.window.showWarningMessage(`The connection "${c.name}" is read-only`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Delete key "${key}" from Consul?`, {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\nExisting value is backed up first (consul kv export format).`,
    }, 'Delete');
    if (ok !== 'Delete') return;
    try {
      const client = await getClient();
      const r = await deleteKv(client, key, backupWriter(extCtx, c.name, key));
      log.info(`consul dashboard delete ${c.name} / ${key}: backup ${r.backup ?? '-'}`);
      vscode.window.showInformationMessage(`Deleted "${key}" from Consul.${r.backup ? ` Backup: ${r.backup}` : ''}`);
      void panel.webview.postMessage({ type: 'kvDeleteResult', success: true, key });
      explorer.refresh();
    } catch (e) {
      log.error(`consulDashboard kvDelete - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      vscode.window.showErrorMessage(`Delete failed: ${errMsg(e)}`);
      void panel.webview.postMessage({ type: 'kvDeleteResult', success: false, key, error: errMsg(e) });
    }
  }

  panel.webview.onDidReceiveMessage((m: { type: string; prefix?: string; key?: string; value?: string; cas?: number; isNew?: boolean }) => {
    if (m.type === 'cluster') {
      void cluster();
    } else if (m.type === 'kvBrowse') {
      void kvBrowse(m.prefix ?? '');
    } else if (m.type === 'kvGetValue' && m.key) {
      void kvGetValue(m.key);
    } else if (m.type === 'kvSave' && m.key !== undefined && m.value !== undefined) {
      void kvSave(m.key, m.value, m.cas ?? 0, m.isNew);
    } else if (m.type === 'kvDelete' && m.key) {
      void handleKvDelete(m.key);
    } else if (m.type === 'kvOpenEditor' && m.key) {
      void openConsulKey(c, m.key).catch((e: unknown) => {
        log.error(`consulDashboard kvOpenEditor - EXCEPTION CAUGHT | ${c.name} / ${m.key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        vscode.window.showErrorMessage(`Open key failed: ${errMsg(e)}`);
      });
    }
  });
}

/** Backup / Restore (SQL Server): script di tab baru ke folder backup default server, dijalankan sendiri */
async function backupCommand(n: Node | undefined, action: 'backup' | 'restore') {
  if (n?.kind !== 'db') return;
  try {
    const pw = await conns.password(n.c.name);
    const r = await drivers[n.c.type].run(n.c, pw, "SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(4000)) AS dir");
    const dir = String(r.resultSets[0]?.rows[0]?.[0] ?? '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 13);
    if (action === 'backup') return void await openScript(n.c, 'master', backupScript(n.db, dir, stamp));
    const file = await vscode.window.showInputBox({ title: `Restore ${n.db}`, prompt: 'Backup file on the server', value: `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${n.db}.bak` });
    if (file) await openScript(n.c, 'master', restoreScript(n.db, file));
  } catch (e) {
    log.error(`backupCommand ${action} - EXCEPTION CAUGHT | ${n.c.name} / ${n.db}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`${action === 'backup' ? 'Backup' : 'Restore'} script failed: ${errMsg(e)}`);
  }
}

async function objectScript(n: Node | undefined, mode: 'show' | 'edit' | 'run') {
  if (n?.kind !== 'obj') return;
  const d = drivers[n.c.type];
  try {
    const pw = await conns.password(n.c.name);
    let content: string;
    let params = 0;
    if (mode === 'run') {
      if (!d.runScript) throw new Error(`Run procedure is not available for ${d.label}`);
      ({ sql: content, params } = await d.runScript(n.c, pw, n.db, n.obj));
    } else {
      const f = mode === 'edit' ? d.editScript : d.definition;
      if (!f) throw new Error(`Object definitions are not available for ${d.label}`);
      content = await f(n.c, pw, n.db, n.obj, n.objKind);
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await conns.bind(doc.uri.toString(), { conn: n.c.name, db: n.db });
    await vscode.window.showTextDocument(doc, { preview: false });
    updateFileStatus();
    log.info(`objectScript ${mode}: ${n.c.name} / ${n.db} / ${n.obj.schema}.${n.obj.name}`);
    if (mode === 'run' && !params) await runQuery(); // tanpa argumen: tidak ada yang perlu diisi, langsung jalan seperti Select Top
  } catch (e) {
    log.error(`objectScript ${mode} - EXCEPTION CAUGHT | ${n.c.name} / ${n.db} / ${n.obj.schema}.${n.obj.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`${mode === 'run' ? 'Run procedure' : mode === 'edit' ? 'Edit' : 'Show definition'} failed: ${errMsg(e)}`);
  }
}

/** klik kanan group / koneksi: konfirmasi Auto-commit On / Off (koneksi juga: ikut group) */
async function autoCommitConfirmCommand(n?: Node) {
  if (n?.kind !== 'group' && n?.kind !== 'conn') return;
  const groups = conns.groupSettings();
  const current = n.kind === 'group' ? groups[n.group]?.confirmAutoCommit : n.c.confirmAutoCommit;
  const items: (vscode.QuickPickItem & { value: boolean | undefined })[] = [
    { label: 'On', description: 'ask before INSERT / UPDATE / DELETE / DDL / EXEC run in Auto-commit', value: true },
    { label: 'Off', description: 'run them without asking', value: false },
    ...(n.kind === 'conn' ? [{ label: 'Same as group', description: n.c.group ? `group "${n.c.group}": ${confirmAutoCommit({ ...n.c, confirmAutoCommit: undefined }, groups) ? 'On' : 'Off'}` : 'no group: On', value: undefined }] : []),
  ];
  for (const i of items) if (i.value === current || (n.kind === 'group' && current === undefined && i.value === true)) i.picked = true, i.label = `$(check) ${i.label}`;
  const pick = await vscode.window.showQuickPick(items, { title: `Auto-commit confirmation for ${n.kind === 'group' ? `group "${n.group}"` : `connection "${n.c.name}"`}` });
  if (!pick) return;
  if (n.kind === 'group') await conns.setGroupConfirm(n.group, pick.value === true ? undefined : pick.value);
  else await conns.setConfirm(n.c.name, pick.value);
  log.info(`autoCommitConfirm ${n.kind === 'group' ? `group ${n.group}` : `connection ${n.c.name}`}: ${pick.value ?? 'same as group'}`);
  explorer.refresh();
}

/** koneksi DBCode (setting dbcode.connections) -> Connections; password ditanya saat pertama dipakai */
async function importFromDbcode() {
  const list = vscode.workspace.getConfiguration('dbcode').get<unknown[]>('connections', []);
  if (!Array.isArray(list) || !list.length) return void vscode.window.showInformationMessage('No DBCode connections found (setting "dbcode.connections").');
  const { conns: found, skipped } = importDbcode(list, new Set(conns.list().map((c) => c.name)));
  const picked = found.length ? await vscode.window.showQuickPick(found.map((c) => ({
    label: c.name, description: `${drivers[c.type].label} · ${address(c)}`, detail: c.group, picked: true, c,
  })), { canPickMany: true, title: `Import ${found.length} connection(s) from DBCode (passwords are asked on first use)` }) : [];
  if (!picked?.length) {
    if (skipped.length) vscode.window.showInformationMessage(`Nothing to import. Skipped: ${skipped.join(', ')}`);
    return;
  }
  await conns.addMany(picked.map((p) => p.c));
  log.info(`importFromDbcode: ${picked.length} imported, skipped: ${skipped.join(', ') || '-'}`);
  explorer.refresh();
  vscode.window.showInformationMessage(`Imported ${picked.length} connection(s) from DBCode.${skipped.length ? ` Skipped: ${skipped.join(', ')}` : ''}`);
}

function editConnection(old?: ConnectionInfo, group?: string) {
  openConnectionForm(conns, log, saveConnection, old, group);
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
    : statementAt(doc.getText(), doc.offsetAt(editor.selection.active), dialectOf(doc.uri));
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
          const rows = {
            columns: () => undefined,
            row: (v: unknown[]) => {
              if (++n % 10000 === 0) progress.report({ message: `${n.toLocaleString()} rows` });
              if (toClipboard && n > CLIPBOARD_MAX_ROWS) throw new Error(`More than ${CLIPBOARD_MAX_ROWS.toLocaleString()} rows: too many for the clipboard, use Save`);
              return sink.row(pick(v));
            },
          };
          const tx = openTx(src!.uri, c);
          n = await (tx ? tx.stream(sql, ac.signal, rows) : drivers[c.type].stream(c, await conns.password(c.name), sql, ac.signal, rows));
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

/** "rows affected" diberi statement asalnya (judul Statement n di panel hasil) */
const withAffected = (r: QueryResult, stmts: string[]) => ({ ...r, affected: affectedStatements(stmts, r.rowsAffected.length) });

/** dialek koneksi file (pemecah statement: body procedure / function utuh); tanpa koneksi = aturan umum */
const dialectOf = (uri: vscode.Uri) => {
  const c = fileConn(uri);
  return c && drivers[c.type].dialect;
};

let consulFs: ConsulFs;

/** panel Live Monitor / Dashboard per koneksi (Disconnect menutupnya; koneksi dianggap connected selama ada) */
const connPanels = new Map<string, Set<vscode.WebviewPanel>>();
function trackPanel(conn: string, p: vscode.WebviewPanel): vscode.WebviewPanel {
  const set = connPanels.get(conn) ?? new Set();
  connPanels.set(conn, set.add(p));
  p.onDidDispose(() => {
    set.delete(p);
    refreshConnState();
  });
  return p;
}
/** Consul (HTTP, tanpa pool): connected sejak Connect sampai Disconnect */
const consulUp = new Set<string>();
const lastUsed = new Map<string, number>();

/** status "connected": pool / client driver terbuka, sesi transaksi, panel monitor, atau Consul yang di-Connect */
function isConnected(c: ConnectionInfo): boolean {
  return !!drivers[c.type].isOpen?.(c.name) || [...txs.values()].some((t) => t.conn === c.name)
    || (connPanels.get(c.name)?.size ?? 0) > 0 || consulUp.has(c.name);
}

// explorer diperbarui hanya bila daftar koneksi yang connected berubah (pool terbuka sesudah password diambil)
/** nama koneksi yang connected saat refresh terakhir; undefined = paksa refresh */
let connSnapshot: string | undefined = '';
let connTimer: NodeJS.Timeout | undefined;
function refreshConnState(delay = 1500) {
  if (connTimer) clearTimeout(connTimer);
  connTimer = setTimeout(() => {
    const now = conns.list().filter(isConnected).map((c) => c.name).join('\n');
    if (now !== connSnapshot) {
      connSnapshot = now;
      explorer.refresh();
    }
  }, delay);
}
function touchConn(name: string) {
  lastUsed.set(name, Date.now());
  refreshConnState();
}

/** Connect: buka koneksi (pool tetap terbuka) + cek login; Consul = leader */
async function connectCommand(c: ConnectionInfo) {
  try {
    const pw = await conns.password(c.name);
    const t = Date.now();
    let info: string;
    if (c.type === 'consul') {
      info = `leader ${await new ConsulClient(consulTarget(c), pw).leader()}`;
      consulUp.add(c.name);
    } else {
      const r = await drivers[c.type].run(c, pw, drivers[c.type].testSql);
      info = (r.resultSets[0]?.rows[0] ?? []).map(String).join(' / ');
    }
    log.info(`connect ${c.name}: ${info}`);
    refreshConnState(0);
    vscode.window.showInformationMessage(`Connected to ${c.name}${info ? ` (${info})` : ''} in ${Date.now() - t} ms`);
  } catch (e) {
    log.error(`connect - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Connect to ${c.name} failed: ${errMsg(e)}`);
  }
}

/**
 * Disconnect: transaksi Manual commit yang masih terbuka ditanya Commit / Rollback dulu (Cancel = tidak jadi), query berjalan
 * dibatalkan, panel monitor / dashboard ditutup, pool / client driver ditutup. quiet = auto disconnect idle (tanpa dialog).
 */
async function disconnect(c: ConnectionInfo, quiet = false): Promise<boolean> {
  const mine = [...txs].filter(([, t]) => t.conn === c.name);
  const open = mine.filter(([, t]) => t.session.open);
  let how: 'commit' | 'rollback' = 'rollback';
  if (open.length) {
    if (quiet) return false;
    const pick = await vscode.window.showWarningMessage(`${c.name} has ${open.length} open transaction(s) (${open.reduce((n, [, t]) => n + t.statements, 0)} run(s)).`,
      { modal: true, detail: 'Commit or roll back before disconnecting.' }, 'Commit', 'Rollback');
    if (!pick) return false;
    how = pick === 'Commit' ? 'commit' : 'rollback';
  }
  for (const [key, t] of mine) {
    await closeTx(key, t, t.session.open ? how : 'rollback').catch((e: unknown) =>
      log.error(`disconnect closeTx - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`));
  }
  for (const q of running.values()) if (q.conn === c.name) cancel(q);
  for (const p of [...(connPanels.get(c.name) ?? [])]) p.dispose();
  await closePool(c);
  consulUp.delete(c.name);
  lastUsed.delete(c.name);
  log.info(`disconnect ${c.name}${quiet ? ' (idle)' : ''}${open.length ? ` (${how} ${open.length} transaction(s))` : ''}`);
  updateFileStatus();
  explorer.collapse(c.name);
  connSnapshot = undefined;
  refreshConnState(0);
  // idle: tanpa popup (tidak diklik user), cukup status bar
  if (quiet) vscode.window.setStatusBarMessage(`$(debug-disconnect) Disconnected from ${c.name} (idle)`, 5000);
  else vscode.window.showInformationMessage(`Disconnected from ${c.name}`);
  return true;
}

/** auto disconnect koneksi yang idle (setting connection.idleDisconnectMinutes, 0 = mati), dicek tiap menit */
function idleWatcher(): vscode.Disposable {
  const t = setInterval(() => {
    const minutes = vscode.workspace.getConfiguration('moonageDaydream.connection').get<number>('idleDisconnectMinutes', 0);
    const busy = new Set([...[...running.values()].map((q) => q.conn), ...[...txs.values()].filter((x) => x.session.open).map((x) => x.conn),
      ...[...connPanels].filter(([, s]) => s.size).map(([n]) => n)]);
    for (const name of idleConnections(Date.now(), lastUsed, minutes, (n) => { const c = conns.get(n); return !!c && isConnected(c); }, busy)) {
      const c = conns.get(name);
      if (c) void disconnect(c, true);
    }
  }, 60_000);
  return new vscode.Disposable(() => clearInterval(t));
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

/** sesi transaksi terbuka file key untuk Load more / Export All Data (lihat openSession) */
const openTx = (key: string, c: ConnectionInfo) => openSession(txs.get(key), c, running.has(key));

/** PostgreSQL: error di dalam transaksi -> transaksi aborted, semua statement ditolak sampai ROLLBACK */
async function warnAborted(key: string) {
  const pick = await vscode.window.showWarningMessage(
    'The transaction is aborted after an error: every statement is refused until it is rolled back (nothing can be committed).', 'Rollback');
  if (pick) await endTransaction('rollback', key);
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
  return { doc, text: editor.selection.isEmpty ? statementAt(doc.getText(), doc.offsetAt(editor.selection.active), dialectOf(doc.uri)) : doc.getText(editor.selection) };
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
  const stmts = splitBatches(t.text).flatMap((b) => splitStatements(b, dialectOf(t.doc.uri)));
  if (mode === 'actual' && !stmts.every((st) => singleSelect([st]))) {
    vscode.window.showWarningMessage('Analyze runs the query, so it is only available for SELECT. Use Explain for other statements.');
    return;
  }
  const c = fileConn(t.doc.uri) ?? (await pickConnection('Select connection'));
  if (!c) return;
  const key = t.doc.uri.toString();
  // Analyze menjalankan query di koneksi lain (transaksi yang selalu di-rollback): baris yang dikunci transaksi file ini membuatnya menunggu
  if (mode === 'actual' && txs.get(key)?.session.open) {
    vscode.window.showWarningMessage('Commit or roll back the open transaction before Analyze (it runs on another connection and would wait for this transaction\'s locks). Explain is still available.');
    return;
  }
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
    const tx = openTx(src.uri, c);
    const next = (await (tx ? tx.run(sql, undefined, offset + PAGE_ROWS, offset)
      : drivers[c.type].run(c, await conns.password(c.name), sql, undefined, offset + PAGE_ROWS, offset))).resultSets[0];
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
  // Permissions: koneksi read-only tidak pernah mengirim statement yang bisa mengubah data ke server
  const blocked = c.readOnly ? readOnlyBlocked(drivers[c.type].dialect, splitBatches(text).flatMap((b) => splitStatements(b, drivers[c.type].dialect))) : undefined;
  if (blocked) {
    log.info(`runQuery blocked (read-only connection ${c.name}): ${preview(text)}`);
    await results.show(c.database ? `${c.name} / ${c.database}` : c.name, { error: blocked, uri: key });
    return;
  }
  // Auto-commit: statement pengubah data langsung permanen -> konfirmasi dulu (bisa dimatikan per group / koneksi)
  const changing = txMode(key) === 'auto' && confirmAutoCommit(c, conns.groupSettings())
    ? changingStatement(drivers[c.type].dialect, splitBatches(text).flatMap((b) => splitStatements(b, drivers[c.type].dialect))) : undefined;
  if (changing) {
    const ok = await vscode.window.showWarningMessage('You are running in Auto-commit mode. Data changes are saved permanently and cannot be rolled back.', {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\n${preview(changing)}\n\nSwitch the file to Manual commit to review changes before committing, or turn this confirmation off for the connection / group (right-click in Connections).`,
    }, 'Confirm');
    if (ok !== 'Confirm') return void log.info(`runQuery cancelled at the Auto-commit confirmation: ${c.name} / ${c.database}`);
  }
  const { q, ac, end } = startRun(key, c, text);
  log.info(`runQuery start: ${c.name} / ${c.database}`);
  const title = c.database ? `${c.name} / ${c.database}` : c.name;
  // beberapa SELECT tanpa variabel / #temp: tiap statement di koneksi sendiri, hasil tampil begitu statement itu selesai
  const stmts = splitBatches(text).flatMap((b) => splitStatements(b, drivers[c.type].dialect));
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
            const wasOpen = tx.session.open;
            const result = withAffected(await tx.session.run(text, ac.signal, limitFor(stmts)), stmts);
            outcome = { result, source: src };
            if (tx.session.open) tx.statements++;
            // SELECT biasa tanpa transaksi terbuka memang tidak membuka transaksi: bukan transaksi yang berakhir
            else if (wasOpen || !readOnly(stmts)) {
              const how = txEndStatement(stmts, drivers[c.type].dialect);
              if (how) {
                // COMMIT / ROLLBACK ditulis di script (atau DDL MySQL = implicit commit) dan berhasil: hasil yang jelas, bukan peringatan
                const msg = how === 'commit' ? 'Transaction committed.' : how === 'rollback' ? 'Transaction rolled back.'
                  : 'Transaction committed implicitly by a DDL statement (MySQL / MariaDB): changes made before it are saved.';
                result.messages.push(msg);
                log.info(`transaction ${how} by the script (${tx.statements + 1} run(s)): ${tx.conn} / ${tx.db}`);
                vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
                tx.statements = 0;
              } else {
                vscode.window.showWarningMessage('The transaction was rolled back by the server (error or cancel); nothing was committed.');
              }
            }
            return;
          }
          outcome = { result: withAffected(await drivers[c.type].run(c, pw, text, ac.signal, limitFor(stmts)), stmts), source: src };
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
    if (manual) {
      updateFileStatus(); // status TX open (n) / lens Commit Rollback
      if (txs.get(key)?.session.failed) void warnAborted(key);
    }
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

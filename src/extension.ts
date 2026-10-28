import * as vscode from 'vscode';
import { Connections } from './connections';
import { Explorer, Node } from './explorer';
import { History, HistoryEntry, RunningQuery, RunningView } from './activity';
import { openConnectionForm } from './connectionForm';
import { ConnectionInfo, address, drivers } from './db';
import { Results, LOCATIONS, VIEW_ID } from './results';
import { SqlFiles, SqlNode, newSqlFile } from './sqlFiles';
import { SqlCompletion } from './completion';
import type { Outcome } from './resultsHtml';
import { splitBatches } from './mssql';
import { parallelSafe, splitStatements } from './sqlContext';

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

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

export function activate(ctx: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Moonage Daydream', { log: true });
  conns = new Connections(ctx);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'moonageDaydream.selectConnection';
  explorer = new Explorer(conns, log);
  sqlFiles = new SqlFiles(ctx.globalState, conns, log);
  completion = new SqlCompletion(conns, fileConn, log);
  updateStatus();
  status.show();
  results = new Results(ctx);
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
      if (e && (await openHistory(e))) await runQuery();
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
    vscode.commands.registerCommand('moonageDaydream.cancelQuery', cancelQuery),
    vscode.commands.registerCommand('moonageDaydream.setFileConnection', setFileConnection),
    vscode.commands.registerCommand('moonageDaydream.setFileDatabase', setFileDatabase),
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completion, '.'),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, { onDidChangeCodeLenses: lensChanged.event, provideCodeLenses }),
    vscode.window.onDidChangeActiveTextEditor(updateFileStatus),
    vscode.window.registerWebviewViewProvider(VIEW_ID, results),
    vscode.window.registerTreeDataProvider('moonageDaydream.explorer', explorer),
    vscode.commands.registerCommand('moonageDaydream.refreshExplorer', (n?: Node) => {
      completion.clear(); // tabel baru juga muncul di autocomplete
      explorer.refresh(n);
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
  for (const c of conns?.list() ?? []) await closePool(c);
}

/** .sql dibuat / dihapus / di-rename (termasuk dari luar VS Code): scan ulang SQL Files */
function sqlWatcher(): vscode.Disposable {
  const w = vscode.workspace.createFileSystemWatcher('**/*.sql', false, true, false);
  const refresh = () => sqlFiles.refresh();
  return vscode.Disposable.from(w, w.onDidCreate(refresh), w.onDidDelete(refresh), vscode.workspace.onDidChangeWorkspaceFolders(refresh));
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
  status.text = `$(database) ${c ? `${c.name}${c.database ? ` / ${c.database}` : ''}` : 'No connection'}`;
  status.tooltip = c ? `${drivers[c.type].label} ${c.user}@${address(c)}/${c.database} (click to switch)` : 'Select a connection';
  status.command = uri ? 'moonageDaydream.setFileConnection' : 'moonageDaydream.selectConnection';
}

function provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  const r = new vscode.Range(0, 0, 0, 0);
  const c = fileConn(doc.uri);
  const q = running.get(doc.uri.toString());
  return [
    !q
      ? new vscode.CodeLens(r, { title: '$(play) Execute', command: 'moonageDaydream.runQuery' })
      : q.cancelling
        ? new vscode.CodeLens(r, { title: '$(loading~spin) Cancelling…', command: 'moonageDaydream.cancelQuery', arguments: [doc.uri] })
        : new vscode.CodeLens(r, { title: '$(debug-stop) Cancel', command: 'moonageDaydream.cancelQuery', arguments: [doc.uri] }),
    new vscode.CodeLens(r, { title: `$(server) ${c?.name ?? 'Select connection'}`, command: 'moonageDaydream.setFileConnection', arguments: [doc.uri] }),
    new vscode.CodeLens(r, { title: `$(database) ${c?.database || 'default database'}`, command: 'moonageDaydream.setFileDatabase', arguments: [doc.uri] }),
  ];
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

async function runQuery() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  if (!text.trim()) return;

  const uri = editor.document.uri;
  const c = fileConn(uri) ?? (await pickConnection('Select connection to run on'));
  if (!c) return;
  if (!conns.binding(uri.toString())) {
    await conns.bind(uri.toString(), { conn: c.name }); // file terikat ke koneksi saat pertama kali dijalankan
    if (conns.active !== c.name) await conns.setActive(c.name);
    updateFileStatus();
  }

  const key = uri.toString();
  const prev = running.get(key);
  if (prev) cancel(prev); // jalankan ulang file yang masih jalan: query lama dihentikan
  const ac = new AbortController();
  const q: RunningQuery = { ac, uri: key, conn: c.name, db: c.database, sql: text, start: Date.now() };
  let finish = () => {};
  q.done = new Promise<void>((r) => (finish = r));
  running.set(key, q);
  log.info(`runQuery start: ${c.name} / ${c.database}`);
  lensChanged.fire();
  runningView.refresh();
  const title = c.database ? `${c.name} / ${c.database}` : c.name;
  // beberapa SELECT tanpa variabel / #temp: tiap statement di koneksi sendiri, hasil tampil begitu statement itu selesai
  const stmts = splitBatches(text).flatMap(splitStatements);
  let outcome: Outcome = parallelSafe(stmts)
    ? { parts: stmts.map((sql) => ({ sql, o: { loading: true } })), uri: key, start: q.start }
    : { loading: true, uri: key };
  await results.show(title, outcome); // spinner sampai hasil (atau error / cancel) menggantikannya

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Running query on ${title}…` },
      async () => {
        const pw = await conns.password(c.name);
        const o = outcome;
        if (!('parts' in o)) {
          outcome = { result: await drivers[c.type].run(c, pw, text, ac.signal) };
          return;
        }
        const acs = (q.parts = o.parts.map(() => new AbortController()));
        ac.signal.addEventListener('abort', () => acs.forEach((a) => a.abort()));
        await Promise.all(o.parts.map(async (part, i) => {
          try {
            part.o = { result: await drivers[c.type].run(c, pw, part.sql, acs[i].signal) };
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
    outcome = { error: ac.signal.aborted ? 'Query cancelled.' : errMsg(e) };
  } finally {
    finish();
    log.info(`runQuery end after ${Date.now() - q.start} ms${ac.signal.aborted ? ' (cancelled)' : ''}: ${c.name} / ${c.database}`);
    if (running.get(key) === q) running.delete(key);
    lensChanged.fire();
    runningView.refresh();
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

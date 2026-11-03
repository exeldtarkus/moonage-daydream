// Find Object: Quick Pick berisi database + tabel / view / procedure satu koneksi, terisi bertahap
import * as vscode from 'vscode';
import { ConnectionInfo, DbObject, ListKind, drivers } from './db';
import type { Connections } from './connections';
import type { Node } from './explorer';
import { loadObjects } from './treeFilter';
import { showError } from './gridEdit';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

const KINDS: ListKind[] = ['table', 'view', 'procedure'];
const ICON: Record<ListKind | 'db', string> = { db: 'database', table: 'table', view: 'eye', procedure: 'symbol-method' };
type Pick = vscode.QuickPickItem & { node: Node };

/** pilih tabel / view = Select Top 100, procedure = Show Definition (bila driver punya), database = New Query di database itu */
export async function findObject(conns: Connections, log: vscode.LogOutputChannel, n?: Node): Promise<void> {
  let c: ConnectionInfo | undefined = n?.kind === 'conn' || n?.kind === 'db' ? n.c : undefined;
  if (!c) {
    const list = conns.list().filter((x) => x.type !== 'consul');
    c = list.length === 1 ? list[0] : (await vscode.window.showQuickPick(list.map((x) => ({ label: x.name, description: drivers[x.type].label, c: x })),
      { title: 'Find Object', placeHolder: 'Search in which connection?' }))?.c;
  }
  if (!c || c.type === 'consul') return;
  const conn = c;
  const d = drivers[conn.type];
  const qp = vscode.window.createQuickPick<Pick>();
  qp.title = `Find Object · ${conn.name}${n?.kind === 'db' ? ` / ${n.db}` : ''}`;
  qp.placeholder = 'Type part of a database, table, view or procedure name';
  qp.matchOnDescription = true;
  qp.busy = true;
  let closed = false;
  const items: Pick[] = [];
  // Quick Pick diperbarui paling sering tiap 300 ms (ribuan objek)
  let timer: NodeJS.Timeout | undefined;
  const flush = () => { timer ??= setTimeout(() => { timer = undefined; qp.items = items; }, 300); };
  const failed: string[] = [];
  qp.onDidHide(() => { closed = true; qp.dispose(); });
  qp.onDidAccept(() => {
    const node = qp.selectedItems[0]?.node;
    qp.hide();
    if (!node) return;
    if (node.kind === 'db') void vscode.commands.executeCommand('moonageDaydream.newQueryForDb', node);
    else if (node.kind === 'obj' && node.objKind !== 'procedure') void vscode.commands.executeCommand('moonageDaydream.selectTop', node);
    else if (node.kind === 'obj' && d.definition) void vscode.commands.executeCommand('moonageDaydream.showDefinition', node);
  });
  qp.show();
  try {
    const pw = await conns.password(conn.name);
    // dari node database: hanya database itu; dari koneksi: semua database
    const dbs = n?.kind === 'db' ? [n.db] : await d.databases(conn, pw);
    for (const db of dbs) items.push({ label: `$(${ICON.db}) ${db}`, description: 'database', node: { kind: 'db', c: conn, db } });
    flush();
    // shortcut: semua objek semua database dimuat ke Quick Pick (bisa lambat / besar di server dengan ratusan database), batasi per database bila perlu
    await loadObjects(dbs, KINDS, (db, kind) => d.objects(conn, pw, db, kind), (db, kind, objs: DbObject[]) => {
      for (const obj of objs) {
        items.push({ label: `$(${ICON[kind]}) ${obj.schema ? `${obj.schema}.${obj.name}` : obj.name}`, description: `${db} · ${kind}`, node: { kind: 'obj', c: conn, db, objKind: kind, obj } });
      }
      flush();
    }, (db, e) => {
      log.error(`findObject ${conn.name} / ${db} - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      if (!failed.includes(db)) failed.push(db);
    }, () => closed);
  } catch (e) {
    log.error(`findObject ${conn.name} - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    qp.hide();
    showError(`Find Object failed: ${errMsg(e)}`);
    return;
  }
  if (closed) return;
  clearTimeout(timer);
  qp.items = items;
  qp.busy = false;
  if (failed.length) qp.placeholder = `Type to search · could not read: ${failed.join(', ')} (see log)`;
}

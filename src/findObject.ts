// Find Object (Ctrl+Alt+O): Quick Pick berisi semua koneksi + database + tabel / view / procedure dari cache metadata
import * as vscode from 'vscode';
import { ConnectionInfo, drivers } from './db';
import type { Connections } from './connections';
import type { Node } from './explorer';
import { MetaKind, readMeta } from './metaCache';
import { showError } from './gridEdit';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

const ICON: Record<MetaKind, string> = { db: 'database', table: 'table', view: 'eye', procedure: 'symbol-method' };
type Pick = vscode.QuickPickItem & { node: Node };

export interface FindDeps {
  conns: Connections;
  log: vscode.LogOutputChannel;
  /** folder cache metadata (lihat metaCache.ts) */
  dir: string;
  /** baca ulang metadata satu koneksi ke cache */
  refresh(c: ConnectionInfo): Promise<unknown>;
  /** sorot node terpilih di view Connections */
  reveal(n: Node): Thenable<void>;
}

/**
 * tanpa node: semua koneksi dari cache (tanpa memilih koneksi, tanpa menghubungi server); dari node koneksi / database: hanya itu,
 * dan koneksi yang belum pernah di-cache dibaca dulu. Pilih koneksi = sorot, database = New Query, tabel / view = Select Top 100,
 * procedure = Show Definition; semuanya juga disorot di Connections.
 */
export async function findObject(deps: FindDeps, n?: Node): Promise<void> {
  const { conns, log } = deps;
  const scope = n?.kind === 'conn' || n?.kind === 'db' ? n : undefined;
  const qp = vscode.window.createQuickPick<Pick>();
  qp.title = scope ? `Find Object · ${scope.c.name}${scope.kind === 'db' ? ` / ${scope.db}` : ''}` : 'Find Object';
  qp.placeholder = 'Type part of a connection, database, table, view or procedure name';
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.onDidHide(() => qp.dispose());
  qp.onDidAccept(() => {
    const node = qp.selectedItems[0]?.node;
    qp.hide();
    if (!node) return;
    if (node.kind === 'db') void vscode.commands.executeCommand('moonageDaydream.newQueryForDb', node);
    else if (node.kind === 'obj' && node.objKind !== 'procedure') void vscode.commands.executeCommand('moonageDaydream.selectTop', node);
    else if (node.kind === 'obj' && drivers[node.c.type].definition) void vscode.commands.executeCommand('moonageDaydream.showDefinition', node);
    Promise.resolve(deps.reveal(node)).catch((e: unknown) => {
      // objek tetap dibuka; sorot gagal mis. karena tersembunyi oleh filter
      log.error(`findObject reveal - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    });
  });
  qp.show();
  try {
    let recs = await readMeta(deps.dir, scope?.c.name);
    if (scope && !recs.length) {
      qp.placeholder = `Reading the databases of ${scope.c.name}…`;
      await deps.refresh(scope.c);
      recs = await readMeta(deps.dir, scope.c.name);
    }
    const list = conns.list().filter((c) => c.type !== 'consul' && (!scope || c.name === scope.c.name));
    const byName = new Map(list.map((c) => [c.name, c]));
    const cached = new Set(recs.map((r) => r.conn));
    const items: Pick[] = scope?.kind === 'db' ? [] : list.map((c) => ({
      label: `$(server) ${c.name}`, description: `${drivers[c.type].label}${cached.has(c.name) ? '' : ' · not cached yet (connect to load its objects)'}`, node: { kind: 'conn', c },
    }));
    for (const r of recs) {
      const c = byName.get(r.conn); // koneksi sudah dihapus: record lama dilewati
      if (!c || (scope?.kind === 'db' && r.db !== scope.db)) continue;
      items.push(r.kind === 'db'
        ? { label: `$(${ICON.db}) ${r.db}`, description: `${c.name} · database`, node: { kind: 'db', c, db: r.db } }
        : { label: `$(${ICON[r.kind]}) ${r.schema ? `${r.schema}.${r.name}` : r.name}`, description: `${c.name} / ${r.db} · ${r.kind}`, node: { kind: 'obj', c, db: r.db, objKind: r.kind, obj: { schema: r.schema, name: r.name } } });
    }
    qp.items = items;
    qp.placeholder = 'Type part of a connection, database, table, view or procedure name';
  } catch (e) {
    log.error(`findObject - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    qp.hide();
    showError(`Find Object failed: ${errMsg(e)}`);
    return;
  }
  qp.busy = false;
}

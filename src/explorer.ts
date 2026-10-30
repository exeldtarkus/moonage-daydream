import * as vscode from 'vscode';
import type { Connections } from './connections';
import { ConnectionInfo, DbObject, ListKind, ObjectKind, address, confirmAutoCommit, drivers, objContext } from './db';
import { CONN_COLORS } from './connColor';
import { MS_DB, MS_SERVER, MS_TABLE, MS_TREE, MS_VIEW, permissionHint } from './mssqlTree';
import { monitorKit } from './monitorKits';
import { ConsulClient, consulTarget, kvChildren } from './consul';

export type Node =
  | { kind: 'group'; group: string }
  | { kind: 'conn'; c: ConnectionInfo }
  | { kind: 'db'; c: ConnectionInfo; db: string }
  | { kind: 'folder'; c: ConnectionInfo; db: string; objKind: ListKind }
  | { kind: 'obj'; c: ConnectionInfo; db: string; objKind: ObjectKind; obj: DbObject }
  // SQL Server Object Explorer (mssqlTree): folder dan item non-objek (login, endpoint, key, index ...)
  | { kind: 'mfolder'; c: ConnectionInfo; folder: string; db?: string; obj?: DbObject; full?: string }
  | { kind: 'item'; c: ConnectionInfo; folder: string; db?: string; label: string; description?: string; full: string }
  // Consul: key / folder KV (folder diakhiri /, '' = akar) dan Dashboard
  | { kind: 'kv'; c: ConnectionInfo; key: string }
  | { kind: 'consulDash'; c: ConnectionInfo }
  | { kind: 'col'; label: string; description: string }
  | { kind: 'msg'; label: string; error?: boolean };

const FOLDERS: { objKind: ListKind; label: string; icon: string }[] = [
  { objKind: 'table', label: 'Tables', icon: 'table' },
  { objKind: 'view', label: 'Views', icon: 'eye' },
  { objKind: 'procedure', label: 'Stored Procedures', icon: 'symbol-method' },
];
const ICONS: Record<ObjectKind, string> = { table: 'table', view: 'eye', procedure: 'symbol-method', function: 'symbol-function', trigger: 'zap' };
const icon = (k: ObjectKind) => ICONS[k];
const isMs = (c: ConnectionInfo) => c.type === 'mssql';

/** Sidebar: koneksi → database → Tables / Views / Stored Procedures → objek → kolom. */
export class Explorer implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** extensionUri: logo database di media/db/<type>.svg */
  constructor(private conns: Connections, private log: vscode.LogOutputChannel, private extensionUri?: vscode.Uri) {}

  /** status "connected" koneksi (diisi extension: pool / transaksi / panel terbuka) */
  connected: (c: ConnectionInfo) => boolean = () => false;
  /** id koneksi berganti setelah Disconnect -> VS Code menganggapnya item baru (collapsed), anak tidak dimuat ulang (pool tidak dibuka lagi) */
  private generation = new Map<string, number>();
  collapse(name: string) {
    this.generation.set(name, (this.generation.get(name) ?? 0) + 1);
  }

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState.Collapsed;
    switch (n.kind) {
      case 'group': {
        const count = this.conns.list().filter((c) => c.group === n.group).length;
        return Object.assign(new vscode.TreeItem(n.group, vscode.TreeItemCollapsibleState.Expanded), {
          id: `group:${n.group}`, description: `${count}${this.conns.groupSettings()[n.group]?.confirmAutoCommit === false ? ' · no commit confirm' : ''}`,
          iconPath: new vscode.ThemeIcon('folder-library'), contextValue: 'group',
        });
      }
      case 'conn': {
        const active = this.conns.active === n.c.name;
        return Object.assign(new vscode.TreeItem(n.c.name, C), {
          description: `${this.connected(n.c) ? '● connected · ' : ''}${drivers[n.c.type].label} · ${address(n.c)}${active ? ' · active' : ''}${n.c.type === 'consul' || confirmAutoCommit(n.c, this.conns.groupSettings()) ? '' : ' · no commit confirm'}`,
          tooltip: `${n.c.user}@${address(n.c)}/${n.c.database}`,
          // logo jenis database; warna koneksi lewat ConnDecorations (nama berwarna + ●)
          iconPath: this.extensionUri ? vscode.Uri.joinPath(this.extensionUri, 'media', 'db', `${n.c.type}.svg`)
            : new vscode.ThemeIcon(active ? 'vm-active' : 'server', n.c.color ? new vscode.ThemeColor(CONN_COLORS[n.c.color]) : undefined),
          resourceUri: connUri(n.c.name),
          id: `conn:${n.c.name}#${this.generation.get(n.c.name) ?? 0}`,
          // .on / .off: ikon inline Disconnect / Connect sesuai status
          contextValue: `${isMs(n.c) ? 'conn.mssql' : monitorKit(n.c.type) ? 'conn.live' : n.c.type === 'consul' ? 'conn.consul' : 'conn'}.${this.connected(n.c) ? 'on' : 'off'}`,
        });
      }
      case 'db':
        return Object.assign(new vscode.TreeItem(n.db, C), { iconPath: new vscode.ThemeIcon('database'), contextValue: isMs(n.c) ? 'db.mssql' : monitorKit(n.c.type) ? 'db.live' : 'db' });
      case 'folder': {
        const f = FOLDERS.find((x) => x.objKind === n.objKind)!;
        return Object.assign(new vscode.TreeItem(f.label, C), { iconPath: new vscode.ThemeIcon('folder') });
      }
      case 'kv': {
        const folder = n.key.endsWith('/');
        const label = n.key.replace(/\/$/, '').split('/').pop()!;
        return Object.assign(new vscode.TreeItem(label, folder ? C : vscode.TreeItemCollapsibleState.None), {
          iconPath: new vscode.ThemeIcon(folder ? 'folder' : 'key'), contextValue: folder ? 'kvFolder' : 'kvKey', tooltip: n.key,
          ...(folder ? {} : { command: { command: 'moonageDaydream.consulOpenKey', title: 'Open', arguments: [n] } }),
        });
      }
      case 'consulDash':
        return Object.assign(new vscode.TreeItem('Dashboard', vscode.TreeItemCollapsibleState.None), {
          iconPath: new vscode.ThemeIcon('dashboard'), contextValue: 'consulDash', tooltip: 'Leader, members, services and health, nodes',
          command: { command: 'moonageDaydream.consulDashboard', title: 'Dashboard', arguments: [n] },
        });
      case 'mfolder': {
        const f = MS_TREE[n.folder];
        return Object.assign(new vscode.TreeItem(f.label, C), { iconPath: new vscode.ThemeIcon(f.icon), contextValue: `ms.${n.folder}` });
      }
      case 'item': {
        const it = MS_TREE[n.folder].item!;
        return Object.assign(new vscode.TreeItem(n.label, it.children ? C : vscode.TreeItemCollapsibleState.None),
          { description: n.description, tooltip: n.description ? `${n.label} · ${n.description}` : n.label, iconPath: new vscode.ThemeIcon(it.icon ?? 'circle-outline'), contextValue: it.context });
      }
      case 'obj': {
        const d = drivers[n.c.type];
        // procedure / function: anaknya parameter (bila driver mendukung), trigger: tanpa anak; `.def` = Show Definition / Edit di menu
        const routine = n.objKind === 'procedure' || n.objKind === 'function';
        const open = n.objKind === 'trigger' || (routine && !d.parameters) ? vscode.TreeItemCollapsibleState.None : C;
        return Object.assign(new vscode.TreeItem(n.obj.schema ? `${n.obj.schema}.${n.obj.name}` : n.obj.name, open),
          { iconPath: new vscode.ThemeIcon(icon(n.objKind)), contextValue: objContext(n.objKind, { def: !!d.definition, ms: isMs(n.c), cols: !!d.columnDdl }) }); // .ms: Script as, .cols: kolom
      }
      case 'col':
        return Object.assign(new vscode.TreeItem(n.label), { description: n.description, iconPath: new vscode.ThemeIcon('symbol-field') });
      case 'msg':
        return Object.assign(new vscode.TreeItem(n.label), {
          iconPath: n.error ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) : undefined,
          tooltip: n.label,
        });
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    // level atas: folder group (urut nama), lalu koneksi tanpa group
    if (!n) return [...this.conns.groups().map((group): Node => ({ kind: 'group', group })), ...this.conns.list().filter((c) => !c.group).map((c): Node => ({ kind: 'conn', c }))];
    if (n.kind === 'group') return this.conns.list().filter((c) => c.group === n.group).map((c) => ({ kind: 'conn', c }));
    if (n.kind === 'col' || n.kind === 'msg' || n.kind === 'consulDash') return [];
    const d = drivers[n.c.type];
    try {
      const pw = await this.conns.password(n.c.name);
      let out: Node[] = [];
      switch (n.kind) {
        case 'kv':
          out = await this.kvChildren(n.c, pw, n.key);
          break;
        case 'conn':
          if (n.c.type === 'consul') {
            out = [{ kind: 'consulDash', c: n.c }, ...(await this.kvChildren(n.c, pw, ''))];
            break;
          }
          out = isMs(n.c) ? MS_SERVER.map((folder) => ({ kind: 'mfolder', c: n.c, folder }))
            : (await d.databases(n.c, pw)).map((db) => ({ kind: 'db', c: n.c, db }));
          break;
        case 'db':
          out = isMs(n.c) ? MS_DB.map((folder) => ({ kind: 'mfolder', c: n.c, folder, db: n.db }))
            : FOLDERS.map((f) => ({ kind: 'folder', c: n.c, db: n.db, objKind: f.objKind }));
          break;
        case 'mfolder':
          out = await this.msChildren(n, pw);
          break;
        case 'item':
          out = await this.msChildren({ kind: 'mfolder', c: n.c, folder: MS_TREE[n.folder].item!.children!, db: n.db, full: n.full }, pw);
          break;
        case 'folder':
          out = (await d.objects(n.c, pw, n.db, n.objKind)).map((obj) => ({ kind: 'obj', c: n.c, db: n.db, objKind: n.objKind, obj }));
          break;
        case 'obj':
          if (isMs(n.c) && (n.objKind === 'table' || n.objKind === 'view')) {
            out = (n.objKind === 'table' ? MS_TABLE : MS_VIEW).map((folder) => ({ kind: 'mfolder', c: n.c, folder, db: n.db, obj: n.obj }));
            break;
          }
          if (n.objKind === 'procedure' || n.objKind === 'function') {
            out = (await d.parameters!(n.c, pw, n.db, n.obj)).map((p) => ({
              kind: 'col', label: p.name, description: `${p.type}${p.output ? ', OUTPUT' : ''}${p.hasDefault ? ', default' : ''}`,
            }));
            break;
          }
          out = (await d.columns(n.c, pw, n.db, n.obj)).map((col) => ({
            kind: 'col', label: col.name, description: `${col.type}${col.nullable ? ', null' : ', not null'}`,
          }));
          break;
      }
      return out.length ? out : [{ kind: 'msg', label: '(empty)' }];
    } catch (e) {
      this.log.error(`Explorer.getChildren - EXCEPTION CAUGHT | ${n.c.name}: ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
      return [{ kind: 'msg', label: e instanceof Error ? e.message : String(e), error: true }];
    }
  }

  /** satu level KV Consul di bawah prefix: folder dulu, lalu key */
  private async kvChildren(c: ConnectionInfo, pw: string, prefix: string): Promise<Node[]> {
    const { folders, keys } = kvChildren(await new ConsulClient(consulTarget(c), pw).keys(prefix), prefix);
    return [...folders, ...keys].map((key): Node => ({ kind: 'kv', c, key }));
  }

  /** isi folder SQL Server: subfolder, lalu baris query katalog (database / objek / kolom / item) */
  private async msChildren(n: Extract<Node, { kind: 'mfolder' }>, pw: string): Promise<Node[]> {
    const f = MS_TREE[n.folder];
    const d = drivers[n.c.type];
    const subs: Node[] = (f.folders ?? []).map((folder) => ({ ...n, folder }));
    if (f.columns && n.db && n.obj) {
      return [...subs, ...(await d.columns(n.c, pw, n.db, n.obj)).map((col): Node => ({
        kind: 'col', label: col.name, description: `${col.type}${col.nullable ? ', null' : ', not null'}`,
      }))];
    }
    if (!f.sql) return subs;
    const db = n.db ?? '';
    const q = (x: string) => `[${x.replace(/]/g, ']]')}]`;
    const full = n.obj ? `${q(db)}.${q(n.obj.schema)}.${q(n.obj.name)}` : n.full;
    let rows: Awaited<ReturnType<NonNullable<typeof d.catalog>>>;
    try {
      rows = await d.catalog!(n.c, pw, f.sql(db), full);
    } catch (e) {
      const hint = permissionHint(n.folder, e);
      if (!hint) throw e; // error lain: node error merah (getChildren)
      this.log.error(`Explorer.msChildren ${n.folder} - EXCEPTION CAUGHT | ${n.c.name}: ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
      return [...subs, { kind: 'msg', label: hint }];
    }
    return [...subs, ...rows.map((r): Node => (f.databases ? { kind: 'db', c: n.c, db: r.name }
      : f.item?.obj ? { kind: 'obj', c: n.c, db, objKind: f.item.obj, obj: { schema: r.schema ?? '', name: r.name } }
      : { kind: 'item', c: n.c, folder: n.folder, db: n.db, label: r.schema ? `${r.schema}.${r.name}` : r.name, description: r.description ?? undefined, full: r.name }))];
  }
}

const CONN_SCHEME = 'moonage-conn';
/** uri semu koneksi: dipakai FileDecorationProvider untuk mewarnai nama koneksi */
export const connUri = (name: string) => vscode.Uri.from({ scheme: CONN_SCHEME, path: `/${encodeURIComponent(name)}` });

/** nama koneksi berwarna + badge ● sesuai warna koneksi di view Connections */
export class ConnDecorations implements vscode.FileDecorationProvider {
  private changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  constructor(private conns: Connections) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CONN_SCHEME) return undefined;
    const c = this.conns.get(decodeURIComponent(uri.path.slice(1)));
    if (!c?.color) return undefined;
    return { badge: '●', color: new vscode.ThemeColor(CONN_COLORS[c.color]), tooltip: `${c.color} connection` };
  }
}

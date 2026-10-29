import * as vscode from 'vscode';
import type { Connections } from './connections';
import { ConnectionInfo, DbObject, ObjectKind, address, drivers } from './db';
import { CONN_COLORS } from './connColor';

export type Node =
  | { kind: 'group'; group: string }
  | { kind: 'conn'; c: ConnectionInfo }
  | { kind: 'db'; c: ConnectionInfo; db: string }
  | { kind: 'folder'; c: ConnectionInfo; db: string; objKind: ObjectKind }
  | { kind: 'obj'; c: ConnectionInfo; db: string; objKind: ObjectKind; obj: DbObject }
  | { kind: 'col'; label: string; description: string }
  | { kind: 'msg'; label: string; error?: boolean };

const FOLDERS: { objKind: ObjectKind; label: string; icon: string }[] = [
  { objKind: 'table', label: 'Tables', icon: 'table' },
  { objKind: 'view', label: 'Views', icon: 'eye' },
  { objKind: 'procedure', label: 'Stored Procedures', icon: 'symbol-method' },
];
const icon = (k: ObjectKind) => FOLDERS.find((f) => f.objKind === k)!.icon;

/** Sidebar: koneksi → database → Tables / Views / Stored Procedures → objek → kolom. */
export class Explorer implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  /** extensionUri: logo database di media/db/<type>.svg */
  constructor(private conns: Connections, private log: vscode.LogOutputChannel, private extensionUri?: vscode.Uri) {}

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState.Collapsed;
    switch (n.kind) {
      case 'group': {
        const count = this.conns.list().filter((c) => c.group === n.group).length;
        return Object.assign(new vscode.TreeItem(n.group, vscode.TreeItemCollapsibleState.Expanded), {
          id: `group:${n.group}`, description: `${count}`, iconPath: new vscode.ThemeIcon('folder-library'), contextValue: 'group',
        });
      }
      case 'conn': {
        const active = this.conns.active === n.c.name;
        return Object.assign(new vscode.TreeItem(n.c.name, C), {
          description: `${drivers[n.c.type].label} · ${address(n.c)}${active ? ' · active' : ''}`,
          tooltip: `${n.c.user}@${address(n.c)}/${n.c.database}`,
          // logo jenis database; warna koneksi lewat ConnDecorations (nama berwarna + ●)
          iconPath: this.extensionUri ? vscode.Uri.joinPath(this.extensionUri, 'media', 'db', `${n.c.type}.svg`)
            : new vscode.ThemeIcon(active ? 'vm-active' : 'server', n.c.color ? new vscode.ThemeColor(CONN_COLORS[n.c.color]) : undefined),
          resourceUri: connUri(n.c.name),
          contextValue: 'conn',
        });
      }
      case 'db':
        return Object.assign(new vscode.TreeItem(n.db, C), { iconPath: new vscode.ThemeIcon('database'), contextValue: 'db' });
      case 'folder': {
        const f = FOLDERS.find((x) => x.objKind === n.objKind)!;
        return Object.assign(new vscode.TreeItem(f.label, C), { iconPath: new vscode.ThemeIcon('folder') });
      }
      case 'obj':
        return Object.assign(
          new vscode.TreeItem(`${n.obj.schema}.${n.obj.name}`, n.objKind === 'procedure' ? vscode.TreeItemCollapsibleState.None : C),
          { iconPath: new vscode.ThemeIcon(icon(n.objKind)), contextValue: n.objKind },
        );
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
    if (n.kind === 'col' || n.kind === 'msg') return [];
    const d = drivers[n.c.type];
    try {
      const pw = await this.conns.password(n.c.name);
      let out: Node[];
      switch (n.kind) {
        case 'conn':
          out = (await d.databases(n.c, pw)).map((db) => ({ kind: 'db', c: n.c, db }));
          break;
        case 'db':
          out = FOLDERS.map((f) => ({ kind: 'folder', c: n.c, db: n.db, objKind: f.objKind }));
          break;
        case 'folder':
          out = (await d.objects(n.c, pw, n.db, n.objKind)).map((obj) => ({ kind: 'obj', c: n.c, db: n.db, objKind: n.objKind, obj }));
          break;
        case 'obj':
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

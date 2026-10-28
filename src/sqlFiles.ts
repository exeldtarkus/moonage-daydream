import * as vscode from 'vscode';
import * as path from 'path';
import type { Connections } from './connections';

/** folder: path relatif (pakai '/') di dalam workspace folder; file: uri file .sql */
export type SqlNode = { kind: 'folder'; root: vscode.WorkspaceFolder; rel: string } | { kind: 'file'; uri: vscode.Uri };

const FLAT = 'sqlFilesFlat';
const CONTEXT = 'moonageDaydream.sqlFilesFlat';
// shortcut: maksimal 5000 file .sql di-scan, naikkan / tambah paging bila ada workspace yang lebih besar
const MAX_FILES = 5000;

/** Sidebar "SQL Files": semua .sql di workspace, tampilan folder (tree) atau daftar file saja (flat). */
export class SqlFiles implements vscode.TreeDataProvider<SqlNode> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private files: Promise<vscode.Uri[]> | undefined;

  constructor(private state: vscode.Memento, private conns: Connections, private log: vscode.LogOutputChannel) {
    void vscode.commands.executeCommand('setContext', CONTEXT, this.flat);
  }

  get flat(): boolean {
    return this.state.get<boolean>(FLAT, false);
  }

  async setFlat(flat: boolean): Promise<void> {
    await this.state.update(FLAT, flat);
    await vscode.commands.executeCommand('setContext', CONTEXT, flat);
    this.changed.fire();
  }

  /** scan ulang workspace (dipanggil watcher saat .sql dibuat / dihapus / di-rename) */
  refresh(): void {
    this.files = undefined;
    this.changed.fire();
  }

  /** binding koneksi per file ikut berubah: cukup gambar ulang tanpa scan */
  redraw(): void {
    this.changed.fire();
  }

  private list(): Promise<vscode.Uri[]> {
    // exclude undefined = files.exclude user tetap berlaku; node_modules dibuang manual
    this.files ??= Promise.resolve(vscode.workspace.findFiles('**/*.sql', undefined, MAX_FILES)).then(
      (uris) => uris.filter((u) => !u.path.includes('/node_modules/')).sort((a, b) => a.path.localeCompare(b.path)),
      (e: unknown) => {
        this.log.error(`SqlFiles.list - EXCEPTION CAUGHT | ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
        return [];
      },
    );
    return this.files;
  }

  async getChildren(n?: SqlNode): Promise<SqlNode[]> {
    if (n?.kind === 'file') return [];
    const files = await this.list();
    if (this.flat) return n ? [] : files.map((uri) => ({ kind: 'file', uri }));

    const roots = vscode.workspace.workspaceFolders ?? [];
    // multi-root: level pertama = workspace folder yang punya .sql
    if (!n && roots.length > 1) {
      return roots.filter((r) => files.some((u) => vscode.workspace.getWorkspaceFolder(u) === r)).map((root) => ({ kind: 'folder', root, rel: '' }));
    }
    const root = n?.root ?? roots[0];
    if (!root) return [];
    const prefix = n?.rel ? `${n.rel}/` : '';
    const dirs = new Set<string>();
    const out: SqlNode[] = [];
    for (const uri of files) {
      if (vscode.workspace.getWorkspaceFolder(uri) !== root) continue;
      const rel = path.posix.relative(root.uri.path, uri.path);
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.push({ kind: 'file', uri });
      else dirs.add(prefix + rest.slice(0, slash));
    }
    const folders: SqlNode[] = [...dirs].sort().map((rel) => ({ kind: 'folder', root, rel }));
    return [...folders, ...out];
  }

  getTreeItem(n: SqlNode): vscode.TreeItem {
    if (n.kind === 'folder') {
      const uri = n.rel ? vscode.Uri.joinPath(n.root.uri, n.rel) : n.root.uri;
      return Object.assign(new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.Collapsed), {
        label: n.rel ? path.posix.basename(n.rel) : n.root.name,
        contextValue: 'sqlFolder',
      });
    }
    const b = this.conns.binding(n.uri.toString());
    const dir = path.posix.dirname(vscode.workspace.asRelativePath(n.uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1));
    const where = b ? `${b.conn}${b.db ? ` / ${b.db}` : ''}` : '';
    return Object.assign(new vscode.TreeItem(n.uri), {
      description: [this.flat && dir !== '.' ? dir : '', where].filter(Boolean).join(' · '),
      tooltip: `${vscode.workspace.asRelativePath(n.uri)}${where ? `\n${where}` : ''}`,
      contextValue: 'sqlFile',
      command: { command: 'vscode.open', title: 'Open', arguments: [n.uri] },
    });
  }
}

/** nama file baru relatif ke folder tujuan: `.sql` ditambahkan bila belum ada; tidak boleh keluar folder */
export function sqlFileName(input: string): string | { error: string } {
  const name = input.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!name) return { error: 'File name is required' };
  if (name.split('/').some((p) => p === '..' || p === '')) return { error: 'Invalid path' };
  return /\.sql$/i.test(name) ? name : `${name}.sql`;
}

/** buat .sql baru di folder (default: root workspace, pilih bila multi-root) lalu buka; `input` diisi test agar tanpa input box */
export async function newSqlFile(sqlFiles: SqlFiles, n?: SqlNode, input?: string): Promise<vscode.Uri | undefined> {
  const roots = vscode.workspace.workspaceFolders ?? [];
  const root = n?.kind === 'folder' ? n.root : roots.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Create SQL file in' }) : roots[0];
  if (!root) {
    if (!roots.length) await vscode.commands.executeCommand('workbench.action.files.newUntitledFile', { languageId: 'sql' });
    return undefined;
  }
  const dir = n?.kind === 'folder' && n.rel ? vscode.Uri.joinPath(root.uri, n.rel) : root.uri;
  const exists = async (u: vscode.Uri) => vscode.workspace.fs.stat(u).then(() => true, () => false); // stat gagal = file belum ada (bukan error)
  input ??= await vscode.window.showInputBox({
    title: `New SQL File in ${vscode.workspace.asRelativePath(dir, roots.length > 1)}`,
    placeHolder: 'query.sql or folder/query.sql',
    validateInput: async (v) => {
      const name = sqlFileName(v);
      if (typeof name !== 'string') return v ? name.error : undefined;
      return (await exists(vscode.Uri.joinPath(dir, name))) ? `${name} already exists` : undefined;
    },
  });
  if (input === undefined) return undefined;
  const name = sqlFileName(input);
  if (typeof name !== 'string') throw new Error(name.error);
  const uri = vscode.Uri.joinPath(dir, name);
  if (await exists(uri)) throw new Error(`${name} already exists`);
  await vscode.workspace.fs.writeFile(uri, new Uint8Array()); // folder perantara ikut dibuat
  sqlFiles.refresh();
  await vscode.window.showTextDocument(uri);
  return uri;
}


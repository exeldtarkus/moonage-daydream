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
        contextValue: n.rel ? 'sqlFolder' : 'sqlFolderRoot', // root workspace tidak bisa di-rename / dihapus dari sini
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


/** uri file / folder dari node (folder root = workspace folder) */
export const nodeUri = (n: SqlNode) => (n.kind === 'file' ? n.uri : n.rel ? vscode.Uri.joinPath(n.root.uri, n.rel) : n.root.uri);

const exists = (u: vscode.Uri) => Promise.resolve(vscode.workspace.fs.stat(u)).then(() => true, () => false); // stat gagal = belum ada (bukan error)

/** nama baru di folder yang sama: tanpa / dan .., file tetap .sql */
export function siblingName(input: string, isFile: boolean): string | { error: string } {
  const name = input.trim();
  if (!name) return { error: 'Name is required' };
  if (/[\\/]/.test(name) || name === '.' || name === '..') return { error: 'Name must not contain / or \\' };
  return isFile && !/\.sql$/i.test(name) ? `${name}.sql` : name;
}

async function askName(title: string, value: string, dir: vscode.Uri, isFile: boolean, input?: string): Promise<vscode.Uri | undefined> {
  input ??= await vscode.window.showInputBox({
    title, value, valueSelection: [0, isFile ? value.replace(/\.sql$/i, '').length : value.length],
    validateInput: async (v) => {
      const name = siblingName(v, isFile);
      if (typeof name !== 'string') return name.error;
      return name !== value && (await exists(vscode.Uri.joinPath(dir, name))) ? `${name} already exists` : undefined;
    },
  });
  if (input === undefined) return undefined;
  const name = siblingName(input, isFile);
  if (typeof name !== 'string') throw new Error(name.error);
  return vscode.Uri.joinPath(dir, name);
}

/** Rename file / folder lewat WorkspaceEdit (editor yang terbuka ikut pindah, bisa Undo); binding koneksi ikut */
export async function renameSqlNode(sqlFiles: SqlFiles, conns: Connections, n: SqlNode, input?: string): Promise<vscode.Uri | undefined> {
  if (n.kind === 'folder' && !n.rel) throw new Error('A workspace folder cannot be renamed here');
  const from = nodeUri(n);
  const name = path.posix.basename(from.path);
  const to = await askName(`Rename ${name}`, name, vscode.Uri.joinPath(from, '..'), n.kind === 'file', input);
  if (!to || to.toString() === from.toString()) return undefined;
  if (await exists(to)) throw new Error(`${path.posix.basename(to.path)} already exists`);
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(from, to);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Rename ${name} was not applied`);
  await conns.moveBindings(from.toString(), to.toString());
  sqlFiles.refresh();
  return to;
}

/** Duplicate: salinan di folder yang sama ("nama copy.sql"), binding koneksi ikut disalin, lalu dibuka */
export async function duplicateSqlFile(sqlFiles: SqlFiles, conns: Connections, n: SqlNode, input?: string): Promise<vscode.Uri | undefined> {
  if (n.kind !== 'file') return undefined;
  const dir = vscode.Uri.joinPath(n.uri, '..');
  const base = path.posix.basename(n.uri.path).replace(/\.sql$/i, '');
  let suggestion = `${base} copy.sql`;
  for (let i = 2; await exists(vscode.Uri.joinPath(dir, suggestion)); i++) suggestion = `${base} copy ${i}.sql`;
  const to = await askName(`Duplicate ${base}.sql`, suggestion, dir, true, input);
  if (!to) return undefined;
  if (await exists(to)) throw new Error(`${path.posix.basename(to.path)} already exists`);
  await vscode.workspace.fs.copy(n.uri, to);
  await conns.moveBindings(n.uri.toString(), to.toString(), true);
  sqlFiles.refresh();
  await vscode.window.showTextDocument(to);
  return to;
}

/** Delete setelah konfirmasi: lokal ke Recycle Bin / Trash, remote permanen (pesan konfirmasi menyebutnya); binding koneksi dihapus */
export async function deleteSqlNode(sqlFiles: SqlFiles, conns: Connections, n: SqlNode, confirmed = false): Promise<boolean> {
  if (n.kind === 'folder' && !n.rel) throw new Error('A workspace folder cannot be deleted here');
  const uri = nodeUri(n);
  const name = vscode.workspace.asRelativePath(uri);
  // remote (WSL / SSH): Trash tidak didukung dan percobaannya bisa menggantung lama -> langsung tawarkan hapus permanen
  const trash = !vscode.env.remoteName;
  if (!confirmed) {
    const what = n.kind === 'folder' ? `folder "${name}" and everything in it` : `"${name}"`;
    const ok = trash ? 'Delete' : 'Delete Permanently';
    const detail = trash ? 'It is moved to the Recycle Bin / Trash.' : 'This window is remote, so there is no Recycle Bin / Trash: it cannot be restored.';
    if ((await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true, detail }, ok)) !== ok) return false;
  }
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: trash });
  } catch (e) {
    if (!trash || confirmed) throw e;
    // Trash gagal di jendela lokal: hapus permanen hanya setelah konfirmasi kedua
    if ((await vscode.window.showWarningMessage(`The Recycle Bin / Trash is not available (${e instanceof Error ? e.message : e}). Delete "${name}" permanently?`,
      { modal: true }, 'Delete Permanently')) !== 'Delete Permanently') return false;
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  }
  await conns.moveBindings(uri.toString(), undefined);
  sqlFiles.refresh();
  return true;
}

/**
 * drag & drop di SQL Files: file / folder dipindah ke folder target (target file = foldernya; tanpa target = root workspace).
 * Lewat WorkspaceEdit (editor ikut pindah, bisa Undo); binding koneksi ikut. Return uri tujuan yang dipindah.
 */
export async function moveSqlNodes(sqlFiles: SqlFiles, conns: Connections, nodes: SqlNode[], target: SqlNode | undefined): Promise<vscode.Uri[]> {
  const root = target?.kind === 'folder' ? target.root : vscode.workspace.workspaceFolders?.[0];
  if (!root) return [];
  const dir = !target ? root.uri : target.kind === 'folder' ? nodeUri(target) : vscode.Uri.joinPath(target.uri, '..');
  const moves: [vscode.Uri, vscode.Uri][] = [];
  for (const n of nodes) {
    if (n.kind === 'folder' && !n.rel) continue; // root workspace tidak dipindah
    const from = nodeUri(n);
    const to = vscode.Uri.joinPath(dir, path.posix.basename(from.path));
    if (to.toString() === from.toString()) continue; // sudah di folder itu
    if (n.kind === 'folder' && `${dir.toString()}/`.startsWith(`${from.toString()}/`)) throw new Error(`Cannot move ${path.posix.basename(from.path)} into itself`);
    if (await exists(to)) throw new Error(`${vscode.workspace.asRelativePath(to)} already exists`);
    moves.push([from, to]);
  }
  if (!moves.length) return [];
  const edit = new vscode.WorkspaceEdit();
  for (const [from, to] of moves) edit.renameFile(from, to);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error('Move was not applied');
  for (const [from, to] of moves) await conns.moveBindings(from.toString(), to.toString());
  sqlFiles.refresh();
  return moves.map(([, to]) => to);
}

const TREE_MIME = 'application/vnd.code.tree.moonagedaydream.sqlfiles';

/** drag ke folder lain = pindah; drag ke editor = buka (tepi editor = split) lewat text/uri-list */
export function sqlFilesDnd(sqlFiles: SqlFiles, conns: Connections, log: vscode.LogOutputChannel): vscode.TreeDragAndDropController<SqlNode> {
  return {
    dropMimeTypes: [TREE_MIME],
    dragMimeTypes: ['text/uri-list'],
    handleDrag(nodes, data) {
      data.set(TREE_MIME, new vscode.DataTransferItem(nodes));
      data.set('text/uri-list', new vscode.DataTransferItem(nodes.filter((n) => n.kind === 'file').map((n) => nodeUri(n).toString()).join('\r\n')));
    },
    async handleDrop(target, data) {
      const nodes = data.get(TREE_MIME)?.value as SqlNode[] | undefined;
      if (!nodes?.length) return;
      try {
        await moveSqlNodes(sqlFiles, conns, nodes, target);
      } catch (e) {
        log.error(`sqlFilesDnd.handleDrop - EXCEPTION CAUGHT | ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
        vscode.window.showErrorMessage(`Move failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  };
}

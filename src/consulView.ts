import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { Connections } from './connections';
import type { ConnectionInfo } from './db';
import { ConsulClient, consulTarget, consulUri, deleteKv, detectFormat, parseConsulUri, saveKv } from './consul';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack : String(e));

/** klien Consul untuk koneksi tersimpan (token ACL dari SecretStorage) */
export async function consulClient(conns: Connections, c: ConnectionInfo): Promise<ConsulClient> {
  return new ConsulClient(consulTarget(c), await conns.password(c.name));
}

/** file backup KV (format consul kv export) di storage extension; path dikembalikan untuk pesan + restore */
export function backupWriter(ctx: vscode.ExtensionContext, conn: string, key: string) {
  return async (json: string) => {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const dir = path.join(ctx.globalStorageUri.fsPath, 'backups', 'consul', conn.replace(/[^\w.-]+/g, '_'));
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${stamp}_${key.replace(/[^\w.-]+/g, '_') || 'root'}.json`);
    await fs.promises.writeFile(file, json, 'utf8');
    return file;
  };
}

/**
 * value KV sebagai file moonage-consul://<koneksi>/<key>: buka = GET (ModifyIndex dicatat), Ctrl+S = konfirmasi, validasi,
 * backup value lama, PUT ?cas= (ditolak bila sudah diubah orang lain). Koneksi read-only tidak bisa menyimpan.
 */
export class ConsulFs implements vscode.FileSystemProvider {
  private changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  /** ModifyIndex saat dibuka per uri; 0 = key baru (New Key) */
  private cas = new Map<string, number>();

  constructor(private ctx: vscode.ExtensionContext, private conns: Connections, private log: vscode.LogOutputChannel, private onSaved: () => void) {}

  /** New Key: dokumen kosong yang baru dibuat di Consul saat disimpan */
  markNew(uri: vscode.Uri) {
    this.cas.set(uri.toString(), 0);
  }

  private target(uri: vscode.Uri) {
    const { conn, key } = parseConsulUri(uri.toString());
    const c = this.conns.get(conn);
    if (!c) throw vscode.FileSystemError.FileNotFound(`Consul connection "${conn}" no longer exists`);
    return { c, key };
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (this.cas.get(uri.toString()) === 0) return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
    const { c, key } = this.target(uri);
    const v = await (await consulClient(this.conns, c)).get(key);
    if (!v) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: v.modifyIndex, size: Buffer.byteLength(v.value) };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    if (this.cas.get(uri.toString()) === 0) return new Uint8Array();
    const { c, key } = this.target(uri);
    const v = await (await consulClient(this.conns, c)).get(key);
    if (!v) throw vscode.FileSystemError.FileNotFound(uri);
    this.cas.set(uri.toString(), v.modifyIndex);
    return Buffer.from(v.value, 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { c, key } = this.target(uri);
    if (c.readOnly) throw vscode.FileSystemError.NoPermissions(`The connection "${c.name}" is read-only`);
    const cas = this.cas.get(uri.toString()) ?? 0;
    const ok = await vscode.window.showWarningMessage(`Save "${key}" to Consul?`, {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\n${cas ? 'The current value is backed up first.' : 'New key.'} The change is applied at once (Consul has no transactions).`,
    }, 'Save');
    if (ok !== 'Save') throw vscode.FileSystemError.Unavailable('Save cancelled');
    try {
      const client = await consulClient(this.conns, c);
      const r = await saveKv(client, key, Buffer.from(content).toString('utf8'), cas, backupWriter(this.ctx, c.name, key));
      this.cas.set(uri.toString(), (await client.get(key))?.modifyIndex ?? 0);
      this.log.info(`consul save ${c.name} / ${key}${r.backup ? ` (backup ${r.backup})` : ''}`);
      vscode.window.showInformationMessage(`Saved "${key}" to Consul.${r.backup ? ` Backup: ${r.backup} (restore: consul kv import @<file>)` : ''}`);
      this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      this.onSaved();
    } catch (e) {
      this.log.error(`ConsulFs.writeFile - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      throw vscode.FileSystemError.Unavailable(errMsg(e));
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Create keys with New Key in Connections');
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Delete keys from Connections (Delete Key)');
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Renaming Consul keys is not supported');
  }
}

/** buka value key di editor; bahasa editor dari isinya (JSON / YAML / teks) */
export async function openConsulKey(c: ConnectionInfo, key: string) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(consulUri(c.name, key)));
  const fmt = detectFormat(doc.getText());
  if (fmt !== 'text') await vscode.languages.setTextDocumentLanguage(doc, fmt);
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** New Key di koneksi / folder: nama key relatif terhadap folder, dokumen kosong, dibuat di Consul saat disimpan */
export async function newConsulKey(provider: ConsulFs, c: ConnectionInfo, prefix: string) {
  const name = await vscode.window.showInputBox({
    title: `New key in ${c.name}${prefix ? ` / ${prefix}` : ''}`, prompt: 'Key name (use / for folders, e.g. app/config)',
    validateInput: (v) => (!v.trim() ? 'Enter a key name' : v.startsWith('/') ? 'Do not start with /' : v.endsWith('/') ? 'A key cannot end with /' : undefined),
  });
  if (!name) return;
  const uri = vscode.Uri.parse(consulUri(c.name, `${prefix}${name.trim()}`));
  provider.markNew(uri);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  vscode.window.setStatusBarMessage('$(info) Type the value, then Ctrl+S to create the key in Consul', 6000);
}

/** Delete key / folder: hitung key yang terhapus, konfirmasi, backup, hapus */
export async function deleteConsulKey(ctx: vscode.ExtensionContext, conns: Connections, log: vscode.LogOutputChannel, c: ConnectionInfo, key: string): Promise<boolean> {
  if (c.readOnly) return void vscode.window.showWarningMessage(`The connection "${c.name}" is read-only`), false;
  try {
    const client = await consulClient(conns, c);
    const count = key.endsWith('/') ? (await client.export(key)).length : 1;
    const ok = await vscode.window.showWarningMessage(`Delete ${key.endsWith('/') ? `folder "${key}" (${count} key(s))` : `key "${key}"`} from Consul?`, {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\nEverything is backed up first (consul kv export format).`,
    }, 'Delete');
    if (ok !== 'Delete') return false;
    const r = await deleteKv(client, key, backupWriter(ctx, c.name, key));
    log.info(`consul delete ${c.name} / ${key}: ${r.deleted} key(s), backup ${r.backup ?? '-'}`);
    vscode.window.showInformationMessage(`Deleted ${r.deleted} key(s).${r.backup ? ` Backup: ${r.backup} (restore: consul kv import @<file>)` : ''}`);
    return true;
  } catch (e) {
    log.error(`deleteConsulKey - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    vscode.window.showErrorMessage(`Delete failed: ${errMsg(e)}`);
    return false;
  }
}

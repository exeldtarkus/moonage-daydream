import * as vscode from 'vscode';
import type { ConnectionInfo } from './db';

const LIST = 'connections';
const ACTIVE = 'activeConnection';
const BINDINGS = 'fileBindings';

/** koneksi + database yang dipakai satu file .sql (key: uri file) */
export interface FileBinding {
  conn: string;
  db?: string;
}
const secretKey = (name: string) => `moonageDaydream.password.${name}`;

/** Daftar koneksi di globalState (tanpa password); password di SecretStorage. */
export class Connections {
  /** file untitled: binding hanya di memori, karena uri `untitled:Untitled-1` dipakai ulang di sesi berikutnya */
  private untitled = new Map<string, FileBinding>();

  constructor(private ctx: vscode.ExtensionContext) {}

  list(): ConnectionInfo[] {
    return this.ctx.globalState.get<ConnectionInfo[]>(LIST, []);
  }

  get(name: string | undefined): ConnectionInfo | undefined {
    return this.list().find((c) => c.name === name);
  }

  async save(c: ConnectionInfo, password: string, oldName?: string): Promise<void> {
    const rest = this.list().filter((x) => x.name !== c.name && x.name !== oldName);
    await this.ctx.globalState.update(LIST, [...rest, c].sort((a, b) => a.name.localeCompare(b.name)));
    if (oldName && oldName !== c.name) {
      await this.ctx.secrets.delete(secretKey(oldName));
      const b = this.bindings();
      for (const v of [...Object.values(b), ...this.untitled.values()]) if (v.conn === oldName) v.conn = c.name;
      await this.ctx.globalState.update(BINDINGS, b);
    }
    await this.ctx.secrets.store(secretKey(c.name), password);
    if (oldName && this.active === oldName) await this.setActive(c.name);
  }

  async remove(name: string): Promise<void> {
    await this.ctx.globalState.update(LIST, this.list().filter((x) => x.name !== name));
    await this.ctx.secrets.delete(secretKey(name));
    if (this.active === name) await this.setActive(undefined);
  }

  async password(name: string): Promise<string> {
    return (await this.ctx.secrets.get(secretKey(name))) ?? '';
  }

  private bindings(): Record<string, FileBinding> {
    return this.ctx.globalState.get<Record<string, FileBinding>>(BINDINGS, {});
  }

  /** binding file; diabaikan bila koneksinya sudah dihapus */
  binding(uri: string): FileBinding | undefined {
    const b = this.untitled.get(uri) ?? this.bindings()[uri];
    return b && this.get(b.conn) ? b : undefined;
  }

  async bind(uri: string, b: FileBinding): Promise<void> {
    if (uri.startsWith('untitled:')) this.untitled.set(uri, b);
    else await this.ctx.globalState.update(BINDINGS, { ...this.bindings(), [uri]: b });
  }

  /** koneksi aktif disimpan per workspace */
  get active(): string | undefined {
    return this.ctx.workspaceState.get<string>(ACTIVE);
  }

  setActive(name: string | undefined): Thenable<void> {
    return this.ctx.workspaceState.update(ACTIVE, name);
  }
}

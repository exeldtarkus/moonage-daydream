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

  /** penulisan globalState berurutan: baca-ubah-tulis yang bersamaan (mis. bind saat rename) tidak saling menimpa */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private ctx: vscode.ExtensionContext) {}

  /**
   * gema globalState: setiap update dikirim balik async, dan nilai yang sudah lewat (gema tulisan / nilai lama) bisa sesaat terbaca lagi.
   * Per key disimpan nilai terakhir yang dipakai jendela ini + semua nilai yang pernah terlihat (dibaca / ditulis):
   * nilai yang pernah terlihat = gema -> pakai nilai terakhir; nilai yang belum pernah terlihat = perubahan dari jendela VS Code lain -> dipakai.
   */
  private own = new Map<string, { value: unknown; seen: Set<string> }>();

  /** catat nilai yang terlihat; hanya 100 terakhir (gema selalu dari tulisan / bacaan yang baru lewat) */
  private see(seen: Set<string>, json: string): Set<string> {
    seen.add(json);
    if (seen.size > 100) seen.delete(seen.values().next().value as string);
    return seen;
  }

  private read<T>(key: string, def: T): T {
    const stored = this.ctx.globalState.get<T>(key, def);
    const json = JSON.stringify(stored);
    const o = this.own.get(key);
    if (o?.seen.has(json)) return o.value as T;
    this.own.set(key, { value: stored, seen: this.see(o?.seen ?? new Set<string>(), json) });
    return stored;
  }

  private async write(key: string, value: unknown): Promise<void> {
    const o = this.own.get(key) ?? { value, seen: new Set<string>() };
    o.value = value;
    this.see(o.seen, JSON.stringify(value));
    this.own.set(key, o);
    await this.ctx.globalState.update(key, value);
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const r = this.queue.then(f);
    this.queue = r.catch(() => undefined); // error dilaporkan ke pemanggil lewat r, antrean tetap jalan
    return r;
  }

  list(): ConnectionInfo[] {
    return this.read<ConnectionInfo[]>(LIST, []);
  }

  get(name: string | undefined): ConnectionInfo | undefined {
    return this.list().find((c) => c.name === name);
  }

  save(c: ConnectionInfo, password: string, oldName?: string): Promise<void> {
    return this.serial(() => this.saveNow(c, password, oldName));
  }

  private async saveNow(c: ConnectionInfo, password: string, oldName?: string): Promise<void> {
    const rest = this.list().filter((x) => x.name !== c.name && x.name !== oldName);
    await this.write(LIST, [...rest, c].sort((a, b) => a.name.localeCompare(b.name)));
    if (oldName && oldName !== c.name) {
      await this.ctx.secrets.delete(secretKey(oldName));
      const b = Object.fromEntries(Object.entries(this.bindings()).map(([k, v]) => [k, v.conn === oldName ? { ...v, conn: c.name } : v]));
      for (const v of this.untitled.values()) if (v.conn === oldName) v.conn = c.name;
      await this.write(BINDINGS, b);
    }
    await this.ctx.secrets.store(secretKey(c.name), password);
    if (oldName && this.active === oldName) await this.setActive(c.name);
  }

  /** pindahkan koneksi ke group (undefined / '' = tanpa group); dipakai juga untuk rename group */
  setGroup(names: string[], group: string | undefined): Promise<void> {
    return this.serial(() => this.write(LIST, this.list().map((c) => {
      if (!names.includes(c.name)) return c;
      const { group: _old, ...rest } = c;
      return group?.trim() ? { ...rest, group: group.trim() } : rest;
    })));
  }

  /** nama group yang dipakai, urut */
  groups(): string[] {
    return [...new Set(this.list().flatMap((c) => (c.group ? [c.group] : [])))].sort((a, b) => a.localeCompare(b));
  }

  remove(name: string): Promise<void> {
    return this.serial(() => this.removeNow(name));
  }

  private async removeNow(name: string): Promise<void> {
    await this.write(LIST, this.list().filter((x) => x.name !== name));
    await this.ctx.secrets.delete(secretKey(name));
    if (this.active === name) await this.setActive(undefined);
  }

  /** tambah koneksi hasil import (tanpa password: diminta saat pertama dipakai, lihat password()) */
  addMany(list: ConnectionInfo[]): Promise<void> {
    return this.serial(async () => {
      const names = new Set(list.map((c) => c.name));
      await this.write(LIST, [...this.list().filter((x) => !names.has(x.name)), ...list].sort((a, b) => a.name.localeCompare(b.name)));
    });
  }

  private asking = new Map<string, Promise<string>>();

  /** password koneksi; belum pernah disimpan (koneksi hasil import) = ditanya sekali lalu disimpan di SecretStorage */
  async password(name: string): Promise<string> {
    const stored = await this.ctx.secrets.get(secretKey(name));
    if (stored !== undefined) return stored;
    let p = this.asking.get(name); // autocomplete / explorer / run bersamaan: satu input box saja
    if (!p) {
      p = Promise.resolve(vscode.window.showInputBox({
        title: `Password for ${name}`, prompt: 'Saved in VS Code Secret Storage (leave empty if the connection has no password)', password: true, ignoreFocusOut: true,
      })).then(async (v) => {
        if (v !== undefined) await this.ctx.secrets.store(secretKey(name), v);
        return v ?? '';
      }).finally(() => this.asking.delete(name));
      this.asking.set(name, p);
    }
    return p;
  }

  private bindings(): Record<string, FileBinding> {
    return this.read<Record<string, FileBinding>>(BINDINGS, {});
  }

  /** binding file; diabaikan bila koneksinya sudah dihapus */
  binding(uri: string): FileBinding | undefined {
    const b = this.untitled.get(uri) ?? this.bindings()[uri];
    return b && this.get(b.conn) ? b : undefined;
  }

  async bind(uri: string, b: FileBinding): Promise<void> {
    if (uri.startsWith('untitled:')) this.untitled.set(uri, b);
    else await this.serial(() => this.write(BINDINGS, { ...this.bindings(), [uri]: b }));
  }

  /**
   * file / folder di-rename, di-copy atau dihapus: binding file itu (dan file di bawah folder) ikut pindah, disalin atau dihapus.
   * to undefined = hapus; keep = salin (from tetap ada).
   */
  moveBindings(from: string, to: string | undefined, keep = false): Promise<void> {
    return this.serial(() => this.moveNow(from, to, keep));
  }

  private async moveNow(from: string, to: string | undefined, keep: boolean): Promise<void> {
    const b = { ...this.bindings() }; // salinan: objek di globalState tidak diubah langsung
    const hit = (k: string) => k === from || k.startsWith(`${from}/`);
    let changed = false;
    for (const k of Object.keys(b).filter(hit)) {
      if (to !== undefined) b[to + k.slice(from.length)] = { ...b[k] };
      if (!keep) delete b[k];
      changed = true;
    }
    if (changed) await this.write(BINDINGS, b);
  }

  /** koneksi aktif disimpan per workspace */
  get active(): string | undefined {
    return this.ctx.workspaceState.get<string>(ACTIVE);
  }

  setActive(name: string | undefined): Thenable<void> {
    return this.ctx.workspaceState.update(ACTIVE, name);
  }
}

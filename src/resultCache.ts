// result cache untuk "Load all": baris hasil per chunk, RAM sampai batas lalu sisanya ke file di .moonage-cache;
// tanpa vscode supaya bisa di-unit test. Desain: docs/main/2026-11-02-grid-million-rows-analysis.md
import { mkdirSync, promises as fs } from 'fs';
import { join } from 'path';
import type { Sink } from './db';
import { cellText } from './resultsHtml';
import { dirSize } from './metaCache';

export const CHUNK_ROWS = 10_000;
export const MAX_CACHED_ROWS = 5_000_000;
export const MAX_CACHE_MB = 100;
export const CACHE_DIR = '.moonage-cache';

/** setting maxCachedRows / cacheMemoryMB: dipotong ke batas atas, nilai < 1 / kosong = default */
export function cacheLimits(maxRows?: number, memMB?: number): { maxRows: number; memBytes: number } {
  const pick = (v: number | undefined, max: number) => (v && v >= 1 ? Math.min(Math.floor(v), max) : max);
  return { maxRows: pick(maxRows, MAX_CACHED_ROWS), memBytes: pick(memMB, MAX_CACHE_MB) * 1024 * 1024 };
}

/** folder .moonage-cache di base + .gitignore berisi * (mengabaikan dirinya sendiri, .gitignore project tidak diubah) */
export async function cacheRoot(base: string): Promise<string> {
  const root = join(base, CACHE_DIR);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(root, '.gitignore'), '*\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e; // sudah ada dari pemakaian sebelumnya
  });
  return root;
}

type Row = (string | null)[];
interface Chunk { n: number; rows?: Row[]; file?: string }
let seq = 0;

/**
 * Sink untuk driver.stream: baris disimpan sebagai teks sel grid (cellText).
 * Chunk penuh tetap di RAM selama total perkiraan <= memBytes, selebihnya ditulis ke chunk-<i>.jsonl (0600).
 * Baris setelah maxRows dibuang, partial = true, onLimit dipanggil sekali (pemanggil meng-cancel query di server).
 */
export class ResultCache implements Sink {
  readonly dir: string;
  readonly chunkRows: number;
  readonly maxRows: number;
  private readonly memLimit: number;
  cols: string[] = [];
  length = 0;
  partial = false;
  memBytes = 0;
  diskBytes = 0;
  onLimit?: () => void;
  private chunks: Chunk[] = [];
  private cur: Row[] = [];

  constructor(root: string, o: { chunkRows?: number; maxRows?: number; memBytes?: number } = {}) {
    const lim = cacheLimits(o.maxRows);
    this.chunkRows = o.chunkRows ?? CHUNK_ROWS;
    this.maxRows = lim.maxRows;
    this.memLimit = o.memBytes ?? lim.memBytes;
    // nama diawali pid: pruneStale menghapus folder milik proses yang sudah mati (sisa crash)
    this.dir = join(root, `${process.pid}-${Date.now().toString(36)}-${seq++}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  columns(cols: string[]): void { this.cols = cols; }

  async row(values: unknown[]): Promise<void> {
    if (this.length >= this.maxRows) {
      if (!this.partial) { this.partial = true; this.onLimit?.(); }
      return;
    }
    this.cur.push(values.map(cellText));
    this.length++;
    if (this.cur.length >= this.chunkRows) await this.seal();
  }

  /** chunk terakhir yang belum penuh ikut disegel; aman dipanggil berulang */
  async finish(): Promise<void> { if (this.cur.length) await this.seal(); }

  private async seal(): Promise<void> {
    const rows = this.cur;
    this.cur = [];
    const text = rows.map((r) => JSON.stringify(r)).join('\n');
    // shortcut: ukuran RAM diperkirakan 2 byte per karakter JSON, bukan diukur heap; cukup untuk batas kasar 100 MB
    const bytes = text.length * 2;
    if (this.memBytes + bytes <= this.memLimit) {
      this.chunks.push({ n: rows.length, rows });
      this.memBytes += bytes;
      return;
    }
    const file = join(this.dir, `chunk-${this.chunks.length}.jsonl`);
    await fs.writeFile(file, text, { mode: 0o600 });
    this.chunks.push({ n: rows.length, file });
    this.diskBytes += Buffer.byteLength(text);
  }

  /** baris chunk ke-i (dari RAM atau file); chunk yang sedang diisi = setelah chunk terakhir */
  async chunk(i: number): Promise<Row[]> {
    const c = this.chunks[i];
    if (!c) return i === this.chunks.length ? this.cur : [];
    if (c.rows) return c.rows;
    return (await fs.readFile(c.file!, 'utf8')).split('\n').map((l) => JSON.parse(l) as Row);
  }

  get chunkCount(): number { return this.chunks.length + (this.cur.length ? 1 : 0); }

  /** baris start .. start+count-1 (semua chunk penuh kecuali terakhir, jadi posisi chunk = start / chunkRows) */
  async page(start: number, count: number): Promise<Row[]> {
    const out: Row[] = [];
    const end = Math.min(start + count, this.length);
    for (let i = start; i < end;) {
      const ci = Math.floor(i / this.chunkRows);
      const rows = await this.chunk(ci);
      const from = i - ci * this.chunkRows;
      const take = rows.slice(from, from + (end - i));
      if (!take.length) break;
      out.push(...take);
      i += take.length;
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.chunks = [];
    this.cur = [];
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * Load all: stream driver diisi ke cache. Batas maxRows tercapai = signal di-abort (driver meng-cancel query di server),
 * error cancel itu ditelan karena memang disengaja. Cancel dari user: baris yang sudah masuk tetap ada, error diteruskan.
 */
export async function loadAll(cache: ResultCache, stream: (signal: AbortSignal, sink: Sink) => Promise<number>,
  o: { signal?: AbortSignal; onProgress?: (rows: number) => void } = {}): Promise<void> {
  const ac = new AbortController();
  const user = () => ac.abort();
  if (o.signal?.aborted) ac.abort();
  o.signal?.addEventListener('abort', user, { once: true });
  cache.onLimit = () => ac.abort();
  const sink: Sink = {
    columns: (c) => cache.columns(c),
    row: async (v) => {
      await cache.row(v);
      if (cache.length % cache.chunkRows === 0 && !cache.partial) o.onProgress?.(cache.length);
    },
  };
  try {
    await stream(ac.signal, sink);
  } catch (e) {
    // batas cache tercapai: query sengaja di-cancel, hasil = baris sampai batas (ditandai partial)
    if (!cache.partial) throw e;
  } finally {
    o.signal?.removeEventListener('abort', user);
    cache.onLimit = undefined;
    await cache.finish();
    o.onProgress?.(cache.length);
  }
}

/** key Search Output: "teks" = sama persis, null = sel NULL, selain itu mengandung (tidak peka huruf besar / kecil) */
export type SearchKey = { exact: string } | { contains: string } | { isNull: true };

export function parseKeys(raw: string[]): SearchKey[] {
  return raw.map((s) => s.trim()).filter(Boolean).map((s): SearchKey =>
    s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? { exact: s.slice(1, -1) }
      : s.toLowerCase() === 'null' ? { isNull: true }
      : { contains: s.toLowerCase() });
}

/** baris cocok bila salah satu key (OR) cocok di salah satu kolom; cols = kolom yang tampil (default semua); tanpa key = cocok */
export function rowMatches(row: Row, keys: SearchKey[], cols?: number[]): boolean {
  if (!keys.length) return true;
  const idx = cols ?? row.map((_, i) => i);
  return idx.some((c) => {
    const v = row[c];
    return keys.some((k) => ('isNull' in k ? v === null
      : v === null ? false
      : 'exact' in k ? v === k.exact
      : v.toLowerCase().includes(k.contains)));
  });
}

/** Search Output atas seluruh cache: nomor baris yang cocok; progres dalam persen per chunk, signal = Cancel */
export async function searchCache(cache: ResultCache, keys: SearchKey[],
  o: { cols?: number[]; signal?: AbortSignal; onProgress?: (percent: number) => void } = {}): Promise<Uint32Array> {
  let out = new Uint32Array(1024);
  let n = 0;
  const total = cache.chunkCount;
  for (let ci = 0; ci < total; ci++) {
    o.signal?.throwIfAborted();
    const rows = await cache.chunk(ci);
    const base = ci * cache.chunkRows;
    for (let r = 0; r < rows.length; r++) {
      if (!rowMatches(rows[r], keys, o.cols)) continue;
      if (n === out.length) { const g = new Uint32Array(out.length * 2); g.set(out); out = g; }
      out[n++] = base + r;
    }
    o.onProgress?.(Math.round(((ci + 1) / total) * 100));
    await new Promise((res) => setImmediate(res)); // beri giliran ke event loop supaya Cancel / UI tetap jalan
  }
  if (!total) o.onProgress?.(100);
  return out.slice(0, n);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // ESRCH = proses sudah tidak ada; EPERM = ada tapi milik user lain
  }
};

/** saat activate: hapus folder cache milik proses yang sudah mati (sisa crash / VS Code ditutup paksa) */
export async function pruneStale(root: string): Promise<void> {
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []); // root belum ada = tidak ada sisa
  for (const d of dirs) {
    const pid = d.isDirectory() ? Number(/^(\d+)-/.exec(d.name)?.[1]) : NaN;
    if (pid && !alive(pid)) await fs.rm(join(root, d.name), { recursive: true, force: true });
  }
}

/** Clear Result Cache: hapus semua folder .moonage-cache yang diberikan; mengembalikan total byte yang dihapus */
export async function clearResultCaches(roots: string[]): Promise<number> {
  let bytes = 0;
  for (const r of roots) {
    bytes += await dirSize(r);
    await fs.rm(r, { recursive: true, force: true });
  }
  return bytes;
}

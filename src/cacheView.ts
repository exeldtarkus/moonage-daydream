// tampilan grid atas result cache (Load all): Search Output + filter corong + sort + ambil halaman; semua di extension host
import { sortRows } from './cacheSort';
import { parseKeys, ResultCache, searchCache } from './resultCache';

type Row = (string | null)[];
export type ViewProgress = (phase: string, percent: number) => void;

/** result set yang dimuat dengan Load all (ResultSet.cache): baris di host, webview meminta per halaman */
export interface GridCache {
  view: CacheView;
  /** waktu snapshot (selesai dimuat) */
  at: number;
  /** stream masih berjalan: jumlah baris sejauh ini, ac = Cancel */
  loading?: { ac: AbortController; rows: number };
  /** search / sort sedang berjalan: ac = Cancel */
  busy?: AbortController;
  /** Clear Result Cache: data sudah dihapus */
  cleared?: boolean;
}

export class CacheView {
  keys: string[] = [];
  filters: Record<number, string> = {};
  cols: number[] | undefined;
  sort: { c: number; dir: 1 | -1 } | null = null;
  /** jumlah sort yang benar-benar dihitung (bukan dari cache sort) */
  sortRuns = 0;
  /** nomor baris yang cocok search / filter (urut naik); null = semua baris */
  private match: Uint32Array | null = null;
  /** urutan tampil setelah sort; null = urutan match */
  private order: Uint32Array | null = null;
  /** hasil sort per kolom + arah, berlaku sampai search / filter berubah */
  private sorted = new Map<string, Uint32Array>();

  constructor(readonly cache: ResultCache, private readonly isNum: (col: number) => boolean = () => false) {}

  /** jumlah baris tampil (hasil search / filter) */
  get count(): number { return this.order?.length ?? this.match?.length ?? this.cache.length; }
  get filtered(): boolean { return this.match !== null; }

  /** search / filter baru: hasil sort lama dibuang; sort aktif dihitung ulang atas baris yang cocok */
  async setSearch(keys: string[], filters: Record<number, string>, cols: number[] | undefined,
    o: { signal?: AbortSignal; onProgress?: ViewProgress } = {}): Promise<void> {
    const parsed = parseKeys(keys);
    const f = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<number, string>;
    const match = parsed.length || Object.keys(f).length
      ? await searchCache(this.cache, parsed, { cols, filters: f, signal: o.signal, onProgress: (p) => o.onProgress?.('searching', p) })
      : null;
    Object.assign(this, { keys: keys.filter((k) => k.trim()), filters: f, cols, match, order: null });
    this.sorted.clear();
    const s = this.sort;
    if (!s) return;
    this.sort = null; // dipasang lagi setelah sort ulang berhasil (Cancel = tanpa sort)
    await this.setSort(s.c, s.dir, o);
  }

  /** sort kolom c (null = urutan asli); Cancel / error: urutan lama tetap */
  async setSort(c: number | null, dir: 1 | -1, o: { signal?: AbortSignal; onProgress?: ViewProgress } = {}): Promise<void> {
    if (c === null) { this.sort = null; this.order = null; return; }
    const key = `${c}:${dir}`;
    let order = this.sorted.get(key);
    if (!order) {
      order = await sortRows(this.cache, this.match, c, dir, this.isNum(c), { signal: o.signal, onProgress: (p, pct) => o.onProgress?.(p, pct) });
      this.sortRuns++;
      this.sorted.set(key, order);
    }
    this.sort = { c, dir };
    this.order = order;
  }

  private idx(pos: number): number { return this.order ? this.order[pos] : this.match ? this.match[pos] : pos; }

  /** baris tampil start .. start+count-1 sebagai [nomor baris asli, ...nilai] */
  async page(start: number, count: number): Promise<(number | string | null)[][]> {
    const end = Math.min(start + count, this.count);
    if (start >= end) return [];
    if (!this.order && !this.match) return (await this.cache.page(start, end - start)).map((r, i) => [start + i, ...r]);
    const idx = Array.from({ length: end - start }, (_, i) => this.idx(start + i));
    return (await this.rowsAt(idx)).map((r, i) => [idx[i], ...r]);
  }

  /** nilai baris menurut nomor baris asli (urutan sesuai masukan); tiap chunk dibaca sekali */
  async rowsAt(indices: number[]): Promise<Row[]> {
    const memo = new Map<number, Row[]>();
    const out: Row[] = [];
    for (const i of indices) {
      const ci = Math.floor(i / this.cache.chunkRows);
      let rows = memo.get(ci);
      if (!rows) { rows = await this.cache.chunk(ci); memo.set(ci, rows); }
      const r = rows[i - ci * this.cache.chunkRows];
      if (r) out.push(r);
    }
    return out;
  }

  /** export: semua baris cache (urutan asli) atau baris tampil (hasil filter + sort) */
  async *rows(scope: 'cache' | 'view'): AsyncGenerator<Row> {
    if (scope === 'cache') {
      for (let ci = 0; ci < this.cache.chunkCount; ci++) yield* await this.cache.chunk(ci);
      return;
    }
    for (let p = 0; p < this.count; p += 1000) for (const r of await this.page(p, 1000)) yield r.slice(1) as Row;
  }
}

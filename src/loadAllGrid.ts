// Load all: hasil query di-stream ke result cache, lalu grid mode cache (Search Output, filter, sort, halaman) dilayani dari sini
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { drivers, type ResultSet } from './db';
import type { ResultMessage } from './results';
import { isNumCol, type Outcome, type Source } from './resultsHtml';
import { addWhere } from './sqlContext';
import { CACHE_DIR, cacheLimits, cacheRoot, chunkBudget, clearResultCaches, loadAll, ResultCache } from './resultCache';
import { CacheView, type GridCache } from './cacheView';
import { conns, fileConn, log, openTx, results } from './extension';
import { showError } from './gridEdit';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));
/** balasan ke webview asal pesan (panel hasil atau tab pin) */
export type Post = (msg: unknown) => unknown;

/** fallback result cache bila tidak ada workspace folder (globalStorage), diisi activate() */
let fallback = '';
export const setResultFallback = (dir: string) => { fallback = dir; };
/** folder result cache: .moonage-cache di tiap workspace folder + fallback globalStorage */
export const resultRoots = () => [...(vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file')
  .map((f) => path.join(f.uri.fsPath, CACHE_DIR)), fallback].filter(Boolean);

/** semua cache yang masih hidup (dibuang begitu tidak lagi tampil di panel hasil / tab pin) */
const live = new Set<GridCache>();

/** result set + statement asal pesan grid (sama dengan Load more: result set pertama) */
function target(m: ResultMessage, o: Outcome | undefined): { rs: ResultSet; src?: Source } | undefined {
  if (!o || m.set !== 0) return;
  const part = 'parts' in o && m.part !== undefined ? o.parts[m.part] : undefined;
  const single = part ? part.o : o;
  if (!('result' in single)) return;
  const rs = single.result.resultSets[0];
  const src: Source | undefined = part && 'parts' in o ? { uri: o.uri, sql: part.sql } : 'source' in single ? single.source : undefined;
  return rs && { rs, src };
}

async function rootFor(uri: vscode.Uri): Promise<string> {
  const f = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (f?.uri.scheme === 'file') return cacheRoot(f.uri.fsPath);
  await fs.mkdir(fallback, { recursive: true, mode: 0o700 });
  return fallback;
}

/** tombol Load all: stream semua baris statement asal (+ WHERE aktif) ke cache; progres ke webview, batas = query di-cancel + partial */
export async function startLoadAll(m: ResultMessage, o: Outcome | undefined, post: Post): Promise<void> {
  const t = target(m, o);
  if (!t?.src || t.rs.cache) return;
  const { rs, src } = t;
  const c = fileConn(vscode.Uri.parse(src.uri));
  if (!c) {
    showError('Load all: the connection for this result no longer exists');
    return results.refresh();
  }
  const cfg = vscode.workspace.getConfiguration('moonageDaydream.grid');
  const lim = cacheLimits(cfg.get<number>('maxCachedRows'), cfg.get<number>('cacheMemoryMB'));
  let gc: GridCache | undefined;
  const started = Date.now();
  try {
    const cache = new ResultCache(await rootFor(vscode.Uri.parse(src.uri)), { maxRows: lim.maxRows, memBytes: chunkBudget(lim) });
    const loading = { ac: new AbortController(), rows: 0 };
    gc = { view: new CacheView(cache, (col) => isNumCol(rs, col)), at: Date.now(), loading };
    rs.cache = gc;
    live.add(gc);
    results.refresh(); // grid digambar ulang dalam mode cache + progres
    const sql = src.where ? addWhere(src.sql, src.where) : src.sql;
    const tx = openTx(src.uri, c);
    const password = tx ? '' : await conns.password(c.name);
    let lastPost = 0;
    await loadAll(cache, (signal, sink) => (tx ? tx.stream(sql, signal, sink) : drivers[c.type].stream(c, password, sql, signal, sink)), {
      signal: loading.ac.signal,
      onProgress: (n) => {
        loading.rows = n;
        if (Date.now() - lastPost < 150) return; // cukup beberapa kali per detik
        lastPost = Date.now();
        post({ type: 'cload', set: m.set, part: m.part, rows: n });
      },
    });
    log.info(`load all: ${cache.length} rows in ${Date.now() - started} ms (RAM ${cache.memBytes} B, disk ${cache.diskBytes} B${cache.partial ? ', partial' : ''})`);
    if (cache.partial) {
      const n = cache.length.toLocaleString('en-US');
      void vscode.window.showWarningMessage(`The result cache limit of ${n} rows was reached and the query was stopped. The loaded rows can still be searched and sorted. `
        + 'To see the rest, narrow the query with WHERE, or use Export → All Data from server (no limit).');
    }
  } catch (e) {
    // Cancel dari user: baris yang sudah masuk tetap bisa dicari (bukan kegagalan, tetap dicatat sesuai aturan log)
    const cancelled = !!gc?.loading?.ac.signal.aborted;
    log.error(`loadAll - EXCEPTION CAUGHT${cancelled ? ' (cancelled by the user, loaded rows kept)' : ''} | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    if (!cancelled) showError(`Load all failed: ${errMsg(e)}`);
  } finally {
    if (gc) {
      gc.loading = undefined;
      gc.at = Date.now();
    }
    results.refresh();
  }
}

export function cancelLoad(m: ResultMessage, o: Outcome | undefined): void {
  target(m, o)?.rs.cache?.loading?.ac.abort();
}
export function cancelView(m: ResultMessage, o: Outcome | undefined): void {
  target(m, o)?.rs.cache?.busy?.abort();
}

/** webview minta halaman baris tampil (nomor asli + nilai) */
export async function cachePage(m: ResultMessage, o: Outcome | undefined, post: Post): Promise<void> {
  const gc = target(m, o)?.rs.cache;
  if (!gc || gc.cleared || m.start === undefined) return;
  try {
    post({ type: 'cpage', set: m.set, part: m.part, gen: m.gen, start: m.start, rows: await gc.view.page(m.start, m.count ?? 200) });
  } catch (e) {
    log.error(`cachePage - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Search Output / filter / kolom tampil / sort berubah: hitung ulang di host dengan progres + Cancel, balas jumlah baris baru */
export async function cacheViewMessage(m: ResultMessage, o: Outcome | undefined, post: Post): Promise<void> {
  const t = target(m, o);
  const gc = t?.rs.cache;
  if (!t || !gc || gc.cleared) return;
  const v = gc.view;
  const reply = (error?: string) => post({ type: 'cview', set: m.set, part: m.part, gen: m.gen, count: v.count, sort: v.sort, error });
  if (gc.loading) { reply('Search, filter and sort are available when loading finishes (or after Cancel)'); return; }
  gc.busy?.abort();
  const ac = new AbortController();
  gc.busy = ac;
  let last = 0;
  const onProgress = (phase: string, pct: number) => {
    if (Date.now() - last < 200) return;
    last = Date.now();
    const s = m.sort;
    const what = phase === 'searching' ? 'Searching' : `Sorting by ${t.rs.columns[s?.c ?? 0] ?? ''} ${s?.dir === -1 ? '↓' : '↑'} (${phase})`;
    post({ type: 'cbusy', set: m.set, part: m.part, text: `${what} ${pct}%` });
  };
  try {
    const keys = m.keys ?? [];
    const filters = m.filters ?? {};
    // kolom tampil hanya berpengaruh bila ada key
    if (!same(keys, v.keys) || !same(filters, v.filters) || (keys.length && !same(m.cols, v.cols))) {
      if (!same(m.sort, v.sort)) await v.setSort(null, 1); // sort lama tidak dihitung ulang bila akan diganti
      await v.setSearch(keys, filters, m.cols, { signal: ac.signal, onProgress });
    }
    if (!same(m.sort, v.sort)) await v.setSort(m.sort?.c ?? null, m.sort?.dir ?? 1, { signal: ac.signal, onProgress });
    reply();
  } catch (e) {
    log.error(`cacheView - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    reply(ac.signal.aborted ? 'Cancelled: the previous order is kept' : `Failed: ${errMsg(e)}`);
  } finally {
    if (gc.busy === ac) gc.busy = undefined;
  }
}

/** cache di semua result set sebuah outcome */
function cachesOf(o: Outcome | undefined): GridCache[] {
  if (!o) return [];
  const singles = 'parts' in o ? o.parts.map((p) => p.o) : [o];
  return singles.flatMap((s) => ('result' in s ? s.result.resultSets.flatMap((r) => (r.cache ? [r.cache] : [])) : []));
}

async function drop(gc: GridCache): Promise<void> {
  live.delete(gc);
  gc.loading?.ac.abort();
  gc.busy?.abort();
  await gc.view.cache.dispose();
}

/** buang cache yang tidak lagi tampil di panel hasil / tab pin (hasil diganti run baru, tab ditutup) */
export function gcCaches(): void {
  const keep = new Set([...cachesOf(results.current?.outcome), ...results.pinned.flatMap((p) => cachesOf(p.outcome))]);
  for (const gc of [...live]) {
    if (!keep.has(gc)) drop(gc).catch((e: unknown) => log.error(`gcCaches - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`));
  }
}

/** deactivate: semua cache dihapus */
export const disposeCaches = () => Promise.all([...live].map(drop));

/** Clear Result Cache: hasil yang tampil memakai cache ditandai "cleared", lalu semua folder cache dihapus; return byte terhapus */
export async function clearAllResultCaches(): Promise<number> {
  for (const gc of [...live]) {
    gc.cleared = true;
    await drop(gc);
  }
  const bytes = await clearResultCaches(resultRoots());
  results.refreshAll();
  return bytes;
}

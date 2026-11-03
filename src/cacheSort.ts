// sort hasil Load all yang bisa lebih besar dari RAM: external merge sort (run per batch di RAM -> file, lalu k-way merge bertingkat)
import { createReadStream, promises as fs } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import type { ResultCache } from './resultCache';

type Pair = [key: string | null, row: number];
export type SortProgress = (phase: 'sorting chunks' | 'merging', percent: number) => void;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let seq = 0;

/** pembanding: NULL selalu di akhir (arah apa pun), angka sebagai angka, teks tanpa beda huruf besar / kecil; sama = nomor baris asli */
export function comparer(dir: 1 | -1, num: boolean): (a: Pair, b: Pair) => number {
  return (a, b) => {
    if (a[0] === null || b[0] === null) return a[0] === b[0] ? a[1] - b[1] : a[0] === null ? 1 : -1;
    const d = num ? Number(a[0]) - Number(b[0]) : collator.compare(a[0], b[0]);
    return d ? dir * d : a[1] - b[1];
  };
}

async function* readRun(file: string): AsyncGenerator<Pair> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line) as Pair;
}

/** heap kecil untuk k-way merge: satu kepala per run */
async function merge(files: string[], cmp: (a: Pair, b: Pair) => number, emit: (p: Pair) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  const its = files.map(readRun);
  const heap: [Pair, number][] = [];
  const less = (i: number, j: number) => cmp(heap[i][0], heap[j][0]) < 0;
  const swap = (i: number, j: number) => { [heap[i], heap[j]] = [heap[j], heap[i]]; };
  const push = (x: [Pair, number]) => {
    heap.push(x);
    for (let i = heap.length - 1; i > 0 && less(i, (i - 1) >> 1); i = (i - 1) >> 1) swap(i, (i - 1) >> 1);
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(l, m)) m = l;
        if (r < heap.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    }
    return top;
  };
  for (let k = 0; k < its.length; k++) {
    const n = await its[k].next();
    if (!n.done) push([n.value, k]);
  }
  let count = 0;
  while (heap.length) {
    if (++count % 10_000 === 0) signal?.throwIfAborted();
    const [p, k] = pop();
    await emit(p);
    const n = await its[k].next();
    if (!n.done) push([n.value, k]);
  }
}

/**
 * Urutkan baris cache (rows = nomor baris hasil search, urut naik; null = semua) menurut kolom col.
 * RAM: satu batch runRows pasangan [nilai, nomor baris] + kepala tiap run saat merge (fanIn run sekaligus);
 * hasil akhir = daftar nomor baris (Uint32Array). File run sementara di <cache>/sort-*, selalu dihapus.
 */
export async function sortRows(cache: ResultCache, rows: Uint32Array | null, col: number, dir: 1 | -1, num: boolean,
  o: { signal?: AbortSignal; onProgress?: SortProgress; runRows?: number; fanIn?: number } = {}): Promise<Uint32Array> {
  const runRows = o.runRows ?? cache.chunkRows;
  const fanIn = Math.max(2, o.fanIn ?? 64);
  const cmp = comparer(dir, num);
  const tmp = join(cache.dir, `sort-${col}-${dir > 0 ? 'asc' : 'desc'}-${seq++}`);
  const total = rows ? rows.length : cache.length;
  const out = new Uint32Array(total);
  try {
    // fase 1: baca chunk berurutan, kumpulkan pasangan per batch, urutkan, tulis sebagai run
    let runs: string[] = [];
    let batch: Pair[] = [];
    const flush = async () => {
      if (!batch.length) return;
      batch.sort(cmp);
      if (!runs.length) await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
      const f = join(tmp, `run-0-${runs.length}.jsonl`);
      await fs.writeFile(f, batch.map((p) => JSON.stringify(p)).join('\n'), { mode: 0o600 });
      runs.push(f);
      batch = [];
    };
    let pos = 0;
    const chunks = cache.chunkCount;
    for (let ci = 0; ci < chunks && (rows ? pos < rows.length : true); ci++) {
      o.signal?.throwIfAborted();
      const base = ci * cache.chunkRows;
      const data = await cache.chunk(ci);
      if (rows) {
        for (; pos < rows.length && rows[pos] < base + data.length; pos++) {
          batch.push([data[rows[pos] - base][col], rows[pos]]);
          if (batch.length >= runRows) await flush();
        }
      } else {
        for (let r = 0; r < data.length; r++) {
          batch.push([data[r][col], base + r]);
          if (batch.length >= runRows) await flush();
        }
      }
      o.onProgress?.('sorting chunks', Math.round(((ci + 1) / chunks) * 100));
      await new Promise((res) => setImmediate(res)); // giliran untuk Cancel / UI
    }
    if (!runs.length) { // semua muat dalam satu batch: tanpa file
      batch.sort(cmp);
      batch.forEach((p, i) => { out[i] = p[1]; });
      o.onProgress?.('merging', 100);
      return out;
    }
    await flush();
    // fase 2: merge bertingkat, maksimal fanIn run sekaligus supaya jumlah file terbuka & buffer tetap kecil
    for (let pass = 1; ; pass++) { // berakhir di merge terakhir (runs <= fanIn); tiap pass memperkecil jumlah run
      if (runs.length <= fanIn) {
        let i = 0;
        await merge(runs, cmp, (p) => { out[i++] = p[1]; if (i % 10_000 === 0) o.onProgress?.('merging', Math.round((i / total) * 100)); }, o.signal);
        o.onProgress?.('merging', 100);
        return out;
      }
      const next: string[] = [];
      for (let g = 0; g < runs.length; g += fanIn) {
        o.signal?.throwIfAborted();
        const f = join(tmp, `run-${pass}-${next.length}.jsonl`);
        const lines: string[] = [];
        const h = await fs.open(f, 'w', 0o600);
        try {
          await merge(runs.slice(g, g + fanIn), cmp, async (p) => {
            lines.push(JSON.stringify(p));
            if (lines.length >= 10_000) await h.write(lines.splice(0).join('\n') + '\n');
          }, o.signal);
          if (lines.length) await h.write(lines.join('\n') + '\n');
        } finally {
          await h.close();
        }
        next.push(f);
        o.onProgress?.('merging', Math.round(((g + fanIn) / runs.length) * 50));
      }
      await Promise.all(runs.map((r) => fs.rm(r, { force: true })));
      runs = next;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

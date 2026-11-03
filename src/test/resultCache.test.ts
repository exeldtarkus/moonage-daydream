import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Sink } from '../db';
import { cacheLimits, cacheRoot, clearResultCaches, loadAll, parseKeys, pruneStale, ResultCache, rowMatches, searchCache } from '../resultCache';

const tmp = () => mkdtempSync(join(tmpdir(), 'md-rcache-'));
const fill = async (c: ResultCache, n: number, cols = ['id', 'nama']) => {
  await c.columns(cols);
  for (let i = 0; i < n; i++) await c.row([i, `r${i}`]);
  await c.finish();
};

test('cacheLimits: defaults 5,000,000 rows / 100 MB, values above the cap are clamped, below 1 falls back', () => {
  assert.deepEqual(cacheLimits(), { maxRows: 5_000_000, memBytes: 100 * 1024 * 1024 });
  assert.deepEqual(cacheLimits(10_000_000, 500), { maxRows: 5_000_000, memBytes: 100 * 1024 * 1024 });
  assert.deepEqual(cacheLimits(25, 1), { maxRows: 25, memBytes: 1024 * 1024 });
  assert.deepEqual(cacheLimits(0, -3), { maxRows: 5_000_000, memBytes: 100 * 1024 * 1024 });
});

test('cacheRoot: creates .moonage-cache with a self-ignoring .gitignore, nothing shows in git status', async () => {
  const repo = tmp();
  try {
    execFileSync('git', ['init', '-q', repo]);
    const root = await cacheRoot(repo);
    assert.equal(root, join(repo, '.moonage-cache'));
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '*\n');
    const c = new ResultCache(root, { chunkRows: 2, memBytes: 1 });
    await fill(c, 5);
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all']).toString(), '');
    await cacheRoot(repo); // dipanggil ulang: tidak error, .gitignore tetap
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '*\n');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('ResultCache: chunks over the memory limit go to disk (0600), pages read across chunks, text like the grid', async () => {
  const root = tmp();
  try {
    const c = new ResultCache(root, { chunkRows: 3, memBytes: 1 }); // RAM 1 byte: semua chunk ke disk
    await c.columns(['id', 'when', 'note']);
    for (let i = 0; i < 8; i++) await c.row([i, new Date(Date.UTC(2026, 0, 1 + i)), i % 2 ? null : 'x']);
    await c.finish();
    assert.equal(c.length, 8);
    assert.equal(c.partial, false);
    assert.deepEqual(c.cols, ['id', 'when', 'note']);
    const files = readdirSync(c.dir).filter((f) => f.startsWith('chunk-')).sort();
    assert.deepEqual(files, ['chunk-0.jsonl', 'chunk-1.jsonl', 'chunk-2.jsonl']);
    if (process.platform !== 'win32') assert.equal(statSync(join(c.dir, files[0])).mode & 0o777, 0o600);
    assert.ok(c.diskBytes > 0);
    assert.equal(c.memBytes, 0);
    assert.deepEqual(await c.page(2, 3), [
      ['2', '2026-01-03T00:00:00.000Z', 'x'], ['3', '2026-01-04T00:00:00.000Z', null], ['4', '2026-01-05T00:00:00.000Z', 'x']]);
    assert.deepEqual((await c.page(6, 10)).map((r) => r[0]), ['6', '7']);
    assert.deepEqual(await c.page(20, 5), []);
    await c.dispose();
    assert.equal(existsSync(c.dir), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ResultCache: within the memory limit chunks stay in RAM (no chunk files)', async () => {
  const root = tmp();
  try {
    const c = new ResultCache(root, { chunkRows: 3 });
    await fill(c, 7);
    assert.equal(readdirSync(c.dir).filter((f) => f.startsWith('chunk-')).length, 0);
    assert.ok(c.memBytes > 0);
    assert.deepEqual((await c.page(0, 7)).map((r) => r[1]), ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** stream palsu ala driver: berhenti bila signal di-abort (cancel di server) */
const fakeStream = (n: number, cancels: string[]) => async (signal: AbortSignal, sink: Sink) => {
  signal.addEventListener('abort', () => cancels.push('cancel'));
  await sink.columns(['id', 'nama']);
  let i = 0;
  for (; i < n; i++) {
    if (signal.aborted) throw new Error('Query was cancelled');
    await sink.row([i, `r${i}`]);
  }
  return i;
};

test('loadAll: stops at maxRows, cancels the server query exactly once, result marked partial', async () => {
  const root = tmp();
  try {
    const cancels: string[] = [];
    const c = new ResultCache(root, { chunkRows: 10, maxRows: 25 });
    const progress: number[] = [];
    await loadAll(c, fakeStream(40, cancels), { onProgress: (n) => progress.push(n) });
    assert.equal(c.length, 25);
    assert.equal(c.partial, true);
    assert.deepEqual(cancels, ['cancel']);
    assert.deepEqual((await c.page(24, 5)).map((r) => r[0]), ['24']);
    assert.ok(progress.length > 0 && progress.at(-1) === 25);
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('loadAll: below the limit not partial, no cancel; a user cancel keeps loaded rows and rethrows', async () => {
  const root = tmp();
  try {
    const cancels: string[] = [];
    const c = new ResultCache(root, { chunkRows: 10, maxRows: 25 });
    await loadAll(c, fakeStream(20, cancels));
    assert.equal(c.length, 20);
    assert.equal(c.partial, false);
    assert.deepEqual(cancels, []);
    await c.dispose();

    const user = new AbortController();
    const d = new ResultCache(root, { chunkRows: 10, maxRows: 100 });
    const slow = async (signal: AbortSignal, sink: Sink) => {
      await sink.columns(['id']);
      for (let i = 0; i < 50; i++) {
        if (signal.aborted) throw new Error('Query was cancelled');
        if (i === 12) user.abort();
        await sink.row([i]);
      }
      return 50;
    };
    await assert.rejects(loadAll(d, slow, { signal: user.signal }), /cancelled/);
    assert.equal(d.length, 13);
    assert.equal(d.partial, false);
    await d.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Search Output keys: contains (case-insensitive), "quoted" = exact, null = NULL cell, chips are OR', () => {
  const keys = parseKeys(['exel', '"Rusia"', 'null', '  ', 'SUMBER']);
  assert.equal(keys.length, 4); // key kosong dibuang
  const row = (...v: (string | null)[]) => v;
  assert.equal(rowMatches(row('1', 'Exel Tarkus', 'x'), parseKeys(['exel'])), true);
  assert.equal(rowMatches(row('2', 'joni', 'sumbersari'), parseKeys(['SUMBER'])), true);
  assert.equal(rowMatches(row('2', 'joni', 'rusia'), parseKeys(['"Rusia"'])), false); // exact peka huruf
  assert.equal(rowMatches(row('2', 'joni', 'Rusia'), parseKeys(['"Rusia"'])), true);
  assert.equal(rowMatches(row('2', 'joni', 'Rusia Timur'), parseKeys(['"Rusia"'])), false);
  assert.equal(rowMatches(row('3', null, 'x'), parseKeys(['null'])), true);
  assert.equal(rowMatches(row('3', 'null', 'x'), parseKeys(['null'])), false);
  assert.equal(rowMatches(row('4', 'budi', 'jakarta'), parseKeys(['exel', 'jakarta'])), true); // OR
  assert.equal(rowMatches(row('4', 'budi', 'jakarta'), parseKeys(['exel', 'rusia'])), false);
  assert.equal(rowMatches(row('4', 'budi', 'jakarta'), []), true); // tanpa key = semua baris
  assert.equal(rowMatches(row('4', 'budi', 'jakarta'), parseKeys(['jakarta']), [0, 1]), false); // kolom tersembunyi tidak ikut
});

test('searchCache: user example over the whole cache (RAM + disk), progress, cancel', async () => {
  const root = tmp();
  try {
    const c = new ResultCache(root, { chunkRows: 2, memBytes: 1 });
    await c.columns(['nama', 'alamat']);
    for (const r of [['exel', 'sumbersari'], ['joni', 'rusia'], ['budi', 'jakarta'], ['Exel2', 'bandung'], ['sari', null]]) await c.row(r);
    await c.finish();
    assert.deepEqual([...await searchCache(c, parseKeys(['exel']))], [0, 3]);
    const progress: number[] = [];
    assert.deepEqual([...await searchCache(c, parseKeys(['exel', 'rusia']), { onProgress: (p) => progress.push(p) })], [0, 1, 3]);
    assert.equal(progress.at(-1), 100);
    assert.deepEqual([...await searchCache(c, parseKeys(['sari']), { cols: [0] })], [4]); // alamat tidak dicari
    assert.deepEqual([...await searchCache(c, [])], [0, 1, 2, 3, 4]);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(searchCache(c, parseKeys(['exel']), { signal: ac.signal }));
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clearResultCaches removes every cache folder and returns the size; pruneStale keeps caches of live processes', async () => {
  const a = tmp();
  const b = tmp();
  try {
    const ra = await cacheRoot(a);
    const c = new ResultCache(ra, { chunkRows: 2, memBytes: 1 });
    await fill(c, 6);
    const dead = join(ra, '999999999-old');
    mkdirSync(dead);
    await pruneStale(ra);
    assert.equal(existsSync(dead), false); // proses 999999999 tidak ada
    assert.equal(existsSync(c.dir), true); // milik proses ini
    const bytes = await clearResultCaches([ra, join(b, '.moonage-cache')]);
    assert.ok(bytes > 0);
    assert.equal(existsSync(ra), false);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('loadAll with the real SQLite driver stream: limit stops at maxRows (partial), search runs over the cached rows', async () => {
  const { drivers } = await import('../db');
  const { writeFileSync } = await import('fs');
  const root = tmp();
  try {
    const file = join(root, 'lab.db');
    writeFileSync(file, '');
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const values = Array.from({ length: 30 }, (_, i) => `(${i + 1}, '${i % 3 ? 'joni' : 'exel'}', ${i % 5 ? `'kota${i}'` : 'NULL'})`).join(', ');
    await drivers.sqlite.run(c, '', `CREATE TABLE t (id INTEGER, nama TEXT, kota TEXT); INSERT INTO t VALUES ${values};`);
    const cache = new ResultCache(root, { chunkRows: 10, maxRows: 25, memBytes: 1 });
    await loadAll(cache, (signal, sink) => drivers.sqlite.stream(c, '', 'SELECT id, nama, kota FROM t ORDER BY id', signal, sink));
    assert.deepEqual(cache.cols, ['id', 'nama', 'kota']);
    assert.equal(cache.length, 25);
    assert.equal(cache.partial, true);
    assert.deepEqual(await cache.page(0, 2), [['1', 'exel', null], ['2', 'joni', 'kota1']]);
    assert.equal((await searchCache(cache, parseKeys(['exel']))).length, 9); // id 1,4,...,25
    assert.deepEqual([...await searchCache(cache, parseKeys(['null']))], [0, 5, 10, 15, 20]);
    await cache.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

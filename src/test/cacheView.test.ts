import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chunkBudget, ResultCache } from '../resultCache';
import { sortRows } from '../cacheSort';
import { CacheView } from '../cacheView';

const tmp = () => mkdtempSync(join(tmpdir(), 'md-cview-'));
async function make(root: string, cols: string[], rows: unknown[][], chunkRows = 2) {
  const c = new ResultCache(root, { chunkRows, memBytes: 1 }); // semua chunk ke disk
  await c.columns(cols);
  for (const r of rows) await c.row(r);
  await c.finish();
  return c;
}
const vals = async (c: ResultCache, order: Uint32Array, col: number) => Promise.all([...order].map(async (i) => (await c.page(i, 1))[0][col]));

test('chunkBudget: RAM for chunks leaves room for the search + sort row lists (4 bytes x 2 x maxRows)', () => {
  assert.equal(chunkBudget({ maxRows: 5_000_000, memBytes: 100 * 1024 * 1024 }), 100 * 1024 * 1024 - 40_000_000);
  assert.equal(chunkBudget({ maxRows: 25, memBytes: 1024 * 1024 }), 1024 * 1024 - 200);
  assert.equal(chunkBudget({ maxRows: 5_000_000, memBytes: 1024 * 1024 }), 0); // tidak cukup: semua chunk ke disk
});

test('sortRows: external merge (tiny runs, several merge passes) equals an in-memory sort; NULL last both ways', async () => {
  const root = tmp();
  try {
    const nums = [5, null, 12, 3, 3, 40, null, 7, 1, 25, 9, 2];
    const c = await make(root, ['n'], nums.map((n) => [n]), 3);
    const asc = await sortRows(c, null, 0, 1, true, { runRows: 2, fanIn: 2 });
    assert.deepEqual(await vals(c, asc, 0), ['1', '2', '3', '3', '5', '7', '9', '12', '25', '40', null, null]);
    assert.deepEqual([...asc].slice(2, 4), [3, 4]); // nilai sama: urutan baris asli dipertahankan
    const desc = await sortRows(c, null, 0, -1, true, { runRows: 2, fanIn: 2 });
    assert.deepEqual(await vals(c, desc, 0), ['40', '25', '12', '9', '7', '5', '3', '3', '2', '1', null, null]);
    assert.deepEqual(readdirSync(c.dir).filter((f) => f.startsWith('sort-')), []); // file run sementara dibersihkan
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sortRows: text is case-insensitive with numeric parts, dates as ISO; only the given rows are sorted', async () => {
  const root = tmp();
  try {
    const c = await make(root, ['t', 'd'], [['beta', new Date(Date.UTC(2026, 2, 1))], ['Alpha', new Date(Date.UTC(2025, 0, 1))],
      ['item10', new Date(Date.UTC(2026, 0, 1))], ['item2', null], ['alpha2', new Date(Date.UTC(2024, 5, 1))]]);
    assert.deepEqual(await vals(c, await sortRows(c, null, 0, 1, false, { runRows: 2, fanIn: 3 }), 0), ['Alpha', 'alpha2', 'beta', 'item2', 'item10']);
    assert.deepEqual([...await sortRows(c, null, 1, 1, false)], [4, 1, 2, 0, 3]);
    assert.deepEqual([...await sortRows(c, Uint32Array.from([0, 2, 3]), 0, -1, false, { runRows: 1 })], [2, 3, 0]);
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sortRows: progress phases, Cancel removes the temporary run files', async () => {
  const root = tmp();
  try {
    const c = await make(root, ['n'], Array.from({ length: 30 }, (_, i) => [30 - i]), 5);
    const phases = new Set<string>();
    await sortRows(c, null, 0, 1, true, { runRows: 4, fanIn: 2, onProgress: (p) => phases.add(p) });
    assert.deepEqual([...phases], ['sorting chunks', 'merging']);
    const ac = new AbortController();
    await assert.rejects(sortRows(c, null, 0, 1, true, {
      runRows: 4, fanIn: 2, signal: ac.signal, onProgress: (p, pct) => { if (p === 'sorting chunks' && pct >= 40) ac.abort(); },
    }));
    assert.deepEqual(readdirSync(c.dir).filter((f) => f.startsWith('sort-')), []);
    assert.equal(existsSync(c.dir), true);
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CacheView: Search Output chips (OR) AND column filters, hidden columns ignored, pages carry the original row index', async () => {
  const root = tmp();
  try {
    const c = await make(root, ['nama', 'alamat', 'kota'], [
      ['exel', 'sumbersari', 'jember'], ['joni', 'rusia', 'moskow'], ['budi', 'jakarta', null], ['Exel2', 'bandung', 'bandung'], ['sari', null, 'jember']]);
    const v = new CacheView(c);
    assert.equal(v.count, 5);
    await v.setSearch(['exel'], {}, undefined);
    assert.equal(v.count, 2);
    assert.deepEqual(await v.page(0, 10), [[0, 'exel', 'sumbersari', 'jember'], [3, 'Exel2', 'bandung', 'bandung']]);
    await v.setSearch(['exel', 'rusia'], {}, undefined);
    assert.deepEqual((await v.page(0, 10)).map((r) => r[0]), [0, 1, 3]);
    await v.setSearch(['exel', 'rusia'], { 2: 'jember' }, undefined); // filter corong per kolom: AND
    assert.deepEqual((await v.page(0, 10)).map((r) => r[0]), [0]);
    await v.setSearch([], { 1: 'null' }, undefined);
    assert.deepEqual((await v.page(0, 10)).map((r) => r[0]), [4]);
    await v.setSearch(['sari'], {}, [0, 2]); // kolom alamat disembunyikan
    assert.deepEqual((await v.page(0, 10)).map((r) => r[0]), [4]);
    await v.setSearch([], {}, undefined);
    assert.equal(v.count, 5);
    assert.deepEqual((await v.page(3, 1))[0], [3, 'Exel2', 'bandung', 'bandung']);
    assert.deepEqual(await v.rowsAt([4, 1]), [['sari', null, 'jember'], ['joni', 'rusia', 'moskow']]);
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CacheView: sort applies to the matching rows only, is reused per column + direction, dropped when the search changes', async () => {
  const root = tmp();
  try {
    const c = await make(root, ['nama', 'umur'], [['exel', 30], ['joni', 25], ['exa', 41], ['budi', 19], ['Exo', null]]);
    const v = new CacheView(c, () => true);
    await v.setSearch(['ex'], {}, undefined);
    await v.setSort(1, -1);
    assert.deepEqual((await v.page(0, 10)).map((r) => r[1]), ['exa', 'exel', 'Exo']);
    assert.equal(v.sortRuns, 1);
    await v.setSort(null, 1);
    assert.deepEqual((await v.page(0, 10)).map((r) => r[1]), ['exel', 'exa', 'Exo']);
    await v.setSort(1, -1);
    assert.equal(v.sortRuns, 1); // dari cache sort
    await v.setSearch(['ex', 'joni'], {}, undefined); // search berubah: sort dihitung ulang atas hasil baru
    assert.deepEqual(v.sort, { c: 1, dir: -1 });
    assert.equal(v.sortRuns, 2);
    assert.deepEqual((await v.page(0, 10)).map((r) => r[1]), ['exa', 'exel', 'joni', 'Exo']);
    const all: unknown[][] = [];
    for await (const r of v.rows('view')) all.push(r);
    assert.deepEqual(all.map((r) => r[0]), ['exa', 'exel', 'joni', 'Exo']);
    const cached: unknown[][] = [];
    for await (const r of v.rows('cache')) cached.push(r);
    assert.equal(cached.length, 5);
    await c.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { render } from '../resultsHtml';
import { ResultCache } from '../resultCache';
import { CacheView, type GridCache } from '../cacheView';
import type { QueryResult } from '../db';

const src = { uri: 'file:///w/a.sql', sql: 'select * from t' };
const res = (o: Partial<QueryResult['resultSets'][0]> = {}): QueryResult => ({
  resultSets: [{ columns: ['nama', 'alamat'], types: ['varchar', 'varchar'], rows: [['exel', 'sumbersari'], ['joni', 'rusia']], total: 2, ...o }],
  rowsAffected: [], messages: [], durationMs: 3,
});

test('Search Output bar above every result grid (also without a source), with chips input and live match count', () => {
  for (const html of [render('csp', 't', { result: res(), source: src }), render('csp', 't', { result: res() })]) {
    assert.match(html, /<div class="sout"[^>]*>.*Search Output/s);
    assert.match(html, /<input class="skey"[^>]*aria-label="Search Output: type a value, Enter to add"/);
    assert.match(html, /<span class="smatch" aria-live="polite">/);
  }
});

test('Load all button only for the first result set of a truncated result with a known source', () => {
  assert.match(render('csp', 't', { result: res({ limited: 100, total: 100 }), source: src }), /<button class="allbtn"/);
  assert.match(render('csp', 't', { result: res({ total: 5000 }), source: src }), /<button class="allbtn"/);
  assert.doesNotMatch(render('csp', 't', { result: res(), source: src }), /class="allbtn"/); // semua baris sudah ada
  assert.doesNotMatch(render('csp', 't', { result: res({ total: 5000 }) }), /class="allbtn"/); // tanpa statement asal
  assert.doesNotMatch(render('csp', 't', { result: res({ total: 5000 }), source: src }, true), /class="allbtn"/); // tab pin
});

test('cached result: rows come from the host (data-cache state), read-only, cache size / partial / loading / cleared in the header', async () => {
  const root = mkdtempSync(join(tmpdir(), 'md-sout-'));
  try {
    const cache = new ResultCache(root, { chunkRows: 2, maxRows: 3, memBytes: 1 });
    await cache.columns(['nama', 'alamat']);
    for (const r of [['exel', 'x'], ['joni', 'rusia'], ['budi', 'y'], ['sari', 'z']]) await cache.row(r);
    await cache.finish();
    const view = new CacheView(cache);
    await view.setSearch(['exel'], {}, undefined);
    const gc: GridCache = { view, at: Date.UTC(2026, 10, 3, 13, 41) };
    const html = render('csp', 't', { result: res({ total: 100, limited: 100, cache: gc }), source: src });
    const state = JSON.parse((/data-cache="([^"]*)"/.exec(html)?.[1] ?? '{}').replace(/&quot;/g, '"').replace(/&amp;/g, '&')) as Record<string, unknown>;
    assert.deepEqual(state, { count: 1, total: 3, keys: ['exel'], filters: {}, sort: null, partial: true, loading: false });
    assert.match(html, /<script type="application\/json" class="rows">\[\]<\/script>/); // baris tidak ikut HTML
    assert.doesNotMatch(html, /class="allbtn"|class="morebtn"|data-edit="1"/);
    assert.match(html, /class="editbar off" title="Editing is off: rows loaded with Load all are read-only/);
    assert.match(html, /Partial: 3 rows cached \(limit reached\)/);
    assert.match(html, /RAM 0\.0 MB · disk 0\.0 MB/);
    gc.loading = { ac: new AbortController(), rows: 2 };
    assert.match(render('csp', 't', { result: res({ cache: gc }), source: src }), /Loading 2 rows…<button class="cancelload"/);
    gc.loading = undefined;
    gc.cleared = true;
    assert.match(render('csp', 't', { result: res({ cache: gc }), source: src }), /Result cache cleared, run the query again/);
    await cache.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('row counts use dots as thousands separator: 1.000.000 row(s) (showing first 1.000), footer, auto limit, Load more', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ['n' + i, 'a']);
  const html = render('csp', 't', { result: res({ rows, total: 1_000_000 }), source: src });
  assert.match(html, /<span class="rtitle">1\.000\.000 row\(s\) \(showing first 1\.000\)<\/span>/);
  assert.match(html, /<b class="count" data-total="1000">1\.000\.000<\/b> \(showing first 1\.000\)/);
  assert.match(html, />Load more \(\+1\.000\)</);
  assert.match(render('csp', 't', { result: res({ rows, total: 12_500, limited: 12_500 }), source: src }), /12\.500 row\(s\) · auto limit 12\.500/);
  assert.match(render('csp', 't', { result: res() }), /<span class="rtitle">2 row\(s\)<\/span>/);
});

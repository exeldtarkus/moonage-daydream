import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });
const foot = () => /<div class="foot">([\s\S]*?)<\/div><\/div>/.exec(page())?.[1] ?? '';

test('header hasil: satu baris berisi judul + ikon aksi', () => {
  const html = page();
  assert.match(html, /<div class="rbar"><span class="rtools">/);
  assert.match(html, /<span class="rtools">[\s\S]{0,2000}class="searchbtn"/, 'ikon search di header');
  assert.match(html, /<span class="rtools">[\s\S]{0,4000}class="addrow"/, 'Add row pindah ke header');
  assert.match(html, /<span class="rtools">[\s\S]{0,4000}class="delrow"/, 'Delete rows pindah ke header');
});

test('header hasil: tombol aksi jadi ikon (svg), bukan teks', () => {
  const html = page();
  assert.match(html, /class="addrow"[^>]*aria-label="Add row"[^>]*><svg/);
  assert.match(html, /class="delrow"[^>]*aria-label="Delete rows"[^>]*><svg/);
  assert.match(html, /class="save"[^>]*aria-label="Save"[^>]*><svg/);
});

test('footer: tanpa tombol edit lagi (tinggal Rows / waktu / paging)', () => {
  const f = foot();
  assert.ok(!f.includes('addrow'), 'Add row tidak di footer');
  assert.ok(!f.includes('editbar'), 'editbar tidak di footer');
  assert.ok(f.includes('Rows:') && f.includes('pager'), 'Rows + pager tetap di footer');
});

test('Search Output: tersembunyi sampai ikon search diklik', () => {
  const html = page();
  assert.match(html, /<div class="sout" role="search" hidden>/);
  assert.match(html, /searchbtn'\)\) \{[\s\S]{0,120}openSearch\(/, 'ikon search memanggil openSearch');
  assert.match(html, /function openSearch\(blk, mode\) \{[\s\S]{0,600}sout\.hidden = close/, 'toggle panel search');
  assert.match(html, /\.skey'\)\.focus\(\)/, 'fokus ke input setelah dibuka');
  assert.match(html, /function openSearch[\s\S]{0,800}s\.keys = \[\]/, 'menutup search membuang key (tidak ada filter tersembunyi)');
});

test('Search Output: [hidden] benar-benar menyembunyikan baris search', () => {
  assert.match(page(), /\.sout\[hidden\] \{ display: none; \}/);
});

test('Ctrl+F di panel hasil membuka Search Output', () => {
  const html = page();
  assert.match(html, /key === 'f'[\s\S]{0,200}openSearch/, 'Ctrl / Cmd + F membuka search');
  assert.match(html, /preventDefault\(\)/);
});

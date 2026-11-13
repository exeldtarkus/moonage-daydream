import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id', 'topic_name'], types: ['int', 'varchar'], rows: [[1, 'a']], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });

test('toolbar hasil: menyatu dengan grid (satu kotak, tanpa celah)', () => {
  const html = page();
  assert.match(html, /\.rbar \{[^}]*border: 1px solid var\(--vscode-panel-border\)/);
  assert.match(html, /\.rbar \{[^}]*border-bottom: 1px solid/, 'garis pemisah ke grid');
  assert.match(html, /\.grid \{[^}]*border-top: 0/);
});

test('toolbar hasil: pemisah sejajar dengan garis kolom nomor baris', () => {
  const html = page();
  assert.match(html, /\.rbar::before \{[^}]*width: var\(--ncol/, 'lebar pemisah mengikuti kolom nomor');
  assert.match(html, /\.rbar::before \+ \* \{[^}]*border-left: 1px solid var\(--vscode-panel-border\)/, 'garis setelah gutter');
  assert.match(html, /setProperty\('--ncol'/, 'lebar kolom nomor diukur saat grid digambar');
});

test('toolbar hasil: tiap segmen dipisah garis penuh (ikon | WHERE | search)', () => {
  const html = page();
  assert.match(html, /\.rbar > \* \+ \*[^{]*\{[^}]*border-left: 1px solid var\(--vscode-panel-border\)/);
  assert.match(html, /\.rbar \{[^}]*gap: 0/, 'tanpa jarak: garis pemisah yang memisahkan');
  assert.match(html, /\.rbar > \* \{[^}]*align-items: center/);
});

test('toolbar hasil: lebar pemisah dihitung dari posisi garis kolom, bukan lebar sel saja', () => {
  assert.match(page(), /getBoundingClientRect\(\)\.right - bar\.getBoundingClientRect\(\)\.left - 1/);
});

test('toolbar hasil: ada garis pemisah antara toolbar ikon dan grid', () => {
  assert.match(page(), /\.rbar \{[^}]*border-bottom: 1px solid var\(--vscode-panel-border\)/);
});

test('toolbar hasil: ikon sedikit lebih besar', () => {
  const html = page();
  assert.match(html, /\.rtools button \{[^}]*width: 26px; height: 24px/);
  assert.match(html, /\.rtools button svg \{ width: 16px; height: 16px/);
});

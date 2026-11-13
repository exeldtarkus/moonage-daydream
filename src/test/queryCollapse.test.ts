import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', {
  uri: 'file:///q.sql', start: 0, end: 44,
  parts: [
    { sql: 'select 1', o: { result: res } },
    { sql: 'select 2', o: { loading: true } },
  ],
});

test('multi query: tiap Query bisa ditutup / dibuka, default terbuka', () => {
  const html = page();
  const parts = html.match(/<details class="qpart" open>/g) ?? [];
  assert.equal(parts.length, 2, 'satu details terbuka per query');
  assert.match(html, /<section data-part="0"><details class="qpart" open><summary>/);
  assert.match(html, /<summary>[\s\S]{0,400}<h2>Query 1 /, 'judul Query ada di summary');
  assert.match(html, /<summary>[\s\S]{0,400}<h2>Query 2 /, 'query yang masih loading juga bisa ditutup');
});

test('multi query: chevron di kiri judul, berputar saat terbuka', () => {
  const html = page();
  assert.match(html, /<summary>\s*<svg class="chev"/, 'ikon chevron sebelum judul');
  assert.match(html, /details\.qpart\[open\] > summary \.chev \{[^}]*rotate\(90deg\)/);
  assert.match(html, /details\.qpart > summary \{[^}]*cursor: pointer/);
  assert.match(html, /details\.qpart > summary \{[^}]*list-style: none/);
});

test('multi query: tombol Collapse all menutup / membuka semua query', () => {
  const html = page();
  assert.match(html, /<button class="pinbtn collapsebtn"[^>]*>/, 'tombol di baris judul');
  assert.ok(html.includes('Collapse all'), 'label awal');
  assert.match(html, /collapsebtn'\)\) \{[\s\S]{0,400}querySelectorAll\('details\.qpart'\)/, 'handler menyentuh semua query');
  assert.ok(html.includes("'Expand all'"), 'label berubah saat semua tertutup');
});

test('single result: tanpa tombol Collapse all (hanya satu hasil)', () => {
  const one = render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });
  assert.ok(!one.includes('collapsebtn"'), 'tidak ada tombol di hasil tunggal');
});

test('Collapse all: ditangani sebelum tombol Pin (gaya tombolnya sama: class pinbtn)', () => {
  const html = page();
  assert.ok(html.indexOf("collapsebtn')) {") < html.indexOf("pinbtn')) {"), 'klik Collapse all tidak jatuh ke handler Pin');
});

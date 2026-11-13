import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const set = (n: number, limited?: number) => ({ columns: ['id'], types: ['int'], rows: Array.from({ length: n }, (_, i) => [i]), total: n, limited });
const one: QueryResult = { resultSets: [set(100, 100)], rowsAffected: [], messages: [], durationMs: 5 };
const two: QueryResult = { resultSets: [set(1), set(2)], rowsAffected: [], messages: [], durationMs: 5 };
const src = { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never;

test('hasil tunggal: teks "Result 1 … row(s) · auto limit" tidak lagi di header', () => {
  const html = render('csp', 't', { result: one, source: src });
  assert.ok(!html.includes('<span class="rhead">'), 'tidak ada label di header');
  assert.ok(!/Result 1 <span class="rtitle">/.test(html), 'tidak ada judul Result di header');
  assert.match(html, /<div class="rbar"><span class="rtools">/, 'header langsung berisi ikon');
});

test('jumlah baris tetap terbaca di footer', () => {
  const html = render('csp', 't', { result: one, source: src });
  assert.match(html, /Rows: <b class="count"[^>]*>100<\/b> · auto limit 100/);
});

test('beberapa result set: label Result N tetap ada supaya bisa dibedakan', () => {
  const html = render('csp', 't', { result: two, source: src });
  assert.ok(html.includes('<span class="rhead">Result 1</span>'));
  assert.ok(html.includes('<span class="rhead">Result 2</span>'));
});

test('mode cache: judul (RAM / disk / snapshot / Loading) tetap ditampilkan', () => {
  const cached = {
    resultSets: [{ ...set(0), cache: { view: { cache: { length: 3, partial: false, memBytes: 10, diskBytes: 0 }, count: 3, keys: [], filters: {}, sort: null }, at: Date.now() } }],
    rowsAffected: [], messages: [], durationMs: 5,
  } as unknown as QueryResult;
  const html = render('csp', 't', { result: cached, source: src });
  assert.match(html, /<span class="rtitle">3 rows cached/);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const one: QueryResult = {
  resultSets: [{ columns: ['terst'], types: ['int'], rows: [[2825]], total: 1 }], rowsAffected: [], messages: [], durationMs: 4,
};
const page = () => render('csp', 't', { result: one, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });

test('hasil berkolom sedikit: ada kolom sisa supaya data tetap di kiri', () => {
  const html = page();
  assert.match(html, /<th class="fill"><\/th><\/tr><\/thead>/, 'kolom sisa di ujung header');
  assert.match(html, /\.fill \{[^}]*width: 100%/, 'kolom sisa menyerap lebar');
  assert.ok(html.includes('<td class="fill"></td></tr>'), 'tiap baris punya sel sisa');
});

test('kolom sisa tidak dianggap kolom data', () => {
  const html = page();
  assert.match(html, /\.slice\(1\)\.filter\(\(th\) => th\.dataset\.c !== undefined\)/, 'order / Columns melewati kolom sisa');
  assert.match(html, /contains\('fill'\)/, 'klik / edit / popup melewati kolom sisa');
});

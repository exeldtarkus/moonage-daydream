import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });

test('toolbar hasil: judul Result dan Search Output satu baris', () => {
  const html = page();
  assert.match(html, /<div class="rbar"><span class="rtools">/, 'header hasil tunggal langsung berisi ikon');
  assert.match(html, /<\/span><div class="sout" role="search" hidden>/, 'Search Output di baris yang sama, tersembunyi sampai dibuka');
  assert.ok(!html.includes('<h3>Result '), 'judul Result tidak lagi baris sendiri');
});

test('toolbar hasil: Search Output mengisi sisa baris, tanpa margin ekstra', () => {
  const html = page();
  assert.match(html, /\.rbar \{[^}]*display: flex/);
  assert.match(html, /\.sout \{[^}]*flex: 1/);
  assert.match(html, /\.sout \{[^}]*margin: 0/);
});

test('baris WHERE lebih rapat', () => {
  assert.match(page(), /\.where \{[^}]*margin: 2px 0/);
  assert.match(page(), /\.where input \{[^}]*padding: 2px 8px/);
});

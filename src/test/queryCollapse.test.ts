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

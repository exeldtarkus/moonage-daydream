import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const set = (n = 1) => ({ columns: ['id'], types: ['int'], rows: Array.from({ length: n }, (_, i) => [i]), total: n });
const one: QueryResult = { resultSets: [set(100)], rowsAffected: [], messages: [], durationMs: 5 };
const two: QueryResult = { resultSets: [set(3), set(3)], rowsAffected: [], messages: [], durationMs: 5 };
const src = { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never;

test('satu hasil tunggal: grid mengisi sisa tinggi panel (tidak ada ruang kosong di bawah)', () => {
  const html = render('csp', 't', { result: one, source: src });
  assert.match(html, /<div class="blk only">/);
  assert.match(html, /body \{[^}]*height: 100vh/);
  assert.match(html, /\.blk\.only \{[^}]*flex: 1/);
  assert.match(html, /\.blk\.only \.grid \{[^}]*max-height: none/);
});

test('hasil ganda tetap setinggi isinya', () => {
  assert.doesNotMatch(render('csp', 't', { result: two, source: src }), /class="blk only"/);
  const parts = render('csp', 't', { uri: 'file:///q.sql', start: 0, end: 1, parts: [
    { sql: 'a', o: { result: one, source: src } }, { sql: 'b', o: { result: one, source: src } },
  ] } as never);
  assert.doesNotMatch(parts, /class="blk only"/);
});

test('hasil tunggal + pesan tambahan tidak diregangkan', () => {
  const withMsg: QueryResult = { ...one, messages: ['Commands completed.'] };
  assert.doesNotMatch(render('csp', 't', { result: withMsg, source: src }), /class="blk only"/);
});

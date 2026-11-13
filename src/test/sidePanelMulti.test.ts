import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res = (n: number): QueryResult => ({
  resultSets: [{ columns: ['id'], types: ['int'], rows: Array.from({ length: n }, (_, i) => [i]), total: n }],
  rowsAffected: [], messages: [], durationMs: 5,
});
const page = () => render('csp', 't', {
  uri: 'file:///q.sql', start: 0, end: 1,
  parts: [{ sql: 'select 1', o: { result: res(2) } }, { sql: 'select 2', o: { result: res(3) } }],
});

test('panel samping: ada pemilih hasil untuk Columns / Inspector / Export', () => {
  const html = page();
  assert.ok(html.includes('<div id="sidesrc"></div>'), 'tempat pemilih hasil di panel');
  assert.match(html, /function sideSources\(\)/, 'daftar hasil dibangun di webview');
  assert.match(html, /class="srcsel"/, 'dropdown pemilih hasil');
  assert.ok(html.includes('Query '), 'label memakai nomor Query');
});

test('panel samping: ganti pilihan hasil mengganti tabel aktif dan menggambar ulang panel', () => {
  const html = page();
  assert.match(html, /srcsel'\)\) \{[\s\S]{0,300}active = [\s\S]{0,120}renderSide\(\)/);
});

test('panel samping: klik grid lain memperbarui panel yang sedang terbuka', () => {
  assert.match(page(), /if \(tb\) \{[\s\S]{0,200}active = tb;[\s\S]{0,200}renderSide\(\)/);
});

test('Export: Save / Copy memakai hasil yang dipilih di panel', () => {
  assert.match(page(), /xsave' \|\|[\s\S]{0,120}tableOf\(\)/);
});

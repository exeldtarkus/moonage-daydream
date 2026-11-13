import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const src = { uri: 'file:///q.sql', sql: 'select * from t', conn: 'c' } as never;
const page = () => render('csp', 't', { result: res, source: src });

test('Auto refresh: pilihan interval di toolbar hasil (Off sampai 5m)', () => {
  const html = page();
  assert.match(html, /<select class="autosel"[^>]*aria-label="Auto refresh"/);
  for (const v of ['0', '5000', '10000', '30000', '60000', '300000']) assert.match(html, new RegExp(`<option value="${v}"`));
  assert.match(html, /<option value="0" selected>Off<\/option>/, 'default mati, interval dipulihkan script dari state');
});

test('Auto refresh: hanya untuk hasil SQL yang bisa dijalankan ulang', () => {
  assert.doesNotMatch(render('csp', 't', { result: res }), /class="autosel"/, 'tanpa statement asal');
  assert.doesNotMatch(render('csp', 't', { result: res, source: src }, true), /class="autosel"/, 'tab pin');
  assert.doesNotMatch(render('csp', 't', { result: res, source: { ...(src as object), mongo: true } as never }), /class="autosel"/, 'mongo');
});

test('Auto refresh: timer di webview, melewati tick saat ada perubahan belum disimpan', () => {
  const js = page();
  assert.match(js, /type: 'rerun'/, 'tick meminta extension menjalankan ulang query');
  assert.match(js, /\.editbar \.pend:not\(\[hidden\]\)/, 'ada pending edit -> tick dilewati');
  assert.match(js, /saved\.auto/, 'interval bertahan saat hasil digambar ulang');
});

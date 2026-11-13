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
  assert.match(html, /\.rbar \{[^}]*border-bottom: 0/);
  assert.match(html, /\.grid \{[^}]*border-top: 0/);
});

test('toolbar hasil: pemisah sejajar dengan garis kolom nomor baris', () => {
  const html = page();
  assert.match(html, /\.rbar::before \{[^}]*width: var\(--ncol/, 'lebar pemisah mengikuti kolom nomor');
  assert.match(html, /\.rbar::before \{[^}]*border-right: 1px solid var\(--vscode-panel-border\)/);
  assert.match(html, /setProperty\('--ncol'/, 'lebar kolom nomor diukur saat grid digambar');
});

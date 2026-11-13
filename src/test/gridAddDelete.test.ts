import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });
const src = (f: string) => readFileSync(join(__dirname, '..', '..', f), 'utf8');

test('Add row: baris baru digulirkan ke layar dan sel pertama yang bisa diisi difokus', () => {
  const html = page();
  assert.match(html, /function addRow\(t\)[\s\S]{0,1200}tr\.scrollIntoView\(/, 'baris baru digulirkan ke layar');
  assert.match(html, /input\.cell:not\(\[disabled\]\)/, 'kolom generated / identity dilewati saat fokus');
});

test('Delete rows tanpa seleksi: beri tahu user, jangan diam saja', () => {
  const html = page();
  assert.match(html, /function markDelete\(t\)[\s\S]{0,400}if \(!sel\.length\)/, 'kasus tanpa seleksi ditangani');
  assert.ok(html.includes("type: 'info'"), 'pesan dikirim ke extension');
  assert.ok(html.includes('Select one or more rows first, then use Delete rows to mark them for deletion.'), 'wording');
});

test('pesan info dari panel hasil ditampilkan sebagai notifikasi VS Code', () => {
  assert.match(src('src/extension.ts'), /m\.type === 'info' \? vscode\.window\.showInformationMessage/);
});

test('Save: tombol di header memakai tabel bloknya, bukan footer (regresi: Save tidak bereaksi)', () => {
  const html = page();
  assert.match(html, /contains\('save'\)\) \{\s*const t = blkTable\(\)/, 'Save memakai blkTable()');
  assert.ok(!/contains\('save'\)\) \{[\s\S]{0,200}closest\('\.foot'\)/.test(html), 'tidak ada lagi pencarian lewat .foot');
});

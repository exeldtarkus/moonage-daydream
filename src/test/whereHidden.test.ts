import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const source = { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never;

test('baris WHERE tidak lagi digambar di panel hasil', () => {
  assert.ok(!render('csp', 't', { result: res, source }).includes('<form class="where"'), 'hasil tunggal');
  assert.ok(!render('csp', 't', { error: 'boom', source }).includes('<form class="where"'), 'hasil error');
  assert.ok(!render('csp', 't', { uri: 'file:///q.sql', start: 0, end: 1, parts: [{ sql: 's', o: { result: res } }] }).includes('<form class="where"'), 'run paralel');
});

test('kode WHERE dipertahankan, cukup satu flag untuk menghidupkan lagi', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'resultsHtml.ts'), 'utf8');
  assert.match(src, /const WHERE_BAR: boolean = false;/);
  assert.ok(src.includes('function whereBar('), 'fungsi whereBar tetap ada');
});

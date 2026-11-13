import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const sql = (where?: string) => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c', where } as never });

test('WHERE: ikon di toolbar hasil, form tersembunyi sampai diklik', () => {
  const html = sql();
  assert.match(html, /<span class="rtools">[\s\S]{0,2000}class="wherebtn"[^>]*aria-label="WHERE filter"/);
  assert.match(html, /<form class="where" hidden/, 'form ikut digambar tapi tersembunyi');
  assert.match(html, /wherebtn'\)\) \{[\s\S]{0,120}openWhere\(/, 'ikon membuka form');
  assert.match(html, /function openWhere\(blk, mode\) \{[\s\S]{0,500}\.focus\(\)/, 'fokus ke input WHERE');
});

test('WHERE: filter yang sedang aktif langsung terlihat (form terbuka + ikon menyala)', () => {
  const html = sql("id = 1");
  assert.match(html, /<form class="where" data-on="1"/, 'form terbuka saat filter aktif');
  assert.match(html, /class="wherebtn on"/, 'ikon menyala');
  assert.ok(html.includes('value="id = 1"'));
});

test('WHERE: hanya untuk hasil SQL yang bisa dijalankan ulang', () => {
  assert.ok(!render('csp', 't', { result: res }).includes('class="wherebtn'), 'tanpa source: tanpa ikon WHERE');
  assert.ok(!render('csp', 't', { result: res, source: { uri: 'u', sql: 'db.a.find({})', mongo: true } as never }).includes('class="wherebtn'), 'MongoDB: tanpa ikon WHERE');
});

test('WHERE: form tidak lagi digambar sebagai baris sendiri di atas grid', () => {
  assert.ok(!/<\/div>\s*<form class="where"/.test(sql()), 'bukan baris terpisah');
  assert.match(sql(), /<form class="where" hidden[\s\S]{0,400}<\/form><div class="sout"/, 'berada di dalam toolbar hasil');
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id'], types: ['int'], rows: [[1]], total: 1 }], rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 'select * from t', conn: 'c' } as never });

test('Auto refresh: tempat hitung mundur di sebelah pilihan interval', () => {
  const html = page();
  assert.match(html, /<span class="autoleft" aria-live="off"><\/span>/);
  assert.match(html, /\.rtools \.auto \.autoleft \{[^}]*font-variant-numeric: tabular-nums/, 'lebar angka tetap supaya tidak goyang');
});

test('Auto refresh: hitung mundur jalan tiap detik dan kosong saat Off', () => {
  const js = page();
  assert.match(js, /function autoLeft\(/);
  assert.match(js, /autoNext/, 'sisa waktu dihitung dari jadwal tick berikutnya');
});

test('Auto refresh: nomor refresh ke berapa, tersembunyi sampai refresh pertama', () => {
  const html = page();
  assert.match(html, /<span class="autorun" hidden><\/span>/);
  assert.match(html, /\.rtools \.auto \.autorun \{/);
  assert.match(html, /saved\.autoN/, 'nomornya bertahan saat hasil digambar ulang');
});

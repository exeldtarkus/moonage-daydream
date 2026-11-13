import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id', 'topic_message'], types: ['int', 'varchar'], rows: [[1, 'a']], total: 1 }],
  rowsAffected: [], messages: [], durationMs: 1,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 'select 1', conn: 'c' } as never });

test('export: tombol pindah ke rail kanan, di bawah Columns / Inspector', () => {
  const html = page();
  const rail = /<nav class="sidetabs">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
  assert.ok(rail.includes('data-pane="cols"'), 'Columns tab');
  assert.ok(rail.includes('data-pane="insp"'), 'Inspector tab');
  assert.ok(rail.includes('data-pane="exp"'), 'Export tab in the rail');
  assert.ok(rail.indexOf('data-pane="exp"') > rail.indexOf('data-pane="insp"'), 'Export sits below Inspector');
});

test('export: tidak ada lagi tombol Export di footer grid', () => {
  const foot = /<div class="foot">([\s\S]*?)<\/div><\/div>/.exec(page())?.[1] ?? '';
  assert.ok(!foot.includes('xbtn'), 'footer has no Export button');
});

test('export: form Export jadi panel samping (bukan popup), untuk tabel hasil yang aktif', () => {
  const html = page();
  assert.ok(html.includes("pane === 'exp'"), 'export pane rendered in the side panel');
  assert.ok(!html.includes("}, 'export');"), 'no export popup menu left');
  assert.match(html, /xsave' \|\|[\s\S]{0,120}tableOf\(\)/, 'Save / Copy act on the active result');
  assert.ok(html.includes("'Columns' : pane === 'insp' ? 'Inspector' : 'Export'"), 'side panel title per pane');
});

test('rail: tiga tab satu kolom berikat (ikon + garis pemisah + tab aktif ditandai)', () => {
  const html = page();
  assert.match(html, /\.sidetabs \{[^}]*border: 1px solid/);
  assert.match(html, /\.sidetabs button \+ button \{[^}]*border-top: 1px solid/);
  assert.match(html, /\.sidetabs button\.on \{[^}]*inset 2px 0/);
  assert.match(html, /\.sidetabs svg \{/);
  assert.match(/<nav class="sidetabs">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '', /<svg[\s\S]*Columns/);
});

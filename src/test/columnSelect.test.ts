import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import { memorySink } from '../exporter';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id', 'spaj_no'], types: ['int', 'varchar'], rows: [[1, '788']], total: 1 }],
  rowsAffected: [], messages: [], durationMs: 1,
};
const page = () => render('csp', 't', { result: res });

test('array format: one value per row as a JSON array (Copy column)', async () => {
  const a = await memorySink('array', ['spaj_no'], false);
  for (const r of [['78826007621'], [null], [12]]) await a.row(r);
  await a.end();
  assert.deepEqual(JSON.parse(a.text()), ['78826007621', null, 12]);
  const empty = await memorySink('array', ['spaj_no'], false);
  await empty.end();
  assert.deepEqual(JSON.parse(empty.text()), []);
});

test('column select: clicking a column header selects the whole column', () => {
  const html = page();
  assert.ok(html.includes('function selectCol('), 'column selection helper in the webview script');
  assert.ok(html.includes("e.target.closest('th .lbl')"), 'the header label is the click target');
  assert.ok(html.includes('paintCol('), 'the selected column is painted');
  assert.match(html, /\.selcol \{/, 'style for the selected column');
});

test('column select: Ctrl+C copies the selected column as an array', () => {
  const html = page();
  assert.ok(html.includes("'copy', 'array'"), 'the column is copied with the array format');
  assert.ok(html.includes('[s.col]'), 'only the selected column is sent');
});

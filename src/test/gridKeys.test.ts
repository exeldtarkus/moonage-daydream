import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id', 'name'], types: ['int', 'varchar'], rows: [[1, 'a'], [2, 'b']], total: 2 }],
  rowsAffected: [], messages: [], durationMs: 5,
};
const page = () => render('csp', 't', { result: res, source: { uri: 'file:///q.sql', sql: 's', conn: 'c' } as never });

test('grid: panah memindahkan sel aktif, Shift+panah memperluas seleksi baris', () => {
  const html = page();
  assert.match(html, /function moveCur\(t, dRow, dCol, shift\)/, 'navigasi keyboard');
  assert.match(html, /ArrowUp[\s\S]{0,200}ArrowDown[\s\S]{0,200}ArrowLeft[\s\S]{0,200}ArrowRight/, 'keempat panah');
  assert.match(html, /moveCur\(t, dr, dc, e\.shiftKey\)/, 'Shift diteruskan');
  assert.match(html, /function moveCur[\s\S]{0,900}shift && s\.anchor !== null/, 'Shift memperluas dari anchor');
});

test('grid: panah tidak mengganggu pengetikan di input (sel, WHERE, search, pager)', () => {
  assert.match(page(), /if \(\(dr \|\| dc\) && !e\.target\.closest\?\.\('input, select, textarea'\)\)/);
});

test('grid: sel aktif yang keluar layar digulirkan kembali', () => {
  assert.match(page(), /function moveCur[\s\S]{0,1600}scrollToPos\(/);
});

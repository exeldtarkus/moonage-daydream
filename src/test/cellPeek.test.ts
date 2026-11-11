import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { render } from '../resultsHtml';
import type { QueryResult } from '../db';

const res: QueryResult = {
  resultSets: [{ columns: ['id', 'topic_message'], types: ['int', 'varchar'], rows: [[1, '{"a":1}']], total: 1 }],
  rowsAffected: [], messages: [], durationMs: 1,
};
const page = () => render('csp', 't', { result: res });

test('cell peek: double-click a cell opens a popup with the full value, JSON pretty-printed', () => {
  const html = page();
  assert.ok(html.includes("open(td, '<pre class=\"peek\">'"), 'popup anchored to the cell');
  assert.ok(html.includes("JSON.stringify(JSON.parse(t), null, 2)"), 'JSON values are pretty-printed');
  assert.ok(html.includes('function peekText(v)'), 'peek helper in the webview script');
});

test('cell peek: short plain values are left alone (no popup)', () => {
  assert.ok(page().includes('PEEK_MIN'), 'threshold for long values');
});

test('cell peek: popup is scrollable, wraps and colors JSON tokens', () => {
  const html = page();
  assert.match(html, /\.menu\.peek \{[^}]*max-width/);
  assert.match(html, /\.peek \{[^}]*max-height: 45vh; overflow: auto; white-space: pre-wrap/);
  assert.match(html, /\.peek \.k \{/);
  assert.match(html, /\.peek \.s \{/);
  assert.match(html, /\.peek \.n \{/);
});

test('grid: a long value does not stretch its column (capped width + ellipsis)', () => {
  assert.match(page(), /\.cv \{[^}]*max-width: 420px;[^}]*text-overflow: ellipsis/);
  assert.ok(page().includes("v.length > PEEK_MIN ? '<span class=\"cv\">'"), 'long cell values are wrapped in .cv');
});

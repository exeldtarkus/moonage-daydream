import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { columnsHtml } from '../columnsHtml';

const t = { conn: 'c', db: 'd', table: 'dbo.t' };

test('columns page: edit mode shows a loading indicator in the grid until the columns arrive', () => {
  const html = columnsHtml('CSP', t, false);
  assert.match(html, /<div class="grid" id="grid"><div class="loading" role="status">[^]*Loading columns/);
});

test('columns page: New Table has no loading indicator (nothing to load)', () => {
  assert.ok(!/class="loading"/.test(columnsHtml('CSP', t, false, 'create')));
});

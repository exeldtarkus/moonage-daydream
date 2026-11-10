import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dbInfoHtml } from '../dbInfo';

const page = (n: string) => readFileSync(join(__dirname, '..', '..', 'media', 'webview', `${n}.html`), 'utf8');

test('Database Info: sections not loaded yet show a spinner, not an empty section', () => {
  const html = dbInfoHtml('CSP', { conn: 'c', db: 'd' }, {});
  assert.match(html, /<p class="muted loading"><span class="spin" aria-hidden="true"><\/span>Loading…<\/p>/);
  assert.ok(/@keyframes spin/.test(html), 'spinner css is in the page');
});

test('pages that wait for data have a spinner placeholder and its css (monitor, consul dashboard, add data, new database)', () => {
  for (const n of ['monitor', 'consulDash', 'addData', 'newDb']) {
    const h = page(n);
    assert.ok(/class="spin"/.test(h), `${n}: spinner placeholder`);
    assert.ok(/@keyframes spin/.test(h), `${n}: spinner css`);
  }
});

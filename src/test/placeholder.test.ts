import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { placeholderHtml } from '../resultsHtml';

test('panel hasil kosong: kartu di tengah dengan ikon, judul dan pintasan', () => {
  const html = placeholderHtml(undefined);
  assert.match(html, /<svg/, 'ada ikon');
  assert.match(html, /\.empty \{[^}]*justify-content: center/, 'konten di tengah vertikal');
  assert.match(html, /\.empty \{[^}]*align-items: center/, 'konten di tengah horizontal');
  assert.match(html, /text-align: center/);
  assert.ok(html.includes('No results yet'), 'judul');
  assert.ok(html.includes('<kbd>Ctrl</kbd>'), 'pintasan ditulis sebagai tombol');
  assert.ok(html.includes('Ctrl+Alt+O') || html.includes('<kbd>O</kbd>'), 'tip Find Object');
});

test('panel hasil kosong: varian ketika hasil tampil di panel lain', () => {
  const html = placeholderHtml('right');
  assert.ok(html.includes('right of the editor'), 'menyebut lokasi panel');
  assert.match(html, /\.empty \{[^}]*justify-content: center/);
});

test('panel hasil kosong: aman untuk CSP webview (tanpa script, tanpa resource luar)', () => {
  const html = placeholderHtml(undefined);
  assert.ok(!html.includes('<script'), 'tanpa script');
  assert.ok(!/https?:\/\//.test(html), 'tanpa resource dari luar');
});

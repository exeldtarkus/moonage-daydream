import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pageJson, webviewPage } from '../webviewPage';

const SRC = join(__dirname, '..', '..', 'src');

test('webviewPage: isi placeholder dari media/webview/<nama>.html', () => {
  const html = webviewPage('consulDash', { cspSource: 'CSP', nonce: 'N1', title: 'a&amp;b' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /style-src CSP /);
  assert.match(html, /<script nonce="N1">/);
  assert.ok(!/\{\{\w+\}\}/.test(html), 'tidak boleh ada placeholder tersisa');
});

test('webviewPage: placeholder tanpa nilai = error (bukan halaman setengah jadi)', () => {
  assert.throws(() => webviewPage('consulDash', { cspSource: 'CSP' }), /consulDash.*nonce/);
});

test('webviewPage: nilai berisi $& / {{x}} tidak diproses ulang', () => {
  const html = webviewPage('consulDash', { cspSource: '$&', nonce: '{{title}}', title: 't' });
  assert.match(html, /style-src \$& /);
  assert.match(html, /nonce="\{\{title\}\}"/);
});

test('tidak ada lagi halaman HTML utuh di source TypeScript', () => {
  // shortcut: exporter.ts (file export HTML) dan results.ts (placeholder 1 baris) dibiarkan inline
  const skip = new Set(['exporter.ts', 'results.ts']);
  const bad = readdirSync(SRC).filter((f) => f.endsWith('.ts') && !skip.has(f) && readFileSync(join(SRC, f), 'utf8').includes('<!DOCTYPE html>'));
  assert.deepEqual(bad, []);
});

test('media/webview: tidak ada {{placeholder}} di dalam <script> yang dijalankan (editor JS jadi error)', () => {
  const dir = join(__dirname, '..', '..', 'media', 'webview');
  const bad = readdirSync(dir).flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/<script nonce="\{\{nonce\}\}">([\s\S]*?)<\/script>/g)]
    .filter((m) => /\{\{\w+\}\}/.test(m[1])).map(() => f));
  assert.deepEqual(bad, []);
});

test('pageJson: aman ditaruh di <script type="application/json"> dan bisa di-parse balik', () => {
  const v = { svg: '<svg></svg></script><b>', n: 1, ok: true };
  const s = pageJson(v);
  assert.ok(!s.includes('<'), s);
  assert.deepEqual(JSON.parse(s), v);
});

test('webviewPage: <script nonce src="x.js"> diganti isi media/webview/x.js (inline, CSP nonce tetap)', () => {
  const html = webviewPage('columns', { cspSource: 'C', nonce: 'N', table: '', conn: '', db: '', newName: '', roNote: '', refreshBtn: '', addColBtn: '', loadingText: '', roHidden: '', pendingTitle: '', revertBtn: '', executeBtn: '', data: '{}' });
  assert.ok(!/<script[^>]* src=/.test(html), 'tidak boleh ada script src tersisa');
  assert.match(html, /<script nonce="N">\nconst vscode = acquireVsCodeApi\(\);/);
});

test('media/webview/*.js: tanpa {{placeholder}} (data lewat page-data)', () => {
  const dir = join(__dirname, '..', '..', 'media', 'webview');
  const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(js.length >= 7, js.join());
  assert.deepEqual(js.filter((f) => /\{\{\w+\}\}/.test(readFileSync(join(dir, f), 'utf8'))), []);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatEditSpans } from '../sqlFormat';

// terapkan span ke teks lama, hasilnya harus sama dengan teks baru
const apply = (old: string, spans: { from: number; to: number; text: string }[]) =>
  [...spans].sort((a, b) => b.from - a.from).reduce((t, s) => t.slice(0, s.from) + s.text + t.slice(s.to), old);

test('formatEditSpans: bagian awal / akhir yang sama tidak ikut diganti', () => {
  const old = 'SELECT a\nFROM t\nWHERE x=1\n';
  const neu = 'SELECT a\nFROM t\nWHERE x = 1\n';
  const spans = formatEditSpans(old, neu);
  assert.equal(apply(old, spans), neu);
  assert.ok(spans.every(s => s.to - s.from < old.length));
});

test('formatEditSpans: teks identik = tanpa edit', () => {
  assert.deepEqual(formatEditSpans('a\n', 'a\n'), []);
});

test('formatEditSpans: beda total tetap bukan satu edit seluruh dokumen (VS Code memindah kursor ke akhir)', () => {
  const old = 'select 1';
  const neu = 'SELECT\n  2;\n';
  const spans = formatEditSpans(old, neu);
  assert.equal(apply(old, spans), neu);
  assert.ok(spans.length >= 2 || spans[0].to - spans[0].from < old.length);
});

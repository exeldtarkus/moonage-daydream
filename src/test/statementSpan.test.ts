import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { statementSpanAt } from '../sqlContext';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = `SELECT 1;\n\nSELECT\n    TOP 10 created_date\n    , id\nFROM\n    dbo.tbl_workerkafka_process\nORDER BY\n    id DESC\n;\n\nSELECT 3;\n`;

test('statementSpanAt: double-click di tengah query memilih seluruh statement sampai ;', () => {
  const at = sql.indexOf('created_date');
  const span = statementSpanAt(sql, at);
  assert.ok(span);
  assert.equal(sql.slice(span.start, span.end), sql.slice(sql.indexOf('SELECT\n'), sql.indexOf('\n;') + 2));
});

test('statementSpanAt: statement pertama / terakhir', () => {
  const a = statementSpanAt(sql, 2);
  assert.equal(sql.slice(a!.start, a!.end), 'SELECT 1;');
  const b = statementSpanAt(sql, sql.indexOf('SELECT 3') + 2);
  assert.equal(sql.slice(b!.start, b!.end), 'SELECT 3;');
});

test('statementSpanAt: statement tanpa ; dan spasi di belakang tidak ikut terpilih', () => {
  const s = 'SELECT 1\n\n';
  assert.equal(statementSpanAt(s, 3)?.end, 8);
});

test('statementSpanAt: posisi di area kosong tanpa statement', () => {
  assert.equal(statementSpanAt('\n\n   \n', 2), undefined);
});

test('setting: perluasan seleksi double-click bisa dimatikan', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  const k = 'moonageDaydream.editor.doubleClickSelectsStatement';
  assert.ok(props[k], 'setting declared');
  assert.equal(props[k].default, true);
});

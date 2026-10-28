import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { crc32, ExportFormat, memorySink, openSink, plain, uniqueNames } from '../exporter';

const dir = join(__dirname, 'tmp-export');
const cols = ['id', 'name', 'name', 'when', 'ok', 'bin'];
const rows: unknown[][] = [
  [1, 'a|b, "c"\nd', null, new Date(Date.UTC(2025, 0, 2)), true, new Uint8Array([1, 255])],
  [2.5, '<x>&', 'y', null, false, null],
];

async function write(format: ExportFormat): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `out.${format}`);
  const sink = await openSink(format, file, cols);
  for (const r of rows) await sink.row(r);
  await sink.end();
  return file;
}

test('plain / uniqueNames / crc32', () => {
  assert.equal(plain(new Date(Date.UTC(2025, 0, 2))), '2025-01-02T00:00:00.000Z');
  assert.equal(plain(new Uint8Array([1, 255])), '0x01FF');
  assert.equal(plain(undefined), null);
  assert.deepEqual(uniqueNames(['a', 'a', 'b', 'a']), ['a', 'a_2', 'b', 'a_3']);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('export formats', async () => {
  try {
    const json = JSON.parse(readFileSync(await write('json'), 'utf8'));
    assert.deepEqual(json[0], { id: 1, name: 'a|b, "c"\nd', name_2: null, when: '2025-01-02T00:00:00.000Z', ok: true, bin: '0x01FF' });
    assert.equal(json.length, 2);
    const pretty = readFileSync(await write('jsonPretty'), 'utf8');
    assert.deepEqual(JSON.parse(pretty), json);
    assert.ok(pretty.startsWith('[\n  {\n    "id": 1,'), 'pretty indented');
    const csv = readFileSync(await write('csv'), 'utf8');
    assert.equal(csv, '﻿id,name,name,when,ok,bin\r\n1,"a|b, ""c""\nd",,2025-01-02T00:00:00.000Z,true,0x01FF\r\n2.5,<x>&,y,,false,\r\n');
    const md = readFileSync(await write('markdown'), 'utf8');
    assert.equal(md.split('\n')[2], '| 1 | a\\|b, "c"<br>d | NULL | 2025-01-02T00:00:00.000Z | true | 0x01FF |');
    const html = readFileSync(await write('html'), 'utf8');
    assert.ok(html.includes('<td>&lt;x&gt;&amp;</td>') && html.includes('<td class="null">NULL</td>'));
    const xlsx = readFileSync(await write('xlsx'));
    assert.equal(xlsx.readUInt32LE(0), 0x04034b50, 'zip signature');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memorySink: TSV without header (Ctrl+C), CSV without BOM, JSON', async () => {
  const tsv = await memorySink('tsv', cols, false);
  for (const r of rows) await tsv.row(r);
  await tsv.end();
  assert.equal(tsv.text(), '1\ta|b, "c" d\t\t2025-01-02T00:00:00.000Z\ttrue\t0x01FF\r\n2.5\t<x>&\ty\t\tfalse\t\r\n');
  const csv = await memorySink('csv', ['a'], true);
  await csv.row(['x']);
  await csv.end();
  assert.equal(csv.text(), 'a\r\nx\r\n', 'no BOM in clipboard text');
  const json = await memorySink('json', ['a']);
  await json.row([1]);
  await json.end();
  assert.deepEqual(JSON.parse(json.text()), [{ a: 1 }]);
});

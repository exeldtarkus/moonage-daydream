import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drivers, type Sink } from '../db';
import { sqlDriver, type Link } from '../sqlDriver';
import { cursorQuery } from '../postgres';

const collect = () => {
  const got: { cols: string[]; rows: unknown[][] } = { cols: [], rows: [] };
  const sink: Sink = { columns: (c) => { got.cols = c; }, row: (r) => { got.rows.push(r); } };
  return { got, sink };
};

test('sqlDriver stream: uses the link stream when the driver has one (rows are not loaded first)', async () => {
  const calls: string[] = [];
  const link: Link = {
    exec: async () => { calls.push('exec'); return { sets: [], affected: [] }; },
    stream: async (_sql, _signal, sink) => { calls.push('stream'); await sink.columns(['a']); await sink.row([1]); return 1; },
    release: async () => undefined,
  };
  const d = sqlDriver({ ...drivers.sqlite, link: async () => link, dedicated: async () => link });
  const { got, sink } = collect();
  assert.equal(await d.stream({ name: 'x', type: 'sqlite', host: '', port: 0, user: '', database: '', trustServerCertificate: false }, '', 'SELECT 1', undefined, sink), 1);
  assert.deepEqual(calls, ['stream']);
  assert.deepEqual(got, { cols: ['a'], rows: [[1]] });
});

test('SQLite stream: first result set row by row, statements before it still run, empty result keeps columns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moonage-stream-'));
  try {
    const file = join(dir, 'lab.db');
    writeFileSync(file, '');
    const c = { name: 'lite', type: 'sqlite' as const, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file };
    const d = drivers.sqlite;
    await d.run(c, '', 'CREATE TABLE t (a INTEGER, b TEXT); INSERT INTO t VALUES (1, \'x\'), (2, \'y\'), (3, NULL);');
    const one = collect();
    assert.equal(await d.stream(c, '', 'SELECT a, b FROM t ORDER BY a', undefined, one.sink), 3);
    assert.deepEqual(one.got, { cols: ['a', 'b'], rows: [[1, 'x'], [2, 'y'], [3, null]] });
    const empty = collect();
    assert.equal(await d.stream(c, '', 'SELECT a FROM t WHERE a > 9', undefined, empty.sink), 0);
    assert.deepEqual(empty.got.cols, ['a']);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(d.stream(c, '', 'SELECT a FROM t', ac.signal, collect().sink));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL cursorQuery: only one SELECT / WITH / VALUES / TABLE becomes a cursor', () => {
  assert.equal(cursorQuery('SELECT * FROM t;'), 'SELECT * FROM t');
  assert.equal(cursorQuery('  with x as (select 1) select * from x'), 'with x as (select 1) select * from x');
  assert.equal(cursorQuery("select ';' as a"), "select ';' as a");
  assert.equal(cursorQuery('SELECT 1; SELECT 2'), undefined);
  assert.equal(cursorQuery('UPDATE t SET a = 1'), undefined);
});

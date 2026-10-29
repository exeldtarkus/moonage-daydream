import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MONITOR_SETS, monitorQueries, monitorSample, monitorSql } from '../monitor';
import { monitorHtml } from '../monitorHtml';
import type { ResultSet } from '../db';

const MB = 1024 * 1024;
const rs = (columns: string[], rows: unknown[][]): ResultSet => ({ columns, rows, total: rows.length });
/** satu sampel mentah dengan urutan result set MONITOR_SQL */
const raw = (o: { batch: number; tran: number; read: number; write: number; lck: number; io: number; reads: number; stallRead: number; cpu?: [number, number] }) => {
  const sets: ResultSet[] = [];
  sets[MONITOR_SETS.counters] = rs(['counter', 'instance', 'cntr_value'], [
    ['Batch Requests/sec', '', o.batch], ['User Connections', '', 5], ['Transactions/sec', '_Total', o.tran], ['Page life expectancy', '', 300],
    ['CPU usage %', 'default', o.cpu?.[0] ?? 25], ['CPU usage % base', 'default', o.cpu?.[1] ?? 100],
  ]);
  sets[MONITOR_SETS.waiting] = rs(['waiting'], [[3]]);
  sets[MONITOR_SETS.io] = rs(['bytes_read', 'bytes_written'], [[o.read, o.write]]);
  sets[MONITOR_SETS.waits] = rs(['wait_type', 'wait_time_ms', 'waiting_tasks_count'], [['LCK_M_X', o.lck, 2], ['PAGEIOLATCH_SH', o.io, 10]]);
  sets[MONITOR_SETS.sessions] = rs(['session_id', 'blocked_by'], [[55, 0], [56, 55]]);
  sets[MONITOR_SETS.expensive] = rs(['query', 'cpu_ms'], [['SELECT 1', 10]]);
  sets[MONITOR_SETS.running] = rs(['session_id', 'statement'], [[61, 'UPDATE t SET a = 1']]);
  sets[MONITOR_SETS.files] = rs(['database', 'file', 'type', 'num_of_reads', 'num_of_writes', 'num_of_bytes_read', 'num_of_bytes_written', 'io_stall_read_ms', 'io_stall_write_ms'],
    [['shop', 'shop_data', 'ROWS', o.reads, 10, o.reads * 8192, 10 * 8192, o.stallRead, 20]]);
  return sets;
};

test('monitor: first sample has gauges, rates need a previous sample', () => {
  const s = monitorSample(raw({ batch: 900, tran: 400, read: 8 * MB, write: 3 * MB, lck: 400, io: 500, reads: 100, stallRead: 200 }), 1000);
  assert.deepEqual(s.point, { t: 1000, cpu: 25, batchPerSec: null, tranPerSec: null, waiting: 3, readMBs: null, writeMBs: null, connections: 5, ple: 300 });
  assert.deepEqual(s.waits.rows, [], 'wait deltas need two samples');
  assert.equal(s.sessions.rows.length, 2);
});

test('monitor: rates per second, wait and file deltas between two samples', () => {
  const prev = { sets: raw({ batch: 900, tran: 400, read: 8 * MB, write: 3 * MB, lck: 400, io: 500, reads: 100, stallRead: 200 }), t: 1000 };
  const s = monitorSample(raw({ batch: 1000, tran: 500, read: 10 * MB, write: 4 * MB, lck: 1000, io: 500, reads: 150, stallRead: 700 }), 3000, prev);
  assert.deepEqual(s.point, { t: 3000, cpu: 25, batchPerSec: 49.5, tranPerSec: 50, waiting: 3, readMBs: 1, writeMBs: 0.5, connections: 5, ple: 300 });
  assert.deepEqual(s.waits.columns, ['wait_type', 'wait_ms_per_sec', 'tasks']);
  assert.deepEqual(s.waits.rows, [['LCK_M_X', 300, 0]], 'only waits that grew, per second');
  assert.deepEqual(s.files.rows, [['shop', 'shop_data', 'ROWS', 25, 0, 0.2, 0, 10, 0]], 'reads/s, writes/s, read MB/s, write MB/s, read / write latency ms');
});

test('monitor: CPU base 0 gives no value, counters reset (restart) give no negative rate', () => {
  const prev = { sets: raw({ batch: 1000, tran: 500, read: 10 * MB, write: 4 * MB, lck: 1000, io: 500, reads: 150, stallRead: 700 }), t: 1000 };
  const s = monitorSample(raw({ batch: 10, tran: 5, read: MB, write: MB, lck: 0, io: 0, reads: 1, stallRead: 0, cpu: [0, 0] }), 2000, prev);
  assert.equal(s.point.cpu, null);
  assert.equal(s.point.batchPerSec, null);
  assert.equal(s.point.readMBs, null);
});

test('monitor: one batch with every result set; panel offers refresh and window choices', () => {
  for (const v of ['dm_os_performance_counters', 'dm_os_waiting_tasks', 'dm_io_virtual_file_stats', 'dm_os_wait_stats', 'dm_exec_sessions', 'dm_exec_query_stats', 'master_files', 'dm_exec_requests']) {
    assert.ok(monitorSql().includes(v), v);
  }
  assert.equal(Object.keys(MONITOR_SETS).length, 8);
  const html = monitorHtml('csp', 'shop-db');
  for (const s of ['1', '2', '5', '10', '30', '60']) assert.ok(html.includes(`<option value="${s}000"`), `refresh ${s}s`);
  for (const m of ['1', '5', '15']) assert.ok(html.includes(`<option value="${m}"`), `window ${m}m`);
  for (const id of ['cpu', 'batch', 'waiting', 'io', 'conn', 'tran']) assert.ok(html.includes(`data-chart="${id}"`), `chart ${id}`);
  for (const tab of ['running', 'sessions', 'waits', 'expensive', 'files']) assert.ok(html.includes(`data-tab="${tab}"`), `tab ${tab}`);
  assert.ok(html.includes('id="pause"') && html.includes('shop-db'));
});

test('monitor: the monitor never measures itself (own session, own batch text, own waits)', () => {
  const q = monitorQueries();
  assert.match(monitorSql(), /^\/\* moonage-monitor \*\//, 'marker on the sample batch');
  for (const k of ['waiting', 'sessions', 'running'] as const) assert.match(q[k], /session_id <> @@SPID/, k);
  assert.match(q.expensive, /NOT LIKE '%moonage-monitor%'/, 'own sample batch not in Expensive queries');
  assert.match(q.running, /statement_start_offset/, 'running statement, not only the whole batch');
});

test('monitor: per database (right-click a database): its sessions, queries, files, transactions and connections', () => {
  const q = monitorQueries("O'Shop");
  for (const k of ['waiting', 'io', 'sessions', 'running', 'expensive', 'files'] as const) assert.match(q[k], /DB_ID\(N'O''Shop'\)/, k);
  assert.match(q.counters, /instance_name = N'O''Shop'/, 'Transactions/sec of the database');
  assert.match(q.counters, /'User Connections'.*database_id = DB_ID\(N'O''Shop'\)/s, 'connections to the database');
  assert.ok(!/DB_ID\(N/.test(monitorSql()), 'server: every database');
  assert.ok(monitorHtml('csp', 'shop / orders').includes('shop / orders'));
});

test('monitor: running queries table from the sample', () => {
  const s = monitorSample(raw({ batch: 900, tran: 400, read: 8 * MB, write: 3 * MB, lck: 400, io: 500, reads: 100, stallRead: 200 }), 1000);
  assert.deepEqual(s.running.rows, [[61, 'UPDATE t SET a = 1']]);
});

test('monitor: per database, server-wide charts / waits are labelled (server)', () => {
  const db = monitorHtml('csp', 'shop / orders', true);
  for (const label of ['CPU % (server)', 'Batch requests/sec (server)', 'Top waits (server)']) assert.ok(db.includes(label), label);
  assert.ok(!db.includes('Transactions/sec (server)') && !db.includes('Waiting tasks (server)'), 'database values not labelled');
  assert.ok(!monitorHtml('csp', 'shop').includes('(server)'), 'server mode: everything is server, no label');
});

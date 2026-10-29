import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { monitorKit } from '../monitorKits';
import { monitorHtml } from '../monitorHtml';
import type { ResultSet } from '../db';

const MB = 1024 * 1024;
const rs = (columns: string[], rows: unknown[][]): ResultSet => ({ columns, rows, total: rows.length });

test('monitor kits: one per supported database, MongoDB / SQLite have none', () => {
  for (const t of ['mssql', 'mysql', 'mariadb', 'postgres'] as const) assert.ok(monitorKit(t), t);
  assert.equal(monitorKit('sqlite'), undefined);
  assert.equal(monitorKit('mongodb'), undefined);
});

test('MySQL kit: queries, per database filter, own statements not counted, kill', () => {
  const k = monitorKit('mysql')!;
  const server = k.parts();
  const db = k.parts("O'Shop");
  assert.match(server.find((p: { id: string }) => p.id === 'status')!.sql, /SHOW GLOBAL STATUS/);
  assert.match(server.find((p: { id: string }) => p.id === 'processlist')!.sql, /ID <> CONNECTION_ID\(\)/, 'own connection hidden');
  assert.match(db.find((p: { id: string }) => p.id === 'processlist')!.sql, /DB = 'O''Shop'/);
  assert.ok(server.find((p: { id: string }) => p.id === 'expensive')!.optional, 'performance_schema may be off');
  assert.equal(k.kill('42'), 'KILL 42;');
  assert.throws(() => k.kill('1; DROP TABLE t'), /session id/);

  const status = (q: number, commit: number, rx: number, rd: number) => rs(['Variable_name', 'Value'], [
    ['Questions', q], ['Com_commit', commit], ['Com_rollback', 0], ['Threads_connected', 7], ['Threads_running', 3],
    ['Bytes_received', rx], ['Bytes_sent', 0], ['Innodb_data_read', rd], ['Innodb_data_written', 0], ['Innodb_row_lock_current_waits', 1]]);
  const plist = rs(['session_id', 'user', 'host', 'database', 'command', 'seconds', 'state', 'statement'],
    [[10, 'app', 'h:1', 'shop', 'Query', 5, 'executing', 'SELECT SLEEP(5)'], [11, 'app', 'h:2', 'shop', 'Sleep', 100, '', null]]);
  const res = (q: number, commit: number, rx: number, rd: number) => ({ status: [status(q, commit, rx, rd)], processlist: [plist], expensive: new Error('performance_schema is off') });
  const prev = { res: res(100, 10, MB, 2 * MB), t: 1000 };
  const s = k.sample(res(203, 20, 3 * MB, 6 * MB), 3000, prev);
  assert.deepEqual(s.point.values, { queries: [50], tran: [5], conn: [7], running: [2], net: [1, 0], io: [2, 0], locks: [1] },
    'Questions minus own 3 statements, Threads_running minus own, MB/s');
  assert.deepEqual(s.tables.running, { columns: plist.columns, rows: [plist.rows[0]] }, 'running = not Sleep');
  assert.equal((s.tables.sessions as { rows: unknown[] }).rows.length, 2);
  assert.match((s.tables.expensive as { message: string }).message, /performance_schema/);
  const first = k.sample(res(100, 10, MB, 2 * MB), 1000);
  assert.deepEqual(first.point.values.queries, [null], 'rates need two samples');
  const perDb = k.sample(res(203, 20, 3 * MB, 6 * MB), 3000, prev, 'shop');
  assert.deepEqual([perDb.point.values.conn, perDb.point.values.running], [[2], [1]], 'per database: its connections / running from the processlist');
});

test('PostgreSQL kit: queries, per database filter, rates, cache hit, active / waiting, kill', () => {
  const k = monitorKit('postgres')!;
  assert.match(k.parts().find((p: { id: string }) => p.id === 'activity')!.sql, /pid <> pg_backend_pid\(\)/);
  assert.match(k.parts("O'Shop").find((p: { id: string }) => p.id === 'activity')!.sql, /datname = 'O''Shop'/);
  assert.match(k.parts("O'Shop").find((p: { id: string }) => p.id === 'stats')!.sql, /datname = 'O''Shop'/);
  assert.ok(k.parts().find((p: { id: string }) => p.id === 'expensive')!.optional, 'pg_stat_statements may be missing');
  assert.equal(k.kill('42'), 'SELECT pg_terminate_backend(42);');

  const stats = (x: number, rr: number, rw: number, br: number, bh: number) => rs(['xacts', 'rows_read', 'rows_written', 'blks_read', 'blks_hit'], [[x, rr, rw, br, bh]]);
  const act = rs(['session_id', 'user', 'host', 'program', 'database', 'state', 'wait_event_type', 'wait_event', 'blocked_by', 'elapsed_ms', 'statement'], [
    [20, 'app', '10.0.0.1', 'psql', 'shop', 'active', 'Lock', 'transactionid', '21', 3000, 'UPDATE t SET a = 1'],
    [21, 'app', '10.0.0.1', 'psql', 'shop', 'idle in transaction', 'Client', 'ClientRead', '', 9000, 'UPDATE t SET a = 2'],
    [22, 'app', '10.0.0.2', 'app', 'shop', 'active', null, null, '', 10, 'SELECT 1'],
  ]);
  const res = (x: number, rr: number, rw: number, br: number, bh: number) => ({ stats: [stats(x, rr, rw, br, bh)], activity: [act], expensive: [rs(['query'], [['SELECT * FROM t']])] });
  const s = k.sample(res(203, 5000, 300, 50, 910), 3000, { res: res(100, 1000, 100, 10, 550), t: 1000 });
  assert.deepEqual(s.point.values, { tran: [50], rows: [2000, 100], disk: [20], cache: [90], conn: [3], active: [2, 1] },
    'xacts minus own 3, rows read / written per second, blocks read/s, cache hit % = hit / (hit + read) since previous, active / waiting');
  assert.deepEqual((s.tables.running as { rows: unknown[][] }).rows.map((r) => r[0]), [20, 22], 'running = active');
  assert.equal((s.tables.expensive as { rows: unknown[] }).rows.length, 1);
});

test('panel from a kit: its charts and tabs, server-wide ones labelled per database', () => {
  const k = monitorKit('postgres')!;
  const html = monitorHtml('csp', 'pg / shop', true, k);
  for (const c of k.charts) assert.ok(html.includes(`data-chart="${c.id}"`), c.id);
  for (const [id] of k.tabs) assert.ok(html.includes(`data-tab="${id}"`), id);
  const my = monitorHtml('csp', 'my / shop', true, monitorKit('mysql')!);
  assert.ok(my.includes('Queries/sec (server)') && !my.includes('Threads connected (server)'));
  assert.ok(monitorHtml('csp', 'ms').includes('data-chart="cpu"'), 'SQL Server stays the default');
});

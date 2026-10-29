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
  assert.deepEqual(s.point.values, { queries: [49.5], tran: [5], conn: [7], running: [2], net: [1, 0], io: [2, 0], locks: [1] },
    'Questions minus own 4 statements, Threads_running minus own, MB/s');
  assert.deepEqual((s.tables.running as { rows: unknown[][] }).rows.map((r) => r[0]), [10], 'running = not Sleep');
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

test('MySQL / MariaDB kits: Blocking tab with each database own lock tables, optional, per database', () => {
  const my = monitorKit('mysql')!, maria = monitorKit('mariadb')!;
  const part = (k: typeof my, db?: string) => k.parts(db).find((p: { id: string }) => p.id === 'blocking')!;
  assert.match(part(my).sql, /performance_schema\.data_lock_waits/);
  assert.match(part(my).sql, /performance_schema\.threads/, 'thread -> processlist id');
  assert.match(part(maria).sql, /information_schema\.INNODB_LOCK_WAITS/);
  assert.match(part(maria).sql, /trx_mysql_thread_id/);
  assert.ok(part(my).optional && part(maria).optional, 'performance_schema off / no privilege: message in the tab');
  assert.match(part(my, "O'Shop").sql, /OBJECT_SCHEMA = 'O''Shop'/);
  assert.match(part(maria, "O'Shop").sql, /lock_table LIKE CONCAT\('`', 'O''Shop', '`\.%'\)/);
  for (const k of [my, maria]) assert.deepEqual(k.tabs.map((t: [string, string, boolean?]) => t[0]), ['running', 'sessions', 'blocking', 'expensive']);
});

test('MySQL kit: blocking rows mark waiting / blocking sessions (blocked_by) like SQL Server', () => {
  const k = monitorKit('mysql')!;
  const plist = rs(['session_id', 'user', 'host', 'database', 'command', 'seconds', 'state', 'statement'], [
    [10, 'app', 'h:1', 'shop', 'Query', 5, 'updating', 'UPDATE t SET a = 2 WHERE id = 1'],
    [11, 'app', 'h:2', 'shop', 'Sleep', 30, '', null],
  ]);
  const blocking = rs(['waiting_id', 'blocking_id', 'table', 'waiting_lock', 'blocking_lock', 'wait_seconds', 'waiting_statement', 'blocking_statement'],
    [[10, 11, 'shop.t', 'X,REC_NOT_GAP', 'X,REC_NOT_GAP', 5, 'UPDATE t SET a = 2 WHERE id = 1', null]]);
  const status = rs(['Variable_name', 'Value'], [['Questions', 1], ['Threads_connected', 2], ['Threads_running', 2]]);
  const s = k.sample({ status: [status], processlist: [plist], blocking: [blocking], expensive: [rs(['query'], [])] }, 1000);
  assert.deepEqual(s.tables.blocking, { columns: blocking.columns, rows: blocking.rows });
  const sessions = s.tables.sessions as { columns: string[]; rows: unknown[][] };
  const bi = sessions.columns.indexOf('blocked_by');
  assert.ok(bi > 0, 'blocked_by column added');
  assert.deepEqual(sessions.rows.map((r) => [r[0], r[bi]]), [[10, 11], [11, null]]);
  const running = s.tables.running as { columns: string[]; rows: unknown[][] };
  assert.deepEqual(running.rows.map((r) => [r[0], r[running.columns.indexOf('blocked_by')]]), [[10, 11]]);
  const off = k.sample({ status: [status], processlist: [plist], blocking: new Error('SELECT command denied'), expensive: [rs(['query'], [])] }, 1000);
  assert.match((off.tables.blocking as { message: string }).message, /SELECT command denied/);
});

test('panel: Kill in the Blocking tab targets the blocking session', () => {
  const html = monitorHtml('csp', 'my', false, monitorKit('mysql')!);
  assert.ok(html.includes('data-tab="blocking"'));
  assert.match(html, /blocking: 'blocking_id'/, 'kill column of the blocking tab');
});

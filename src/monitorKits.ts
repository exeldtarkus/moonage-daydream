import type { DbType, ResultSet } from './db';
import { monitorQueries, monitorSample, monitorSql } from './monitor';
import type { MonitorTable } from './monitor';

/** grafik panel Live Monitor; serverWide = tetap level server walau monitoring satu database; max = batas tetap (persen) */
export interface MonitorChart { id: string; label: string; tip: string; serverWide?: boolean; max?: number }
/** isi tab: tabel, atau pesan (mis. performance_schema / pg_stat_statements tidak aktif) */
export type MonitorTab = MonitorTable | { message: string };
type Res = Record<string, ResultSet[] | Error>;
export interface KitSample { point: { t: number; values: Record<string, (number | null)[]> }; tables: Record<string, MonitorTab> }

/** monitoring satu jenis database: query per bagian (bagian optional boleh gagal), sampel -> grafik + tabel, kill */
export interface MonitorKit {
  charts: MonitorChart[];
  tabs: [id: string, label: string, serverWide?: boolean][];
  parts(db?: string): { id: string; sql: string; optional?: string }[];
  sample(res: Res, t: number, prev?: { res: Res; t: number }, db?: string): KitSample;
  kill(id: string): string;
  /** query tab untuk Open as query */
  query(tab: string, db?: string): string | undefined;
}

const MB = 1024 * 1024;
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => Number(v ?? 0);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rate = (cur: number, prev: number | undefined, dt: number, div = 1, own = 0) =>
  (prev === undefined || cur < prev || dt <= 0 ? null : r1(Math.max(0, cur - prev - own) / div / dt));
const sets = (r: ResultSet[] | Error | undefined) => (Array.isArray(r) ? r : undefined);
const table = (r: ResultSet[] | Error | undefined, message: string): MonitorTab =>
  (r instanceof Error ? { message: `${message}: ${r.message}` } : { columns: r?.[0]?.columns ?? [], rows: r?.[0]?.rows ?? [] });
/** session id angka (input dari tabel / user) */
const sessionId = (id: string) => {
  if (!/^\d+$/.test(id.trim()) || +id < 1) throw new Error('Enter a session id (number)');
  return +id;
};
/** baris kolom sebagai indeks nama -> nilai */
const col = (t: MonitorTab, name: string) => ('columns' in t ? t.columns.indexOf(name) : -1);

const MARK = '/* moonage-monitor */';

const mssqlKit: MonitorKit = {
  charts: [
    { id: 'cpu', label: 'CPU %', tip: 'SQL Server CPU usage (Resource Pool Stats)', serverWide: true, max: 100 },
    { id: 'batch', label: 'Batch requests/sec', tip: 'SQL Statistics: Batch Requests/sec', serverWide: true },
    { id: 'waiting', label: 'Waiting tasks', tip: 'User tasks waiting for a resource (sys.dm_os_waiting_tasks)' },
    { id: 'io', label: 'Database I/O MB/s', tip: 'Read and write MB/s, all database files' },
    { id: 'conn', label: 'User connections', tip: 'General Statistics: User Connections' },
    { id: 'tran', label: 'Transactions/sec', tip: 'Databases: Transactions/sec (_Total)' },
  ],
  tabs: [['running', 'Running queries'], ['sessions', 'Sessions / Blocking'], ['waits', 'Top waits', true], ['expensive', 'Expensive queries'], ['files', 'File I/O']],
  parts: (db) => [{ id: 'all', sql: monitorSql(db) }],
  sample(res, t, prev) {
    const cur = sets(res.all);
    if (!cur) throw res.all as Error;
    const p = prev && sets(prev.res.all);
    const s = monitorSample(cur, t, p && { sets: p, t: prev!.t });
    const v = s.point;
    return {
      point: { t, values: { cpu: [v.cpu], batch: [v.batchPerSec], waiting: [v.waiting], io: [v.readMBs, v.writeMBs], conn: [v.connections], tran: [v.tranPerSec] } },
      tables: { running: s.running, sessions: s.sessions, waits: s.waits, expensive: s.expensive, files: s.files },
    };
  },
  kill: (id) => `KILL ${sessionId(id)};`,
  query: (tab, db) => (monitorQueries(db) as Record<string, string>)[tab],
};

const MY_STATUS = ['Questions', 'Com_commit', 'Com_rollback', 'Threads_connected', 'Threads_running', 'Bytes_received', 'Bytes_sent',
  'Innodb_data_read', 'Innodb_data_written', 'Innodb_row_lock_current_waits'];
/** MySQL / MariaDB: SHOW GLOBAL STATUS, processlist, digest performance_schema (opsional) */
const mysqlKit: MonitorKit = {
  charts: [
    { id: 'queries', label: 'Queries/sec', tip: 'Questions: statements sent by clients', serverWide: true },
    { id: 'tran', label: 'Transactions/sec', tip: 'Com_commit + Com_rollback', serverWide: true },
    { id: 'conn', label: 'Threads connected', tip: 'Threads_connected (per database: its connections in the processlist)' },
    { id: 'running', label: 'Threads running', tip: 'Threads_running (per database: its non-sleeping connections)' },
    { id: 'net', label: 'Network MB/s', tip: 'Bytes received / sent', serverWide: true },
    { id: 'io', label: 'InnoDB I/O MB/s', tip: 'Innodb_data_read / Innodb_data_written', serverWide: true },
    { id: 'locks', label: 'Row lock waits', tip: 'Innodb_row_lock_current_waits', serverWide: true },
  ],
  tabs: [['running', 'Running queries'], ['sessions', 'Sessions'], ['expensive', 'Expensive queries']],
  parts: (db) => [
    { id: 'status', sql: `${MARK} SHOW GLOBAL STATUS WHERE Variable_name IN (${MY_STATUS.map(lit).join(', ')})` },
    { id: 'processlist', sql: `${MARK} SELECT ID AS session_id, USER AS user, HOST AS host, DB AS \`database\`, COMMAND AS command, TIME AS seconds,
  STATE AS state, LEFT(INFO, 4000) AS statement FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID()${db === undefined ? '' : ` AND DB = ${lit(db)}`}
  ORDER BY TIME DESC` },
    // digest tanpa komentar: statement monitor sendiri dikenali dari teksnya
    { id: 'expensive', optional: 'Expensive queries need performance_schema', sql: `${MARK} SELECT LEFT(DIGEST_TEXT, 400) AS query, SCHEMA_NAME AS \`database\`,
  COUNT_STAR AS executions, ROUND(SUM_TIMER_WAIT / 1000000000) AS total_ms, ROUND(AVG_TIMER_WAIT / 1000000000, 1) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined,
  LAST_SEEN AS last_run FROM performance_schema.events_statements_summary_by_digest
  WHERE DIGEST_TEXT NOT LIKE 'SHOW GLOBAL STATUS%' AND DIGEST_TEXT NOT LIKE '%PROCESSLIST%' AND DIGEST_TEXT NOT LIKE '%events_statements_summary_by_digest%'${db === undefined ? '' : ` AND SCHEMA_NAME = ${lit(db)}`}
  ORDER BY SUM_TIMER_WAIT DESC LIMIT 20` },
  ],
  sample(res, t, prev, db) {
    const status = (r: Res | undefined) => new Map((sets(r?.status)?.[0]?.rows ?? []).map((x) => [String(x[0]), num(x[1])]));
    const c = status(res);
    if (!sets(res.status)) throw res.status as Error;
    const p = prev ? status(prev.res) : undefined;
    const dt = prev ? (t - prev.t) / 1000 : 0;
    const own = this.parts(db).length; // statement monitor sendiri di antara dua sampel
    const g = (m: Map<string, number> | undefined, k: string) => m?.get(k);
    const r = (k: string, div = 1, o = 0) => rate(c.get(k) ?? 0, g(p, k), dt, div, o);
    const sessions = table(res.processlist, 'Processlist not available');
    const ci = col(sessions, 'command');
    const running: MonitorTab = 'rows' in sessions ? { columns: sessions.columns, rows: sessions.rows.filter((x) => !['Sleep', 'Daemon', 'Binlog Dump'].includes(String(x[ci]))) } : sessions;
    const tranCur = (c.get('Com_commit') ?? 0) + (c.get('Com_rollback') ?? 0);
    const tranPrev = p && (p.get('Com_commit') ?? 0) + (p.get('Com_rollback') ?? 0);
    return {
      point: {
        t, values: {
          queries: [r('Questions', 1, own)], tran: [rate(tranCur, tranPrev, dt)],
          conn: [db === undefined ? c.get('Threads_connected') ?? 0 : 'rows' in sessions ? sessions.rows.length : null],
          running: [db === undefined ? Math.max(0, (c.get('Threads_running') ?? 1) - 1) : 'rows' in running ? running.rows.length : null],
          net: [r('Bytes_received', MB), r('Bytes_sent', MB)], io: [r('Innodb_data_read', MB), r('Innodb_data_written', MB)],
          locks: [c.get('Innodb_row_lock_current_waits') ?? 0],
        },
      },
      tables: { running, sessions, expensive: table(res.expensive, 'Expensive queries need performance_schema') },
    };
  },
  kill: (id) => `KILL ${sessionId(id)};`,
  query(tab, db) {
    const ps = this.parts(db);
    return (tab === 'expensive' ? ps.find((x) => x.id === 'expensive') : tab === 'running' || tab === 'sessions' ? ps.find((x) => x.id === 'processlist') : undefined)?.sql;
  },
};

/** PostgreSQL: pg_stat_database, pg_stat_activity (+ pg_blocking_pids), pg_stat_statements (opsional) */
const postgresKit: MonitorKit = {
  charts: [
    { id: 'tran', label: 'Transactions/sec', tip: 'xact_commit + xact_rollback (pg_stat_database)' },
    { id: 'rows', label: 'Rows read / written per sec', tip: 'tup_returned + tup_fetched / tup_inserted + tup_updated + tup_deleted' },
    { id: 'disk', label: 'Disk blocks read/sec', tip: 'blks_read: blocks not found in shared buffers' },
    { id: 'cache', label: 'Cache hit %', tip: 'blks_hit / (blks_hit + blks_read) since the previous sample', max: 100 },
    { id: 'conn', label: 'Connections', tip: 'Client backends (pg_stat_activity)' },
    { id: 'active', label: 'Active / waiting', tip: 'Active sessions / active sessions waiting on an event' },
  ],
  tabs: [['running', 'Running queries'], ['sessions', 'Sessions / Blocking'], ['expensive', 'Expensive queries']],
  parts: (db) => {
    const where = db === undefined ? '' : ` AND datname = ${lit(db)}`;
    return [
      { id: 'stats', sql: `${MARK} SELECT sum(xact_commit + xact_rollback) AS xacts, sum(tup_returned + tup_fetched) AS rows_read,
  sum(tup_inserted + tup_updated + tup_deleted) AS rows_written, sum(blks_read) AS blks_read, sum(blks_hit) AS blks_hit
  FROM pg_stat_database WHERE datname IS NOT NULL${where}` },
      { id: 'activity', sql: `${MARK} SELECT pid AS session_id, usename AS user, client_addr::text AS host, application_name AS program, datname AS database, state,
  wait_event_type, wait_event, array_to_string(pg_blocking_pids(pid), ',') AS blocked_by, round(extract(epoch FROM now() - query_start) * 1000) AS elapsed_ms,
  left(query, 4000) AS statement FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()${where}
  ORDER BY elapsed_ms DESC NULLS LAST` },
      { id: 'expensive', optional: 'Expensive queries need the pg_stat_statements extension', sql: `${MARK} SELECT left(query, 400) AS query, calls AS executions,
  round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 1) AS avg_ms, rows FROM pg_stat_statements
  WHERE query NOT LIKE '%moonage-monitor%'${db === undefined ? '' : ` AND dbid = (SELECT oid FROM pg_database WHERE datname = ${lit(db)})`}
  ORDER BY total_exec_time DESC LIMIT 20` },
    ];
  },
  sample(res, t, prev, db) {
    const row = (r: Res | undefined) => sets(r?.stats)?.[0]?.rows[0]?.map(num);
    const c = row(res);
    if (!c) throw res.stats as Error;
    const p = prev ? row(prev.res) : undefined;
    const dt = prev ? (t - prev.t) / 1000 : 0;
    const sessions = table(res.activity, 'pg_stat_activity not available');
    const si = col(sessions, 'state');
    const wi = col(sessions, 'wait_event');
    const active = 'rows' in sessions ? sessions.rows.filter((x) => x[si] === 'active') : [];
    const dHit = p ? c[4] - p[4] : 0;
    const dRead = p ? c[3] - p[3] : 0;
    return {
      point: {
        t, values: {
          tran: [rate(c[0], p?.[0], dt, 1, this.parts(db).length)], rows: [rate(c[1], p?.[1], dt), rate(c[2], p?.[2], dt)], disk: [rate(c[3], p?.[3], dt)],
          cache: [p && dHit >= 0 && dRead >= 0 && dHit + dRead > 0 ? r1((dHit / (dHit + dRead)) * 100) : null],
          conn: ['rows' in sessions ? sessions.rows.length : null], active: [active.length, active.filter((x) => x[wi] !== null && x[wi] !== undefined).length],
        },
      },
      tables: { running: 'rows' in sessions ? { columns: sessions.columns, rows: active } : sessions, sessions, expensive: table(res.expensive, 'Expensive queries need the pg_stat_statements extension') },
    };
  },
  kill: (id) => `SELECT pg_terminate_backend(${sessionId(id)});`,
  query(tab, db) {
    const ps = this.parts(db);
    return (tab === 'expensive' ? ps.find((x) => x.id === 'expensive') : tab === 'running' || tab === 'sessions' ? ps.find((x) => x.id === 'activity') : undefined)?.sql;
  },
};

const KITS: Partial<Record<DbType, MonitorKit>> = { mssql: mssqlKit, mysql: mysqlKit, mariadb: mysqlKit, postgres: postgresKit };
/** kit Live Monitor untuk jenis database; undefined = tidak didukung (SQLite, MongoDB) */
export const monitorKit = (type: DbType) => KITS[type];

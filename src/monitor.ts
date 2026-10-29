import type { ResultSet } from './db';

/** urutan result set monitorSql */
export const MONITOR_SETS = { counters: 0, waiting: 1, io: 2, waits: 3, sessions: 4, expensive: 5, files: 6, running: 7 } as const;
export type MonitorPart = keyof typeof MONITOR_SETS;

// wait yang selalu ada walau server diam (background / idle), tidak berguna di Top waits
const BENIGN = ['SLEEP_TASK', 'LAZYWRITER_SLEEP', 'SQLTRACE_BUFFER_FLUSH', 'XE_TIMER_EVENT', 'XE_DISPATCHER_WAIT', 'REQUEST_FOR_DEADLOCK_SEARCH',
  'LOGMGR_QUEUE', 'CHECKPOINT_QUEUE', 'BROKER_TO_FLUSH', 'BROKER_TASK_STOP', 'BROKER_EVENTHANDLER', 'BROKER_RECEIVE_WAITFOR', 'FT_IFTS_SCHEDULER_IDLE_WAIT',
  'DIRTY_PAGE_POLL', 'HADR_FILESTREAM_IOMGR_IOCOMPLETION', 'SP_SERVER_DIAGNOSTICS_SLEEP', 'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', 'QDS_ASYNC_QUEUE',
  'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP', 'SQLTRACE_INCREMENTAL_FLUSH_SLEEP', 'WAITFOR', 'CLR_AUTO_EVENT', 'CLR_MANUAL_EVENT',
  'ONDEMAND_TASK_QUEUE', 'DISPATCHER_QUEUE_SEMAPHORE', 'XE_LIVE_TARGET_TVF', 'PVS_PREALLOCATE', 'SOS_WORK_DISPATCHER', 'PREEMPTIVE_OS_FLUSHFILEBUFFERS'];

/** penanda batch sampel monitor: query monitor sendiri tidak ikut tampil di Expensive queries */
const MARK = '/* moonage-monitor */';

/**
 * query tiap bagian sampel (urutan = MONITOR_SETS), juga untuk Open as query. db = monitoring satu database (klik kanan database):
 * sesi, query, file, waiting tasks, transaksi dan koneksi database itu saja; CPU, Batch requests dan wait stats tetap level server.
 * Sesi monitor sendiri (@@SPID) dan batch sampelnya tidak pernah dihitung.
 */
export function monitorQueries(db?: string): Record<MonitorPart, string> {
  const lit = db === undefined ? '' : `N'${db.replace(/'/g, "''")}'`;
  const dbId = `DB_ID(${lit})`;
  const and = (col: string) => (db === undefined ? '' : ` AND ${col} = ${dbId}`);
  return {
    counters: `SELECT RTRIM(counter_name) AS counter, RTRIM(instance_name) AS instance, cntr_value FROM sys.dm_os_performance_counters
WHERE (object_name LIKE '%SQL Statistics%' AND counter_name = 'Batch Requests/sec')${db === undefined ? `
   OR (object_name LIKE '%General Statistics%' AND counter_name = 'User Connections')` : ''}
   OR (object_name LIKE '%:Databases%' AND counter_name = 'Transactions/sec' AND instance_name = ${db === undefined ? "'_Total'" : lit})
   OR (object_name LIKE '%Buffer Manager%' AND counter_name = 'Page life expectancy')
   OR (object_name LIKE '%Resource Pool Stats%' AND counter_name IN ('CPU usage %', 'CPU usage % base') AND instance_name = 'default')${db === undefined ? '' : `
UNION ALL SELECT 'User Connections', ${lit}, COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND session_id <> @@SPID AND database_id = ${dbId}`};`,
    waiting: `SELECT COUNT(*) AS waiting FROM sys.dm_os_waiting_tasks wt JOIN sys.dm_exec_sessions s ON s.session_id = wt.session_id
WHERE s.is_user_process = 1 AND wt.session_id <> @@SPID${and('s.database_id')};`,
    io: `SELECT SUM(num_of_bytes_read) AS bytes_read, SUM(num_of_bytes_written) AS bytes_written FROM sys.dm_io_virtual_file_stats(${db === undefined ? 'NULL' : dbId}, NULL);`,
    waits: `SELECT wait_type, wait_time_ms, waiting_tasks_count FROM sys.dm_os_wait_stats
WHERE wait_time_ms > 0 AND wait_type NOT LIKE 'SLEEP%' AND wait_type NOT IN (${BENIGN.map((w) => `'${w}'`).join(', ')});`,
    sessions: `SELECT s.session_id, s.login_name, s.host_name, s.program_name, DB_NAME(s.database_id) AS [database], s.status, r.command,
  r.blocking_session_id AS blocked_by, r.wait_type, r.wait_time AS wait_ms, r.total_elapsed_time AS elapsed_ms, s.cpu_time AS cpu_ms,
  s.open_transaction_count AS open_tran, LEFT(t.text, 400) AS current_sql
FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID${and('s.database_id')}
ORDER BY CASE WHEN r.blocking_session_id > 0 THEN 0 WHEN EXISTS (SELECT 1 FROM sys.dm_exec_requests b WHERE b.blocking_session_id = s.session_id) THEN 0
  WHEN r.session_id IS NOT NULL THEN 1 ELSE 2 END, s.session_id;`,
    expensive: `SELECT TOP 20 LEFT(t.text, 400) AS query, DB_NAME(pa.dbid) AS [database], qs.execution_count AS executions,
  qs.total_worker_time / 1000 AS cpu_ms, qs.total_worker_time / 1000 / qs.execution_count AS avg_cpu_ms,
  qs.total_elapsed_time / 1000 / qs.execution_count AS avg_ms, qs.total_logical_reads / qs.execution_count AS avg_reads, qs.last_execution_time AS last_run
FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
CROSS APPLY (SELECT CAST(value AS INT) AS dbid FROM sys.dm_exec_plan_attributes(qs.plan_handle) WHERE attribute = 'dbid') pa
WHERE t.text NOT LIKE '%moonage-monitor%'${and('pa.dbid')}
ORDER BY qs.total_worker_time DESC;`,
    files: `SELECT DB_NAME(v.database_id) AS [database], mf.name AS [file], mf.type_desc AS type, v.num_of_reads, v.num_of_writes, v.num_of_bytes_read,
  v.num_of_bytes_written, v.io_stall_read_ms, v.io_stall_write_ms
FROM sys.dm_io_virtual_file_stats(${db === undefined ? 'NULL' : dbId}, NULL) v JOIN sys.master_files mf ON mf.database_id = v.database_id AND mf.file_id = v.file_id ORDER BY 1, 2;`,
    // query yang sedang berjalan: statement aktif (bukan hanya seluruh batch), siapa / dari mana, lama, CPU, reads, blocking
    running: `SELECT r.session_id, s.login_name, s.host_name, s.program_name, DB_NAME(r.database_id) AS [database], r.status, r.command,
  r.blocking_session_id AS blocked_by, r.wait_type, r.wait_time AS wait_ms, r.total_elapsed_time AS elapsed_ms, r.cpu_time AS cpu_ms,
  r.logical_reads AS reads, r.open_transaction_count AS open_tran,
  SUBSTRING(t.text, r.statement_start_offset / 2 + 1, (CASE WHEN r.statement_end_offset = -1 THEN DATALENGTH(t.text) ELSE r.statement_end_offset END - r.statement_start_offset) / 2 + 1) AS statement,
  LEFT(t.text, 4000) AS batch
FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND r.session_id <> @@SPID${and('r.database_id')}
ORDER BY r.total_elapsed_time DESC;`,
  };
}

/** satu sampel monitor (butuh VIEW SERVER STATE); diawali penanda supaya tidak muncul di Expensive queries */
export const monitorSql = (db?: string) => `${MARK}\nSET NOCOUNT ON;\n${Object.values(monitorQueries(db)).join('\n')}`;

export interface MonitorPoint {
  t: number; cpu: number | null; batchPerSec: number | null; tranPerSec: number | null; waiting: number;
  readMBs: number | null; writeMBs: number | null; connections: number; ple: number | null;
}
export interface MonitorTable { columns: string[]; rows: unknown[][] }
export interface MonitorSample { point: MonitorPoint; sessions: MonitorTable; waits: MonitorTable; expensive: MonitorTable; files: MonitorTable; running: MonitorTable }

const MB = 1024 * 1024;
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => Number(v ?? 0);
/** laju per detik; counter turun (server restart / reset) = tidak ada nilai */
const rate = (cur: number, prev: number | undefined, dt: number, div = 1, own = 0) =>
  (prev === undefined || cur < prev || dt <= 0 ? null : r1(Math.max(0, cur - prev - own) / div / dt));
/** batch yang dikirim monitor sendiri di antara dua sampel */
const OWN_BATCHES = 1;

function counters(sets: ResultSet[]): Map<string, number> {
  return new Map((sets[MONITOR_SETS.counters]?.rows ?? []).map((r) => [String(r[0]), num(r[2])]));
}

/** sampel mentah (MONITOR_SQL) + sampel sebelumnya -> titik grafik dan tabel; t = waktu sampel (ms) */
export function monitorSample(sets: ResultSet[], t: number, prev?: { sets: ResultSet[]; t: number }): MonitorSample {
  const dt = prev ? (t - prev.t) / 1000 : 0;
  const c = counters(sets);
  const p = prev ? counters(prev.sets) : undefined;
  const io = sets[MONITOR_SETS.io]?.rows[0] ?? [];
  const pio = prev?.sets[MONITOR_SETS.io]?.rows[0];
  const base = c.get('CPU usage % base') ?? 0;
  const point: MonitorPoint = {
    t,
    cpu: base > 0 ? r1(((c.get('CPU usage %') ?? 0) / base) * 100) : null,
    // batch sampel monitor sendiri (1 per sampel) dikurangkan
    batchPerSec: rate(c.get('Batch Requests/sec') ?? 0, p?.get('Batch Requests/sec'), dt, 1, OWN_BATCHES),
    tranPerSec: rate(c.get('Transactions/sec') ?? 0, p?.get('Transactions/sec'), dt),
    waiting: num(sets[MONITOR_SETS.waiting]?.rows[0]?.[0]),
    readMBs: rate(num(io[0]), pio && num(pio[0]), dt, MB),
    writeMBs: rate(num(io[1]), pio && num(pio[1]), dt, MB),
    connections: c.get('User Connections') ?? 0,
    ple: c.has('Page life expectancy') ? c.get('Page life expectancy')! : null,
  };
  const table = (i: number): MonitorTable => ({ columns: sets[i]?.columns ?? [], rows: sets[i]?.rows ?? [] });

  // Top waits: selisih wait_time_ms sejak sampel sebelumnya (ms per detik), 10 terbesar
  const pw = new Map((prev?.sets[MONITOR_SETS.waits]?.rows ?? []).map((r) => [String(r[0]), r]));
  const waits = prev ? (sets[MONITOR_SETS.waits]?.rows ?? []).flatMap((r) => {
    const old = pw.get(String(r[0]));
    const ms = num(r[1]) - num(old?.[1]);
    return old && ms > 0 && dt > 0 ? [[String(r[0]), r1(ms / dt), Math.max(0, num(r[2]) - num(old[2]))]] : [];
  }).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 10) : [];

  // File I/O: laju dan latensi rata-rata (ms per operasi) sejak sampel sebelumnya
  const key = (r: unknown[]) => `${r[0]}\n${r[1]}`;
  const pf = new Map((prev?.sets[MONITOR_SETS.files]?.rows ?? []).map((r) => [key(r), r]));
  const files = (sets[MONITOR_SETS.files]?.rows ?? []).map((r) => {
    const o = pf.get(key(r));
    const d = (i: number) => (o && dt > 0 ? Math.max(0, num(r[i]) - num(o[i])) : 0);
    const reads = d(3), writes = d(4);
    return [r[0], r[1], r[2], r1(reads / (dt || 1)), r1(writes / (dt || 1)), r1(d(5) / MB / (dt || 1)), r1(d(6) / MB / (dt || 1)),
      reads ? r1(d(7) / reads) : 0, writes ? r1(d(8) / writes) : 0];
  });
  return {
    point,
    sessions: table(MONITOR_SETS.sessions),
    running: table(MONITOR_SETS.running),
    waits: { columns: ['wait_type', 'wait_ms_per_sec', 'tasks'], rows: waits },
    expensive: table(MONITOR_SETS.expensive),
    files: { columns: ['database', 'file', 'type', 'reads_per_sec', 'writes_per_sec', 'read_mb_per_sec', 'write_mb_per_sec', 'read_latency_ms', 'write_latency_ms'], rows: files },
  };
}

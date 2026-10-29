import * as sql from 'mssql';
import { MAX_ROWS, connectMs, typedOptions } from './db';
import type { Column, ConnectionInfo, Driver, ListKind, ObjectKind, ProcParam, QueryResult, ResultSet, Session, Sink } from './db';
import { driverLog } from './log';
import { maskSql, readOnly, splitStatements } from './sqlContext';

const errText = (e: unknown) => (e instanceof Error ? `${e.message} - stack-trace: ${e.stack}` : String(e));

/** pool per koneksi + database (database bisa beda per file .sql) */
const pools = new Map<string, Promise<sql.ConnectionPool>>();
const poolKey = (conn: ConnectionInfo) => `${conn.name}\n${conn.database}`;

/** gagal connect yang layak dicoba ulang: timeout / pencarian port named instance (SQL Server Browser, UDP 1434) */
export const retryableConnectError = (e: unknown) => {
  const x = e as { code?: string; message?: string };
  return x?.code === 'ETIMEOUT' || x?.code === 'EINSTLOOKUP' || /Failed to connect .* in \d+ms|Port for .* not found/i.test(x?.message ?? '');
};

/** satu kali coba ulang bila error-nya retryable (UDP 1434 kadang hilang -> timeout acak saat membuka pool baru) */
export async function retryOnce<T>(f: () => Promise<T>, retryable: (e: unknown) => boolean): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!retryable(e)) throw e;
    return f();
  }
}

/**
 * konfigurasi pool. Windows authentication = NTLM dengan domain / user / password eksplisit
 * (tedious tidak bisa SSO memakai user Windows yang sedang login).
 */
export const poolConfig = (conn: ConnectionInfo, password: string): sql.config => ({
  server: conn.host,
  port: conn.instance ? undefined : conn.port, // tedious: port dan instanceName tidak boleh bersamaan
  ...(conn.auth === 'windows'
    ? { authentication: { type: 'ntlm', options: { domain: conn.domain ?? '', userName: conn.user, password } } }
    : { user: conn.user, password }),
  database: conn.database || undefined,
  requestTimeout: 0, // tanpa batas (default mssql 15 detik): query lama dihentikan lewat Cancel, bukan timeout diam-diam
  connectionTimeout: connectMs(conn),
  options: { ...typedOptions(conn.options), encrypt: conn.ssl ?? true, trustServerCertificate: conn.trustServerCertificate, instanceName: conn.instance || undefined },
});

function pool(conn: ConnectionInfo, password: string): Promise<sql.ConnectionPool> {
  const key = poolKey(conn);
  let p = pools.get(key);
  if (!p) {
    p = retryOnce(() => new sql.ConnectionPool(poolConfig(conn, password)).connect(), retryableConnectError);
    pools.set(key, p);
    p.catch(() => pools.delete(key)); // gagal connect: coba ulang di run berikutnya (error dilaporkan oleh pemanggil)
  }
  return p;
}

/**
 * Pecah script per baris `GO` (separator batch SSMS/sqlcmd, bukan T-SQL).
 * shortcut: `GO` di dalam string/komentar multi-baris ikut dianggap separator, dan `GO n` tidak diulang n kali; perbaiki bila ada yang butuh.
 */
export function splitBatches(text: string): string[] {
  return text.split(/^[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?:--.*)?$/gim).map((b) => b.trim()).filter(Boolean);
}

/** quote identifier T-SQL: [nama]] aneh] */
export const q = (s: string) => `[${s.replace(/]/g, ']]')}]`;


/** definisi view / procedure -> script CREATE OR ALTER (komentar sebelum CREATE dipertahankan) */
export function alterScript(definition: string): string {
  const m = /\b(?:create(?:\s+or\s+alter)?|alter)\s+(procedure|proc|view|function|trigger)\b/i.exec(maskSql(definition));
  if (!m) throw new Error('The definition is not a CREATE VIEW / PROCEDURE / FUNCTION / TRIGGER statement');
  return `${definition.slice(0, m.index)}CREATE OR ALTER ${m[1].toUpperCase()}${definition.slice(m.index + m[0].length)}`;
}

/**
 * parameter yang punya nilai default (huruf kecil), dibaca dari header CREATE PROCEDURE sampai AS di level atas:
 * sys.parameters.has_default_value hanya terisi untuk procedure CLR.
 */
export function paramDefaults(definition: string): Set<string> {
  const code = maskSql(definition);
  const start = /\b(?:procedure|proc|function)\b/i.exec(code);
  const out = new Set<string>();
  if (!start) return out;
  let depth = 0;
  let end = code.length;
  for (let i = start.index + start[0].length; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    // AS penutup header: di level atas dan bukan `@param AS tipe`
    else if (!depth && /^as\b/i.test(code.slice(i, i + 3)) && !/\w/.test(code[i - 1]) && !/@[\w@#$]+\s*$/.test(code.slice(0, i))) {
      end = i;
      break;
    }
  }
  const header = code.slice(start.index, end);
  for (const m of header.matchAll(/(@[\w@#$]+)\s+(?:as\s+)?[\w.[\]]+(?:\s*\([^)]*\))?(?:\s+varying)?\s*(=)?/gi)) {
    if (m[2]) out.add(m[1].toLowerCase());
  }
  return out;
}

/** script function: scalar = SELECT f(...) AS [result], table-valued = SELECT * FROM f(...); DEFAULT untuk parameter ber-default */
export function fnScript(db: string, obj: { schema: string; name: string }, params: ProcParam[], tableValued: boolean): string {
  const target = `${q(db)}.${q(obj.schema)}.${q(obj.name)}`;
  const args = params.map((p, i) => `${i ? '  , ' : '    '}${p.hasDefault ? `DEFAULT -- ${p.type} (has default)` : `NULL -- ${p.type}`}`.replace(/-- /, `-- ${p.name} `));
  const call = params.length ? `${target}(\n${args.join('\n')}\n)` : `${target}()`;
  return tableValued ? `SELECT * FROM ${call};` : `SELECT ${call} AS [result];`;
}

const lit = (s: string) => `N'${s.replace(/'/g, "''")}'`;
const DROP: Record<ObjectKind, string> = { table: 'TABLE', view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER' };

/**
 * Script as (tab baru, tidak dijalankan): nama dua bagian karena tab terikat ke database objek.
 * shortcut: CREATE TABLE hanya kolom + primary key (tanpa default / FK / identity / index); ambil dari SSMS bila perlu lengkap.
 */
export function scriptAs(action: 'select' | 'insert' | 'update' | 'delete' | 'drop' | 'create', obj: { schema: string; name: string }, kind: ObjectKind,
  cols: Column[], pk: string[]): string {
  const target = obj.schema ? `${q(obj.schema)}.${q(obj.name)}` : q(obj.name);
  const list = (xs: string[]) => xs.map((x, i) => `${i ? '  , ' : '    '}${x}`).join('\n');
  const where = (keys: typeof cols) => (keys.length ? keys.map((c, i) => `${i ? '  AND ' : '    '}${q(c.name)} = NULL -- ${c.type}`).join('\n') : '    <condition>');
  const keys = cols.filter((c) => pk.includes(c.name));
  const writable = cols.filter((c) => !c.generated);
  switch (action) {
    case 'select': return `SELECT TOP (1000)\n${list(cols.map((c) => q(c.name)))}\nFROM ${target};`;
    case 'insert': return `INSERT INTO ${target} (\n${list(writable.map((c) => q(c.name)))}\n)\nVALUES (\n${list(writable.map((c) => `NULL -- ${c.name} ${c.type}`))}\n);`;
    case 'update': return `UPDATE ${target}\nSET\n${list(writable.filter((c) => !pk.includes(c.name)).map((c) => `${q(c.name)} = NULL -- ${c.type}`))}\nWHERE\n${where(keys)}\n;`;
    case 'delete': return `DELETE FROM ${target}\nWHERE\n${where(keys)}\n;`;
    case 'drop': return kind === 'trigger' && !obj.schema ? `DROP TRIGGER ${target} ON DATABASE;` : `DROP ${DROP[kind]} ${target};`;
    case 'create': return `CREATE TABLE ${target} (\n${list([...cols.map((c) => `${q(c.name)} ${c.type} ${c.nullable ? 'NULL' : 'NOT NULL'}`),
      ...(pk.length ? [`CONSTRAINT ${q(`PK_${obj.name}`)} PRIMARY KEY (${pk.map(q).join(', ')})`] : [])])}\n);`;
  }
}

/** metadata tabel untuk CREATE TABLE lengkap (tableMeta) */
export interface TableMeta {
  schema: string;
  name: string;
  columns: (Column & { collation?: string; identity?: { seed: string; increment: string }; computed?: { definition: string; persisted: boolean };
    default?: { name: string; definition: string } })[];
  keys: { name: string; primary: boolean; clustered: boolean; columns: { name: string; desc: boolean }[] }[];
  checks: { name: string; definition: string }[];
  foreignKeys: { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }[];
  indexes: { name: string; unique: boolean; clustered: boolean; columns: { name: string; desc: boolean }[]; included: string[]; filter?: string }[];
}

/** CREATE TABLE (kolom, identity, computed, default, collation, PK / unique / check) lalu ALTER TABLE ... FOREIGN KEY dan CREATE INDEX */
export function createTableScript(t: TableMeta): string {
  const target = `${q(t.schema)}.${q(t.name)}`;
  const cols = (cs: { name: string; desc: boolean }[]) => cs.map((c) => `${q(c.name)} ${c.desc ? 'DESC' : 'ASC'}`).join(', ');
  const action = (a: string) => (a && a !== 'NO_ACTION' ? a.replace('_', ' ') : '');
  const lines = [
    ...t.columns.map((c) => (c.computed ? `${q(c.name)} AS ${c.computed.definition}${c.computed.persisted ? ' PERSISTED' : ''}`
      : `${q(c.name)} ${c.type}${c.collation ? ` COLLATE ${c.collation}` : ''}${c.identity ? ` IDENTITY(${c.identity.seed}, ${c.identity.increment})` : ''}`
        + ` ${c.nullable ? 'NULL' : 'NOT NULL'}${c.default ? ` CONSTRAINT ${q(c.default.name)} DEFAULT ${c.default.definition}` : ''}`)),
    ...t.keys.map((k) => `CONSTRAINT ${q(k.name)} ${k.primary ? 'PRIMARY KEY' : 'UNIQUE'} ${k.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} (${cols(k.columns)})`),
    ...t.checks.map((ck) => `CONSTRAINT ${q(ck.name)} CHECK ${ck.definition}`),
  ];
  return [
    `CREATE TABLE ${target} (`, ...lines.map((l, i) => `${i ? '  , ' : '    '}${l}`), ');',
    ...t.foreignKeys.map((fk) => `ALTER TABLE ${target} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.refSchema)}.${q(fk.refTable)} (${fk.refColumns.map(q).join(', ')})`
      + `${action(fk.onDelete) ? ` ON DELETE ${action(fk.onDelete)}` : ''}${action(fk.onUpdate) ? ` ON UPDATE ${action(fk.onUpdate)}` : ''};`),
    ...t.indexes.map((ix) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}${ix.clustered ? 'CLUSTERED' : 'NONCLUSTERED'} INDEX ${q(ix.name)} ON ${target} (${cols(ix.columns)})`
      + `${ix.included.length ? ` INCLUDE (${ix.included.map(q).join(', ')})` : ''}${ix.filter ? ` WHERE ${ix.filter}` : ''};`),
  ].join('\n');
}

/** SQL Server Agent: jalankan / hentikan job */
export const jobScript = (action: 'start' | 'stop', job: string) => `EXEC msdb.dbo.sp_${action}_job @job_name = ${lit(job)};`;

/** KILL hanya untuk session id angka (input user) */
export function killScript(id: string): string {
  if (!/^\d+$/.test(id.trim()) || +id < 1) throw new Error('Enter a session id (number)');
  return `KILL ${+id};`;
}

/** BACKUP (COPY_ONLY: tidak mengganggu rantai backup terjadwal) ke folder backup server */
export function backupScript(db: string, dir: string, stamp: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const file = `${dir.replace(/[\\/]+$/, '')}${sep}${db}_${stamp}.bak`;
  return `BACKUP DATABASE ${q(db)}\nTO DISK = ${lit(file)}\nWITH COPY_ONLY, INIT, CHECKSUM, STATS = 10;`;
}

/** RESTORE: cek isi backup dulu; perintah restore dikomentari (REPLACE menimpa database) */
export const restoreScript = (db: string, file: string) => [
  '-- 1. check the backup (logical file names, sizes)',
  `RESTORE FILELISTONLY FROM DISK = ${lit(file)};`,
  '-- 2. restore: uncomment, add MOVE ... TO ... when the data / log folders differ; REPLACE overwrites the existing database',
  `-- RESTORE DATABASE ${q(db)} FROM DISK = ${lit(file)} WITH REPLACE, RECOVERY, STATS = 10;`,
].join('\n');

/** SQL Server: sesi aktif (siapa, dari mana, sedang menjalankan apa, diblokir siapa) */
export const ACTIVITY_SQL = `SELECT s.session_id, s.login_name, s.host_name, s.program_name, DB_NAME(s.database_id) AS [database], s.status,
  r.command, r.blocking_session_id AS blocked_by, r.wait_type, r.wait_time AS wait_ms, r.total_elapsed_time AS elapsed_ms,
  s.cpu_time AS cpu_ms, s.reads, s.writes, s.open_transaction_count AS open_tran, t.text AS current_sql
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
ORDER BY CASE WHEN r.blocking_session_id > 0 THEN 0 WHEN r.session_id IS NOT NULL THEN 1 ELSE 2 END, s.session_id;`;

/** SQL Server: info server */
export const SERVER_INFO_SQL = `SELECT @@SERVERNAME AS server, SERVERPROPERTY('ProductVersion') AS version, SERVERPROPERTY('ProductLevel') AS level,
  SERVERPROPERTY('Edition') AS edition, SERVERPROPERTY('Collation') AS collation, SERVERPROPERTY('IsHadrEnabled') AS always_on,
  SERVERPROPERTY('InstanceDefaultDataPath') AS data_path, SERVERPROPERTY('InstanceDefaultBackupPath') AS backup_path,
  (SELECT sqlserver_start_time FROM sys.dm_os_sys_info) AS started_at, (SELECT cpu_count FROM sys.dm_os_sys_info) AS cpus;`;

/** SQL Server: info database + file data / log (database file ini) */
export const DB_INFO_SQL = `SELECT name, state_desc AS state, recovery_model_desc AS recovery_model, collation_name AS collation, compatibility_level,
  create_date, is_read_only, user_access_desc AS user_access FROM sys.databases WHERE database_id = DB_ID();
SELECT name, type_desc AS type, physical_name, CAST(CAST(size AS BIGINT) * 8 / 1024.0 AS DECIMAL(12, 1)) AS size_mb,
  CAST(FILEPROPERTY(name, 'SpaceUsed') * 8 / 1024.0 AS DECIMAL(12, 1)) AS used_mb,
  CASE WHEN max_size = -1 THEN 'unlimited' ELSE CAST(CAST(max_size AS BIGINT) * 8 / 1024 AS VARCHAR(20)) + ' MB' END AS max_size,
  CASE WHEN is_percent_growth = 1 THEN CAST(growth AS VARCHAR(10)) + ' %' ELSE CAST(CAST(growth AS BIGINT) * 8 / 1024 AS VARCHAR(20)) + ' MB' END AS growth
FROM sys.database_files;`;

/** script EXEC procedure dengan semua parameter: NULL / DEFAULT sebagai nilai awal, OUTPUT di-DECLARE lalu di-SELECT */
export function execScript(db: string, obj: { schema: string; name: string }, params: ProcParam[]): string {
  const target = `${q(db)}.${q(obj.schema)}.${q(obj.name)}`;
  if (!params.length) return `EXEC ${target};`;
  const outs = params.filter((p) => p.output);
  return [
    ...outs.map((p) => `DECLARE ${p.name} ${p.type};`),
    `EXEC ${target}`,
    ...params.map((p, i) => `${i ? '  , ' : '    '}${p.name} = ${p.output ? `${p.name} OUTPUT -- ${p.type}` : p.hasDefault ? `DEFAULT -- ${p.type} (has default)` : `NULL -- ${p.type}`}`),
    ';',
    ...(outs.length ? [`SELECT ${outs.map((p) => `${p.name} AS ${q(p.name)}`).join(', ')};`] : []),
  ].join('\n');
}

const CATALOG: Record<ListKind, string> = { table: 'tables', view: 'views', procedure: 'procedures' };

/** tipe kolom seperti di SSMS: nvarchar(50), varchar(max), decimal(10,2) */
export function fmtType(type: string, maxLength: number, precision: number, scale: number): string {
  if (/^(n?(var)?char|varbinary|binary)$/.test(type)) {
    if (maxLength === -1) return `${type}(max)`;
    return `${type}(${type.startsWith('n') ? maxLength / 2 : maxLength})`;
  }
  if (type === 'decimal' || type === 'numeric') return `${type}(${precision},${scale})`;
  return type;
}

async function select<T>(conn: ConnectionInfo, password: string, text: string, params: Record<string, string> = {}): Promise<T[]> {
  const req = (await pool(conn, password)).request();
  for (const [k, v] of Object.entries(params)) req.input(k, sql.NVarChar, v);
  return (await req.query<T>(text)).recordset;
}

/** jalankan satu batch dengan request stream: hanya MAX_ROWS baris per result set disimpan, cancel lewat signal, auto limit */
async function collect(req: sql.Request, batch: string, out: QueryResult, signal?: AbortSignal, limit?: number, asBatch = false, skip = 0): Promise<void> {
  req.arrayRowMode = true;
  req.stream = true; // baris dibaca per event: hanya MAX_ROWS yang disimpan
  req.on('info', (i: { message: string }) => out.messages.push(i.message)); // PRINT / RAISERROR level rendah
  const cancel = () => req.cancel(); // kirim attention ke server: query dihentikan di server, bukan hanya di client
  signal?.addEventListener('abort', cancel);
  await new Promise<void>((resolve, reject) => {
    let err: unknown;
    let cur: ResultSet | undefined;
    let limited = false;
    let inSet = false; // rowsaffected berikutnya milik SELECT ini (jumlahnya sudah ada di result set)
    req.on('recordset', (cols: { name: string; type?: { declaration?: string } }[]) => {
      inSet = true;
      out.resultSets.push(cur = { columns: cols.map((c) => c.name), types: cols.map((c) => c.type?.declaration ?? ''), rows: [], total: 0 });
    });
    // satu event per statement: hanya UPDATE / INSERT / DELETE / MERGE dll. yang masuk rowsAffected (seperti driver lain)
    req.on('rowsaffected', (n: number) => {
      if (inSet) inSet = false;
      else out.rowsAffected.push(n);
    });
    req.on('row', (row: unknown[]) => {
      if (!cur || limited) return;
      cur.total++;
      if (cur.total > skip && cur.rows.length < MAX_ROWS) cur.rows.push(row); // skip: halaman sebelumnya sudah dimuat
      if (limit && cur.total >= limit) {
        limited = true; // auto limit: cukup, hentikan query di server; error "Canceled" berikutnya bukan kegagalan
        cur.limited = limit;
        req.cancel();
      }
    });
    req.on('error', (e: unknown) => (err ??= e)); // mode stream: error lewat event, yang pertama yang dilaporkan
    const done = () => (err && !(limited && !signal?.aborted) ? reject(err) : resolve());
    // asBatch: SQL batch biasa (bukan sp_executesql), dibutuhkan agar output SET SHOWPLAN_XML / STATISTICS XML ikut kembali
    if (asBatch) req.batch(batch, done);
    else req.query(batch, done);
  }).finally(() => signal?.removeEventListener('abort', cancel));
}

/** export All Data: semua baris result set pertama ke sink (lihat Driver.stream); req = pool biasa atau koneksi sesi transaksi */
async function streamOn(req: sql.Request, text: string, signal: AbortSignal | undefined, sink: Sink): Promise<number> {
  req.arrayRowMode = true;
  req.stream = true;
  const cancel = () => req.cancel();
  signal?.addEventListener('abort', cancel);
  let n = 0;
  let sets = 0;
  let failed: unknown;
  let chain = Promise.resolve();
  let busy = 0;
  // hanya result set pertama; baris diproses berurutan lewat chain, query di-pause selama sink menulis (backpressure)
  const step = (f: () => Promise<void> | void) => {
    busy++;
    req.pause();
    chain = chain.then(f).then(() => {
      if (--busy === 0) req.resume();
    }, (e: unknown) => {
      busy--;
      failed ??= e;
      req.cancel();
    });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let err: unknown;
      req.on('recordset', (cols: { name: string }[]) => {
        if (++sets === 1) step(() => sink.columns(cols.map((c) => c.name)));
      });
      req.on('row', (row: unknown[]) => {
        if (sets !== 1 || failed) return;
        n++;
        if (busy) return step(() => sink.row(row)); // masih menunggu tulisan sebelumnya: jaga urutan
        try {
          const r = sink.row(row);
          if (r) step(() => r);
        } catch (e) {
          failed ??= e; // mis. batas baris Excel: hentikan query, error dilaporkan ke pemanggil
          req.cancel();
        }
      });
      req.on('error', (e: unknown) => (err ??= e));
      req.query(text, () => chain.then(() => (failed ?? err ? reject(failed ?? err) : resolve())));
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  return n;
}

/** kolom result set plan XML dari SET SHOWPLAN_XML / STATISTICS XML */
const PLAN_COLUMN = /showplan/i;

export const mssqlDriver: Driver = {
  label: 'SQL Server',
  defaultPort: 1433,
  dialect: 'mssql',
  formatter: 'transactsql',
  quote: q,
  defaultSchema: 'dbo',
  defaultDb: 'master',
  testSql: 'SELECT @@SERVERNAME AS server, DB_NAME() AS db',

  async run(conn, password, text, signal, limit, skip) {
    const p = await pool(conn, password);
    const out: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
    const start = Date.now();
    for (const batch of splitBatches(text)) {
      signal?.throwIfAborted(); // batch GO berikutnya tidak dijalankan
      await collect(p.request(), batch, out, signal, limit, false, skip);
    }
    out.durationMs = Date.now() - start;
    return out;
  },

  async session(conn, password) {
    // pool sendiri berisi 1 koneksi yang tidak pernah ditutup karena idle: transaksi tetap hidup di antara run.
    // Status transaksi selalu dibaca dari server (@@TRANCOUNT), bukan ditebak client: COMMIT / BEGIN TRAN / ROLLBACK
    // yang ditulis di script, rollback karena error / XACT_ABORT, dan koneksi yang putus ikut terbaca.
    const p = await retryOnce(() => new sql.ConnectionPool({
      ...poolConfig(conn, password), pool: { max: 1, min: 0, idleTimeoutMillis: 2 ** 31 - 1 },
    }).connect(), retryableConnectError);
    let open = false;
    let spid = 0; // koneksi tempat transaksi dibuka; beda = koneksi putus lalu dibuat ulang (transaksi sudah di-rollback server)
    const state = async () => (await p.request().query<{ n: number; spid: number }>('SELECT @@TRANCOUNT AS n, @@SPID AS spid')).recordset[0];
    /** sebelum perintah: transaksi yang tercatat terbuka harus masih ada di koneksi yang sama */
    const alive = async () => {
      const b = await state();
      if (open && (b.n === 0 || b.spid !== spid)) {
        open = false;
        throw new Error('The open transaction was lost (connection reset) and has been rolled back by the server. Nothing was run; run again to start a new transaction.');
      }
      return b;
    };
    /** sesudah perintah: status dari server; koneksi lain / gagal dibaca = dibiarkan, perintah berikutnya melaporkan lewat alive() */
    const refresh = async () => {
      const b = await state();
      if (b.spid === spid) open = b.n > 0;
    };
    const s: Session = {
      get open() { return open; },
      async run(text, signal, limit, skip) {
        const before = await alive();
        const batches = splitBatches(text);
        // SELECT biasa tanpa transaksi terbuka: tidak ada yang perlu di-commit, transaksi tidak dibuka
        const begin = before.n === 0 && !readOnly(batches.flatMap((b) => splitStatements(b, 'mssql')));
        if (begin) await p.request().batch('BEGIN TRAN');
        spid = before.spid;
        open = before.n > 0 || begin;
        const out: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
        const start = Date.now();
        try {
          for (const batch of batches) {
            signal?.throwIfAborted();
            // SQL batch seperti SSMS, bukan sp_executesql: COMMIT / ROLLBACK / BEGIN TRAN di script tanpa error 266,
            // SET dan #temp tetap ada di run berikutnya (koneksi sesi ini khusus untuk file ini)
            await collect(p.request(), batch, out, signal, limit, true, skip);
          }
        } finally {
          await refresh().catch((e: unknown) => driverLog.error(`mssql session.run state - EXCEPTION CAUGHT | ${errText(e)}`));
        }
        out.durationMs = Date.now() - start;
        return out;
      },
      stream: (text, signal, sink) => streamOn(p.request(), text, signal, sink),
      async commit() {
        if (!open) return;
        await alive();
        try {
          // WHILE: BEGIN TRAN nested di script (@@TRANCOUNT > 1) ikut di-commit semua, bukan hanya satu level
          await p.request().batch('WHILE @@TRANCOUNT > 0 COMMIT TRAN');
        } finally {
          // gagal di tengah (mis. koneksi putus): status asli dari server, transaksi tidak dianggap selesai diam-diam
          await refresh().catch((e: unknown) => driverLog.error(`mssql session.commit state - EXCEPTION CAUGHT | ${errText(e)}`));
        }
        if (open) throw new Error('The transaction is still open after commit (@@TRANCOUNT > 0, or its status could not be read)');
      },
      async rollback() {
        if (!open) return;
        await alive();
        try {
          await p.request().batch('IF @@TRANCOUNT > 0 ROLLBACK TRAN');
        } finally {
          await refresh().catch((e: unknown) => driverLog.error(`mssql session.rollback state - EXCEPTION CAUGHT | ${errText(e)}`));
        }
      },
      async close() {
        try {
          await s.rollback();
        } finally {
          await p.close(); // koneksi ditutup: sisa transaksi apa pun di-rollback server
        }
      },
    };
    return s;
  },
  async plan(conn, password, text, mode, signal) {
    const p = await pool(conn, password);
    // satu koneksi lewat transaksi (SET ... berlaku per sesi), selalu di-rollback: Analyze tidak pernah menyimpan perubahan
    const tx = new sql.Transaction(p);
    await tx.begin();
    const out: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
    const start = Date.now();
    const option = mode === 'estimated' ? 'SHOWPLAN_XML' : 'STATISTICS XML';
    let failure: unknown;
    try {
      await new sql.Request(tx).batch(`SET ${option} ON`); // SHOWPLAN_XML harus sendirian dalam batch
      try {
        for (const batch of splitBatches(text)) {
          signal?.throwIfAborted();
          await collect(new sql.Request(tx), batch, out, signal, undefined, true);
        }
      } finally {
        if (!signal?.aborted) await new sql.Request(tx).batch(`SET ${option} OFF`);
      }
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      try {
        await tx.rollback();
      } catch (re) {
        if (!failure) throw re;
        // query sudah gagal / dibatalkan: error asli yang dilaporkan (dan di-log pemanggil), error rollback ditempelkan
        if (failure instanceof Error) failure.message += ` (rollback: ${re instanceof Error ? re.message : re})`;
      }
    }
    out.durationMs = Date.now() - start;
    const isPlan = (rs: ResultSet) => rs.columns.length === 1 && PLAN_COLUMN.test(rs.columns[0]);
    const xml = out.resultSets.filter(isPlan).flatMap((rs) => rs.rows.map((r) => String(r[0])));
    out.resultSets = out.resultSets.filter((rs) => !isPlan(rs));
    return { xml, result: out };
  },
  async stream(conn, password, text, signal, sink) {
    return streamOn((await pool(conn, password)).request(), text, signal, sink);
  },
  async databases(conn, password) {
    const rows = await select<{ name: string }>(conn, password, 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name');
    return rows.map((r) => r.name);
  },

  objects(conn, password, db, kind) {
    return select(conn, password, `SELECT s.name AS [schema], o.name FROM ${q(db)}.sys.${CATALOG[kind]} o
      JOIN ${q(db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE o.is_ms_shipped = 0 ORDER BY s.name, o.name`);
  },

  async primaryKey(conn, password, db, obj) {
    const rows = await select<{ name: string }>(conn, password,
      `SELECT c.name FROM ${q(db)}.sys.indexes i
        JOIN ${q(db)}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${q(db)}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@full) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`,
      { full: `${q(db)}.${q(obj.schema)}.${q(obj.name)}` });
    return rows.map((r) => r.name);
  },
  async columns(conn, password, db, obj) {
    const rows = await select<{ name: string; type: string; max_length: number; precision: number; scale: number; is_nullable: boolean; is_identity: boolean; is_computed: boolean }>(
      conn, password,
      // all_columns: termasuk kolom view / tabel sistem (sys.objects dll.), sys.columns hanya objek user
      `SELECT c.name, t.name AS type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed FROM ${q(db)}.sys.all_columns c
        JOIN ${q(db)}.sys.types t ON t.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(@full) ORDER BY c.column_id`,
      { full: `${q(db)}.${q(obj.schema)}.${q(obj.name)}` },
    );
    return rows.map((r) => ({ name: r.name, type: fmtType(r.type, r.max_length, r.precision, r.scale), nullable: r.is_nullable,
      ...(r.is_identity || r.is_computed || r.type === 'timestamp' ? { generated: true } : {}) }));
  },

  selectTop(db, obj, n) {
    return `SELECT TOP ${n} * FROM ${q(db)}.${q(obj.schema)}.${q(obj.name)};`;
  },

  catalog: (conn, password, text, full) => select(conn, password, text, full === undefined ? {} : { full }),

  async createTableScript(conn, password, db, obj) {
    const B = q(db);
    const params = { full: `${B}.${q(obj.schema)}.${q(obj.name)}`, db };
    const [cols, keys, checks, fks, ixs] = await Promise.all([
      select<{ name: string; type: string; max_length: number; precision: number; scale: number; is_nullable: boolean; collation: string | null; seed: string | null; inc: string | null;
        computed: string | null; is_persisted: boolean | null; df_name: string | null; df_def: string | null }>(conn, password,
        `SELECT c.name, t.name AS type, c.max_length, c.precision, c.scale, c.is_nullable,
          CASE WHEN c.collation_name <> CAST(DATABASEPROPERTYEX(@db, 'Collation') AS sysname) THEN c.collation_name END AS collation,
          CAST(ic.seed_value AS varchar(40)) AS seed, CAST(ic.increment_value AS varchar(40)) AS inc, cc.definition AS computed, cc.is_persisted,
          dc.name AS df_name, dc.definition AS df_def
        FROM ${B}.sys.columns c JOIN ${B}.sys.types t ON t.user_type_id = c.user_type_id
        LEFT JOIN ${B}.sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        LEFT JOIN ${B}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
        LEFT JOIN ${B}.sys.default_constraints dc ON dc.object_id = c.default_object_id
        WHERE c.object_id = OBJECT_ID(@full) ORDER BY c.column_id`, params),
      select<{ name: string; type: string; type_desc: string; col: string; is_descending_key: boolean }>(conn, password,
        `SELECT k.name, k.type, i.type_desc, col.name AS col, ic.is_descending_key FROM ${B}.sys.key_constraints k
        JOIN ${B}.sys.indexes i ON i.object_id = k.parent_object_id AND i.index_id = k.unique_index_id
        JOIN ${B}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
        JOIN ${B}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE k.parent_object_id = OBJECT_ID(@full) ORDER BY CASE k.type WHEN 'PK' THEN 0 ELSE 1 END, k.name, ic.key_ordinal`, params),
      select<{ name: string; definition: string }>(conn, password, `SELECT name, definition FROM ${B}.sys.check_constraints WHERE parent_object_id = OBJECT_ID(@full) ORDER BY name`, params),
      select<{ name: string; col: string; ref_schema: string; ref_table: string; ref_col: string; on_delete: string; on_update: string }>(conn, password,
        `SELECT fk.name, pc.name AS col, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_col,
          fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
        FROM ${B}.sys.foreign_keys fk JOIN ${B}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN ${B}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN ${B}.sys.tables rt ON rt.object_id = fk.referenced_object_id JOIN ${B}.sys.schemas rs ON rs.schema_id = rt.schema_id
        JOIN ${B}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE fk.parent_object_id = OBJECT_ID(@full) ORDER BY fk.name, fkc.constraint_column_id`, params),
      select<{ name: string; is_unique: boolean; type_desc: string; filter: string | null; col: string; is_descending_key: boolean; is_included_column: boolean }>(conn, password,
        `SELECT i.name, i.is_unique, i.type_desc, i.filter_definition AS filter, col.name AS col, ic.is_descending_key, ic.is_included_column
        FROM ${B}.sys.indexes i JOIN ${B}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN ${B}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@full) AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.type IN (1, 2)
        ORDER BY i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id`, params),
    ]);
    if (!cols.length) throw new Error(`Table ${obj.schema}.${obj.name} not found`);
    // baris per kolom -> satu entri per constraint / index (urutan dari query)
    const group = <R extends { name: string }, T>(rows: R[], make: (r: R) => T, add: (t: T, r: R) => void) => {
      const out = new Map<string, T>();
      for (const r of rows) {
        if (!out.has(r.name)) out.set(r.name, make(r));
        add(out.get(r.name)!, r);
      }
      return [...out.values()];
    };
    return createTableScript({
      schema: obj.schema, name: obj.name,
      columns: cols.map((c) => ({
        name: c.name, type: fmtType(c.type, c.max_length, c.precision, c.scale), nullable: c.is_nullable,
        ...(c.collation ? { collation: c.collation } : {}),
        ...(c.seed !== null && c.inc !== null ? { identity: { seed: c.seed, increment: c.inc } } : {}),
        ...(c.computed ? { computed: { definition: c.computed, persisted: !!c.is_persisted } } : {}),
        ...(c.df_name && c.df_def ? { default: { name: c.df_name, definition: c.df_def } } : {}),
      })),
      keys: group(keys, (r) => ({ name: r.name, primary: r.type.trim() === 'PK', clustered: r.type_desc === 'CLUSTERED', columns: [] as { name: string; desc: boolean }[] }),
        (k, r) => k.columns.push({ name: r.col, desc: r.is_descending_key })),
      checks,
      foreignKeys: group(fks, (r) => ({ name: r.name, columns: [] as string[], refSchema: r.ref_schema, refTable: r.ref_table, refColumns: [] as string[], onDelete: r.on_delete, onUpdate: r.on_update }),
        (f, r) => { f.columns.push(r.col); f.refColumns.push(r.ref_col); }),
      indexes: group(ixs, (r) => ({ name: r.name, unique: r.is_unique, clustered: r.type_desc === 'CLUSTERED', columns: [] as { name: string; desc: boolean }[], included: [] as string[], ...(r.filter ? { filter: r.filter } : {}) }),
        (ix, r) => (r.is_included_column ? ix.included.push(r.col) : ix.columns.push({ name: r.col, desc: r.is_descending_key }))),
    });
  },

  async definition(conn, password, db, obj) {
    // trigger database (ON DATABASE) tidak punya schema: dicari lewat nama di sys.triggers
    const rows = await select<{ def: string | null }>(conn, password, obj.schema
      ? `SELECT m.definition AS def FROM ${q(db)}.sys.sql_modules m WHERE m.object_id = OBJECT_ID(@full)`
      : `SELECT m.definition AS def FROM ${q(db)}.sys.sql_modules m JOIN ${q(db)}.sys.triggers t ON t.object_id = m.object_id WHERE t.parent_class = 0 AND t.name = @full`,
    { full: obj.schema ? `${q(db)}.${q(obj.schema)}.${q(obj.name)}` : obj.name });
    if (!rows[0]?.def) throw new Error(`The definition of ${obj.schema}.${obj.name} is not available (encrypted, or no VIEW DEFINITION permission)`);
    return rows[0].def;
  },

  async parameters(conn, password, db, obj) {
    const full = `${q(db)}.${q(obj.schema)}.${q(obj.name)}`;
    const rows = await select<{ name: string; type: string; max_length: number; precision: number; scale: number; is_output: boolean; has_default_value: boolean }>(
      conn, password,
      `SELECT p.name, t.name AS type, p.max_length, p.precision, p.scale, p.is_output, p.has_default_value FROM ${q(db)}.sys.parameters p
        JOIN ${q(db)}.sys.types t ON t.user_type_id = p.user_type_id WHERE p.object_id = OBJECT_ID(@full) AND p.parameter_id > 0 ORDER BY p.parameter_id`,
      { full },
    );
    let defaults = new Set<string>();
    if (rows.length) {
      try {
        defaults = paramDefaults(await mssqlDriver.definition!(conn, password, db, obj));
      } catch (e) {
        // definisi terenkripsi / tanpa izin: parameter tetap tampil, default tidak diketahui (diisi NULL)
        driverLog.error(`mssql parameters definition - EXCEPTION CAUGHT | ${errText(e)}`);
      }
    }
    return rows.map((r) => ({ name: r.name, type: fmtType(r.type, r.max_length, r.precision, r.scale), output: r.is_output,
      hasDefault: r.has_default_value || defaults.has(r.name.toLowerCase()) }));
  },

  editScript: async (conn, password, db, obj) => alterScript(await mssqlDriver.definition!(conn, password, db, obj)),

  async runScript(conn, password, db, obj) {
    const [ps, kind] = await Promise.all([mssqlDriver.parameters!(conn, password, db, obj),
      select<{ type: string }>(conn, password, `SELECT RTRIM(type) AS type FROM ${q(db)}.sys.objects WHERE object_id = OBJECT_ID(@full)`, { full: `${q(db)}.${q(obj.schema)}.${q(obj.name)}` })]);
    const type = kind[0]?.type ?? 'P';
    // function: SELECT (scalar FN / FS, table-valued IF / TF / FT), selain itu EXEC procedure
    const sql = /^(FN|FS)$/.test(type) ? fnScript(db, obj, ps, false) : /^(IF|TF|FT)$/.test(type) ? fnScript(db, obj, ps, true) : execScript(db, obj, ps);
    return { sql, params: ps.length };
  },

  async close(name) {
    const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${name}\n`));
    for (const [k] of mine) pools.delete(k);
    // error (mis. pool gagal connect) diteruskan ke pemanggil untuk di-log
    await Promise.all(mine.map(async ([, p]) => (await p).close()));
  },
};

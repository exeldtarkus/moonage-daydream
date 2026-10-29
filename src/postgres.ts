import { Client, Pool, types } from 'pg';
import type { ClientConfig, PoolClient, QueryArrayResult } from 'pg';
import type { ConnectionInfo, ObjectKind } from './db';
import { driverLog } from './log';
import { sqlDriver } from './sqlDriver';
import type { Link, Raw } from './sqlDriver';

/** pool per koneksi + database: PostgreSQL tidak bisa query lintas database dalam satu koneksi */
const pools = new Map<string, Pool>();

/** quote identifier PostgreSQL: "nama"" aneh" */
export const quotePg = (s: string) => `"${s.replace(/"/g, '""')}"`;

const NAMES: Record<number, string> = Object.fromEntries(Object.entries(types.builtins).map(([k, v]) => [v, k.toLowerCase()]));
// date, timestamp, timestamptz, time, timetz sebagai teks apa adanya (tanpa geser zona waktu ke Date JavaScript)
const TEXT_OIDS = new Set([1082, 1114, 1184, 1083, 1266]);
const typeParsers = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    (TEXT_OIDS.has(oid) ? (v: string) => v : types.getTypeParser(oid, format as 'text'))) as typeof types.getTypeParser,
};

const config = (conn: ConnectionInfo, password: string, db?: string): ClientConfig => ({
  host: conn.host, port: conn.port, user: conn.user, password, database: (db ?? conn.database) || 'postgres',
  connectionTimeoutMillis: 15_000, types: typeParsers,
});

function pool(conn: ConnectionInfo, password: string, db?: string): Pool {
  const key = `${conn.name}\n${(db ?? conn.database) || ''}`;
  let p = pools.get(key);
  if (!p) {
    p = new Pool({ ...config(conn, password, db), max: 5 });
    p.on('error', (e) => {
      // koneksi idle putus: pool dibuat ulang di query berikutnya
      driverLog.error(`postgres pool - EXCEPTION CAUGHT | ${conn.name}: ${e.message} - stack-trace: ${e.stack}`);
      pools.delete(key);
    });
    pools.set(key, p);
  }
  return p;
}

/** hasil satu / beberapa statement (simple query protocol) -> Raw */
export function toRaw(res: QueryArrayResult | QueryArrayResult[]): Raw {
  const raw: Raw = { sets: [], affected: [] };
  for (const r of Array.isArray(res) ? res : [res]) {
    if (r.fields?.length) raw.sets.push({ columns: r.fields.map((f) => f.name), types: r.fields.map((f) => NAMES[f.dataTypeID] ?? String(f.dataTypeID)), rows: r.rows });
    else raw.affected.push(r.rowCount ?? 0);
  }
  return raw;
}

function link(c: PoolClient | Client, cancel: (pid: number) => Promise<unknown>, done: () => Promise<void>): Link {
  return {
    async exec(sql, signal) {
      signal?.throwIfAborted();
      let cancelFailed: unknown;
      // cancel = pg_cancel_backend dari koneksi lain: query dihentikan di server
      const onAbort = () => cancel((c as unknown as { processID: number }).processID).catch((e: unknown) => (cancelFailed = e));
      signal?.addEventListener('abort', onAbort);
      try {
        const res = await c.query({ text: sql, rowMode: 'array' }) as unknown as QueryArrayResult | QueryArrayResult[];
        signal?.throwIfAborted();
        return toRaw(res);
      } catch (e) {
        if (cancelFailed && e instanceof Error) e.message += ` (cancel failed: ${cancelFailed instanceof Error ? cancelFailed.message : cancelFailed})`;
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    release: done,
  };
}

async function select<T>(conn: ConnectionInfo, password: string, db: string | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool(conn, password, db).query(sql, params)).rows as T[];
}

const SYSTEM = `NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
const KIND: Record<ObjectKind, string> = {
  table: `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema ${SYSTEM} ORDER BY 1, 2`,
  view: `SELECT table_schema AS schema, table_name AS name FROM information_schema.views WHERE table_schema ${SYSTEM} ORDER BY 1, 2`,
  procedure: `SELECT DISTINCT routine_schema AS schema, routine_name AS name FROM information_schema.routines WHERE routine_schema ${SYSTEM} ORDER BY 1, 2`,
};
const full = (schema: string, name: string) => `${quotePg(schema)}.${quotePg(name)}`;

export const postgresDriver = sqlDriver({
  label: 'PostgreSQL',
  defaultPort: 5432,
  dialect: 'postgres',
  formatter: 'postgresql',
  quote: quotePg,
  defaultSchema: 'public',
  defaultDb: 'postgres',
  testSql: `SELECT COALESCE(inet_server_addr()::text, 'local') AS server, current_database() AS db`,
  // ANALYZE menjalankan query (pemanggil membatasi ke SELECT)
  explain: (s, mode) => (mode === 'estimated' ? `EXPLAIN ${s}` : `EXPLAIN ANALYZE ${s}`),

  async link(conn, password, db) {
    const p = pool(conn, password, db);
    const c = await p.connect();
    return link(c, (pid) => p.query('SELECT pg_cancel_backend($1)', [pid]), async () => c.release());
  },
  async dedicated(conn, password) {
    const c = new Client(config(conn, password));
    await c.connect();
    return link(c, (pid) => pool(conn, password).query('SELECT pg_cancel_backend($1)', [pid]), () => c.end());
  },
  async databases(conn, password) {
    return (await select<{ name: string }>(conn, password, undefined, 'SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1')).map((r) => r.name);
  },
  objects: (conn, password, db, kind) => select(conn, password, db, KIND[kind]),
  columns: (conn, password, db, obj) => select(conn, password, db,
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [full(obj.schema, obj.name)]),
  async primaryKey(conn, password, db, obj) {
    const rows = await select<{ name: string }>(conn, password, db,
      `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [full(obj.schema, obj.name)]);
    return rows.map((r) => r.name);
  },
  selectTop: (_db, obj, n) => `SELECT * FROM ${full(obj.schema, obj.name)} LIMIT ${n};`,
  async close(name) {
    const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${name}\n`));
    for (const [k] of mine) pools.delete(k);
    await Promise.all(mine.map(([, p]) => p.end()));
  },
});

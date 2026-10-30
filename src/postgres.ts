import { Client, Pool, types } from 'pg';
import type { ClientConfig, PoolClient, QueryArrayResult } from 'pg';
import type { ColumnDdl, ConnectionInfo, ListKind, ObjectKind, ProcParam, TypeSpec } from './db';
import { connectMs, typedOptions } from './db';
import { maskSql } from './sqlContext';
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

export const pgConfig = (conn: ConnectionInfo, password: string, db?: string): ClientConfig => ({
  ...typedOptions(conn.options),
  host: conn.host, port: conn.port, user: conn.user, password, database: (db ?? conn.database) || 'postgres',
  connectionTimeoutMillis: connectMs(conn), types: typeParsers,
  ...(conn.ssl ? { ssl: { rejectUnauthorized: !conn.trustServerCertificate } } : {}),
});

function pool(conn: ConnectionInfo, password: string, db?: string): Pool {
  const key = `${conn.name}\n${(db ?? conn.database) || ''}`;
  let p = pools.get(key);
  if (!p) {
    p = new Pool({ ...pgConfig(conn, password, db), max: 5 });
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
    // ReadyForQuery: I = idle, T = dalam transaksi, E = transaksi aborted karena error.
    // Query yang error ditolak saat ErrorResponse, ReadyForQuery (status baru) datang sesudahnya: tunggu dulu (maks ~1 detik)
    async txState() {
      const cl = c as unknown as { readyForQuery: boolean; getTransactionStatus(): string | null };
      for (let i = 0; i < 200 && !cl.readyForQuery; i++) await new Promise((r) => setTimeout(r, 5));
      return ({ T: 'open', E: 'failed' } as const)[cl.getTransactionStatus() ?? ''] ?? 'idle';
    },
  };
}

/** function / procedure bernama ini (overload urut oid): jenis + argumen pg_get_function_arguments */
function routines(conn: ConnectionInfo, password: string, db: string, obj: { schema: string; name: string }) {
  return select<{ kind: 'f' | 'p'; args: string }>(conn, password, db, `SELECT p.prokind AS kind, pg_get_function_arguments(p.oid) AS args FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f', 'p') ORDER BY p.oid`, [obj.schema, obj.name]);
}

// tipe bawaan yang namanya lebih dari satu kata: argumen tanpa nama diawali kata ini
const MULTI_WORD_TYPE = /^(character|double|timestamp|time|bit|interval)$/i;

/** pg_get_function_arguments: "a integer, b text DEFAULT 'x'::text, OUT c integer" -> parameter (mode, nama, tipe, default) */
export function pgArgs(text: string): ProcParam[] {
  const masked = maskSql(text);
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') depth--;
    else if (i === text.length || (masked[i] === ',' && !depth)) {
      if (text.slice(from, i).trim()) parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  return parts.map((part) => {
    const d = /\s+DEFAULT\s+/i.exec(maskSql(part));
    let decl = d ? part.slice(0, d.index) : part;
    const m = /^(IN|OUT|INOUT|VARIADIC)\s+/i.exec(decl);
    const mode = (m?.[1].toLowerCase() ?? 'in') as ProcParam['mode'];
    if (m) decl = decl.slice(m[0].length);
    const first = /^("(?:[^"]|"")+"|\S+)\s+(.+)$/.exec(decl.trim());
    const named = first && !MULTI_WORD_TYPE.test(first[1]);
    return { name: named ? first![1] : '', type: (named ? first![2] : decl).trim(), mode, output: mode === 'out' || mode === 'inout', hasDefault: !!d };
  });
}

/**
 * Run: function = SELECT * FROM f(...) (argumen OUT bukan argumen panggilan), procedure = CALL p(...) (OUT diisi NULL).
 * Nama lengkap: notasi bernama `a => NULL`, argumen ber-default dikomentari; ada argumen tanpa nama: posisi saja.
 */
export function pgRunScript(schema: string, name: string, kind: 'f' | 'p', params: ProcParam[]): string {
  const target = `${full(schema, name)}`;
  const call = kind === 'p' ? 'CALL' : 'SELECT * FROM';
  const ps = params.filter((p) => kind === 'p' || p.mode !== 'out');
  if (!ps.length) return `${call} ${target}();`;
  const named = ps.every((p) => p.name);
  const arg = (p: ProcParam) => `${named ? `${p.name} => ` : ''}NULL -- ${p.mode === 'out' || p.mode === 'inout' ? `${p.mode.toUpperCase()} ` : ''}${p.type}${p.hasDefault ? ' (has default)' : ''}`;
  const active = named ? ps.filter((p) => !p.hasDefault || p.output) : ps;
  const lines = active.map((p, i) => `${i ? '  , ' : '    '}${arg(p)}`);
  if (named) lines.push(...ps.filter((p) => p.hasDefault && !p.output).map((p) => `  -- , ${arg(p)}`));
  return `${call} ${target}(\n${lines.join('\n')}\n);`;
}

/** Edit view: CREATE OR REPLACE VIEW nama AS + pg_get_viewdef */
export function pgViewScript(qualified: string, def: string): string {
  const body = def.trimEnd().replace(/;$/, '');
  return `CREATE OR REPLACE VIEW ${qualified} AS\n${body};`;
}

async function select<T>(conn: ConnectionInfo, password: string, db: string | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool(conn, password, db).query(sql, params)).rows as T[];
}

const SYSTEM = `NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
const KIND: Record<ListKind, string> = {
  table: `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema ${SYSTEM} ORDER BY 1, 2`,
  view: `SELECT table_schema AS schema, table_name AS name FROM information_schema.views WHERE table_schema ${SYSTEM} ORDER BY 1, 2`,
  procedure: `SELECT DISTINCT routine_schema AS schema, routine_name AS name FROM information_schema.routines WHERE routine_schema ${SYSTEM} ORDER BY 1, 2`,
};
const full = (schema: string, name: string) => `${quotePg(schema)}.${quotePg(name)}`;

/** literal string PostgreSQL (standard_conforming_strings: backslash bukan escape) */
const litPg = (s: string) => `'${s.replace(/'/g, "''")}'`;
const PG_MAXLEN = 10485760;

/** tipe data bawaan PostgreSQL 16 (nama pendek seperti hasil Show), urut dropdown editor Columns */
export const PG_TYPES: TypeSpec[] = [
  ...['smallint', 'integer', 'bigint'].map((name) => ({ name, group: 'Numeric' })),
  { name: 'numeric', group: 'Numeric', args: 'precisionScale', max: 1000, def: '10,2' },
  { name: 'real', group: 'Numeric' },
  { name: 'double precision', group: 'Numeric' },
  ...['smallserial', 'serial', 'bigserial'].map((name) => ({ name, group: 'Numeric', note: 'Add only: integer + sequence default' })),
  { name: 'money', group: 'Numeric' },
  { name: 'boolean', group: 'Boolean' },
  { name: 'char', group: 'Text', args: 'length', max: PG_MAXLEN, def: '10' },
  { name: 'varchar', group: 'Text', args: 'length', max: PG_MAXLEN, def: '100', note: 'no length = unlimited' },
  { name: 'text', group: 'Text' },
  { name: 'bytea', group: 'Binary' },
  { name: 'bit', group: 'Binary', args: 'length', max: 83886080, def: '1' },
  { name: 'varbit', group: 'Binary', args: 'length', max: 83886080, def: '8' },
  { name: 'date', group: 'Date and time' },
  ...['time', 'timetz', 'timestamp', 'timestamptz', 'interval'].map((name) => ({ name, group: 'Date and time', args: 'scale' as const, max: 6 })),
  ...['uuid', 'json', 'jsonb', 'xml', 'tsvector', 'tsquery'].map((name) => ({ name, group: 'Other' })),
  ...['inet', 'cidr', 'macaddr', 'macaddr8'].map((name) => ({ name, group: 'Network' })),
  ...['point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle'].map((name) => ({ name, group: 'Geometric' })),
];

export const pgColumnDdl: ColumnDdl = {
  separator: '\n',
  newType: 'varchar(100)',
  note: 'PostgreSQL runs the whole script in one transaction: if a step fails, no change is applied.',
  types: PG_TYPES,
  // format_type -> nama pendek yang ada di dropdown (character varying(50) -> varchar(50), timestamp(3) with time zone -> timestamptz(3))
  show: (o) => `SELECT a.attnum AS ordinal, a.attname AS column_name,
  CASE t.typname WHEN 'varchar' THEN replace(f.ft, 'character varying', 'varchar') WHEN 'bpchar' THEN replace(f.ft, 'character', 'char')
    WHEN 'varbit' THEN replace(f.ft, 'bit varying', 'varbit')
    WHEN 'timestamp' THEN regexp_replace(f.ft, ' without time zone$', '') WHEN 'timestamptz' THEN regexp_replace(f.ft, '^timestamp(.*) with time zone$', 'timestamptz\\1')
    WHEN 'time' THEN regexp_replace(f.ft, ' without time zone$', '') WHEN 'timetz' THEN regexp_replace(f.ft, '^time(.*) with time zone$', 'timetz\\1')
    ELSE f.ft END AS data_type,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
  CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS default_value,
  CASE a.attidentity WHEN 'a' THEN 'ALWAYS' WHEN 'd' THEN 'BY DEFAULT' END AS identity,
  CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated,
  CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) THEN 'PK' ELSE '' END AS primary_key,
  CASE WHEN a.attcollation <> t.typcollation THEN c.collname END AS collation,
  col_description(a.attrelid, a.attnum) AS comment,
  CASE WHEN a.attcollation <> t.typcollation THEN 'COLLATE ' || quote_ident(c.collname) END AS keep
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
CROSS JOIN LATERAL (SELECT format_type(a.atttypid, a.atttypmod) AS ft) f
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation c ON c.oid = a.attcollation
WHERE a.attrelid = to_regclass(${litPg(full(o.schema, o.name))}) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;`,
  add: (o, c) => `ALTER TABLE ${full(o.schema, o.name)} ADD COLUMN ${quotePg(c.name)} ${c.type.trim()} ${c.nullable ? 'NULL' : 'NOT NULL'}${c.default?.trim() ? ` DEFAULT ${c.default.trim()}` : ''};`,
  drop: (o, name) => `ALTER TABLE ${full(o.schema, o.name)} DROP COLUMN ${quotePg(name)};`,
  edit(o, old, next) {
    const tbl = full(o.schema, o.name);
    const col = quotePg(next.name);
    const type = next.type.trim();
    const [was, now] = [old.default?.trim() || '', next.default?.trim() || ''];
    // tanpa COLLATE, ALTER TYPE memakai collation default tipe baru: collation lama dibawa untuk tipe teks
    const collate = old.keep && /^\s*(var)?char|^\s*text\b/i.test(type) ? ` ${old.keep}` : '';
    const alters = [
      ...(type !== old.type ? [`ALTER COLUMN ${col} TYPE ${type}${collate} USING ${col}::${type}`] : []),
      ...(next.nullable !== old.nullable ? [`ALTER COLUMN ${col} ${next.nullable ? 'DROP' : 'SET'} NOT NULL`] : []),
      ...(now !== was ? [now ? `ALTER COLUMN ${col} SET DEFAULT ${now}` : `ALTER COLUMN ${col} DROP DEFAULT`] : []),
    ];
    const steps = [
      ...(next.name !== old.name ? [`ALTER TABLE ${tbl} RENAME COLUMN ${quotePg(old.name)} TO ${col};`] : []),
      ...(alters.length ? [`ALTER TABLE ${tbl} ${alters.join(', ')};`] : []),
    ];
    return steps.length ? steps.join('\n') : `-- no changes to ${quotePg(old.name)}`;
  },
};

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
  columnDdl: pgColumnDdl,

  async link(conn, password, db) {
    const p = pool(conn, password, db);
    const c = await p.connect();
    return link(c, (pid) => p.query('SELECT pg_cancel_backend($1)', [pid]), async () => c.release());
  },
  async dedicated(conn, password) {
    const c = new Client(pgConfig(conn, password));
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

  async definition(conn, password, db, obj, kind) {
    if (kind === 'view') {
      const [r] = await select<{ def: string | null }>(conn, password, db, 'SELECT pg_get_viewdef(to_regclass($1), true) AS def', [full(obj.schema, obj.name)]);
      if (!r?.def) throw new Error(`View ${obj.schema}.${obj.name} not found`);
      return pgViewScript(full(obj.schema, obj.name), r.def);
    }
    // overload (nama sama, argumen beda): semua definisi, masing-masing satu statement
    const rows = await select<{ def: string }>(conn, password, db, `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f', 'p') ORDER BY p.oid`, [obj.schema, obj.name]);
    if (!rows.length) throw new Error(`Function / procedure ${obj.schema}.${obj.name} not found (aggregates and window functions are not supported)`);
    return rows.map((r) => `${r.def.trimEnd().replace(/;$/, '')};`).join('\n\n');
  },
  async parameters(conn, password, db, obj) {
    const [r] = await routines(conn, password, db, obj);
    return r ? pgArgs(r.args) : [];
  },
  // pg_get_functiondef / pgViewScript sudah CREATE OR REPLACE
  editScript: (conn, password, db, obj, kind) => postgresDriver.definition!(conn, password, db, obj, kind),
  async runScript(conn, password, db, obj) {
    const rs = await routines(conn, password, db, obj);
    if (!rs.length) throw new Error(`Function / procedure ${obj.schema}.${obj.name} not found`);
    const scripts = rs.map((r) => pgRunScript(obj.schema, obj.name, r.kind, pgArgs(r.args)));
    return { sql: (rs.length > 1 ? `-- ${rs.length} overloads: run the one you need\n` : '') + scripts.join('\n\n'),
      params: rs.length > 1 ? rs.length : pgArgs(rs[0].args).length };
  },
  isOpen: (name) => [...pools.keys()].some((k) => k.startsWith(`${name}\n`)),
  async close(name) {
    const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${name}\n`));
    for (const [k] of mine) pools.delete(k);
    await Promise.all(mine.map(([, p]) => p.end()));
  },
});

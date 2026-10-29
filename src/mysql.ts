import * as mysql from 'mysql2/promise';
import { Types } from 'mysql2';
import type { ConnectionInfo, Driver, ObjectKind } from './db';
import { sqlDriver } from './sqlDriver';
import type { Link, Raw } from './sqlDriver';

/** pool per koneksi + database (database bisa beda per file .sql) */
const pools = new Map<string, mysql.Pool>();

/** quote identifier MySQL: `nama`` aneh` */
export const quoteMy = (s: string) => `\`${s.replace(/`/g, '``')}\``;

const config = (conn: ConnectionInfo, password: string, db?: string): mysql.ConnectionOptions => ({
  host: conn.host, port: conn.port, user: conn.user, password, database: (db ?? conn.database) || undefined, connectTimeout: 15_000,
  // beberapa statement sekaligus (seperti batch SQL Server); tanggal sebagai teks apa adanya (tanpa geser zona waktu); BIGINT / DECIMAL tanpa pembulatan
  multipleStatements: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
});

function pool(conn: ConnectionInfo, password: string, db?: string): mysql.Pool {
  const key = `${conn.name}\n${(db ?? conn.database) || ''}`;
  let p = pools.get(key);
  if (!p) {
    p = mysql.createPool({ ...config(conn, password, db), connectionLimit: 5 });
    pools.set(key, p);
  }
  return p;
}

const TYPE: Record<string, string> = {
  DECIMAL: 'decimal', NEWDECIMAL: 'decimal', TINY: 'tinyint', SHORT: 'smallint', LONG: 'int', INT24: 'mediumint', LONGLONG: 'bigint',
  FLOAT: 'float', DOUBLE: 'double', VARCHAR: 'varchar', VAR_STRING: 'varchar', STRING: 'char', NEWDATE: 'date',
};
const BLOB = /BLOB$/;

/** nama tipe kolom dari field packet (kode protokol -> nama SQL); charset 63 = binary */
export function typeName(f: { columnType?: number; type?: number; characterSet?: number }): string {
  const n = String((Types as unknown as Record<number, string>)[f.columnType ?? f.type ?? -1] ?? '');
  if (BLOB.test(n)) return f.characterSet === 63 ? 'blob' : 'text';
  return TYPE[n] ?? n.toLowerCase();
}

type Fields = (mysql.FieldPacket[] | undefined)[];

/** hasil query multipleStatements -> Raw: fields berupa array per statement bila lebih dari satu statement */
export function toRaw(res: unknown, fields: unknown): Raw {
  const multi = Array.isArray(fields) && fields.some((f) => f === undefined || Array.isArray(f));
  const results = multi ? (res as unknown[]) : [res];
  const fieldList = (multi ? fields : [fields]) as Fields;
  const raw: Raw = { sets: [], affected: [] };
  results.forEach((r, i) => {
    const f = fieldList[i];
    if (f) raw.sets.push({ columns: f.map((x) => x.name), types: f.map(typeName), rows: r as unknown[][] });
    else raw.affected.push((r as mysql.ResultSetHeader | undefined)?.affectedRows ?? 0);
  });
  return raw;
}

function link(c: mysql.PoolConnection | mysql.Connection, killer: mysql.Pool | (() => Promise<mysql.Connection>), done: () => Promise<void>): Link {
  return {
    async exec(sql, signal) {
      signal?.throwIfAborted();
      let killFailed: unknown;
      // cancel = KILL QUERY dari koneksi lain: query dihentikan di server, koneksi ini tetap hidup
      const kill = async () => {
        try {
          if (typeof killer === 'function') {
            const k = await killer();
            try {
              await k.query(`KILL QUERY ${c.threadId}`);
            } finally {
              await k.end();
            }
          } else await killer.query(`KILL QUERY ${c.threadId}`);
        } catch (e) {
          killFailed = e; // dilaporkan bersama hasil query (pemanggil yang mencatat log)
        }
      };
      signal?.addEventListener('abort', kill);
      try {
        const [res, fields] = await c.query({ sql, rowsAsArray: true });
        signal?.throwIfAborted(); // KILL QUERY pada SLEEP() dsb. tidak selalu error: tetap dilaporkan sebagai dibatalkan
        return toRaw(res, fields);
      } catch (e) {
        if (killFailed && e instanceof Error) e.message += ` (cancel failed: ${killFailed instanceof Error ? killFailed.message : killFailed})`;
        throw e;
      } finally {
        signal?.removeEventListener('abort', kill);
      }
    },
    release: done,
  };
}

/** query katalog (baris objek, parameter ?) */
async function select<T>(conn: ConnectionInfo, password: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool(conn, password).query(sql, params);
  return rows as T[];
}

const KIND: Record<ObjectKind, string> = {
  table: `SELECT table_schema AS \`schema\`, table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
  view: `SELECT table_schema AS \`schema\`, table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'VIEW' ORDER BY table_name`,
  procedure: `SELECT routine_schema AS \`schema\`, routine_name AS name FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name`,
};

function make(label: string, formatter: 'mysql' | 'mariadb', analyze: (s: string) => string): Driver {
  return sqlDriver({
    label,
    defaultPort: 3306,
    dialect: 'mysql',
    formatter,
    quote: quoteMy,
    defaultSchema: '', // MySQL: schema = database
    defaultDb: 'mysql',
    testSql: 'SELECT @@hostname AS server, DATABASE() AS db',
    explain: (s, mode) => (mode === 'estimated' ? `EXPLAIN ${s}` : analyze(s)),

    async link(conn, password, db) {
      const p = pool(conn, password, db);
      const c = await p.getConnection();
      return link(c, p, async () => c.release());
    },
    async dedicated(conn, password) {
      const open = () => mysql.createConnection(config(conn, password));
      const c = await open();
      return link(c, open, () => c.end());
    },
    async databases(conn, password) {
      return (await select<{ name: string }>(conn, password, 'SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name')).map((r) => r.name);
    },
    objects: (conn, password, db, kind) => select(conn, password, KIND[kind], [db]),
    async columns(conn, password, db, obj) {
      const rows = await select<{ name: string; type: string; nullable: string }>(conn, password,
        'SELECT column_name AS name, column_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
        [db, obj.name]);
      return rows.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable === 'YES' }));
    },
    async primaryKey(conn, password, db, obj) {
      const rows = await select<{ name: string }>(conn, password,
        `SELECT column_name AS name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position`,
        [db, obj.name]);
      return rows.map((r) => r.name);
    },
    selectTop: (db, obj, n) => `SELECT * FROM ${quoteMy(db)}.${quoteMy(obj.name)} LIMIT ${n};`,
    async close(name) {
      const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${name}\n`));
      for (const [k] of mine) pools.delete(k);
      await Promise.all(mine.map(([, p]) => p.end()));
    },
  });
}

// MySQL 8.0.18+: EXPLAIN ANALYZE; MariaDB: ANALYZE <statement>
export const mysqlDriver = make('MySQL', 'mysql', (s) => `EXPLAIN ANALYZE ${s}`);
export const mariadbDriver = make('MariaDB', 'mariadb', (s) => `ANALYZE ${s}`);

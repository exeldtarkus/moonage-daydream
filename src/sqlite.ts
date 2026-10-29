import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { Database, SqlJsStatic } from 'sql.js';
import type { ConnectionInfo, ObjectKind } from './db';
import { maskSql, splitStatements } from './sqlContext';
import { sqlDriver } from './sqlDriver';
import type { Link } from './sqlDriver';

// wasm ter-embed di file JS: tidak ada file .wasm yang perlu dicari saat runtime / ikut di VSIX
// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js/dist/sql-wasm-inline.js') as () => Promise<SqlJsStatic>;
let engine: Promise<SqlJsStatic> | undefined;

/** quote identifier SQLite: "nama"" aneh" */
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** statement yang tidak mengubah file (file tidak perlu ditulis ulang) */
const READ_ONLY = /^\s*(select|with|pragma|explain|values)\b/i;
export const writes = (sql: string) => !splitStatements(sql).every((s) => READ_ONLY.test(maskSql(s)));

async function open(conn: ConnectionInfo): Promise<Database> {
  const file = conn.file;
  if (!file) throw new Error('SQLite connection has no database file');
  if (!existsSync(file)) throw new Error(`SQLite file not found: ${file}`);
  const SQL = await (engine ??= initSqlJs());
  return new SQL.Database(readFileSync(file));
}

/** tulis isi database ke file lewat file sementara + rename (file tidak pernah setengah tertulis) */
function save(conn: ConnectionInfo, db: Database) {
  const tmp = `${conn.file}.moonage-tmp`;
  writeFileSync(tmp, db.export());
  renameSync(tmp, conn.file!);
}

/**
 * sql.js: database dimuat ke memori dari file, perubahan ditulis balik ke file setelah query selesai (atau saat COMMIT).
 * shortcut: query berjalan sinkron di extension host (tidak bisa di-cancel di tengah jalan) dan file dibaca utuh per query;
 * cocok untuk file kecil / menengah. Perubahan dari aplikasi lain di antara baca dan tulis bisa tertimpa. Ganti ke node:sqlite bila tersedia di VS Code.
 */
function link(conn: ConnectionInfo, db: Database, session: boolean): Link {
  return {
    async exec(sql, signal) {
      signal?.throwIfAborted();
      const changes = writes(sql);
      try {
        const sets = db.exec(sql).map((r) => ({ columns: r.columns, types: r.columns.map(() => ''), rows: r.values as unknown[][] }));
        return { sets, affected: changes ? [db.getRowsModified()] : [] };
      } finally {
        // di luar sesi: statement yang sudah berhasil tetap tersimpan walau statement berikutnya gagal (sama seperti autocommit SQLite)
        if (session ? /^\s*commit\b/i.test(sql) : changes) save(conn, db);
      }
    },
    async release() {
      db.close();
    },
  };
}

const KIND: Record<ObjectKind, string> = {
  table: `SELECT 'main' AS schema, name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  view: `SELECT 'main' AS schema, name FROM sqlite_master WHERE type = 'view' ORDER BY name`,
  procedure: '',
};

async function select<T>(conn: ConnectionInfo, sql: string): Promise<T[]> {
  const db = await open(conn);
  try {
    const [r] = db.exec(sql);
    return (r?.values ?? []).map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])) as T);
  } finally {
    db.close();
  }
}

export const sqliteDriver = sqlDriver({
  label: 'SQLite',
  defaultPort: 0,
  dialect: 'sqlite',
  formatter: 'sqlite',
  quote,
  defaultSchema: 'main',
  defaultDb: 'main',
  testSql: `SELECT 'SQLite ' || sqlite_version() AS server, 'main' AS db`,
  explain: (s, mode) => (mode === 'estimated' ? `EXPLAIN QUERY PLAN ${s}` : undefined),

  link: async (conn) => link(conn, await open(conn), false),
  dedicated: async (conn) => link(conn, await open(conn), true),
  databases: async () => ['main'],
  objects: async (conn, _pw, _db, kind) => (KIND[kind] ? select(conn, KIND[kind]) : []),
  async columns(conn, _pw, _db, obj) {
    const rows = await select<{ name: string; type: string; notnull: number }>(conn, `PRAGMA table_info(${quote(obj.name)})`);
    return rows.map((r) => ({ name: r.name, type: r.type.toLowerCase(), nullable: !r.notnull }));
  },
  async primaryKey(conn, _pw, _db, obj) {
    const rows = await select<{ name: string; pk: number }>(conn, `PRAGMA table_info(${quote(obj.name)})`);
    return rows.filter((r) => r.pk > 0).sort((a, b) => a.pk - b.pk).map((r) => r.name);
  },
  selectTop: (_db, obj, n) => `SELECT * FROM ${quote(obj.name)} LIMIT ${n};`,
  close: async () => undefined, // tidak ada koneksi yang di-cache
});

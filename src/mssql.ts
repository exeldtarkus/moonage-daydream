import * as sql from 'mssql';
import { MAX_ROWS } from './db';
import type { ConnectionInfo, Driver, ObjectKind, QueryResult, ResultSet } from './db';

/** pool per koneksi + database (database bisa beda per file .sql) */
const pools = new Map<string, Promise<sql.ConnectionPool>>();
const poolKey = (conn: ConnectionInfo) => `${conn.name}\n${conn.database}`;

function pool(conn: ConnectionInfo, password: string): Promise<sql.ConnectionPool> {
  const key = poolKey(conn);
  let p = pools.get(key);
  if (!p) {
    p = new sql.ConnectionPool({
      server: conn.host,
      port: conn.instance ? undefined : conn.port, // tedious: port dan instanceName tidak boleh bersamaan
      user: conn.user,
      password,
      database: conn.database || undefined,
      options: { encrypt: true, trustServerCertificate: conn.trustServerCertificate, instanceName: conn.instance || undefined },
    }).connect();
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

const CATALOG: Record<ObjectKind, string> = { table: 'tables', view: 'views', procedure: 'procedures' };

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

export const mssqlDriver: Driver = {
  label: 'SQL Server',
  defaultPort: 1433,

  async run(conn, password, text, signal, limit) {
    const p = await pool(conn, password);
    const out: QueryResult = { resultSets: [], rowsAffected: [], messages: [], durationMs: 0 };
    const start = Date.now();
    for (const batch of splitBatches(text)) {
      signal?.throwIfAborted(); // batch GO berikutnya tidak dijalankan
      const req = p.request();
      req.arrayRowMode = true;
      req.stream = true; // baris dibaca per event: hanya MAX_ROWS yang disimpan
      req.on('info', (i: { message: string }) => out.messages.push(i.message)); // PRINT / RAISERROR level rendah
      const cancel = () => req.cancel(); // kirim attention ke server: query dihentikan di server, bukan hanya di client
      signal?.addEventListener('abort', cancel);
      const r = await new Promise<sql.IResult<unknown>>((resolve, reject) => {
        let err: unknown;
        let cur: ResultSet | undefined;
        let limited = false;
        req.on('recordset', (cols: { name: string; type?: { declaration?: string } }[]) => out.resultSets.push(cur = {
          columns: cols.map((c) => c.name), types: cols.map((c) => c.type?.declaration ?? ''), rows: [], total: 0,
        }));
        req.on('row', (row: unknown[]) => {
          if (!cur || limited) return;
          cur.total++;
          if (cur.rows.length < MAX_ROWS) cur.rows.push(row);
          if (limit && cur.total >= limit) {
            limited = true; // auto limit: cukup, hentikan query di server; error "Canceled" berikutnya bukan kegagalan
            cur.limited = limit;
            req.cancel();
          }
        });
        req.on('error', (e: unknown) => (err ??= e)); // mode stream: error lewat event, yang pertama yang dilaporkan
        req.query(batch, (_e, result) => (err && !(limited && !signal?.aborted) ? reject(err) : resolve(result ?? ({ rowsAffected: [] } as unknown as sql.IResult<unknown>))));
      }).finally(() => signal?.removeEventListener('abort', cancel));
      out.rowsAffected.push(...r.rowsAffected);
    }
    out.durationMs = Date.now() - start;
    return out;
  },

  async stream(conn, password, text, signal, sink) {
    const p = await pool(conn, password);
    const req = p.request();
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
  },
  async databases(conn, password) {
    const rows = await select<{ name: string }>(conn, password, 'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name');
    return rows.map((r) => r.name);
  },

  objects(conn, password, db, kind) {
    return select(conn, password, `SELECT s.name AS [schema], o.name FROM ${q(db)}.sys.${CATALOG[kind]} o
      JOIN ${q(db)}.sys.schemas s ON s.schema_id = o.schema_id WHERE o.is_ms_shipped = 0 ORDER BY s.name, o.name`);
  },

  async columns(conn, password, db, obj) {
    const rows = await select<{ name: string; type: string; max_length: number; precision: number; scale: number; is_nullable: boolean }>(
      conn, password,
      `SELECT c.name, t.name AS type, c.max_length, c.precision, c.scale, c.is_nullable FROM ${q(db)}.sys.columns c
        JOIN ${q(db)}.sys.types t ON t.user_type_id = c.user_type_id WHERE c.object_id = OBJECT_ID(@full) ORDER BY c.column_id`,
      { full: `${q(db)}.${q(obj.schema)}.${q(obj.name)}` },
    );
    return rows.map((r) => ({ name: r.name, type: fmtType(r.type, r.max_length, r.precision, r.scale), nullable: r.is_nullable }));
  },

  selectTop(db, obj, n) {
    return `SELECT TOP ${n} * FROM ${q(db)}.${q(obj.schema)}.${q(obj.name)};`;
  },

  async close(name) {
    const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${name}\n`));
    for (const [k] of mine) pools.delete(k);
    // error (mis. pool gagal connect) diteruskan ke pemanggil untuk di-log
    await Promise.all(mine.map(async ([, p]) => (await p).close()));
  },
};

import { MAX_ROWS } from './db';
import type { ConnectionInfo, Driver, QueryResult, Session } from './db';
import { addLimit } from './sqlContext';

/** hasil mentah dari server: satu entri per statement yang mengembalikan baris */
export interface Raw {
  sets: { columns: string[]; types: string[]; rows: unknown[][] }[];
  affected: number[];
}

/** satu koneksi: semua statement dikirim sekaligus; signal abort = cancel di server */
export interface Link {
  exec(sql: string, signal?: AbortSignal): Promise<Raw>;
  release(): Promise<void>;
}

/** bagian driver yang beda per DB; run / session / stream dibuat sqlDriver() di atas Link */
export type Base = Omit<Driver, 'run' | 'session' | 'stream' | 'plan'> & {
  /** koneksi dari pool (db kosong = database koneksi) */
  link(conn: ConnectionInfo, password: string, db?: string): Promise<Link>;
  /** koneksi khusus transaksi manual */
  dedicated(conn: ConnectionInfo, password: string): Promise<Link>;
};

/**
 * hasil mentah -> QueryResult dengan aturan yang sama seperti mssql: MAX_ROWS baris disimpan, skip = baris halaman sebelumnya,
 * limited = berhenti di limit. server = LIMIT / OFFSET sudah dipasang di SQL (baris pertama hasil = baris ke skip+1).
 */
export function toResult(raw: Raw, start: number, limit?: number, skip = 0, server = false): QueryResult {
  return {
    resultSets: raw.sets.map((s) => {
      const all = server ? s.rows : s.rows.slice(skip, limit);
      const total = server ? skip + s.rows.length : limit ? Math.min(s.rows.length, limit) : s.rows.length;
      return { columns: s.columns, types: s.types, rows: all.slice(0, MAX_ROWS), total, ...(limit && total >= limit ? { limited: limit } : {}) };
    }),
    rowsAffected: raw.affected, messages: [], durationMs: Date.now() - start,
  };
}

async function exec(link: Link, sql: string, signal?: AbortSignal, limit?: number, skip = 0): Promise<QueryResult> {
  signal?.throwIfAborted();
  const start = Date.now();
  // limit hanya dipakai untuk satu SELECT (autoLimitable / Load more); statement dengan LIMIT sendiri dipotong di client
  const limited = limit ? addLimit(sql, limit, skip) : undefined;
  return toResult(await link.exec(limited ?? sql, signal), start, limit, skip, !!limited);
}

/** Driver lengkap untuk DB SQL selain SQL Server (MySQL / MariaDB, PostgreSQL, SQLite) */
export function sqlDriver(base: Base): Driver {
  const pooled = async <T>(conn: ConnectionInfo, password: string, f: (l: Link) => Promise<T>) => {
    const l = await base.link(conn, password);
    try {
      return await f(l);
    } finally {
      await l.release();
    }
  };
  return {
    ...base,
    run: (conn, password, sql, signal, limit, skip) => pooled(conn, password, (l) => exec(l, sql, signal, limit, skip)),

    async session(conn, password) {
      const l = await base.dedicated(conn, password);
      let open = false;
      const end = async (how: 'COMMIT' | 'ROLLBACK') => {
        if (!open) return;
        open = false;
        await l.exec(how);
      };
      const s: Session = {
        get open() { return open; },
        async run(sql, signal, limit) {
          if (!open) {
            await l.exec('BEGIN');
            open = true;
          }
          return exec(l, sql, signal, limit);
        },
        commit: () => end('COMMIT'),
        rollback: () => end('ROLLBACK'),
        async close() {
          try {
            await end('ROLLBACK');
          } finally {
            await l.release();
          }
        },
      };
      return s;
    },

    // shortcut: semua baris result set pertama dimuat ke memori dulu lalu diteruskan ke sink; ganti ke cursor / stream driver bila export jutaan baris
    stream: (conn, password, sql, signal, sink) => pooled(conn, password, async (l) => {
      const set = (await l.exec(sql, signal)).sets[0];
      if (!set) return 0;
      await sink.columns(set.columns);
      for (const row of set.rows) {
        signal?.throwIfAborted();
        await sink.row(row);
      }
      return set.rows.length;
    }),
  };
}

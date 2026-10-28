import { mssqlDriver } from './mssql';

export type DbType = 'mssql';

export interface ConnectionInfo {
  name: string;
  type: DbType;
  host: string;
  port: number;
  /** mssql named instance (mis. SQLEXPRESS); bila diisi, port dicari lewat SQL Server Browser (UDP 1434) dan `port` diabaikan */
  instance?: string;
  user: string;
  database: string;
  /** mssql: encrypt + trustServerCertificate (untuk server lokal / sertifikat self-signed) */
  trustServerCertificate: boolean;
}

// shortcut: hanya MAX_ROWS baris pertama per result set yang disimpan & ditampilkan (sisanya dihitung saja) supaya memori kecil
// dan cancel tetap responsif di tabel besar; ganti ke paging / virtual scroll bila perlu melihat semua baris
export const MAX_ROWS = 1000;

export interface ResultSet {
  columns: string[];
  /** tipe kolom dari driver (mis. int, nvarchar); kosong bila tidak diketahui */
  types?: string[];
  /** maksimal MAX_ROWS baris pertama */
  rows: unknown[][];
  /** jumlah baris sebenarnya (berhenti di limit bila auto limit berlaku) */
  total: number;
  /** auto limit: query dihentikan di server setelah sekian baris */
  limited?: number;
}

export interface QueryResult {
  resultSets: ResultSet[];
  rowsAffected: number[];
  messages: string[];
  durationMs: number;
}

export type ObjectKind = 'table' | 'view' | 'procedure';

export interface DbObject {
  schema: string;
  name: string;
}

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

/** sesi transaksi manual (satu koneksi) */
export interface Session {
  /** jalankan di dalam transaksi (BEGIN TRAN otomatis bila belum terbuka) */
  run(sql: string, signal?: AbortSignal, limit?: number): Promise<QueryResult>;
  /** transaksi sedang terbuka */
  readonly open: boolean;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface Driver {
  label: string;
  defaultPort: number;
  /** `signal` abort = cancel query di server */
  /** limit: ambil sekian baris pertama lalu hentikan query di server (hanya untuk satu SELECT, lihat autoLimitable) */
  run(conn: ConnectionInfo, password: string, sql: string, signal?: AbortSignal, limit?: number): Promise<QueryResult>;
  /**
   * transaksi manual: satu koneksi khusus; transaksi dibuka otomatis saat run pertama dan tetap terbuka sampai commit / rollback.
   */
  session(conn: ConnectionInfo, password: string): Promise<Session>;
  /**
   * execution plan: estimated = query tidak dijalankan; actual = query dijalankan (pemanggil membatasi ke SELECT).
   * Dijalankan dalam transaksi yang selalu di-rollback. xml = satu plan XML per batch / statement.
   */
  plan(conn: ConnectionInfo, password: string, sql: string, mode: 'estimated' | 'actual', signal?: AbortSignal): Promise<{ xml: string[]; result: QueryResult }>;
  /**
   * export All Data: semua baris result set pertama diteruskan ke sink tanpa limit / MAX_ROWS.
   * row() boleh mengembalikan Promise: query di-pause sampai selesai (backpressure file). Mengembalikan jumlah baris.
   */
  stream(conn: ConnectionInfo, password: string, sql: string, signal: AbortSignal | undefined,
    sink: { columns(cols: string[]): Promise<void> | void; row(values: unknown[]): Promise<void> | void }): Promise<number>;
  /** explorer (read-only, query ke katalog) */
  databases(conn: ConnectionInfo, password: string): Promise<string[]>;
  objects(conn: ConnectionInfo, password: string, db: string, kind: ObjectKind): Promise<DbObject[]>;
  columns(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<Column[]>;
  /** query "SELECT TOP n" untuk tabel/view, sesuai dialek */
  selectTop(db: string, obj: DbObject, n: number): string;
  /** tutup koneksi/pool yang di-cache untuk nama koneksi ini */
  close(name: string): Promise<void>;
}

// tambah DB lain: buat file driver baru lalu daftarkan di sini (+ tambah ke DbType)
export const drivers: Record<DbType, Driver> = {
  mssql: mssqlDriver,
};

/** alamat untuk ditampilkan: host\instance atau host:port */
export const address = (c: ConnectionInfo) => (c.instance ? `${c.host}\\${c.instance}` : `${c.host}:${c.port}`);

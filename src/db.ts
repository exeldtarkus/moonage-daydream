import { mssqlDriver } from './mssql';
import { mariadbDriver, mysqlDriver } from './mysql';
import { mongoDriver } from './mongo';
import { postgresDriver } from './postgres';
import { sqliteDriver } from './sqlite';

export type DbType = 'mssql' | 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mongodb';
/** dialek untuk literal / script UPDATE */
export type Dialect = 'mssql' | 'mysql' | 'postgres' | 'sqlite' | 'mongodb';

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
  /** mssql: 'windows' = Windows authentication lewat NTLM (domain + user + password); default SQL Server login */
  auth?: 'sql' | 'windows';
  domain?: string;
  /** sqlite: path file database (host / port / user tidak dipakai) */
  file?: string;
  /** mongodb: database tempat user dibuat (mis. admin) */
  authSource?: string;
  /** folder di view Connections (mis. prod, non-prod); kosong = di level atas */
  group?: string;
  /** warna koneksi: ikon di Connections + label & garis di editor (lihat connColor.ts) */
  color?: import('./connColor').ConnColor;
}

// shortcut: hanya MAX_ROWS baris pertama per result set yang disimpan & ditampilkan (sisanya dihitung saja) supaya memori kecil
// dan cancel tetap responsif di tabel besar; ganti ke paging / virtual scroll bila perlu melihat semua baris
export const MAX_ROWS = 1000;
/** Load more: baris per halaman dan batas total baris di grid */
export const PAGE_ROWS = 1000;
export const GRID_MAX_ROWS = 50_000;

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

/** penerima baris export All Data; row() boleh mengembalikan Promise (backpressure) */
export interface Sink { columns(cols: string[]): Promise<void> | void; row(values: unknown[]): Promise<void> | void }

/** sesi transaksi manual (satu koneksi) */
export interface Session {
  /** jalankan di dalam transaksi (BEGIN TRAN otomatis bila belum terbuka); limit / skip seperti Driver.run */
  run(sql: string, signal?: AbortSignal, limit?: number, skip?: number): Promise<QueryResult>;
  /** export All Data di koneksi sesi: ikut melihat perubahan yang belum di-commit, tidak tertahan lock transaksi sendiri */
  stream(sql: string, signal: AbortSignal | undefined, sink: Sink): Promise<number>;
  /** transaksi sedang terbuka */
  readonly open: boolean;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface Driver {
  label: string;
  defaultPort: number;
  dialect: Dialect;
  /** bahasa sql-formatter; kosong = tidak bisa di-format (MongoDB) */
  formatter?: 'transactsql' | 'mysql' | 'mariadb' | 'postgresql' | 'sqlite';
  /** quote identifier: [x] / `x` / "x" */
  quote(name: string): string;
  /** schema bila tidak ditulis: dbo / public / main; '' = schema sama dengan database (MySQL) */
  defaultSchema: string;
  /** database bila koneksi tidak menyebut database */
  defaultDb: string;
  /** Test connection: satu baris (server, database) */
  testSql: string;
  /** false = tidak ada transaksi manual (lens Auto-commit / Manual disembunyikan) */
  transactions?: false;
  /** auto limit boleh untuk statement ini; default aturan SQL (autoLimitable) */
  autoLimitable?(stmts: string[]): boolean;
  /** `signal` abort = cancel query di server */
  /** skip: baris pertama sebanyak ini dilewati (Load more); limit: ambil sekian baris pertama lalu hentikan query di server (hanya untuk satu SELECT, lihat autoLimitable) */
  run(conn: ConnectionInfo, password: string, sql: string, signal?: AbortSignal, limit?: number, skip?: number): Promise<QueryResult>;
  /**
   * transaksi manual: satu koneksi khusus; transaksi dibuka otomatis saat run pertama dan tetap terbuka sampai commit / rollback.
   */
  session(conn: ConnectionInfo, password: string): Promise<Session>;
  /**
   * execution plan: estimated = query tidak dijalankan; actual = query dijalankan (pemanggil membatasi ke SELECT).
   * Dijalankan dalam transaksi yang selalu di-rollback. xml = satu plan XML per batch / statement.
   */
  plan?(conn: ConnectionInfo, password: string, sql: string, mode: 'estimated' | 'actual', signal?: AbortSignal): Promise<{ xml: string[]; result: QueryResult }>;
  /** tanpa plan(): Explain / Analyze = statement EXPLAIN biasa (hasilnya grid); undefined = mode tidak didukung */
  explain?(sql: string, mode: 'estimated' | 'actual'): string | undefined;
  /**
   * export All Data: semua baris result set pertama diteruskan ke sink tanpa limit / MAX_ROWS.
   * row() boleh mengembalikan Promise: query di-pause sampai selesai (backpressure file). Mengembalikan jumlah baris.
   */
  stream(conn: ConnectionInfo, password: string, sql: string, signal: AbortSignal | undefined, sink: Sink): Promise<number>;
  /** explorer (read-only, query ke katalog) */
  databases(conn: ConnectionInfo, password: string): Promise<string[]>;
  objects(conn: ConnectionInfo, password: string, db: string, kind: ObjectKind): Promise<DbObject[]>;
  columns(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<Column[]>;
  /** query "SELECT TOP n" untuk tabel/view, sesuai dialek */
  selectTop(db: string, obj: DbObject, n: number): string;
  /** kolom primary key (urut key) tabel db.schema.name; kosong bila tidak ada PK */
  primaryKey(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<string[]>;
  /** tutup koneksi/pool yang di-cache untuk nama koneksi ini */
  close(name: string): Promise<void>;
}

// tambah DB lain: buat file driver baru lalu daftarkan di sini (+ tambah ke DbType)
export const drivers: Record<DbType, Driver> = {
  mssql: mssqlDriver,
  mysql: mysqlDriver,
  mariadb: mariadbDriver,
  postgres: postgresDriver,
  sqlite: sqliteDriver,
  mongodb: mongoDriver,
};

/**
 * sesi transaksi file yang masih terbuka di koneksi / database c, untuk baca ulang (Load more / Export All Data):
 * ikut melihat perubahan yang belum di-commit dan tidak tertahan lock transaksi sendiri. undefined = pakai pool biasa.
 * busy = query file itu masih berjalan di sesi yang sama.
 */
export function openSession(tx: { session: Session; conn: string; db: string } | undefined, c: ConnectionInfo, busy: boolean): Session | undefined {
  if (!tx?.session.open || tx.conn !== c.name || tx.db !== c.database) return undefined;
  if (busy) throw new Error('A query is still running in this transaction; wait or cancel it first.');
  return tx.session;
}

/** alamat untuk ditampilkan: host\instance atau host:port */
export const address = (c: ConnectionInfo) => (c.type === 'sqlite' ? c.file ?? '' : c.instance ? `${c.host}\\${c.instance}` : `${c.host}:${c.port}`);

/** schema objek yang tidak ditulis di SQL */
export const schemaOf = (c: ConnectionInfo, db: string) => drivers[c.type].defaultSchema || db;

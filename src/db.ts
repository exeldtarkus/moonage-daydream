import { mssqlDriver } from './mssql';
import { mariadbDriver, mysqlDriver } from './mysql';
import { mongoDriver } from './mongo';
import { consulDriver } from './consul';
import { postgresDriver } from './postgres';
import { sqliteDriver } from './sqlite';

export type DbType = 'mssql' | 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'mongodb' | 'consul';
/** dialek untuk literal / script UPDATE */
export type Dialect = 'mssql' | 'mysql' | 'postgres' | 'sqlite' | 'mongodb' | 'consul';

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
  /** SSL / TLS (mssql: encrypt); undefined = default driver (mssql aktif, lainnya mati) */
  ssl?: boolean;
  /** batas waktu connect dalam detik; undefined = default driver (15) */
  connectTimeout?: number;
  /** hanya statement read-only (SELECT) yang boleh dijalankan di koneksi ini */
  readOnly?: boolean;
  /** Driver settings: opsi tambahan yang diteruskan ke driver (key / value) */
  options?: Record<string, string>;
  /** konfirmasi sebelum statement pengubah data di Auto-commit; undefined = ikut group (default aktif) */
  confirmAutoCommit?: boolean;
}

/** pengaturan per group di Connections */
export type GroupSettings = Record<string, { confirmAutoCommit?: boolean }>;
/** konfirmasi Auto-commit aktif? koneksi -> group -> default aktif */
export const confirmAutoCommit = (c: ConnectionInfo, groups: GroupSettings) =>
  c.confirmAutoCommit ?? (c.group ? groups[c.group]?.confirmAutoCommit : undefined) ?? true;

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
  /** jumlah baris tiap statement non-SELECT (urut) */
  rowsAffected: number[];
  /** statement asal tiap rowsAffected (n = nomor statement di teks yang dijalankan); undefined = tidak bisa dipastikan */
  affected?: ({ n: number; sql: string } | undefined)[];
  messages: string[];
  durationMs: number;
}

/** objek yang didaftar driver.objects() */
export type ListKind = 'table' | 'view' | 'procedure';
/** objek di explorer: ListKind + function / trigger (SQL Server) */
export type ObjectKind = ListKind | 'function' | 'trigger';

export interface DbObject {
  schema: string;
  name: string;
}

/** parameter stored procedure */
export interface ProcParam { name: string; type: string; output: boolean; hasDefault: boolean; mode?: 'in' | 'out' | 'inout' | 'variadic' }

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  /** nilai dibuat server (SQL Server identity / computed / rowversion): tidak diisi di INSERT / UPDATE */
  generated?: boolean;
  /** definisi default kolom (mis. ((0))); hanya driver dengan columnDdl yang mengisi */
  default?: string;
}

/** kolom yang ditambah / diubah lewat Add / Edit Column */
export type ColumnDef = Pick<Column, 'name' | 'type' | 'nullable' | 'default'> & {
  /** MySQL: atribut kolom yang ikut ditulis ulang di CHANGE COLUMN (COLLATE, ON UPDATE, COMMENT) */
  keep?: string;
};

/** script kolom tabel (klik kanan tabel): show dijalankan langsung, lainnya dibuka di tab tanpa dijalankan */
export interface ColumnDdl {
  /** pemisah langkah script (SQL Server: GO) */
  separator: string;
  /** tipe bawaan untuk dropdown (urut tampil, dikelompokkan per group) */
  types: TypeSpec[];
  /** tipe awal kolom baru (Add column) */
  newType: string;
  /** catatan tambahan di konfirmasi Execute (mis. DDL implicit commit) */
  note?: string;
  show(obj: DbObject): string;
  add(obj: DbObject, col: ColumnDef): string;
  edit(obj: DbObject, old: ColumnDef, next: ColumnDef): string;
  drop(obj: DbObject, name: string): string;
  /** validasi tambahan per database (old kosong = kolom baru); undefined = valid */
  check?(c: ColumnDef, old?: ColumnDef): string | undefined;
  /** SQLite: ubah tipe / NULL / default lewat rebuild tabel (changed memakai nama kolom asal); dijalankan sebelum langkah lain */
  rebuild?(obj: DbObject, original: ColumnRow[], changed: ColumnDef[]): string;
  /** bungkus seluruh script (mis. satu transaksi) */
  wrap?(sql: string): string;
  /** New Table: CREATE TABLE lengkap (kolom, PK, UQ, FK); tidak ada = menu New Table tidak tampil */
  create?(obj: DbObject, cols: NewColumn[]): string;
  /** tipe yang boleh auto increment / identity */
  aiTypes?: string[];
  /** pilihan ON DELETE / ON UPDATE foreign key (pertama = default, tidak ditulis) */
  fkActions?: string[];
}

/** kolom New Table: atribut PK / AI (auto increment / identity) / UQ / FK satu kolom */
export type NewColumn = ColumnDef & {
  pk?: boolean;
  ai?: boolean;
  unique?: boolean;
  fk?: { schema: string; table: string; column: string; onDelete?: string; onUpdate?: string };
};

/** New Table: validasi lalu script CREATE TABLE (kosong bila ada error); kolom PK dipaksa NOT NULL */
export function createTable(ddl: ColumnDdl, obj: DbObject, rows: NewColumn[]): { sql: string; errors: string[] } {
  const cols = rows.filter((r) => r.name.trim() || r.type.trim()).map((r): NewColumn => ({ ...r, name: r.name.trim(), type: r.type.trim(),
    nullable: r.nullable && !r.pk, default: r.ai ? undefined : r.default?.trim() || undefined }));
  const errors: string[] = [];
  if (!obj.name.trim()) errors.push('Table name is required');
  if (!cols.length) errors.push('Add at least one column');
  cols.forEach((c, i) => {
    const e = checkColumn(c) ?? checkType(c.type, ddl.types) ?? ddl.check?.(c);
    if (e) errors.push(`${c.name || `column ${i + 1}`}: ${e}`);
    else if (c.ai && ddl.aiTypes && !ddl.aiTypes.includes(splitType(c.type, ddl.types).base)) errors.push(`${c.name}: auto increment needs an integer type (${ddl.aiTypes.join(', ')})`);
    if (c.fk && (!c.fk.table || !c.fk.column)) errors.push(`${c.name}: choose the referenced table and column`);
  });
  if (cols.filter((c) => c.ai).length > 1) errors.push('Only one auto increment column per table');
  const seen = new Set<string>();
  for (const c of cols) {
    const k = c.name.toLowerCase();
    if (k && seen.has(k)) errors.push(`Duplicate column name: ${c.name}`);
    seen.add(k);
  }
  return errors.length || !ddl.create ? { sql: '', errors } : { sql: ddl.create({ ...obj, name: obj.name.trim() }, cols), errors: [] };
}

/**
 * tipe data bawaan untuk dropdown editor Columns. args = ukuran di dalam kurung: length (n / max bila allowMax),
 * precisionScale (p,s), precision (p), scale (detik pecahan), values (daftar nilai enum / set); max = batas atas; tanpa args = tanpa ukuran.
 */
export interface TypeSpec {
  name: string;
  group: string;
  args?: 'length' | 'precisionScale' | 'precision' | 'scale' | 'values';
  max?: number;
  allowMax?: boolean;
  /** ukuran awal saat tipe dipilih di dropdown */
  def?: string;
  note?: string;
}

/** 'decimal(10, 2)' -> { base: 'decimal', args: '10,2' }; known = ada di daftar (selain itu tipe custom / user-defined, apa adanya) */
export function splitType(type: string, specs: TypeSpec[]): { base: string; args: string; known: boolean } {
  const m = /^\s*([\w ]+?)\s*(?:\((.*)\))?\s*$/.exec(type);
  const spec = m && specs.find((x) => x.name === m[1].toLowerCase());
  if (!m || !spec) return { base: type.trim(), args: '', known: false };
  // nilai enum / set bisa berisi spasi
  return { base: spec.name, args: spec.args === 'values' ? (m[2] ?? '').trim() : (m[2] ?? '').replace(/\s+/g, ''), known: true };
}

/** ukuran tipe sesuai aturan TypeSpec; undefined = valid (tipe custom tidak dicek, server yang menolak) */
export function checkType(type: string, specs: TypeSpec[]): string | undefined {
  const { base, args, known } = splitType(type, specs);
  const spec = specs.find((x) => x.name === base);
  if (!known || !spec) return undefined;
  if (spec.args === 'values') return args ? undefined : `${base}: list of values, e.g. ('a','b')`;
  if (!args) return undefined;
  const int = (v: string | undefined, lo: number, hi: number) => v !== undefined && /^\d+$/.test(v) && +v >= lo && +v <= hi;
  const max = spec.max ?? 0;
  switch (spec.args) {
    case undefined: return `${base} has no size`;
    case 'length': return (spec.allowMax && args.toLowerCase() === 'max') || int(args, 1, max) ? undefined : `${base}: length 1-${max}${spec.allowMax ? ' or max' : ''}`;
    case 'precision': return int(args, 1, max) ? undefined : `${base}: precision 1-${max}`;
    case 'scale': return int(args, 0, max) ? undefined : `${base}: fractional seconds 0-${max}`;
    case 'precisionScale': {
      const [p, sc, extra] = args.split(',');
      return extra === undefined && int(p, 1, max) && (sc === undefined || int(sc, 0, +p)) ? undefined : `${base}: precision 1-${max}, scale 0-precision`;
    }
  }
}

/** validasi input Add / Edit Column; undefined = valid */
export function checkColumn(c: ColumnDef): string | undefined {
  if (!c.name.trim()) return 'Column name is required';
  if (!c.type.trim()) return 'Data type is required';
  return undefined;
}

/** contextValue objek di explorer: .def = Show / Edit, .ms = SQL Server (Script as), .cols = editor Columns */
export function objContext(kind: ObjectKind, f: { def: boolean; ms: boolean; cols: boolean }): string {
  return `${kind}${f.def ? '.def' : ''}${f.ms ? '.ms' : ''}${f.cols && kind === 'table' ? '.cols' : ''}`;
}

/** baris editor Columns: orig = nama kolom asal (kosong = kolom baru), deleted = ditandai hapus */
export type ColumnRow = ColumnDef & { orig?: string; deleted?: boolean; generated?: boolean };

/** hasil ColumnDdl.show -> kolom yang bisa diedit + info read-only (alias wajib: column_name, data_type, nullable YES/NO, default_value) */
export function showColumns(rs: Pick<ResultSet, 'columns' | 'rows'>): { cols: ColumnRow[]; info: { columns: string[]; rows: unknown[][] } } {
  const at = (k: string) => rs.columns.indexOf(k);
  const core = ['ordinal', 'column_name', 'data_type', 'nullable', 'default_value', 'keep'];
  const extra = rs.columns.map((c, i) => [c, i] as const).filter(([c]) => !core.includes(c));
  // identity / computed / generated terisi = nilai dibuat server: hanya nama yang bisa diubah
  const gen = ['identity', 'computed', 'generated'].map(at).filter((i) => i >= 0);
  return {
    cols: rs.rows.map((r) => {
      const d = r[at('default_value')];
      return { name: String(r[at('column_name')]), type: String(r[at('data_type')]), nullable: r[at('nullable')] === 'YES',
        ...(d !== null && d !== undefined && d !== '' ? { default: String(d) } : {}),
        ...(at('keep') >= 0 && r[at('keep')] ? { keep: String(r[at('keep')]) } : {}),
        ...(gen.some((i) => r[i] !== null && r[i] !== undefined && r[i] !== '') ? { generated: true } : {}) };
    }),
    info: { columns: extra.map(([c]) => c), rows: rs.rows.map((r) => extra.map(([, i]) => r[i])) },
  };
}

const sameCol = (a: ColumnDef, b: ColumnDef) => a.name === b.name && a.type.trim() === b.type.trim() && a.nullable === b.nullable
  && (a.default?.trim() || '') === (b.default?.trim() || '');

/** editor Columns -> script (hapus, ubah, tambah; satu langkah per batch); errors = input tidak valid, script kosong */
/** satu langkah di daftar Pending changes */
export interface ColumnStep { kind: 'rebuild' | 'drop' | 'edit' | 'add'; column: string; to?: string; sql: string; detail?: string[] }

/** perubahan kolom selain nama, untuk dibaca user: tipe, NULL, default */
function diffColumn(a: ColumnDef, b: ColumnDef): string[] {
  const nul = (n: boolean) => (n ? 'NULL' : 'NOT NULL');
  const [da, db] = [a.default?.trim() || '', b.default?.trim() || ''];
  return [
    ...(a.type.trim() !== b.type.trim() ? [`${a.type} → ${b.type}`] : []),
    ...(a.nullable !== b.nullable ? [`${nul(a.nullable)} → ${nul(b.nullable)}`] : []),
    ...(da === db ? [] : !db ? [`default ${da} removed`] : !da ? [`default ${db} added`] : [`default ${da} → ${db}`]),
  ];
}

export function columnChanges(ddl: ColumnDdl, obj: DbObject, original: ColumnRow[], rows: ColumnRow[]): { sql: string; errors: string[]; count: number; steps: ColumnStep[] } {
  const live = rows.filter((r) => !r.deleted && (r.orig || r.name.trim() || r.type.trim()));
  const clean = (r: ColumnRow): ColumnDef => ({ name: r.name.trim(), type: r.type.trim(), nullable: r.nullable, ...(r.default?.trim() ? { default: r.default.trim() } : {}) });
  const old = (r: ColumnRow) => original.find((c) => c.name === r.orig)!;
  const errors = live.flatMap((r) => {
    const e = checkColumn(r) ?? checkType(r.type, ddl.types) ?? ddl.check?.(clean(r), r.orig ? old(r) : undefined);
    return e ? [`${r.orig ?? `new column ${rows.indexOf(r) + 1}`}: ${e}`] : [];
  });
  const seen = new Set<string>();
  for (const r of live) {
    const k = r.name.trim().toLowerCase();
    if (k && seen.has(k)) errors.push(`Duplicate column name: ${r.name.trim()}`);
    seen.add(k);
  }
  if (errors.length) return { sql: '', errors, count: 0, steps: [] };
  // SQLite: perubahan selain nama dikerjakan satu rebuild tabel di awal (nama asal), rename / drop / add sesudahnya
  const rebuilt = ddl.rebuild ? live.filter((r) => r.orig && diffColumn(old(r), clean(r)).length) : [];
  const steps: ColumnStep[] = [
    ...(rebuilt.length ? [{ kind: 'rebuild' as const, column: obj.name, sql: ddl.rebuild!(obj, original, rebuilt.map((r) => ({ ...clean(r), name: r.orig! }))),
      detail: rebuilt.map((r) => `${r.orig}: ${diffColumn(old(r), clean(r)).join(', ')}`) }] : []),
    ...rows.filter((r) => r.deleted && r.orig).map((r): ColumnStep => ({ kind: 'drop', column: r.orig!, sql: ddl.drop(obj, r.orig!) })),
    ...live.filter((r) => r.orig && !sameCol(old(r), clean(r))).map((r): ColumnStep => ({ kind: 'edit', column: r.orig!,
      ...(clean(r).name !== r.orig ? { to: clean(r).name } : {}), sql: ddl.edit(obj, old(r), clean(r)), detail: diffColumn(old(r), clean(r)) })),
    ...live.filter((r) => !r.orig).map((r): ColumnStep => ({ kind: 'add', column: clean(r).name, sql: ddl.add(obj, clean(r)) })),
  ];
  const sql = steps.map((x) => x.sql).join(ddl.separator);
  return { sql: sql && ddl.wrap ? ddl.wrap(sql) : sql, errors: [], count: steps.length, steps };
}

/** isian form New Database; choice = daftar yang bisa dicari (value '' = default server), group = bagian yang bisa dilipat */
export interface DbField {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'choice';
  group?: string;
  hint?: string;
  /** pilihan choice; run = jalankan query di koneksi (semua baris, mis. 5500 collation) */
  items?(run: (sql: string) => Promise<{ resultSets: { rows: unknown[][] }[] }>): Promise<{ value: string; label?: string }[]>;
}

/** New Database (form tab): isian per database lalu script CREATE DATABASE */
export interface NewDatabase {
  maxName: number;
  fields: DbField[];
  /** pesan error isian; kosong = valid */
  check(values: Record<string, string>): string[];
  script(name: string, values: Record<string, string>): string;
}

/** script New Database atau daftar error (script kosong bila ada error) */
export function newDatabaseScript(nd: NewDatabase, name: string, values: Record<string, string>): { sql: string; errors: string[] } {
  const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, x.trim()]));
  const errors = [checkDbName(name, nd.maxName), ...nd.check(v)].filter((e): e is string => !!e);
  return errors.length ? { sql: '', errors } : { sql: nd.script(name.trim(), v), errors: [] };
}

/** validasi nama database baru; undefined = valid */
export function checkDbName(name: string, max: number): string | undefined {
  if (!name.trim()) return 'Database name is required';
  if (name.trim().length > max) return `Database name is at most ${max} characters`;
  return undefined;
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
  /** PostgreSQL: transaksi aborted karena error (semua statement ditolak sampai ROLLBACK) */
  readonly failed?: boolean;
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
  objects(conn: ConnectionInfo, password: string, db: string, kind: ListKind): Promise<DbObject[]>;
  /** schema di database (tanpa schema sistem), untuk New Table; tidak ada = schema = database (MySQL) / dari tabel yang ada */
  schemas?(conn: ConnectionInfo, password: string, db: string): Promise<string[]>;
  columns(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<Column[]>;
  /** definisi view / procedure / function (teks CREATE ...); tidak ada = Show / Edit tidak tersedia */
  definition?(conn: ConnectionInfo, password: string, db: string, obj: DbObject, kind?: ObjectKind): Promise<string>;
  /** parameter procedure / function (urut; overload PostgreSQL: yang pertama); tidak ada = node tidak bisa di-expand */
  parameters?(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<ProcParam[]>;
  /** Edit: script yang mengubah objek (CREATE OR ALTER / CREATE OR REPLACE / DROP + CREATE), tidak dijalankan otomatis */
  editScript?(conn: ConnectionInfo, password: string, db: string, obj: DbObject, kind: ObjectKind): Promise<string>;
  /** Script as CREATE untuk tabel (lengkap: identity, computed, default, constraint, FK, index); tidak ada = kolom + PK saja */
  /** Show / Add / Edit / Delete Column untuk tabel; tidak ada = menu kolom tidak tampil */
  columnDdl?: ColumnDdl;
  /** klik kanan koneksi -> New Database…; tidak ada = menu tidak tampil */
  newDatabase?: NewDatabase;
  createTableScript?(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<string>;
  /** Run: script EXEC / CALL / SELECT dengan argumen; params = jumlah argumen (0 = langsung dijalankan) */
  runScript?(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<{ sql: string; params: number }>;
  /** SQL Server Object Explorer: baris query folder mssqlTree (@full = objek / item induk) */
  catalog?(conn: ConnectionInfo, password: string, sql: string, full?: string): Promise<{ schema?: string; name: string; description?: string | null }[]>;
  /** query "SELECT TOP n" untuk tabel/view, sesuai dialek */
  selectTop(db: string, obj: DbObject, n: number): string;
  /** kolom primary key (urut key) tabel db.schema.name; kosong bila tidak ada PK */
  primaryKey(conn: ConnectionInfo, password: string, db: string, obj: DbObject): Promise<string[]>;
  /** tutup koneksi/pool yang di-cache untuk nama koneksi ini */
  close(name: string): Promise<void>;
  /** pool / client koneksi ini sedang terbuka (status "connected"); tidak ada = driver tanpa koneksi tetap (SQLite, Consul) */
  isOpen?(name: string): boolean;
}

// tambah DB lain: buat file driver baru lalu daftarkan di sini (+ tambah ke DbType)
export const drivers: Record<DbType, Driver> = {
  mssql: mssqlDriver,
  mysql: mysqlDriver,
  mariadb: mariadbDriver,
  postgres: postgresDriver,
  sqlite: sqliteDriver,
  mongodb: mongoDriver,
  consul: consulDriver,
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

/** Driver settings -> opsi driver: 'true' / 'false' -> boolean, angka -> number, selain itu teks */
export const typedOptions = (o?: Record<string, string>): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
/** batas waktu connect (ms) dari setting koneksi (detik), default 15 detik */
export const connectMs = (c: ConnectionInfo) => (c.connectTimeout ?? 15) * 1000;

/** koneksi yang terbuka, tidak dipakai >= minutes menit dan tidak sibuk (query / transaksi) -> auto disconnect; minutes 0 = mati */
export function idleConnections(now: number, lastUsed: Map<string, number>, minutes: number, isOpen: (name: string) => boolean, busy: Set<string>): string[] {
  if (minutes <= 0) return [];
  return [...lastUsed].filter(([name, t]) => now - t >= minutes * 60_000 && isOpen(name) && !busy.has(name)).map(([name]) => name);
}

/** alamat untuk ditampilkan: host\instance atau host:port */
export const address = (c: ConnectionInfo) => (c.type === 'sqlite' ? c.file ?? '' : c.instance ? `${c.host}\\${c.instance}` : `${c.host}:${c.port}`);

/** schema objek yang tidak ditulis di SQL */
export const schemaOf = (c: ConnectionInfo, db: string) => drivers[c.type].defaultSchema || db;

import { mssqlDriver } from './mssql';
import { mariadbDriver, mysqlDriver } from './mysql';
import { mongoDriver } from './mongo';
import { consulDriver } from './consul';
import { postgresDriver } from './postgres';
import { sqliteDriver } from './sqlite';
import { driverLog } from './log';
import { createHash } from 'crypto';

const errText = (e: unknown) => (e instanceof Error ? `${e.message} - stack-trace: ${e.stack ?? e.message}` : `${String(e)} - stack-trace: ${String(e)}`);

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
/** lingkungan group (ikon + warna di Connections); 'none' = tanpa ikon lingkungan walau nama group mirip */
export type GroupEnv = 'production' | 'uat' | 'development' | 'local';
export type GroupSettings = Record<string, { confirmAutoCommit?: boolean; env?: GroupEnv | 'none' }>;

/** lingkungan group: pilihan user, selain itu ditebak dari nama (UAT dicek dulu supaya "pre-prod" tidak jadi production) */
export function groupEnv(group: string, settings: GroupSettings): GroupEnv | undefined {
  const set = settings[group]?.env;
  if (set) return set === 'none' ? undefined : set;
  if (/uat|stag|stg|pre-?prod|\bqa\b/i.test(group)) return 'uat';
  if (/prod|\blive\b/i.test(group)) return 'production';
  if (/local|docker/i.test(group)) return 'local';
  if (/dev/i.test(group)) return 'development';
  return undefined;
}
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
  /** Load all: baris ada di result cache extension host (rows tetap halaman awal) */
  cache?: import('./cacheView').GridCache;
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
  /** auto increment / identity */
  ai?: boolean;
  /** MySQL: ekspresi generated (AS (...) VIRTUAL / STORED) yang dibawa saat kolom dipindah */
  gen?: string;
};

/** tujuan foreign key: kolom tujuan berpasangan dengan kolom lokal sesuai urutan */
export interface KeyRef { schema: string; table: string; columns: string[]; onDelete?: string; onUpdate?: string }

/**
 * UNIQUE / FOREIGN KEY tingkat tabel (satu atau lebih kolom, urutan bermakna); PK tetap di chip kolom.
 * readOnly = index berfilter / ekspresi dari server: ditampilkan saja, tidak pernah di-drop / dibuat ulang.
 */
export interface TableKey {
  kind: 'unique' | 'fk';
  /** nama constraint / index; kosong = nama otomatis (keyName) */
  name?: string;
  cols: string[];
  ref?: KeyRef;
  /** UNIQUE yang berupa unique index, bukan constraint */
  index?: boolean;
  readOnly?: boolean;
}

/** ' ON DELETE x ON UPDATE y' untuk FK; NO ACTION (default) tidak ditulis */
export function fkActs(r: { onDelete?: string; onUpdate?: string }): string {
  return `${r.onDelete && r.onDelete !== 'NO ACTION' ? ` ON DELETE ${r.onDelete}` : ''}${r.onUpdate && r.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${r.onUpdate}` : ''}`;
}

/** nama otomatis UQ_/FK_<tabel>_<kolom...>; lewat nameMax (byte) dipotong + hash pendek supaya tetap unik dan stabil */
export function keyName(obj: DbObject, kind: TableKey['kind'], cols: string[], nameMax?: number): string {
  const full = `${kind === 'unique' ? 'UQ' : 'FK'}_${obj.name.trim()}_${cols.join('_')}`;
  if (!nameMax || Buffer.byteLength(full, 'utf8') <= nameMax) return full;
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 8);
  let head = full;
  while (Buffer.byteLength(head, 'utf8') > nameMax - hash.length - 1) head = head.slice(0, -1);
  return `${head}_${hash}`;
}

/** validasi key tabel terhadap kolom final (rows); chip UQ / FK satu kolom ikut dicek untuk duplikat */
export function checkKeys(ddl: ColumnDdl, obj: DbObject, rows: NewColumn[], keys: TableKey[]): string[] {
  const errors: string[] = [];
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  // UNIQUE: susunan kolom tidak berpengaruh; FK: pasangan kolom berurutan + tujuan
  const sig = (k: TableKey) => k.kind === 'unique'
    ? `u:${k.cols.map((c) => c.toLowerCase()).sort().join(',')}`
    : `f:${k.cols.join(',')}>${k.ref?.schema}.${k.ref?.table}(${k.ref?.columns.join(',')})`.toLowerCase();
  const seen = new Set<string>([
    ...rows.filter((r) => r.unique).map((r) => sig({ kind: 'unique', cols: [r.name] })),
    ...rows.filter((r) => r.fk).map((r) => sig({ kind: 'fk', cols: [r.name], ref: { schema: r.fk!.schema, table: r.fk!.table, columns: [r.fk!.column] } })),
  ]);
  keys.forEach((k, i) => {
    const label = k.name?.trim() || `${k.kind === 'unique' ? 'UNIQUE' : 'FOREIGN KEY'} ${i + 1}`;
    const err = (m: string) => { errors.push(`${label}: ${m}`); };
    if (k.kind === 'fk' && !ddl.fkActions) return err('foreign keys are not supported here');
    if (!k.cols.length) return err('choose at least one column');
    for (const c of k.cols) if (!byName.has(c.toLowerCase())) err(`unknown column ${c}`);
    if (new Set(k.cols.map((c) => c.toLowerCase())).size !== k.cols.length) err('a column is used twice');
    if (k.kind === 'fk') {
      if (!k.ref?.table || !k.ref.columns.length || k.ref.columns.some((c) => !c)) return err('choose the referenced table and columns');
      if (k.ref.columns.length !== k.cols.length) err('local and referenced keys need the same number of columns');
      if (new Set(k.ref.columns.map((c) => c.toLowerCase())).size !== k.ref.columns.length) err('a referenced column is used twice');
      for (const [p, verb] of [['onDelete', 'DELETE'], ['onUpdate', 'UPDATE']] as const) {
        const act = k.ref[p];
        if (act && !ddl.fkActions!.includes(act)) err(`ON ${verb} ${act} is not supported here`);
        if (act === 'SET NULL' && k.cols.some((c) => byName.get(c.toLowerCase())?.nullable === false)) err(`ON ${verb} SET NULL needs nullable columns`);
      }
    }
    const name = k.name?.trim();
    if (name && ddl.nameMax && Buffer.byteLength(name, 'utf8') > ddl.nameMax) err(`constraint name too long (max ${ddl.nameMax})`);
    const s = sig(k);
    if (seen.has(s)) err('Duplicate key definition');
    seen.add(s);
  });
  return errors;
}

/**
 * hasil ColumnDdl.keys (satu baris per kolom anggota: key_name, kind unique / fk, is_index, read_only, col_name, ord,
 * ref_schema, ref_table, ref_column, on_delete, on_update) -> key berurutan; NO ACTION tidak ditulis
 */
export function readKeys(rs: Pick<ResultSet, 'columns' | 'rows'>): TableKey[] {
  const at = (k: string) => rs.columns.indexOf(k);
  const v = (row: unknown[], k: string) => (at(k) < 0 || row[at(k)] === null || row[at(k)] === undefined ? undefined : String(row[at(k)]));
  const flag = (row: unknown[], k: string) => Number(row[at(k)] ?? 0) === 1 || row[at(k)] === true;
  const keys = new Map<string, { key: TableKey; members: [number, string, string][] }>();
  for (const row of rs.rows) {
    const kind = v(row, 'kind') === 'fk' ? 'fk' : 'unique';
    const name = v(row, 'key_name') ?? '';
    let entry = keys.get(`${kind}\u0000${name}`);
    if (!entry) {
      const key: TableKey = { kind, name, cols: [] };
      if (flag(row, 'is_index')) key.index = true;
      if (flag(row, 'read_only')) key.readOnly = true;
      if (kind === 'fk') {
        key.ref = { schema: v(row, 'ref_schema') ?? '', table: v(row, 'ref_table') ?? '', columns: [] };
        for (const [p, col] of [['onDelete', 'on_delete'], ['onUpdate', 'on_update']] as const) {
          const act = v(row, col);
          if (act && act !== 'NO ACTION') key.ref[p] = act;
        }
      }
      entry = { key, members: [] };
      keys.set(`${kind}\u0000${name}`, entry);
    }
    // kolom ekspresi (PostgreSQL / MySQL functional index) tidak punya nama
    entry.members.push([Number(v(row, 'ord') ?? 0), v(row, 'col_name') ?? '(expression)', v(row, 'ref_column') ?? '']);
  }
  return [...keys.values()].map(({ key, members }) => {
    members.sort((a, b) => a[0] - b[0]);
    key.cols = members.map((m) => m[1]);
    if (key.ref) key.ref.columns = members.map((m) => m[2]);
    return key;
  });
}

/** foreign key satu kolom; name = nama constraint yang ada (untuk drop) */
export interface ColumnFk { schema: string; table: string; column: string; onDelete?: string; onUpdate?: string; name?: string }

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
  add(obj: DbObject, col: NewColumn, pos?: { after?: string | null; pkCols?: string[] }): string;
  edit(obj: DbObject, old: ColumnDef, next: ColumnDef): string;
  drop(obj: DbObject, name: string): string;
  /** validasi tambahan per database (old kosong = kolom baru; cols = semua kolom New Table, ada = mode New Table); undefined = valid */
  check?(c: ColumnDef, old?: ColumnDef, cols?: NewColumn[]): string | undefined;
  /** SQLite: ubah tipe / NULL / default lewat rebuild tabel (changed memakai nama kolom asal); dijalankan sebelum langkah lain */
  rebuild?(obj: DbObject, original: ColumnRow[], changed: ColumnDef[]): string;
  /** bungkus seluruh script (mis. satu transaksi) */
  wrap?(sql: string): string;
  /** New Table: CREATE TABLE lengkap (kolom, PK, lalu keys = semua UNIQUE / FK bernama, termasuk chip satu kolom); tidak ada = menu New Table tidak tampil */
  create?(obj: DbObject, cols: NewColumn[], keys: TableKey[]): string;
  /** tipe yang boleh auto increment / identity */
  aiTypes?: string[];
  /** pilihan ON DELETE / ON UPDATE foreign key (pertama = default, tidak ditulis) */
  fkActions?: string[];
  /** MySQL: auto increment harus PK / UQ */
  aiNeedsKey?: boolean;
  /** panjang maksimum nama constraint (byte): SQL Server 128, MySQL 64, PostgreSQL 63 */
  nameMax?: number;
  /** pasang / lepas auto increment / identity di kolom yang ada (tidak ada = hanya kolom baru) */
  setAi?(obj: DbObject, col: ColumnDef, on: boolean): string;
  /** MySQL: DROP PRIMARY KEY + ADD PRIMARY KEY (...) dalam satu statement */
  replacePk?(obj: DbObject, cols: string[]): string;
  dropPk?(obj: DbObject, name?: string): string;
  addPk?(obj: DbObject, cols: string[], name?: string): string;
  dropUnique?(obj: DbObject, name: string, index: boolean): string;
  /** SQLite: perubahan key tabel lewat rebuild tabel (drop / add sudah bernama); dipakai bila tidak ada addUnique / addFk */
  keyRebuild?(obj: DbObject, original: ColumnRow[], drop: TableKey[], add: TableKey[]): string;
  /** query key tabel lebih dari satu kolom (dibaca readKeys); tidak ada = tabel Keys hanya untuk key baru */
  keys?(obj: DbObject): string;
  /** default nama: UQ_<tabel>_<kolom...> */
  addUnique?(obj: DbObject, cols: string[], name?: string, index?: boolean): string;
  dropFk?(obj: DbObject, name: string): string;
  /** default nama: FK_<tabel>_<kolom...> */
  addFk?(obj: DbObject, cols: string[], ref: KeyRef, name?: string): string;
  move?(obj: DbObject, col: ColumnDef, after: string | null): string;
  /** SQL Server: lepas dan pasang lagi key saat tipe atau nullability kolom berubah */
  rebuildKeys?: boolean;
  /** MySQL: DROP COLUMN mengubah PK/UQ dengan sendirinya */
  dropKeepsKeys?: boolean;
  /** label atribut AI di judul langkah */
  aiLabel?: string;
}

/** kolom New Table: atribut PK / AI (auto increment / identity) / UQ / FK satu kolom */
export type NewColumn = ColumnDef & {
  pk?: boolean;
  unique?: boolean;
  fk?: ColumnFk;
};

/** New Table: validasi lalu script CREATE TABLE (kosong bila ada error); kolom PK / AI dipaksa NOT NULL */
export function createTable(ddl: ColumnDdl, obj: DbObject, rows: NewColumn[], keys: TableKey[] = []): { sql: string; errors: string[] } {
  const cols = rows.filter((r) => r.name.trim() || r.type.trim()).map((r): NewColumn => ({ ...r, name: r.name.trim(), type: r.type.trim(),
    nullable: r.nullable && !r.pk && !r.ai, default: r.ai ? undefined : r.default?.trim() || undefined }));
  const errors: string[] = [];
  if (!obj.name.trim()) errors.push('Table name is required');
  if (!cols.length) errors.push('Add at least one column');
  const bad = new Set<NewColumn>();
  cols.forEach((c, i) => {
    const e = checkColumn(c) ?? checkType(c.type, ddl.types) ?? ddl.check?.(c, undefined, cols);
    if (e) { errors.push(`${c.name || `column ${i + 1}`}: ${e}`); bad.add(c); }
  });
  errors.push(...checkRows(ddl, obj, cols.filter((c) => !bad.has(c))));
  if (bad.size && cols.filter((c) => c.ai).length > 1 && !errors.includes('Only one auto increment column per table')) errors.push('Only one auto increment column per table');
  const seen = new Set<string>();
  for (const c of cols) {
    const k = c.name.toLowerCase();
    if (k && seen.has(k)) errors.push(`Duplicate column name: ${c.name}`);
    seen.add(k);
  }
  errors.push(...checkKeys(ddl, obj, cols, keys));
  if (errors.length || !ddl.create) return { sql: '', errors };
  const o = { ...obj, name: obj.name.trim() };
  // chip UQ / FK satu kolom memakai nama lama (UQ_/FK_<tabel>_<kolom>, panjangnya dicek checkRows); urutan: semua UNIQUE lalu semua FK
  const named = keys.map((k) => ({ ...k, name: k.name?.trim() || keyName(o, k.kind, k.cols, ddl.nameMax) }));
  const all: TableKey[] = [
    ...cols.filter((c) => c.unique).map((c): TableKey => ({ kind: 'unique', name: `UQ_${o.name}_${c.name}`, cols: [c.name] })),
    ...named.filter((k) => k.kind === 'unique'),
    ...cols.filter((c) => c.fk).map(({ name, fk }): TableKey => ({ kind: 'fk', name: `FK_${o.name}_${name}`, cols: [name],
      ref: { schema: fk!.schema, table: fk!.table, columns: [fk!.column], onDelete: fk!.onDelete, onUpdate: fk!.onUpdate } })),
    ...named.filter((k) => k.kind === 'fk'),
  ];
  return { sql: ddl.create(o, cols, all), errors: [] };
}

/**
 * validasi atribut kolom (New Table dan editor Columns): AI (tipe, jumlah, key, kolom lama), FK (tujuan, SET NULL), panjang nama constraint baru.
 * rows sudah di-trim, baris yang dihapus tidak ikut; original = kolom dari Show (editor Columns).
 */
export function checkRows(ddl: ColumnDdl, obj: DbObject, rows: (NewColumn & { orig?: string })[], original?: ColumnRow[]): string[] {
  const errors: string[] = [];
  const old = (r: { orig?: string }) => (r.orig ? original?.find((c) => c.name === r.orig) : undefined);
  const long = (n: string) => (ddl.nameMax && Buffer.byteLength(n, 'utf8') > ddl.nameMax ? [`${n}: constraint name too long (max ${ddl.nameMax})`] : []);
  for (const r of rows) {
    const o = old(r);
    if (r.ai && !ddl.aiTypes) errors.push(`${r.name}: auto increment is not supported here`);
    // tipe dicek bila AI baru dinyalakan atau tipenya berubah (identity lama bertipe numeric(18,0) tetap boleh)
    else if (r.ai && (!o?.ai || o.type !== r.type) && !ddl.aiTypes!.includes(splitType(r.type, ddl.types).base)) errors.push(`${r.name}: auto increment needs an integer type (${ddl.aiTypes!.join(', ')})`);
    else if (r.ai && ddl.aiNeedsKey && !r.pk && !r.unique) errors.push(`${r.name}: auto increment needs PK or UQ (MySQL)`);
    if (o && !ddl.setAi && !!r.ai !== !!o.ai) errors.push(`${r.name}: identity can only be set on a new column`);
    if (r.fk && !ddl.fkActions) errors.push(`${r.name}: foreign keys are not supported here`);
    else if (r.fk && (!r.fk.table || !r.fk.column)) errors.push(`${r.name}: choose the referenced table and column`);
    else if (r.fk) for (const [k, label] of [['onDelete', 'DELETE'], ['onUpdate', 'UPDATE']] as const) {
      if (r.fk[k] === 'SET NULL' && !r.nullable) errors.push(`${r.name}: ON ${label} SET NULL needs a nullable column`);
    }
    if (r.unique && !o?.unique) errors.push(...long(`UQ_${obj.name}_${r.name}`));
    if (r.fk && !o?.fk) errors.push(...long(`FK_${obj.name}_${r.name}`));
  }
  if (rows.filter((r) => r.ai).length > 1) errors.push('Only one auto increment column per table');
  // nama PK baru hanya bila susunan PK berubah; MySQL (replacePk) tanpa nama
  const pkNow = rows.filter((r) => r.pk).map((r) => r.orig ?? `\u0000${r.name}`).join('\u0001');
  const pkOld = (original ?? []).filter((c) => c.pk).map((c) => c.name).join('\u0001');
  if (!ddl.replacePk && pkNow && (!original || pkNow !== pkOld)) errors.push(...long(`PK_${obj.name}`));
  return errors;
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
export function objContext(kind: ObjectKind, f: { def: boolean; ms: boolean; cols: boolean; trg?: boolean }): string {
  // .trg: tabel bisa diberi trigger dari template (klik kanan -> New Trigger…), selalu sebelum .cols
  return `${kind}${f.def ? '.def' : ''}${f.ms ? '.ms' : ''}${f.trg && kind === 'table' ? '.trg' : ''}${f.cols && kind === 'table' ? '.cols' : ''}`;
}

/** baris editor Columns: orig = nama kolom asal (kosong = kolom baru), deleted = ditandai hapus; pkName / uqName = nama constraint yang ada */
export type ColumnRow = NewColumn & { orig?: string; deleted?: boolean; generated?: boolean; pkName?: string; uqName?: string; uqIndex?: boolean };

/** hasil ColumnDdl.show -> kolom yang bisa diedit + info read-only (alias wajib: column_name, data_type, nullable YES/NO, default_value) */
export function showColumns(rs: Pick<ResultSet, 'columns' | 'rows'>): { cols: ColumnRow[]; info: { columns: string[]; rows: unknown[][] } } {
  const at = (k: string) => rs.columns.indexOf(k);
  // alias atribut (PK / AI / UQ / FK, gen) dipetakan ke field baris, bukan info read-only
  const core = ['ordinal', 'column_name', 'data_type', 'nullable', 'default_value', 'keep', 'ai', 'primary_key', 'pk_name', 'uq_name', 'uq_index',
    'fk_name', 'fk_schema', 'fk_table', 'fk_column', 'fk_delete', 'fk_update', 'gen'];
  const extra = rs.columns.map((c, i) => [c, i] as const).filter(([c]) => !core.includes(c));
  const filled = (v: unknown) => v !== null && v !== undefined && v !== '' && v !== 'NO' && v !== 0 && v !== '0';
  // identity / computed / generated terisi = nilai dibuat server: hanya nama yang bisa diubah
  const gen = ['identity', 'computed', 'generated'].map(at).filter((i) => i >= 0);
  return {
    cols: rs.rows.map((r) => {
      const v = (k: string) => (at(k) >= 0 && filled(r[at(k)]) ? String(r[at(k)]) : undefined);
      const d = r[at('default_value')];
      const fk = v('fk_table') && { ...(v('fk_name') ? { name: v('fk_name') } : {}), schema: v('fk_schema') ?? '', table: v('fk_table')!, column: v('fk_column') ?? '',
        ...(v('fk_delete') ? { onDelete: v('fk_delete') } : {}), ...(v('fk_update') ? { onUpdate: v('fk_update') } : {}) };
      return { name: String(r[at('column_name')]), type: String(r[at('data_type')]), nullable: r[at('nullable')] === 'YES',
        ...(d !== null && d !== undefined && d !== '' ? { default: String(d) } : {}),
        ...(v('keep') ? { keep: v('keep') } : {}),
        ...(gen.some((i) => r[i] !== null && r[i] !== undefined && r[i] !== '') ? { generated: true } : {}),
        // SQL Server identity: AI tampil menyala (tetap hanya rename)
        ...(v('ai') || v('identity') ? { ai: true } : {}),
        ...(v('primary_key') ? { pk: true } : {}), ...(v('pk_name') ? { pkName: v('pk_name') } : {}),
        ...(v('uq_name') ? { unique: true, uqName: v('uq_name') } : {}), ...(v('uq_index') ? { uqIndex: true } : {}),
        ...(fk ? { fk } : {}),
        ...(v('gen') ? { gen: v('gen') } : {}) };
    }),
    info: { columns: extra.map(([c]) => c), rows: rs.rows.map((r) => extra.map(([, i]) => r[i])) },
  };
}

const sameCol = (a: ColumnDef, b: ColumnDef) => a.name === b.name && a.type.trim() === b.type.trim() && a.nullable === b.nullable
  && (a.default?.trim() || '') === (b.default?.trim() || '');

/** editor Columns -> script (hapus, ubah, tambah; satu langkah per batch); errors = input tidak valid, script kosong */
/** satu langkah di daftar Pending changes */
export interface ColumnStep {
  kind: 'rebuild' | 'drop' | 'edit' | 'add' | 'move' | 'dropKey' | 'addKey' | 'ai';
  column: string;
  to?: string;
  sql: string;
  detail?: string[];
  title?: string;
}

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

/**
 * langkah DDL editor Columns. keys = key tabel final dari UI (nama kolom final), originalKeys = key dari server (nama kolom asal);
 * key read-only (index berfilter / ekspresi) tidak pernah di-drop / dibuat ulang.
 */
export function columnChanges(ddl: ColumnDdl, obj: DbObject, original: ColumnRow[], rows: ColumnRow[], keys: TableKey[] = [], originalKeys: TableKey[] = []): { sql: string; errors: string[]; count: number; steps: ColumnStep[] } {
  const live = rows.filter((r) => !r.deleted && (r.orig || r.name.trim() || r.type.trim()));
  const editableKeys = !!ddl.addPk;
  const clean = (r: ColumnRow): ColumnDef => ({
    name: r.name.trim(), type: r.type.trim(), nullable: r.nullable && (!editableKeys || (!r.pk && !r.ai)),
    ...((!editableKeys || !r.ai) && r.default?.trim() ? { default: r.default.trim() } : {}),
    ...(r.keep ? { keep: r.keep } : {}), ...(r.ai ? { ai: true } : {}), ...(r.gen ? { gen: r.gen } : {}),
  });
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
  if (ddl.addPk) errors.push(...checkRows(ddl, obj, live.map((r) => ({ ...r, ...clean(r) })), original));
  const editable = keys.filter((k) => !k.readOnly);
  errors.push(...checkKeys(ddl, obj, live.map((r) => ({ ...r, ...clean(r) })), editable));
  // kolom anggota key read-only tidak boleh dihapus / diganti nama / diubah tipe atau NULL
  for (const k of originalKeys.filter((x) => x.readOnly)) {
    const hit = k.cols.filter((c) => {
      const r = live.find((x) => x.orig === c);
      return !r || clean(r).name !== c || r.type.trim() !== original.find((o) => o.name === c)?.type.trim() || clean(r).nullable !== original.find((o) => o.name === c)?.nullable;
    });
    if (hit.length) errors.push(`${k.name}: ${hit.join(', ')} used by a read-only key (filtered / expression index); change it manually`);
  }
  if (errors.length) return { sql: '', errors, count: 0, steps: [] };
  const nameOf = (r: ColumnRow) => clean(r).name;
  const liveOf = (c: ColumnRow) => live.find((r) => r.orig === c.name);
  const sameFk = (a?: ColumnFk, b?: ColumnFk) =>
    a?.schema === b?.schema && a?.table === b?.table && a?.column === b?.column
    && (a?.onDelete || 'NO ACTION') === (b?.onDelete || 'NO ACTION')
    && (a?.onUpdate || 'NO ACTION') === (b?.onUpdate || 'NO ACTION');
  const keyEdit = (r?: ColumnRow) => {
    if (!ddl.rebuildKeys || !r?.orig) return false;
    const before = old(r);
    const after = clean(r);
    return before.type.trim() !== after.type || before.nullable !== after.nullable;
  };
  const keyEditDetail = 're-created because the column type changes; fails if other tables reference this key or an index uses this column';
  const fkName = (c: ColumnRow) => c.fk?.name ?? `FK_${obj.name}_${c.name}`;
  const uqName = (c: ColumnRow) => c.uqName ?? `UQ_${obj.name}_${c.name}`;
  const oldPk = original.filter((c) => c.pk && !(ddl.dropKeepsKeys && rows.some((r) => r.deleted && r.orig === c.name)));
  const newPk = live.filter((r) => r.pk);
  const oldPkIds = oldPk.map((c) => c.name);
  const newPkIds = newPk.map((r) => r.orig ?? `new:${rows.indexOf(r)}`);
  const pkChanged = oldPkIds.length !== newPkIds.length || oldPkIds.some((id) => !newPkIds.includes(id));
  const oldPkEdit = original.some((c) => c.pk && keyEdit(liveOf(c)));
  const pkNeedsStep = editableKeys && (pkChanged || oldPkEdit);
  const inlinePk = !!ddl.aiNeedsKey && newPk.some((r) => !r.orig && r.ai);
  const replacePk = !!ddl.replacePk && oldPk.length > 0 && newPk.length > 0 && pkChanged && !inlinePk;
  const aiLabel = ddl.aiLabel ?? 'auto increment';
  const steps: ColumnStep[] = [];

  // diff key tabel: key server yang definisinya sama (setelah rename kolom) dipertahankan, selain itu drop lalu add
  const finalName = (c: string) => { const r = live.find((x) => x.orig === c); return r ? nameOf(r) : c; };
  const sameKey = (a: TableKey, b: TableKey) => a.kind === b.kind && !!a.index === !!b.index && a.cols.join('\u0001') === b.cols.join('\u0001')
    && (a.kind === 'unique' || (a.ref?.schema === b.ref?.schema && a.ref?.table === b.ref?.table && a.ref?.columns.join('\u0001') === b.ref?.columns.join('\u0001')
      && (a.ref?.onDelete || 'NO ACTION') === (b.ref?.onDelete || 'NO ACTION') && (a.ref?.onUpdate || 'NO ACTION') === (b.ref?.onUpdate || 'NO ACTION')));
  const kept = new Set<TableKey>();
  const keyDrops: TableKey[] = [];
  const keyAdds: { key: TableKey; name: string; detail?: string[] }[] = [];
  for (const before of originalKeys.filter((k) => !k.readOnly)) {
    const match = editable.find((k) => !kept.has(k) && (!k.name?.trim() || k.name.trim() === before.name) && sameKey({ ...before, cols: before.cols.map(finalName) }, k));
    if (!match) { keyDrops.push(before); continue; }
    kept.add(match);
    if (before.cols.some((c) => { const r = live.find((x) => x.orig === c); return !!r && keyEdit(r); })) {
      keyDrops.push(before);
      keyAdds.push({ key: match, name: before.name!, detail: [keyEditDetail] });
    }
  }
  for (const k of editable) if (!kept.has(k)) keyAdds.push({ key: k, name: k.name?.trim() || keyName(obj, k.kind, k.cols, ddl.nameMax) });
  if ((keyDrops.length || keyAdds.length) && !ddl.keyRebuild && (!ddl.addUnique || !ddl.dropUnique || (ddl.fkActions && (!ddl.addFk || !ddl.dropFk)))) {
    return { sql: '', errors: ['Changing table keys is not supported here yet'], count: 0, steps: [] };
  }

  if (editableKeys) {
    for (const before of original) {
      if (!before.fk) continue;
      const current = liveOf(before);
      if (!current || !current.fk || !sameFk(before.fk, current.fk) || keyEdit(current)) {
        const detail = keyEdit(current ?? before) ? [keyEditDetail] : undefined;
        steps.push({ kind: 'dropKey', column: before.name, sql: ddl.dropFk!(obj, fkName(before)), title: `Drop foreign key ${fkName(before)}`, ...(detail ? { detail } : {}) });
      }
    }
    for (const k of keyDrops.filter((x) => x.kind === 'fk')) {
      steps.push({ kind: 'dropKey', column: k.cols.join(', '), sql: ddl.dropFk!(obj, k.name!), title: `Drop foreign key ${k.name}` });
    }
    for (const before of original) {
      if (!before.unique) continue;
      const current = liveOf(before);
      if ((!current && !ddl.dropKeepsKeys) || (current && !current.unique) || keyEdit(current ?? before)) {
        const detail = keyEdit(current ?? before) ? [keyEditDetail] : undefined;
        steps.push({ kind: 'dropKey', column: before.name, sql: ddl.dropUnique!(obj, uqName(before), !!before.uqIndex),
          title: `Drop unique ${uqName(before)}`, ...(detail ? { detail } : {}) });
      }
    }
    for (const k of keyDrops.filter((x) => x.kind === 'unique')) {
      steps.push({ kind: 'dropKey', column: k.cols.join(', '), sql: ddl.dropUnique!(obj, k.name!, !!k.index), title: `Drop unique ${k.name}` });
    }
    for (const before of original) {
      const current = liveOf(before);
      if (ddl.setAi && before.ai && current && !current.ai) {
        steps.push({ kind: 'ai', column: before.name, sql: ddl.setAi(obj, clean(before), false), title: `Remove ${aiLabel} from ${before.name}` });
      }
    }
    if (pkNeedsStep && oldPk.length && !replacePk) {
      const pkName = oldPk.find((c) => c.pkName)?.pkName;
      const detail = oldPkEdit ? [keyEditDetail] : undefined;
      steps.push({ kind: 'dropKey', column: oldPk[0].name, sql: ddl.dropPk!(obj, pkName),
        title: `Drop primary key${pkName ? ` ${pkName}` : ''}`, ...(detail ? { detail } : {}) });
    }
  }

  // SQLite: perubahan selain nama dikerjakan satu rebuild tabel di awal (nama asal), rename / drop / add sesudahnya
  const rebuilt = ddl.rebuild ? live.filter((r) => r.orig && diffColumn(old(r), clean(r)).length) : [];
  if (rebuilt.length) steps.push({ kind: 'rebuild', column: obj.name, sql: ddl.rebuild!(obj, original, rebuilt.map((r) => ({ ...clean(r), name: r.orig! }))),
    detail: rebuilt.map((r) => `${r.orig}: ${diffColumn(old(r), clean(r)).join(', ')}`) });
  steps.push(...rows.filter((r) => r.deleted && r.orig).map((r): ColumnStep => ({
    kind: 'drop', column: r.orig!, sql: ddl.drop(obj, r.orig!), title: `Drop ${r.orig}`,
  })));
  steps.push(...live.filter((r) => r.orig && !sameCol(old(r), clean(r))).map((r): ColumnStep => {
    const next = { ...clean(r), ai: !!old(r).ai && !!r.ai, gen: old(r).gen, keep: old(r).keep };
    return { kind: 'edit', column: r.orig!, ...(clean(r).name !== r.orig ? { to: clean(r).name } : {}),
      sql: ddl.edit(obj, old(r), next), detail: diffColumn(old(r), next),
      title: r.orig === clean(r).name ? `Change ${r.orig}` : `Change ${r.orig} to ${clean(r).name}` };
  }));
  steps.push(...live.filter((r) => !r.orig).map((r): ColumnStep => {
    const index = rows.indexOf(r);
    const previous = rows.slice(0, index).reverse().find((candidate) => !candidate.deleted && (candidate.orig || candidate.name.trim() || candidate.type.trim()));
    const pos = ddl.move || (ddl.aiNeedsKey && r.ai && r.pk)
      ? { ...(ddl.move ? { after: previous ? nameOf(previous) : null } : {}),
        ...(ddl.aiNeedsKey && r.ai && r.pk ? { pkCols: newPk.map(nameOf) } : {}) }
      : undefined;
    return { kind: 'add', column: clean(r).name, sql: ddl.add(obj, { ...clean(r), pk: r.pk, unique: r.unique, fk: r.fk }, pos), title: `Add ${clean(r).name}` };
  }));
  if (ddl.move) {
    const deleted = new Set(rows.filter((r) => r.deleted && r.orig).map((r) => r.orig!));
    const simulated = original.filter((r) => !deleted.has(r.name)).map((r) => {
      const current = liveOf(r);
      return current ? nameOf(current) : r.name;
    });
    for (const r of live.filter((x) => !x.orig)) {
      const index = rows.indexOf(r);
      const previous = rows.slice(0, index).reverse().find((candidate) => !candidate.deleted && (candidate.orig || candidate.name.trim() || candidate.type.trim()));
      const after = previous ? nameOf(previous) : null;
      const at = after ? simulated.indexOf(after) + 1 : 0;
      simulated.splice(at < 0 ? simulated.length : at, 0, nameOf(r));
    }
    for (const move of moveSteps(simulated, live.map(nameOf))) {
      const current = live.find((r) => nameOf(r) === move.col)!;
      const before = current.orig ? old(current) : undefined;
      const final = { ...clean(current), ai: before ? !!before.ai && !!current.ai : current.ai,
        keep: before?.keep ?? current.keep, gen: before?.gen ?? current.gen };
      steps.push({ kind: 'move', column: move.col, sql: ddl.move(obj, final, move.after),
        title: move.after ? `Move ${move.col} after ${move.after}` : `Move ${move.col} to first` });
    }
  }
  if (editableKeys) {
    if (replacePk) {
      const names = newPk.map(nameOf);
      steps.push({ kind: 'addKey', column: names.join(', '), sql: ddl.replacePk!(obj, names), title: `Replace primary key (${names.join(', ')})` });
    } else if (pkNeedsStep && newPk.length && !inlinePk) {
      const names = newPk.map(nameOf);
      const name = oldPkEdit ? oldPk.find((c) => c.pkName)?.pkName : undefined;
      const detail = oldPkEdit ? [keyEditDetail] : undefined;
      steps.push({ kind: 'addKey', column: names.join(', '), sql: ddl.addPk!(obj, names, name),
        title: `Add primary key${name ? ` ${name}` : ` PK_${obj.name}`} (${names.join(', ')})`, ...(detail ? { detail } : {}) });
    }
    for (const r of live) {
      if (!r.unique || (r.orig && old(r).unique)) {
        if (!(r.unique && r.orig && keyEdit(r))) continue;
        const before = old(r);
        const name = before.uqName;
        const detail = [keyEditDetail];
        steps.push({ kind: 'addKey', column: nameOf(r), sql: ddl.addUnique!(obj, [nameOf(r)], name, !!before.uqIndex),
          title: `Add unique ${name ?? `UQ_${obj.name}_${nameOf(r)}`} (${nameOf(r)})`, detail });
        continue;
      }
      if (r.orig && keyEdit(r)) continue;
      const name = `UQ_${obj.name}_${nameOf(r)}`;
      steps.push({ kind: 'addKey', column: nameOf(r), sql: ddl.addUnique!(obj, [nameOf(r)]),
        title: `Add unique ${name} (${nameOf(r)})` });
    }
    for (const { key: k, name, detail } of keyAdds.filter((x) => x.key.kind === 'unique')) {
      steps.push({ kind: 'addKey', column: k.cols.join(', '), sql: ddl.addUnique!(obj, k.cols, name, !!k.index),
        title: `Add unique ${name} (${k.cols.join(', ')})`, ...(detail ? { detail } : {}) });
    }
    for (const before of original) {
      const current = liveOf(before);
      if (ddl.setAi && current && !before.ai && current.ai) {
        steps.push({ kind: 'ai', column: nameOf(current), sql: ddl.setAi(obj, clean(current), true),
          title: `Set ${aiLabel} on ${nameOf(current)}` });
      }
    }
    for (const r of live) {
      if (!r.fk) continue;
      const before = r.orig ? old(r) : undefined;
      const needsAdd = !before?.fk || !sameFk(before.fk, r.fk) || keyEdit(r);
      if (!needsAdd) continue;
      const name = keyEdit(r) ? before?.fk?.name : undefined;
      const fk = { ...r.fk, ...(name ? { name } : {}) };
      const detail = keyEdit(r) ? [keyEditDetail] : undefined;
      const actions = [
        ...(fk.onDelete && fk.onDelete !== 'NO ACTION' ? [` ON DELETE ${fk.onDelete}`] : []),
        ...(fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? [` ON UPDATE ${fk.onUpdate}`] : []),
      ].join('');
      const fkTitle = name ?? `FK_${obj.name}_${nameOf(r)}`;
      steps.push({ kind: 'addKey', column: nameOf(r), sql: ddl.addFk!(obj, [nameOf(r)], { schema: fk.schema, table: fk.table, columns: [fk.column], onDelete: fk.onDelete, onUpdate: fk.onUpdate }, fk.name),
        title: `Add foreign key ${fkTitle} (${nameOf(r)}) → ${fk.table}(${fk.column})${actions}`, ...(detail ? { detail } : {}) });
    }
    for (const { key: k, name, detail } of keyAdds.filter((x) => x.key.kind === 'fk')) {
      steps.push({ kind: 'addKey', column: k.cols.join(', '), sql: ddl.addFk!(obj, k.cols, k.ref!, name),
        title: `Add foreign key ${name} (${k.cols.join(', ')}) → ${k.ref!.table}(${k.ref!.columns.join(', ')})${fkActs(k.ref!)}`, ...(detail ? { detail } : {}) });
    }
  }
  if (ddl.keyRebuild && (keyDrops.length || keyAdds.length)) {
    // rebuild key memakai definisi tabel dari server: tidak digabung dengan perubahan kolom pada Execute yang sama
    if (steps.length) return { sql: '', errors: ['Apply column changes and key changes separately (each rebuilds the table)'], count: 0, steps: [] };
    try {
      steps.push({ kind: 'rebuild', column: obj.name, sql: ddl.keyRebuild(obj, original, keyDrops, keyAdds.map((a) => ({ ...a.key, name: a.name }))),
        title: 'Rebuild table for key changes', detail: [...keyDrops.map((k) => `drop ${k.name} (${k.cols.join(', ')})`), ...keyAdds.map((a) => `add ${a.name} (${a.key.cols.join(', ')})`)] });
    } catch (e) {
      // definisi tabel tidak bisa dipetakan: berhenti (fail closed), tidak ada script
      driverLog.error(`columnChanges keyRebuild - EXCEPTION CAUGHT | ${obj.name}: ${(e as Error).message} - stack-trace: ${(e as Error).stack}`);
      return { sql: '', errors: [(e as Error).message], count: 0, steps: [] };
    }
  }
  const sql = steps.map((x) => x.sql).join(ddl.separator);
  return { sql: sql && ddl.wrap ? ddl.wrap(sql) : sql, errors: [], count: steps.length, steps };
}

/** minimal moves needed to make the server's column order match the grid */
export function moveSteps(server: string[], grid: string[]): { col: string; after: string | null }[] {
  const simulated = [...server];
  const moves: { col: string; after: string | null }[] = [];
  for (let i = 0; i < grid.length; i++) {
    const col = grid[i];
    const index = simulated.indexOf(col);
    if (index < 0) continue;
    const after = grid[i - 1] ?? null;
    const actualAfter = simulated[index - 1] ?? null;
    if (actualAfter === after) continue;
    moves.push({ col, after });
    simulated.splice(index, 1);
    const previous = after === null ? -1 : simulated.indexOf(after);
    simulated.splice(previous < 0 ? 0 : previous + 1, 0, col);
  }
  return moves;
}

/** detail teks konfirmasi Execute untuk data dan constraints yang terdampak */
/** keys = key tabel dari server (originalKeys); kolom anggota key yang dihapus sudah ditolak columnChanges */
export function columnsConfirm(ddl: ColumnDdl, steps: ColumnStep[], rows: ColumnRow[], keys: TableKey[]): string {
  const lines: string[] = [];
  const deleted = rows.filter((r) => r.deleted && r.orig);
  if (deleted.length) lines.push(`Deleted columns lose their data: ${deleted.map((r) => r.orig).join(', ')}.`);
  const dropped = steps.filter((s) => s.kind === 'dropKey').map((s) => {
    if (s.title === 'Drop primary key') return 'primary key';
    return s.title?.replace(/^Drop (?:foreign key|unique|primary key)\s*/, '') || s.column;
  });
  if (dropped.length) lines.push(`Constraints dropped: ${dropped.join(', ')}.`);
  // MySQL: unique index yang awal kolomnya sama dengan FK yang tetap ada bisa menjadi index FK itu (error 1553 saat di-drop)
  if (ddl.dropKeepsKeys) {
    const droppedName = (prefix: string) => steps.filter((s) => s.kind === 'dropKey' && s.title?.startsWith(prefix)).map((s) => s.title!.slice(prefix.length));
    const goneFk = new Set(droppedName('Drop foreign key '));
    const fks = [...keys.filter((k) => k.kind === 'fk').map((k) => ({ name: k.name ?? '', cols: k.cols })),
      ...rows.filter((r) => r.orig && r.fk?.name).map((r) => ({ name: r.fk!.name!, cols: [r.orig!] }))].filter((f) => !goneFk.has(f.name));
    for (const uq of droppedName('Drop unique ')) {
      const cols = keys.find((k) => k.kind === 'unique' && k.name === uq)?.cols ?? rows.filter((r) => r.uqName === uq).map((r) => r.orig!);
      for (const f of fks.filter((x) => x.cols.every((c, i) => cols[i] === c))) {
        lines.push(`${uq} may be the index behind foreign key ${f.name}; MySQL refuses the drop (error 1553) unless another index starts with ${f.cols.join(', ')}.`);
      }
    }
  }
  if (steps.some((s) => s.kind === 'move')) lines.push('Moving columns rebuilds the table; on a big table this takes time and locks writes.');
  if (steps.some((s) => s.title?.startsWith('Drop primary key') || s.title?.startsWith('Add primary key') || s.title?.startsWith('Replace primary key'))) {
    lines.push('Changing the primary key rebuilds its index.');
  }
  lines.push('The script in SQL preview is executed and committed.');
  if (ddl.note) lines.push(ddl.note);
  return lines.join('\n');
}

/** jalankan script Columns; SQL Server memakai sesi agar semua batch berada pada satu koneksi */
export async function execScript(d: Pick<Driver, 'run' | 'session'>, c: ConnectionInfo, password: string, sql: string, oneConnection: boolean): Promise<void> {
  if (!oneConnection) {
    await d.run(c, password, sql);
    return;
  }
  const session = await d.session(c, password);
  let failed = false;
  try {
    await session.run(sql);
    await session.commit();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    try {
      await session.close();
    } catch (e) {
      driverLog.error(`execScript close - EXCEPTION CAUGHT | ${errText(e)}`);
      // eslint-disable-next-line no-unsafe-finally -- error close hanya dilempar bila script sendiri sukses
      if (!failed) throw e;
    }
  }
}

/** isian form New Database; choice = daftar yang bisa dicari (value '' = default server), group = bagian yang bisa dilipat */
export interface DbField {
  key: string;
  label: string;
  /** password: input tersembunyi, tampil *** di preview / Open in SQL Editor (lihat maskSecrets) */
  kind: 'text' | 'number' | 'choice' | 'password';
  group?: string;
  hint?: string;
  /** pilihan choice; run = jalankan query di koneksi (semua baris, mis. 5500 collation) */
  items?(run: (sql: string) => Promise<{ resultSets: { rows: unknown[][] }[] }>): Promise<{ value: string; label?: string }[]>;
}

/** New Database (form tab): isian per database lalu script CREATE DATABASE */
export interface NewDatabase {
  maxName: number;
  /** sebutan objek di pesan validasi nama (default 'Database'), mis. 'Linked server' */
  noun?: string;
  fields: DbField[];
  /** pesan error isian; kosong = valid */
  check(values: Record<string, string>): string[];
  script(name: string, values: Record<string, string>): string;
  /** jalankan script dengan database baru sebagai database koneksi (MongoDB: database dibuat lewat koleksi pertama) */
  useNewDatabase?: boolean;
  /** validasi nama database tambahan; undefined = valid */
  checkName?(name: string): string | undefined;
}

/** script New Database atau daftar error (script kosong bila ada error) */
export function newDatabaseScript(nd: NewDatabase, name: string, values: Record<string, string>): { sql: string; errors: string[] } {
  const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, x.trim()]));
  const errors = [checkDbName(name, nd.maxName, nd.noun) ?? nd.checkName?.(name.trim()), ...nd.check(v)].filter((e): e is string => !!e);
  return errors.length ? { sql: '', errors } : { sql: nd.script(name.trim(), v), errors: [] };
}

/** validasi nama database baru; undefined = valid */
export function checkDbName(name: string, max: number, noun = 'Database'): string | undefined {
  if (!name.trim()) return `${noun} name is required`;
  if (name.trim().length > max) return `${noun} name is at most ${max} characters`;
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
  /** Drop Database (klik kanan database, konfirmasi modal): script; inside = dijalankan dengan database itu sebagai database koneksi (MongoDB); system = database yang tidak boleh di-drop */
  dropDatabase?: { script(db: string): string; inside?: boolean; system?: string[] };
  /** Drop Table (klik kanan tabel, konfirmasi modal): script, dijalankan di database tabel */
  dropTable?(obj: DbObject): string;
  /** nama tabel lengkap + quote untuk script INSERT (Add Data); tidak ada = Add Data tidak tersedia */
  tableRef?(obj: DbObject): string;
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

/** koneksi untuk menjalankan Drop Database: tidak boleh memakai database yang di-drop (MongoDB: justru database itu sendiri) */
export function dropTarget(conn: ConnectionInfo, db: string, d: Pick<Driver, 'defaultDb' | 'dropDatabase'>): ConnectionInfo {
  if (d.dropDatabase?.inside) return { ...conn, database: db };
  let use = conn.database && conn.database !== db ? conn.database : d.defaultDb;
  if (use === db) use = 'template1'; // shortcut: PostgreSQL saja yang defaultDb-nya bisa sama dengan database yang di-drop
  return { ...conn, database: use };
}

/** teks popup konfirmasi modal Drop Database / Drop Table */
export function dropConfirm(kind: 'database' | 'table', name: string, where: string, sql: string): { message: string; detail: string } {
  return {
    message: `Drop ${kind} ${name} on ${where}?`,
    detail: `This permanently deletes the ${kind} and all its ${kind === 'database' ? 'data' : 'rows'}. It cannot be undone.\n\n${sql}`,
  };
}

/** isian password diganti *** (preview / Open in SQL Editor); nilai asli hanya dipakai saat Execute */
export function maskSecrets(nd: NewDatabase, values: Record<string, string>): Record<string, string> {
  const secret = new Set(nd.fields.filter((f) => f.kind === 'password').map((f) => f.key));
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secret.has(k) && v ? '***' : v]));
}

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { Database, SqlJsStatic } from 'sql.js';
import type { ColumnDdl, ColumnDef, ColumnRow, ConnectionInfo, DbObject, ListKind, NewColumn, ObjectKind, TypeSpec } from './db';
import { maskSql, splitStatements } from './sqlContext';
import { driverLog } from './log';
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

/** New Database SQLite: file database kosong yang valid; file yang sudah ada tidak ditimpa */
export async function createSqliteFile(file: string): Promise<void> {
  if (existsSync(file)) throw new Error(`File already exists: ${file}`);
  const SQL = await (engine ??= initSqlJs());
  const db = new SQL.Database();
  try {
    save({ file } as ConnectionInfo, db);
  } finally {
    db.close();
  }
}

/** nama koneksi dari nama file tanpa ekstensi; sudah dipakai -> "nama (2)", "nama (3)", ... */
export function uniqueConnName(file: string, taken: string[]): string {
  const base = (file.split(/[\\/]/).pop() ?? '').replace(/(.)\.[^.]*$/, '$1');
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base} (${i})`;
  return name;
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
      } catch (e) {
        // script dengan BEGIN sendiri (mis. editor Columns) yang gagal di tengah: transaksinya dibatalkan, bukan disimpan setengah jadi
        if (!session && splitStatements(sql).some((x) => /^\s*begin\b/i.test(maskSql(x)))) {
          try {
            db.exec('ROLLBACK');
          } catch (r) {
            driverLog.error(`sqlite rollback - EXCEPTION CAUGHT | ${conn.name}: ${(r as Error).message} - stack-trace: ${(r as Error).stack}`);
          }
        }
        throw e;
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

const KIND: Record<ListKind, string> = {
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

/** token SQL tingkat atas: string / identifier ber-quote, grup kurung utuh, kata, atau satu karakter */
function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const close: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };
  const quoted = (j: number) => {
    const end = close[text[j]];
    for (j++; j < text.length; j++) {
      if (text[j] !== end) continue;
      if (end !== ']' && text[j + 1] === end) { j++; continue; } // quote ganda = escape
      return j + 1;
    }
    return j;
  };
  while (i < text.length) {
    const ch = text[i];
    let j = i + 1;
    if (/\s/.test(ch)) { i++; continue; }
    if (close[ch]) j = quoted(i);
    else if (ch === '(') {
      for (let depth = 0; j <= text.length; ) {
        const c = text[j - 1];
        if (close[c] && j - 1 > i) { j = quoted(j - 1) + 1; continue; }
        depth += c === '(' ? 1 : c === ')' ? -1 : 0;
        if (depth === 0) break;
        j++;
      }
    } else if (/[\w$.]/.test(ch)) while (j < text.length && /[\w$.]/.test(text[j])) j++;
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

/** pisah isi CREATE TABLE (...) per koma tingkat atas, spasi awal tiap bagian tetap */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0, q = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) { if (ch === q) q = ''; continue; } // quote ganda: tutup lalu buka lagi, hasilnya sama
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if (ch === '[') q = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  return [...parts, body.slice(start)];
}

const START = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS']);
const unquote = (t: string) => (/^["`[]/.test(t) ? t.slice(1, -1) : t).toLowerCase();

/** definisi kolom baru: tipe / NULL / DEFAULT diganti, constraint lain (PK, CHECK, COLLATE, REFERENCES, ...) dibawa */
function rewriteColumn(def: string, c: ColumnDef): string {
  const t = tokens(def);
  let i = 1;
  while (i < t.length && !START.has(t[i].toUpperCase())) i++; // tipe lama
  const kept: string[] = [];
  let prefix: string[] = [];
  while (i < t.length) {
    const kw = t[i].toUpperCase();
    const clause = [t[i++]];
    if (kw === 'CONSTRAINT') { prefix = [clause[0], t[i++]]; continue; }
    if (kw === 'DEFAULT') clause.push(...t.slice(i, i += /^[-+]$/.test(t[i]) ? 2 : 1));
    else {
      // klausa berlanjut sampai kata awal klausa berikutnya; di REFERENCES: SET NULL / SET DEFAULT / NOT DEFERRABLE masih bagian FK
      const fk = kw === 'REFERENCES';
      const starts = (j: number) => {
        const w = t[j].toUpperCase();
        if (kw === 'NOT' && j === i && w === 'NULL') return false;
        if (fk && ((w === 'NULL' || w === 'DEFAULT') && t[j - 1].toUpperCase() === 'SET')) return false;
        if (fk && w === 'NOT' && t[j + 1]?.toUpperCase() === 'DEFERRABLE') return false;
        return START.has(w);
      };
      while (i < t.length && !starts(i)) clause.push(t[i++]);
    }
    if (!['NOT', 'NULL', 'DEFAULT'].includes(kw)) kept.push(...prefix, ...clause);
    prefix = [];
  }
  return [t[0], c.type.trim(), ...kept, ...(c.nullable ? [] : ['NOT NULL']), ...(c.default?.trim() ? [`DEFAULT ${c.default.trim()}`] : [])].join(' ');
}

/**
 * rebuild tabel SQLite (langkah resmi "making other kinds of table schema changes"): tabel baru dari CREATE asli dengan definisi kolom
 * yang berubah ditulis ulang, salin data, drop, rename, index / trigger dibuat lagi. bundle = JSON { create, extras } dari Show.
 */
export function sqliteRebuild(o: DbObject, bundle: string, copy: string[], changed: ColumnDef[]): string {
  const { create, extras } = JSON.parse(bundle) as { create: string; extras: string[] };
  const t = tokens(create);
  const group = t.find((x) => x.startsWith('('));
  if (!group) throw new Error(`Cannot read the definition of table ${o.name}`);
  const at = create.indexOf(group, create.indexOf(t[t.indexOf(group) - 1]) + t[t.indexOf(group) - 1].length);
  const body = splitTop(group.slice(1, -1)).map((part) => {
    const name = tokens(part)[0] ?? '';
    const c = !START.has(name.toUpperCase()) && name.toUpperCase() !== 'FOREIGN' && changed.find((x) => x.name.toLowerCase() === unquote(name));
    return c ? `${/^\s*/.exec(part)![0]}${rewriteColumn(part, c)}` : part;
  }).join(',');
  const tmp = quote(`${o.name}__moonage_new`);
  const cols = copy.map(quote).join(', ');
  return [
    `CREATE TABLE ${tmp} (${body})${create.slice(at + group.length)};`,
    `INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${quote(o.name)};`,
    `DROP TABLE ${quote(o.name)};`,
    // legacy: RENAME TO tidak memeriksa ulang view yang menunjuk tabel lama (sudah di-drop)
    'PRAGMA legacy_alter_table = ON;',
    `ALTER TABLE ${tmp} RENAME TO ${quote(o.name)};`,
    'PRAGMA legacy_alter_table = OFF;',
    ...extras.map((x) => `${x};`),
  ].join('\n');
}

const litLite = (s: string) => `'${s.replace(/'/g, "''")}'`;
const affinity = (a: string) => `affinity ${a}`;

/** SQLite: tipe = afinitas + nama umum (dipetakan ke afinitas, ukuran tidak dipaksa) */
export const SQLITE_TYPES: TypeSpec[] = [
  ...['integer', 'real', 'text', 'blob', 'numeric'].map((name) => ({ name, group: 'Affinity', note: affinity(name.toUpperCase()) })),
  ...['int', 'bigint', 'smallint', 'tinyint'].map((name) => ({ name, group: 'Common names', note: affinity('INTEGER') })),
  { name: 'boolean', group: 'Common names', note: `${affinity('NUMERIC')}, stored as 0 / 1` },
  { name: 'decimal', group: 'Common names', args: 'precisionScale', max: 1000, def: '10,2', note: `${affinity('NUMERIC')}, size not enforced` },
  ...['double', 'float'].map((name) => ({ name, group: 'Common names', note: affinity('REAL') })),
  { name: 'varchar', group: 'Common names', args: 'length', max: 1000000000, def: '100', note: `${affinity('TEXT')}, length not enforced` },
  { name: 'char', group: 'Common names', args: 'length', max: 1000000000, def: '10', note: `${affinity('TEXT')}, length not enforced` },
  ...['date', 'datetime'].map((name) => ({ name, group: 'Common names', note: `${affinity('NUMERIC')}, usually ISO-8601 text` })),
];

export const sqliteColumnDdl: ColumnDdl = {
  separator: '\n',
  newType: 'text',
  note: 'SQLite runs the whole script in one transaction: if a step fails, no change is applied. Type / NULL / default changes rebuild the table (data is copied to a new table).',
  types: SQLITE_TYPES,
  // keep = CREATE TABLE + index / trigger tabel (JSON), dipakai rebuild
  show: (o) => `SELECT p.cid + 1 AS ordinal, p.name AS column_name, p.type AS data_type, CASE WHEN p."notnull" THEN 'NO' ELSE 'YES' END AS nullable,
  p.dflt_value AS default_value, CASE WHEN p.pk > 0 THEN 'PK' ELSE '' END AS primary_key,
  CASE p.hidden WHEN 2 THEN 'VIRTUAL' WHEN 3 THEN 'STORED' END AS generated,
  (SELECT json_object('create', m.sql, 'extras', (SELECT json_group_array(x.sql) FROM sqlite_master x
    WHERE x.tbl_name = m.name AND x.type IN ('index', 'trigger') AND x.sql IS NOT NULL)) FROM sqlite_master m WHERE m.type = 'table' AND m.name = ${litLite(o.name)}) AS keep
FROM pragma_table_xinfo(${litLite(o.name)}) p
WHERE p.hidden <> 1
ORDER BY p.cid;`,
  add: (o, c) => `ALTER TABLE ${quote(o.name)} ADD COLUMN ${quote(c.name)} ${c.type.trim()}${c.nullable ? '' : ' NOT NULL'}${c.default?.trim() ? ` DEFAULT ${c.default.trim()}` : ''};`,
  drop: (o, name) => `ALTER TABLE ${quote(o.name)} DROP COLUMN ${quote(name)};`,
  // tipe / NULL / default dikerjakan rebuild (langkah pertama); di sini hanya nama
  edit: (o, old, next) => (next.name !== old.name ? `ALTER TABLE ${quote(o.name)} RENAME COLUMN ${quote(old.name)} TO ${quote(next.name)};`
    : `-- ${quote(old.name)}: type / NULL / default changed by the table rebuild (step 1)`),
  check(c, old, cols) {
    // New Table: AUTOINCREMENT hanya di kolom INTEGER PRIMARY KEY tunggal (alias rowid)
    if (cols) return (c as NewColumn).ai && !((c as NewColumn).pk && c.type.toLowerCase() === 'integer' && cols.filter((x) => x.pk).length === 1)
      ? 'auto increment needs integer PRIMARY KEY alone (SQLite)' : undefined;
    return !old && !c.nullable && !c.default?.trim() ? 'a new NOT NULL column needs a default (SQLite)' : undefined;
  },
  aiTypes: ['integer'],
  fkActions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  // schema diabaikan: satu file = satu database (main)
  create(o, cols) {
    const act = (k: string, v?: string) => (v && v !== 'NO ACTION' ? ` ON ${k} ${v}` : '');
    const pk = cols.filter((c) => c.pk);
    const ai = cols.some((c) => c.ai);
    const lines = [
      ...cols.map((c) => `${quote(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`
        + (c.ai ? ` CONSTRAINT ${quote(`PK_${o.name}`)} PRIMARY KEY AUTOINCREMENT` : '')),
      ...(pk.length && !ai ? [`CONSTRAINT ${quote(`PK_${o.name}`)} PRIMARY KEY (${pk.map((c) => quote(c.name)).join(', ')})`] : []),
      ...cols.filter((c) => c.unique).map((c) => `CONSTRAINT ${quote(`UQ_${o.name}_${c.name}`)} UNIQUE (${quote(c.name)})`),
      ...cols.filter((c) => c.fk).map(({ name, fk }) => `CONSTRAINT ${quote(`FK_${o.name}_${name}`)} FOREIGN KEY (${quote(name)}) REFERENCES ${quote(fk!.table)} (${quote(fk!.column)})`
        + act('DELETE', fk!.onDelete) + act('UPDATE', fk!.onUpdate)),
    ];
    return [`CREATE TABLE ${quote(o.name)} (`, lines.map((l) => `  ${l}`).join(',\n'), ');'].join('\n');
  },
  rebuild: (o, original: ColumnRow[], changed) => sqliteRebuild(o, original[0]?.keep ?? '{}', original.filter((c) => !c.generated).map((c) => c.name), changed),
  wrap: (sql) => `BEGIN;\n${sql}\nCOMMIT;`,
};

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
  columnDdl: sqliteColumnDdl,

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

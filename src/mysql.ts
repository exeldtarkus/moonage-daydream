import * as mysql from 'mysql2/promise';
import { Types } from 'mysql2';
import type { ColumnDdl, ColumnDef, ConnectionInfo, Driver, ListKind, ObjectKind, ProcParam, TypeSpec } from './db';
import { connectMs, typedOptions } from './db';
import { sqlDriver } from './sqlDriver';
import type { Link, Raw } from './sqlDriver';

/** pool per koneksi + database (database bisa beda per file .sql) */
const pools = new Map<string, mysql.Pool>();

/** quote identifier MySQL: `nama`` aneh` */
export const quoteMy = (s: string) => `\`${s.replace(/`/g, '``')}\``;

export const mysqlConfig = (conn: ConnectionInfo, password: string, db?: string): mysql.ConnectionOptions => ({
  ...typedOptions(conn.options),
  host: conn.host, port: conn.port, user: conn.user, password, database: (db ?? conn.database) || undefined, connectTimeout: connectMs(conn),
  ...(conn.ssl ? { ssl: { rejectUnauthorized: !conn.trustServerCertificate } } : {}),
  // beberapa statement sekaligus (seperti batch SQL Server); tanggal sebagai teks apa adanya (tanpa geser zona waktu); BIGINT / DECIMAL tanpa pembulatan
  multipleStatements: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
});

function pool(conn: ConnectionInfo, password: string, db?: string): mysql.Pool {
  const key = `${conn.name}\n${(db ?? conn.database) || ''}`;
  let p = pools.get(key);
  if (!p) {
    p = mysql.createPool({ ...mysqlConfig(conn, password, db), connectionLimit: 5 });
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
    // paket OK membawa flag SERVER_STATUS_IN_TRANS; DO 0 = statement kosong yang membalas paket OK
    async txState() {
      const [r] = await c.query('DO 0');
      return (r as mysql.ResultSetHeader).serverStatus & 1 ? 'open' : 'idle';
    },
  };
}

/** Edit: view = CREATE OR REPLACE; procedure / function = DROP IF EXISTS + CREATE (MySQL tidak punya OR REPLACE untuk routine) */
export function myEditScript(type: 'VIEW' | 'PROCEDURE' | 'FUNCTION', db: string, name: string, create: string): string {
  const body = create.trimEnd().replace(/;$/, '');
  if (type === 'VIEW') return `${body.replace(/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?/i, 'CREATE OR REPLACE ')};`;
  return `-- run the whole script (DROP + CREATE)\nDROP ${type} IF EXISTS ${quoteMy(db)}.${quoteMy(name)};\n${body};`;
}

/** Run: CALL procedure (OUT / INOUT lewat variabel @nama lalu di-SELECT) atau SELECT function, semua argumen NULL */
export function myRunScript(db: string, name: string, type: 'PROCEDURE' | 'FUNCTION', params: ProcParam[]): string {
  const target = `${quoteMy(db)}.${quoteMy(name)}`;
  const args = params.map((p, i) => `${i ? '  , ' : '    '}${p.output ? `@${p.name} -- ${p.mode === 'inout' ? 'INOUT' : 'OUT'} ${p.name} ${p.type}` : `NULL -- ${p.name} ${p.type}`}`);
  if (type === 'FUNCTION') return params.length ? `SELECT ${target}(\n${args.join('\n')}\n) AS \`result\`;` : `SELECT ${target}() AS \`result\`;`;
  if (!params.length) return `CALL ${target}();`;
  const outs = params.filter((p) => p.output);
  return [...outs.map((p) => `SET @${p.name} = NULL;`), `CALL ${target}(`, ...args, ');',
    ...(outs.length ? [`SELECT ${outs.map((p) => `@${p.name} AS ${quoteMy(p.name)}`).join(', ')};`] : [])].join('\n');
}

/** PROCEDURE / FUNCTION dari information_schema.routines */
/** literal string MySQL; shortcut: anggap backslash escape aktif (tanpa NO_BACKSLASH_ESCAPES), cukup untuk nama tabel */
const litMy = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const INTS = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'];

/** tipe data bawaan MySQL 8.4 / MariaDB 11 (satu daftar untuk keduanya), urut dropdown editor Columns */
export const MY_TYPES: TypeSpec[] = [
  { name: 'tinyint', group: 'Integer', args: 'length', max: 255, note: 'tinyint(1) = boolean; other display widths are deprecated' },
  ...INTS.slice(1).map((name) => ({ name, group: 'Integer' })),
  ...INTS.map((name) => ({ name: `${name} unsigned`, group: 'Integer' })),
  { name: 'decimal', group: 'Fixed / floating point', args: 'precisionScale', max: 65, def: '10,2', note: 'scale up to 30' },
  { name: 'float', group: 'Fixed / floating point', args: 'precisionScale', max: 255, note: 'float(M,D) is deprecated' },
  { name: 'double', group: 'Fixed / floating point', args: 'precisionScale', max: 255, note: 'double(M,D) is deprecated' },
  { name: 'bit', group: 'Fixed / floating point', args: 'length', max: 64, def: '1' },
  { name: 'char', group: 'Text', args: 'length', max: 255, def: '10' },
  { name: 'varchar', group: 'Text', args: 'length', max: 65535, def: '100', note: 'row size limit 65535 bytes' },
  ...['tinytext', 'text', 'mediumtext', 'longtext'].map((name) => ({ name, group: 'Text' })),
  { name: 'enum', group: 'Text', args: 'values', def: "'a','b'", note: "list of values, e.g. 'a','b'" },
  { name: 'set', group: 'Text', args: 'values', def: "'a','b'", note: "list of values, e.g. 'a','b'" },
  { name: 'binary', group: 'Binary', args: 'length', max: 255, def: '16' },
  { name: 'varbinary', group: 'Binary', args: 'length', max: 65535, def: '255' },
  ...['tinyblob', 'blob', 'mediumblob', 'longblob'].map((name) => ({ name, group: 'Binary' })),
  { name: 'date', group: 'Date and time' },
  { name: 'time', group: 'Date and time', args: 'scale', max: 6 },
  { name: 'datetime', group: 'Date and time', args: 'scale', max: 6 },
  { name: 'timestamp', group: 'Date and time', args: 'scale', max: 6 },
  { name: 'year', group: 'Date and time', args: 'length', max: 4, note: 'MariaDB shows year(4)' },
  { name: 'json', group: 'Other', note: 'MariaDB: alias of longtext with a JSON check' },
  ...['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'].map((name) => ({ name, group: 'Spatial' })),
  { name: 'uuid', group: 'MariaDB', note: 'MariaDB 10.7+' },
  { name: 'inet4', group: 'MariaDB', note: 'MariaDB 10.10+' },
  { name: 'inet6', group: 'MariaDB', note: 'MariaDB 10.5+' },
];

const myTbl = (o: { schema: string; name: string }) => (o.schema ? `${quoteMy(o.schema)}.${quoteMy(o.name)}` : quoteMy(o.name));
const myCol = (c: ColumnDef, collate = '', rest = '') => `${quoteMy(c.name)} ${c.type.trim()}${collate ? ` ${collate}` : ''} ${c.nullable ? 'NULL' : 'NOT NULL'}`
  + `${c.default?.trim() ? ` DEFAULT ${c.default.trim()}` : ''}${rest ? ` ${rest}` : ''}`;

export const myColumnDdl: ColumnDdl = {
  separator: '\n',
  newType: 'varchar(100)',
  note: 'MySQL / MariaDB DDL commits implicitly: steps before a failing step stay applied (no rollback).',
  types: MY_TYPES,
  // tipe integer tanpa display width (MariaDB: int(11)) kecuali tinyint(1); default MySQL dikembalikan ke bentuk ekspresi SQL
  show: (o) => `SELECT ordinal_position AS ordinal, column_name AS column_name,
  CASE WHEN data_type IN (${INTS.map(litMy).join(', ')}) AND column_type NOT LIKE '%zerofill%' AND column_type NOT LIKE 'tinyint(1)%'
    THEN CONCAT(data_type, IF(column_type LIKE '%unsigned', ' unsigned', '')) ELSE column_type END AS data_type,
  is_nullable AS nullable,
  CASE WHEN column_default IS NULL THEN NULL
    WHEN VERSION() LIKE '%MariaDB%' THEN NULLIF(column_default, 'NULL')
    WHEN extra LIKE '%DEFAULT_GENERATED%' THEN IF(column_default LIKE 'current_timestamp%', column_default, CONCAT('(', column_default, ')'))
    WHEN data_type IN (${[...INTS, 'decimal', 'float', 'double', 'bit', 'year'].map(litMy).join(', ')}) THEN column_default
    ELSE QUOTE(column_default) END AS default_value,
  IF(extra LIKE '%auto_increment%', 'auto_increment', NULL) AS \`identity\`,
  NULLIF(generation_expression, '') AS \`generated\`,
  IF(column_key = 'PRI', 'PK', '') AS primary_key,
  collation_name AS \`collation\`,
  column_comment AS \`comment\`,
  CONCAT_WS(' ', CONCAT('COLLATE ', collation_name), IF(extra LIKE '%on update%', SUBSTRING(extra, LOCATE('on update', extra)), NULL),
    IF(column_comment = '', NULL, CONCAT('COMMENT ', QUOTE(column_comment)))) AS keep
FROM information_schema.columns
WHERE table_schema = ${litMy(o.schema)} AND table_name = ${litMy(o.name)}
ORDER BY ordinal_position;`,
  add: (o, c) => `ALTER TABLE ${myTbl(o)} ADD COLUMN ${myCol(c)};`,
  drop: (o, name) => `ALTER TABLE ${myTbl(o)} DROP COLUMN ${quoteMy(name)};`,
  edit(o, old, next) {
    const altered = next.type.trim() !== old.type || next.nullable !== old.nullable || (next.default?.trim() || '') !== (old.default?.trim() || '');
    // rename saja: RENAME COLUMN tidak menyentuh atribut lain (auto_increment, generated, comment)
    if (!altered) return next.name !== old.name ? `ALTER TABLE ${myTbl(o)} RENAME COLUMN ${quoteMy(old.name)} TO ${quoteMy(next.name)};` : `-- no changes to ${quoteMy(old.name)}`;
    // CHANGE COLUMN menulis ulang seluruh definisi: collation (hanya untuk tipe teks), ON UPDATE, COMMENT dibawa
    const m = /^COLLATE (\S+)\s*(.*)$/.exec(old.keep ?? '');
    const text = /^\s*((var)?char|(tiny|medium|long)?text|enum|set)\b/i.test(next.type);
    return `ALTER TABLE ${myTbl(o)} CHANGE COLUMN ${quoteMy(old.name)} ${myCol(next, m && text ? `COLLATE ${m[1]}` : '', m ? m[2] : old.keep ?? '')};`;
  },
};

async function routineType(conn: ConnectionInfo, password: string, db: string, name: string): Promise<'PROCEDURE' | 'FUNCTION'> {
  const rows = await select<{ t: string }>(conn, password, 'SELECT routine_type AS t FROM information_schema.routines WHERE routine_schema = ? AND routine_name = ?', [db, name]);
  if (!rows[0]) throw new Error(`Routine ${db}.${name} not found`);
  return rows[0].t === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
}

/** query katalog (baris objek, parameter ?) */
async function select<T>(conn: ConnectionInfo, password: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool(conn, password).query(sql, params);
  return rows as T[];
}

const KIND: Record<ListKind, string> = {
  table: `SELECT table_schema AS \`schema\`, table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
  view: `SELECT table_schema AS \`schema\`, table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'VIEW' ORDER BY table_name`,
  procedure: `SELECT routine_schema AS \`schema\`, routine_name AS name FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name`,
};

function make(label: string, formatter: 'mysql' | 'mariadb', analyze: (s: string) => string): Driver {
  const mysqlLike: Driver = sqlDriver({
    label,
    defaultPort: 3306,
    dialect: 'mysql',
    formatter,
    quote: quoteMy,
    defaultSchema: '', // MySQL: schema = database
    defaultDb: 'mysql',
    testSql: 'SELECT @@hostname AS server, DATABASE() AS db',
    explain: (s, mode) => (mode === 'estimated' ? `EXPLAIN ${s}` : analyze(s)),
    columnDdl: myColumnDdl,

    async link(conn, password, db) {
      const p = pool(conn, password, db);
      const c = await p.getConnection();
      return link(c, p, async () => c.release());
    },
    async dedicated(conn, password) {
      const open = () => mysql.createConnection(mysqlConfig(conn, password));
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

    async definition(conn, password, db, obj, kind) {
      const type = kind === 'view' ? 'VIEW' : await routineType(conn, password, db, obj.name);
      const rows = await select<Record<string, string | null>>(conn, password, `SHOW CREATE ${type} ${quoteMy(db)}.${quoteMy(obj.name)}`);
      const def = rows[0]?.[`Create ${type[0]}${type.slice(1).toLowerCase()}`];
      if (!def) throw new Error(`The definition of ${obj.name} is not available (no privilege to see it, e.g. SHOW_ROUTINE / SHOW VIEW)`);
      return def;
    },
    async parameters(conn, password, db, obj) {
      const rows = await select<{ name: string; type: string; mode: string }>(conn, password,
        `SELECT parameter_name AS name, dtd_identifier AS type, parameter_mode AS mode FROM information_schema.parameters
          WHERE specific_schema = ? AND specific_name = ? AND ordinal_position > 0 ORDER BY ordinal_position`, [db, obj.name]);
      return rows.map((r) => {
        const mode = (r.mode ?? 'IN').toLowerCase() as ProcParam['mode'];
        return { name: r.name, type: r.type, mode, output: mode === 'out' || mode === 'inout', hasDefault: false };
      });
    },
    async editScript(conn, password, db, obj, kind) {
      const type = kind === 'view' ? 'VIEW' : await routineType(conn, password, db, obj.name);
      return myEditScript(type, db, obj.name, await mysqlLike.definition!(conn, password, db, obj, kind));
    },
    async runScript(conn, password, db, obj) {
      const [type, ps] = await Promise.all([routineType(conn, password, db, obj.name), mysqlLike.parameters!(conn, password, db, obj)]);
      return { sql: myRunScript(db, obj.name, type, ps), params: ps.length };
    },
    isOpen: (name) => [...pools.keys()].some((k) => k.startsWith(`${name}\n`)),
    async close(name) {
      const mine = [...pools.entries()].filter(([k]) => k.startsWith(`${name}\n`));
      for (const [k] of mine) pools.delete(k);
      await Promise.all(mine.map(([, p]) => p.end()));
    },
  });
  return mysqlLike;
}

// MySQL 8.0.18+: EXPLAIN ANALYZE; MariaDB: ANALYZE <statement>
export const mysqlDriver = make('MySQL', 'mysql', (s) => `EXPLAIN ANALYZE ${s}`);
export const mariadbDriver = make('MariaDB', 'mariadb', (s) => `ANALYZE ${s}`);

import type { Dialect } from './db';
/** bagian identifier sebelum kursor, mis. `[My DB].dbo.AG` -> { parts: ['My DB', 'dbo'], word: 'AG' } */
export function identifierChain(before: string): { parts: string[]; word: string } {
  const m = /((?:(?:\[[^\]]*\]|[\w$#@]+)?\.){0,2})(\[[^\]]*|[\w$#@]*)$/.exec(before);
  if (!m || !m[1]) return { parts: [], word: m?.[2].replace(/^\[/, '') ?? '' };
  const parts = m[1].slice(0, -1).split('.').map((p) => p.replace(/^\[|\]$/g, ''));
  return { parts, word: m[2].replace(/^\[/, '') };
}

/** nama yang butuh kurung siku di SQL Server (spasi, diawali angka, karakter khusus) */
export const ident = (name: string, quote = (n: string) => `[${n.replace(/]/g, ']]')}]`) => (/^[A-Za-z_][\w$#@]*$/.test(name) ? name : quote(name));

/** isi string '...', "...", [..], `..`, $$..$$, komentar -- dan /* *\/ diganti spasi (panjang sama): `;`, `@`, `#` di hasilnya pasti kode. keepQuoted: hanya komentar yang diganti */
export function maskSql(sql: string, keepQuoted = false): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const two = sql.slice(i, i + 2);
    let end: number;
    const dollar = sql[i] === '$' ? /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(i, i + 64))?.[0] : undefined;
    if (dollar && !/[\w$]/.test(sql[i - 1] ?? '')) {
      // PostgreSQL $$ ... $$ / $tag$ ... $tag$ (body function / procedure): diperlakukan seperti string
      const close = sql.indexOf(dollar, i + dollar.length);
      end = close < 0 ? sql.length : close + dollar.length;
    } else if (two === '--') end = (sql.indexOf('\n', i) + 1 || sql.length + 1) - 1;
    else if (two === '/*') end = (sql.indexOf('*/', i + 2) + 1 || sql.length - 1) + 1;
    else if (sql[i] === "'" || sql[i] === '"' || sql[i] === '[' || sql[i] === '`') {
      const close = sql[i] === '[' ? ']' : sql[i];
      end = i + 1;
      while (end < sql.length && !(sql[end] === close && sql[end + 1] !== close)) end += sql[end] === close ? 2 : 1;
      end = Math.min(end + 1, sql.length);
    } else {
      out += sql[i++];
      continue;
    }
    const comment = two === '--' || two === '/*';
    out += keepQuoted && !comment ? sql.slice(i, end) : sql.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

/** pecah per `;` di level atas; potongan yang hanya komentar / kosong dibuang */
/**
 * CREATE PROCEDURE / FUNCTION / TRIGGER / VIEW / EVENT yang mulai di `from`: akhir statement-nya, undefined = bukan routine / dialek
 * tanpa aturan khusus. SQL Server: sampai baris GO / akhir teks (satu objek per batch). MySQL / MariaDB: `;` sesudah END terluar
 * (BEGIN / CASE ... END; END IF / LOOP / WHILE / REPEAT tidak dihitung). PostgreSQL tidak perlu: body $$ ... $$ sudah di-mask.
 */
function routineEnd(masked: string, from: number, dialect?: Dialect): number | undefined {
  if (dialect !== 'mssql' && dialect !== 'mysql') return undefined;
  const head = /^\s*create\s+(?:or\s+(?:alter|replace)\s+)?(?:definer\s*=\s*\S+\s+)?(?:procedure|proc|function|trigger|view|event)\b/i.exec(masked.slice(from));
  if (!head) return undefined;
  if (dialect === 'mssql') {
    const go = /^[ \t]*GO[ \t]*\d*[ \t]*$/im.exec(masked.slice(from + head[0].length));
    return go ? from + head[0].length + go.index : masked.length;
  }
  const re = /\b(begin|case|end(?:\s+(if|loop|while|repeat|case)\b)?)\b|;/gi;
  re.lastIndex = from + head[0].length;
  let depth = 0;
  for (let m; (m = re.exec(masked)); ) {
    if (m[0] === ';') {
      if (!depth) return m.index + 1;
    } else if (/^(begin|case)$/i.test(m[1])) depth++;
    else if (!m[2] || /^case$/i.test(m[2])) depth = Math.max(0, depth - 1);
  }
  return masked.length;
}

export function splitStatements(sql: string, dialect?: Dialect): string[] {
  const masked = maskSql(sql);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= sql.length; i++) {
    if (i === start) {
      const r = routineEnd(masked, start, dialect);
      if (r !== undefined) {
        if (masked.slice(start, r).trim()) out.push(sql.slice(start, r).trim());
        start = r;
        i = r - 1;
        continue;
      }
    }
    if (i < sql.length && masked[i] !== ';') continue;
    if (masked.slice(start, i).trim()) out.push(sql.slice(start, i + 1).trim());
    start = i + 1;
  }
  return out;
}

/** boleh dijalankan paralel (koneksi terpisah): >1 statement, semuanya SELECT / WITH tanpa variabel, #temp, INTO */
export function parallelSafe(stmts: string[]): boolean {
  return stmts.length > 1 && stmts.every((s) => {
    const code = maskSql(s);
    return /^\s*(select|with)\b/i.test(code) && !/@\w|#|\binto\b/i.test(code.replace(/@@\w+/g, ''));
  });
}

/** satu baris ringkas untuk judul hasil (tanpa komentar) */
export const preview = (sql: string) => {
  const line = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
};

/** statement di level atas, dipisah `;` atau baris `GO`; start/end = teks tanpa spasi di awal, terminated = diakhiri `;` */
export function statementSegments(sql: string, dialect?: Dialect): { start: number; end: number; terminated: boolean }[] {
  const masked = maskSql(sql);
  const segs: { start: number; end: number; terminated: boolean }[] = [];
  const add = (from: number, to: number, terminated: boolean) => {
    if (!masked.slice(from, to).trim()) return; // hanya komentar / spasi
    const start = from + (sql.slice(from, to).length - sql.slice(from, to).trimStart().length);
    segs.push({ start, end: to, terminated });
  };
  let from = 0;
  const sep = /;|^[ \t]*GO[ \t]*\d*[ \t]*$/gim;
  for (;;) {
    const r = routineEnd(masked, from, dialect);
    if (r !== undefined) {
      add(from, r, /;\s*$/.test(masked.slice(from, r)));
      from = r;
      sep.lastIndex = r;
    }
    const m = sep.exec(masked);
    if (!m) break;
    const isSemi = m[0] === ';';
    add(from, isSemi ? m.index + 1 : m.index, isSemi);
    from = m.index + m[0].length;
  }
  add(from, sql.length, false);
  return segs;
}

/**
 * statement di posisi kursor (offset): dipisah `;` atau baris `GO` di level atas.
 * Kursor di antara statement (baris kosong / tepat setelah `;`) memilih statement sebelumnya.
 */
export function statementAt(sql: string, offset: number, dialect?: Dialect): string {
  const segs = statementSegments(sql, dialect);
  const hit = segs.find((s) => s.start <= offset && offset <= s.end) ?? [...segs].reverse().find((s) => s.end < offset) ?? segs[0];
  return hit ? sql.slice(hit.start, hit.end).trimEnd() : '';
}

/** posisi token kode terakhir statement yang tidak diakhiri `;` (komentar di belakangnya diabaikan) */
export function missingSemicolons(sql: string, dialect?: Dialect): { start: number; end: number }[] {
  const masked = maskSql(sql, true); // hanya komentar yang dibuang: token terakhir boleh string / [nama]
  return statementSegments(sql, dialect).filter((s) => !s.terminated).map((s) => {
    const code = masked.slice(0, s.end).trimEnd();
    let start = code.length;
    while (start > s.start && !/\s/.test(sql[start - 1])) start--;
    return { start, end: code.length };
  });
}

const NOT_ALIAS = /^(where|join|inner|left|right|full|outer|cross|on|group|order|having|union|except|intersect|with|as|go|select|set|values|option|for|apply|pivot|unpivot|output)$/i;
const NAME = String.raw`(?:\[[^\]]*\]|"[^"]*"|\`[^\`]*\`|[\w$#@]+)`;
/** [x] / "x" / `x` -> x */
const unquote = (p: string) => p.replace(/^[[`"]|[\]`"]$/g, '');

/**
 * tabel di FROM / JOIN dan target UPDATE / INSERT [INTO] / DELETE [FROM]: `Shop..T p`, `dbo.T AS x`, `[My DB].dbo.T`,
 * `FROM a x, b y` -> parts (db, schema, nama) + alias. Target `UPDATE o ... FROM T o` (alias) diwakili tabel di FROM.
 */
export function tableRefs(stmt: string): { parts: string[]; alias?: string }[] {
  const masked = maskSql(stmt);
  // alias bukan FROM: `DELETE o FROM T o` / `UPDATE o FROM ...` (FROM berikutnya tetap terbaca)
  const ref = String.raw`(${NAME}?(?:\s*\.\s*${NAME}?){0,2})(?:\s+(?:as\s+)?(?!from\b)(${NAME}))?`;
  const top = String.raw`(?:\s+top\s*\([^)]*\)(?:\s+percent)?)?`;
  // DELETE [TOP (n)] FROM t: tabelnya ditangkap cabang from
  const dml = String.raw`update${top}|insert${top}(?:\s+into)?|delete(?!${top}\s+from\b)${top}`;
  const re = new RegExp(String.raw`\b(?:from|join|(${dml}))\s+${ref}`, 'gi');
  const more = new RegExp(String.raw`\s*,\s*${ref}`, 'iy'); // FROM a, b, c (koma di level FROM)
  const out: { parts: string[]; alias?: string }[] = [];
  const targets = new Set<{ parts: string[]; alias?: string }>(); // target UPDATE / INSERT / DELETE
  const push = (raw: string, alias?: string) => {
    const parts = raw.split('.').map((p) => unquote(p.trim()));
    if (!parts[parts.length - 1]) return false; // `FROM db.` belum selesai diketik
    out.push({ parts, alias: alias && !NOT_ALIAS.test(alias) ? unquote(alias) : undefined });
    return true;
  };
  for (let m; (m = re.exec(stmt)); ) {
    if (masked[m.index] !== stmt[m.index]) continue; // `from` di dalam string / komentar
    if (m[1] && /\b(?:for|key|on)\s*$/i.test(masked.slice(0, m.index))) continue; // FOR UPDATE, ON DUPLICATE KEY UPDATE, ON UPDATE CASCADE
    if (!push(m[2], m[3])) continue;
    if (m[1]) targets.add(out[out.length - 1]);
    more.lastIndex = re.lastIndex;
    for (let c; (c = more.exec(stmt)) && masked[c.index + c[0].indexOf(',')] === ','; ) {
      if (!push(c[1], c[2])) break;
      re.lastIndex = more.lastIndex;
    }
  }
  const aliases = new Set(out.map((r) => r.alias?.toLowerCase()).filter(Boolean));
  return out.filter((r) => !(targets.has(r) && r.parts.length === 1 && aliases.has(r.parts[0].toLowerCase())));
}

/** auto limit boleh: tepat satu statement SELECT / WITH tanpa TOP, OFFSET..FETCH, INTO, SET ROWCOUNT (dipotong = berhenti, tidak ada efek samping) */
export function autoLimitable(stmts: string[]): boolean {
  if (stmts.length !== 1) return false;
  const code = maskSql(stmts[0]);
  return /^\s*(select|with)\b/i.test(code) && !/\btop\b|\bfetch\s+(next|first)\b|\binto\b|\browcount\b/i.test(code);
}

/** posisi kata kunci di level atas (di luar kurung / string / komentar) */
function topLevel(masked: string, re: RegExp): RegExpExecArray[] {
  const depth: number[] = [];
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '(') d++;
    depth.push(d);
    if (masked[i] === ')') d--;
  }
  const out: RegExpExecArray[] = [];
  const g = new RegExp(re.source, 'gi');
  for (let m; (m = g.exec(masked)); ) if (depth[m.index] === 0) out.push(m);
  return out;
}

/**
 * filter WHERE dari toolbar hasil: kondisi ditambahkan ke SELECT level atas (CTE / subquery di dalam kurung tidak disentuh).
 * Sudah ada WHERE -> `WHERE (lama) AND (baru)`; belum -> WHERE disisipkan sebelum GROUP BY / HAVING / ORDER BY / OPTION / FOR.
 */
export function addWhere(stmt: string, cond: string): string {
  const sql = stmt.trim().replace(/;\s*$/, '');
  if (!cond.trim()) return sql;
  const masked = maskSql(sql);
  if (topLevel(masked, /\b(union|except|intersect)\b/).length) throw new Error('WHERE filter is not supported for UNION / EXCEPT / INTERSECT');
  if (!topLevel(masked, /\bfrom\b/).length) throw new Error('WHERE filter needs a query with FROM');
  const tail = /\b(group\s+by|having|order\s+by|option\s*\(|for\s+(xml|json|browse))\b/;
  const where = topLevel(masked, /\bwhere\b/)[0];
  if (where) {
    const bodyStart = where.index + where[0].length;
    const end = topLevel(masked, tail).find((m) => m.index > bodyStart)?.index ?? sql.length;
    return `${sql.slice(0, bodyStart)} (${sql.slice(bodyStart, end).trim()})\n    AND (${cond.trim()})${end < sql.length ? `\n${sql.slice(end)}` : ''}`;
  }
  const at = topLevel(masked, tail)[0]?.index ?? sql.length;
  return `${sql.slice(0, at).trimEnd()}\nWHERE ${cond.trim()}${at < sql.length ? `\n${sql.slice(at)}` : ''}`;
}

/**
 * hanya membaca: semua statement SELECT / WITH tanpa INTO, DML, EXEC, dan tanpa hint kunci yang ditahan sampai commit
 * (UPDLOCK / HOLDLOCK / XLOCK ...). Transaksi manual tidak dibuka untuk statement seperti ini.
 */
export function readOnly(stmts: string[]): boolean {
  return stmts.length > 0 && stmts.every((st) => {
    const code = maskSql(st);
    return /^\s*(select|with)\b/i.test(code)
      && !/\b(into|insert|update|delete|merge|exec|execute|updlock|holdlock|xlock|tablockx|serializable|repeatableread)\b/i.test(code);
  });
}

/**
 * statement asal tiap jumlah "rows affected" (urut): INSERT / UPDATE / DELETE / MERGE (boleh diawali WITH) dan SELECT ... INTO.
 * Hanya dipasangkan bila pasti: jumlahnya sama dan tanpa EXEC (prosedur bisa melaporkan banyak jumlah); selain itu undefined.
 */
export function affectedStatements(stmts: string[], counts: number): ({ n: number; sql: string } | undefined)[] {
  const codes = stmts.map((st) => maskSql(st));
  const dml = stmts.flatMap((sql, i) => (/^\s*(?:with\b[\s\S]*\)\s*)?(?:insert|update|delete|merge)\b/i.test(codes[i])
    || (/^\s*(?:select|with)\b/i.test(codes[i]) && /\binto\b/i.test(codes[i])) ? [{ n: i + 1, sql: sql.trim() }] : []));
  const sure = dml.length === counts && !codes.some((c) => /\bexec(?:ute)?\b/i.test(c));
  return Array.from({ length: counts }, (_, i) => (sure ? dml[i] : undefined));
}

/**
 * koneksi read-only (Permissions): pesan error bila ada statement yang bisa mengubah data, undefined = boleh dijalankan.
 * Boleh: SELECT / WITH tanpa INTO / DML, DECLARE, SET @variabel, SHOW, DESCRIBE; MongoDB: method baca (find, aggregate tanpa $out / $merge, count ...).
 */
export function readOnlyBlocked(dialect: Dialect, stmts: string[]): string | undefined {
  const bad = stmts.find((st) => {
    const code = maskSql(st);
    if (dialect === 'mongodb') {
      return /\.(insert\w*|update\w*|replace\w*|delete\w*|remove|drop\w*|create\w*|rename\w*|bulkWrite|findOneAnd\w*|findAndModify)\s*\(|\$(out|merge)\b/i.test(st);
    }
    if (/^\s*(declare\s+@|set\s+@|show\b|desc(ribe)?\b)/i.test(code)) return false;
    return !/^\s*(select|with)\b/i.test(code)
      || /\b(into|insert|update|delete|merge|exec|execute|drop|alter|create|truncate|grant|revoke|deny)\b/i.test(code);
  });
  return bad === undefined ? undefined : `The connection is read-only: only statements that do not change data can run (blocked: ${preview(bad)})`;
}

/**
 * statement terakhir di script yang menutup transaksi: COMMIT / ROLLBACK, atau (MySQL / MariaDB) DDL yang melakukan implicit commit.
 * undefined = tidak ada: transaksi diakhiri server (error / cancel).
 */
export function txEndStatement(stmts: string[], dialect: Dialect = 'mssql'): 'commit' | 'rollback' | 'implicit' | undefined {
  const end = (st: string) => {
    const code = maskSql(st);
    const m = /^\s*(commit|rollback)\b/i.exec(code);
    if (m) return m[1].toLowerCase() as 'commit' | 'rollback';
    // MySQL / MariaDB: DDL, GRANT, LOCK TABLES ... = implicit commit (tabel TEMPORARY tidak)
    if (dialect === 'mysql' && /^\s*(create|alter|drop|rename|truncate|grant|revoke|lock\s+tables|unlock\s+tables)\b/i.test(code)
      && !/^\s*(create|drop)\s+temporary\b/i.test(code)) return 'implicit';
    return undefined;
  };
  return stmts.map(end).filter(Boolean).pop();
}

/** satu SELECT / WITH tanpa INTO: boleh diberi filter WHERE dari toolbar hasil */
export function singleSelect(stmts: string[]): boolean {
  if (stmts.length !== 1) return false;
  const code = maskSql(stmts[0]);
  return /^\s*(select|with)\b/i.test(code) && !/\binto\b/i.test(code);
}

const NUMERIC_TYPE = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|money|smallmoney|int2|int4|int8|float4|float8)\b/;
const BOOL_TYPE = /^(bit|bool|boolean)\b/;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** teks -> literal string dialek: N'..' (mssql), '..' (MySQL juga escape backslash) */
const text = (v: string, d: Dialect) => (d === 'mssql' ? `N'${v.replace(/'/g, "''")}'` : `'${(d === 'mysql' ? v.replace(/\\/g, '\\\\') : v).replace(/'/g, "''")}'`);

/** literal untuk nilai dari driver (kunci WHERE): angka apa adanya, tanggal 'yyyy-mm-ddThh:mm:ss.fff', biner 0x.. / X'..', teks N'..' / '..' */
export function sqlLiteral(v: unknown, d: Dialect = 'mssql'): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return d === 'postgres' ? String(v).toUpperCase() : v ? '1' : '0';
  if (v instanceof Date) {
    // mssql membaca datetime sebagai UTC: tulis balik komponen UTC tanpa zona (driver lain mengembalikan tanggal sebagai teks)
    return `'${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}.${pad(v.getUTCMilliseconds(), 3)}'`;
  }
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex').toUpperCase();
    return d === 'mssql' ? `0x${hex}` : d === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'`;
  }
  return text(String(v), d);
}

/** nilai baru yang diketik user di grid -> literal sesuai tipe kolom; `NULL` = NULL; angka / bit / boolean divalidasi */
export function editLiteral(value: string | null, type: string, d: Dialect = 'mssql'): string {
  if (value === null || value === 'NULL') return 'NULL';
  const t = type.toLowerCase();
  if (NUMERIC_TYPE.test(t)) {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) throw new Error(`"${value}" is not a number (${type})`);
    return value.trim();
  }
  if (BOOL_TYPE.test(t)) {
    const b = value.trim().toLowerCase();
    if (!['0', '1', 'true', 'false'].includes(b)) throw new Error(`"${value}" is not a ${t} (0 / 1 / true / false)`);
    const on = b === '1' || b === 'true';
    return d === 'postgres' ? (on ? 'TRUE' : 'FALSE') : on ? '1' : '0';
  }
  return text(value, d);
}

/**
 * auto limit / Load more untuk MySQL, PostgreSQL, SQLite: `LIMIT n OFFSET skip` di akhir SELECT.
 * undefined = statement sudah punya LIMIT / FOR UPDATE di level atas (dijalankan apa adanya).
 */
export function addLimit(stmt: string, limit: number, skip = 0): string | undefined {
  const sql = splitStatements(stmt)[0]?.replace(/;$/, '') ?? stmt;
  if (topLevel(maskSql(sql), /\b(limit|for\s+(update|share|no\s+key|key)|lock\s+in)\b/).length) return undefined;
  return `${sql}\nLIMIT ${limit - skip}${skip ? ` OFFSET ${skip}` : ''}`; // baris baru: komentar -- di baris terakhir tidak menelan LIMIT
}

export interface CellEdit {
  row: number;
  col: number;
  value: string | null;
}

/**
 * script UPDATE untuk edit di grid: satu UPDATE per baris (kolom yang diubah), WHERE semua kolom primary key (nilai asli),
 * di dalam BEGIN TRAN; COMMIT / ROLLBACK dibiarkan ke user (tidak pernah dijalankan otomatis).
 */
export function updateScript(table: string, columns: string[], types: string[], rows: unknown[][], pk: string[], edits: CellEdit[],
  q: (n: string) => string = (n) => `[${n.replace(/]/g, ']]')}]`, d: Dialect = 'mssql'): string {
  const pkIdx = pk.map((k) => {
    const i = columns.findIndex((c) => c.toLowerCase() === k.toLowerCase());
    if (i < 0) throw new Error(`Primary key column ${k} must be part of the SELECT to edit rows`);
    return i;
  });
  const byRow = new Map<number, CellEdit[]>();
  for (const e of edits) byRow.set(e.row, [...(byRow.get(e.row) ?? []), e]);
  const stmts = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([r, es]) => {
    const row = rows[r];
    if (!row) throw new Error(`Row ${r + 1} is not loaded`);
    if (es.some((e) => pkIdx.includes(e.col))) throw new Error('Primary key columns cannot be edited here');
    const set = es.map((e) => `${q(columns[e.col])} = ${editLiteral(e.value, types[e.col] ?? '', d)}`).join(', ');
    const where = pkIdx.map((i) => (row[i] === null ? `${q(columns[i])} IS NULL` : `${q(columns[i])} = ${sqlLiteral(row[i], d)}`)).join(' AND ');
    return `UPDATE ${table}\nSET ${set}\nWHERE ${where};`;
  });
  return `-- Generated by Moonage Daydream from ${edits.length} edited cell(s) in ${stmts.length} row(s). Review before running.\n${d === 'mssql' ? 'BEGIN TRAN' : 'BEGIN'};\n\n${stmts.join('\n\n')}\n\n-- Check the affected rows, then run ONE of:\n-- COMMIT;\n-- ROLLBACK;\n`;
}

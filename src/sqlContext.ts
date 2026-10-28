/** bagian identifier sebelum kursor, mis. `[My DB].dbo.AG` -> { parts: ['My DB', 'dbo'], word: 'AG' } */
export function identifierChain(before: string): { parts: string[]; word: string } {
  const m = /((?:(?:\[[^\]]*\]|[\w$#@]+)?\.){0,2})(\[[^\]]*|[\w$#@]*)$/.exec(before);
  if (!m || !m[1]) return { parts: [], word: m?.[2].replace(/^\[/, '') ?? '' };
  const parts = m[1].slice(0, -1).split('.').map((p) => p.replace(/^\[|\]$/g, ''));
  return { parts, word: m[2].replace(/^\[/, '') };
}

/** nama yang butuh kurung siku di SQL Server (spasi, diawali angka, karakter khusus) */
export const ident = (name: string) => (/^[A-Za-z_][\w$#@]*$/.test(name) ? name : `[${name.replace(/]/g, ']]')}]`);

/** isi string '...', "...", [..], komentar -- dan /* *\/ diganti spasi (panjang sama): `;`, `@`, `#` di hasilnya pasti kode. keepQuoted: hanya komentar yang diganti */
export function maskSql(sql: string, keepQuoted = false): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const two = sql.slice(i, i + 2);
    let end: number;
    if (two === '--') end = (sql.indexOf('\n', i) + 1 || sql.length + 1) - 1;
    else if (two === '/*') end = (sql.indexOf('*/', i + 2) + 1 || sql.length - 1) + 1;
    else if (sql[i] === "'" || sql[i] === '"' || sql[i] === '[') {
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
export function splitStatements(sql: string): string[] {
  const masked = maskSql(sql);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= sql.length; i++) {
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
export function statementSegments(sql: string): { start: number; end: number; terminated: boolean }[] {
  const masked = maskSql(sql);
  const segs: { start: number; end: number; terminated: boolean }[] = [];
  const add = (from: number, to: number, terminated: boolean) => {
    if (!masked.slice(from, to).trim()) return; // hanya komentar / spasi
    const start = from + (sql.slice(from, to).length - sql.slice(from, to).trimStart().length);
    segs.push({ start, end: to, terminated });
  };
  let from = 0;
  const sep = /;|^[ \t]*GO[ \t]*\d*[ \t]*$/gim;
  for (let m; (m = sep.exec(masked)); ) {
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
export function statementAt(sql: string, offset: number): string {
  const segs = statementSegments(sql);
  const hit = segs.find((s) => s.start <= offset && offset <= s.end) ?? [...segs].reverse().find((s) => s.end < offset) ?? segs[0];
  return hit ? sql.slice(hit.start, hit.end).trimEnd() : '';
}

/** posisi token kode terakhir statement yang tidak diakhiri `;` (komentar di belakangnya diabaikan) */
export function missingSemicolons(sql: string): { start: number; end: number }[] {
  const masked = maskSql(sql, true); // hanya komentar yang dibuang: token terakhir boleh string / [nama]
  return statementSegments(sql).filter((s) => !s.terminated).map((s) => {
    const code = masked.slice(0, s.end).trimEnd();
    let start = code.length;
    while (start > s.start && !/\s/.test(sql[start - 1])) start--;
    return { start, end: code.length };
  });
}

const NOT_ALIAS = /^(where|join|inner|left|right|full|outer|cross|on|group|order|having|union|except|intersect|with|as|go|select|set|values|option|for|apply|pivot|unpivot)$/i;
const NAME = String.raw`(?:\[[^\]]*\]|[\w$#@]+)`;

/** tabel di FROM / JOIN statement: `Shop..T p`, `dbo.T AS x`, `[My DB].dbo.T`, `FROM a x, b y` -> parts (db, schema, nama) + alias */
export function tableRefs(stmt: string): { parts: string[]; alias?: string }[] {
  const masked = maskSql(stmt);
  const ref = String.raw`(${NAME}?(?:\s*\.\s*${NAME}?){0,2})(?:\s+(?:as\s+)?(${NAME}))?`;
  const re = new RegExp(String.raw`\b(?:from|join)\s+${ref}`, 'gi');
  const more = new RegExp(String.raw`\s*,\s*${ref}`, 'iy'); // FROM a, b, c (koma di level FROM)
  const out: { parts: string[]; alias?: string }[] = [];
  const push = (raw: string, alias?: string) => {
    const parts = raw.split('.').map((p) => p.trim().replace(/^\[|\]$/g, ''));
    if (!parts[parts.length - 1]) return false; // `FROM db.` belum selesai diketik
    out.push({ parts, alias: alias && !NOT_ALIAS.test(alias) ? alias.replace(/^\[|\]$/g, '') : undefined });
    return true;
  };
  for (let m; (m = re.exec(stmt)); ) {
    if (masked[m.index] !== stmt[m.index]) continue; // `from` di dalam string / komentar
    if (!push(m[1], m[2])) continue;
    more.lastIndex = re.lastIndex;
    for (let c; (c = more.exec(stmt)) && masked[c.index + c[0].indexOf(',')] === ','; ) {
      if (!push(c[1], c[2])) break;
      re.lastIndex = more.lastIndex;
    }
  }
  return out;
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

/** satu SELECT / WITH tanpa INTO: boleh diberi filter WHERE dari toolbar hasil */
export function singleSelect(stmts: string[]): boolean {
  if (stmts.length !== 1) return false;
  const code = maskSql(stmts[0]);
  return /^\s*(select|with)\b/i.test(code) && !/\binto\b/i.test(code);
}

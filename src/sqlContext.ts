/** bagian identifier sebelum kursor, mis. `[My DB].dbo.AG` -> { parts: ['My DB', 'dbo'], word: 'AG' } */
export function identifierChain(before: string): { parts: string[]; word: string } {
  const m = /((?:(?:\[[^\]]*\]|[\w$#@]+)?\.){0,2})(\[[^\]]*|[\w$#@]*)$/.exec(before);
  if (!m || !m[1]) return { parts: [], word: m?.[2].replace(/^\[/, '') ?? '' };
  const parts = m[1].slice(0, -1).split('.').map((p) => p.replace(/^\[|\]$/g, ''));
  return { parts, word: m[2].replace(/^\[/, '') };
}

/** nama yang butuh kurung siku di SQL Server (spasi, diawali angka, karakter khusus) */
export const ident = (name: string) => (/^[A-Za-z_][\w$#@]*$/.test(name) ? name : `[${name.replace(/]/g, ']]')}]`);

/** isi string '...', "...", [..], komentar -- dan /* *\/ diganti spasi (panjang sama): `;`, `@`, `#` di hasilnya pasti kode */
export function maskSql(sql: string): string {
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
    out += sql.slice(i, end).replace(/[^\n]/g, ' ');
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

/**
 * statement di posisi kursor (offset): dipisah `;` atau baris `GO` di level atas.
 * Kursor di antara statement (baris kosong / tepat setelah `;`) memilih statement sebelumnya.
 */
export function statementAt(sql: string, offset: number): string {
  const masked = maskSql(sql);
  const segs: { start: number; end: number }[] = [];
  const add = (from: number, to: number) => {
    const code = masked.slice(from, to);
    if (!code.trim()) return; // hanya komentar / spasi
    const start = from + (sql.slice(from, to).length - sql.slice(from, to).trimStart().length);
    segs.push({ start, end: to });
  };
  let from = 0;
  const sep = /;|^[ \t]*GO[ \t]*\d*[ \t]*$/gim;
  for (let m; (m = sep.exec(masked)); ) {
    const isSemi = m[0] === ';';
    add(from, isSemi ? m.index + 1 : m.index);
    from = m.index + m[0].length;
  }
  add(from, sql.length);
  const hit = segs.find((s) => s.start <= offset && offset <= s.end) ?? [...segs].reverse().find((s) => s.end < offset) ?? segs[0];
  return hit ? sql.slice(hit.start, hit.end).trimEnd() : '';
}

const NOT_ALIAS = /^(where|join|inner|left|right|full|outer|cross|on|group|order|having|union|except|intersect|with|as|go|select|set|values|option|for|apply|pivot|unpivot)$/i;
const NAME = String.raw`(?:\[[^\]]*\]|[\w$#@]+)`;

/** tabel di FROM / JOIN statement: `Shop..T p`, `dbo.T AS x`, `[My DB].dbo.T` -> parts (db, schema, nama) + alias */
export function tableRefs(stmt: string): { parts: string[]; alias?: string }[] {
  const masked = maskSql(stmt);
  const re = new RegExp(String.raw`\b(?:from|join)\s+(${NAME}?(?:\s*\.\s*${NAME}?){0,2})(?:\s+(?:as\s+)?(${NAME}))?`, 'gi');
  const out: { parts: string[]; alias?: string }[] = [];
  for (let m; (m = re.exec(stmt)); ) {
    if (masked[m.index] !== stmt[m.index]) continue; // `from` di dalam string / komentar
    const parts = m[1].split('.').map((p) => p.trim().replace(/^\[|\]$/g, ''));
    if (!parts[parts.length - 1]) continue; // `FROM db.` belum selesai diketik
    const alias = m[2] && !NOT_ALIAS.test(m[2]) ? m[2].replace(/^\[|\]$/g, '') : undefined;
    out.push({ parts, alias });
  }
  return out;
}

/** auto limit boleh: tepat satu statement SELECT / WITH tanpa TOP, OFFSET..FETCH, INTO, SET ROWCOUNT (dipotong = berhenti, tidak ada efek samping) */
export function autoLimitable(stmts: string[]): boolean {
  if (stmts.length !== 1) return false;
  const code = maskSql(stmts[0]);
  return /^\s*(select|with)\b/i.test(code) && !/\btop\b|\bfetch\s+(next|first)\b|\binto\b|\browcount\b/i.test(code);
}

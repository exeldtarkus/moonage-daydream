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

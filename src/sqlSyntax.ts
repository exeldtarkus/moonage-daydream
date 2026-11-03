// cek sintaks SQL offline (node-sql-parser) untuk garis bawah di editor; tanpa vscode supaya bisa di-unit test
import type { Dialect } from './db';
import { maskSql, statementSegments } from './sqlContext';

export interface SyntaxIssue { start: number; end: number; message: string }
interface PegError { message: string; found?: string | null; location?: { start: { offset: number } } }
type Astify = (sql: string, opt: { database: string }) => unknown;

// parser per dialek dimuat saat pertama dipakai (tiap dialek ±250 KB)
const LOADERS: Partial<Record<Dialect, () => Promise<{ Parser: new () => { astify: Astify } }>>> = {
  mssql: () => import('node-sql-parser/build/transactsql'),
  mysql: () => import('node-sql-parser/build/mysql'),
  postgres: () => import('node-sql-parser/build/postgresql'),
  sqlite: () => import('node-sql-parser/build/sqlite'),
};
const DATABASE: Partial<Record<Dialect, string>> = { mssql: 'transactsql', mysql: 'mysql', postgres: 'postgresql', sqlite: 'sqlite' };
const parsers = new Map<Dialect, Promise<Astify>>();

/** hanya statement data (SELECT / INSERT / UPDATE / DELETE / WITH): parser belum mengenal semua sintaks procedure / MERGE / DDL vendor */
const CHECKED = /^\s*(select|insert|update|delete|with)\b/i;
// shortcut: statement lebih dari 50.000 karakter tidak dicek (parser lambat), naikkan bila perlu
const MAX_LEN = 50_000;
/** hasil per teks statement: mengetik di satu statement tidak mem-parse ulang statement lain */
const memo = new Map<string, Omit<SyntaxIssue, 'start' | 'end'> & { at: number } | null>();

/** salah sintaks per statement; posisi start / end = offset di `sql` */
export async function syntaxIssues(sql: string, dialect: Dialect | undefined): Promise<SyntaxIssue[]> {
  const load = dialect && LOADERS[dialect];
  if (!load) return [];
  let parser = parsers.get(dialect);
  if (!parser) parsers.set(dialect, (parser = load().then(({ Parser }) => { const p = new Parser(); return (s, o) => p.astify(s, o); })));
  const astify = await parser;
  const masked = maskSql(sql, true); // komentar diganti spasi: kata pertama statement = kata kode pertama
  const out: SyntaxIssue[] = [];
  for (const seg of statementSegments(sql, dialect)) {
    const text = sql.slice(seg.start, seg.end).replace(/;\s*$/, '');
    if (!CHECKED.test(masked.slice(seg.start, seg.end)) || text.length > MAX_LEN) continue;
    const key = `${dialect}\0${text}`;
    let hit = memo.get(key);
    if (hit === undefined) {
      hit = null;
      try {
        astify(text, { database: DATABASE[dialect]! });
      } catch (e) {
        const pe = e as PegError;
        // error tanpa posisi bukan salah sintaks (mis. bug parser): diabaikan, tidak ditandai
        if (pe.location) hit = { at: pe.location.start.offset, message: `SQL syntax error: ${pe.found == null ? 'unexpected end of statement' : `unexpected "${pe.found}"`}` };
      }
      if (memo.size > 1000) memo.clear();
      memo.set(key, hit);
    }
    if (!hit) continue;
    out.push({ ...wordAt(text, hit.at), message: hit.message });
    const last = out[out.length - 1];
    last.start += seg.start;
    last.end += seg.start;
  }
  return out;
}

/** rentang yang digaris bawahi: kata / token di posisi error; di akhir statement = kata terakhir */
function wordAt(text: string, at: number): { start: number; end: number } {
  const code = text.trimEnd();
  if (at >= code.length) {
    const m = /\S+$/.exec(code);
    return m ? { start: m.index, end: code.length } : { start: Math.max(0, code.length - 1), end: code.length };
  }
  const m = /^[\w@#$]+/.exec(text.slice(at));
  return { start: at, end: at + (m ? m[0].length : 1) };
}

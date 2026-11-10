import { format } from 'sql-formatter';
import { maskSql } from './sqlContext';

export interface FormatSettings {
  /** dialek sql-formatter (default transactsql) */
  language?: 'transactsql' | 'mysql' | 'mariadb' | 'postgresql' | 'sqlite';
  keywordCase: 'upper' | 'lower' | 'preserve';
  leadingComma: boolean;
  /** `;` di baris sendiri */
  semicolonNewline: boolean;
  tabWidth: number;
  useTabs: boolean;
}

/** koma di akhir baris (kode, bukan string / komentar) dipindah ke awal baris berikutnya: `    , kolom` */
export function leadingCommas(sql: string): string {
  const lines = sql.split('\n');
  const masked = maskSql(sql).split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const code = masked[i].trimEnd();
    if (!code.endsWith(',')) continue;
    lines[i] = (lines[i].slice(0, code.length - 1) + lines[i].slice(code.length)).trimEnd();
    const indent = /^\s*/.exec(lines[i + 1])![0];
    lines[i + 1] = `${indent}, ${lines[i + 1].slice(indent.length)}`;
    masked[i + 1] = `${indent}, ${masked[i + 1].slice(indent.length)}`;
  }
  return lines.join('\n');
}

/** format SQL (sql-formatter, dialek koneksi file; default transactsql); melempar error bila SQL tidak bisa di-parse */
export function formatSql(sql: string, s: FormatSettings): string {
  const out = format(sql, { language: s.language ?? 'transactsql', keywordCase: s.keywordCase, newlineBeforeSemicolon: s.semicolonNewline, tabWidth: s.tabWidth, useTabs: s.useTabs });
  return s.leadingComma ? leadingCommas(out) : out;
}

export interface EditSpan { from: number; to: number; text: string }

/**
 * Edit minimal old -> neu (buang awalan / akhiran yang sama). VS Code memindah kursor + scroll ke akhir bila satu edit
 * menimpa SELURUH dokumen (replaceMove), jadi hasil yang masih menutup semua teks dipecah jadi dua edit.
 */
export function formatEditSpans(old: string, neu: string): EditSpan[] {
  if (old === neu) return [];
  let a = 0;
  const max = Math.min(old.length, neu.length);
  while (a < max && old[a] === neu[a]) a++;
  let b = 0;
  while (b < max - a && old[old.length - 1 - b] === neu[neu.length - 1 - b]) b++;
  const from = a, to = old.length - b, text = neu.slice(a, neu.length - b);
  if (from > 0 || to < old.length || to - from < 2) return [{ from, to, text }];
  return [{ from, to: from + 1, text }, { from: from + 1, to, text: '' }];
}

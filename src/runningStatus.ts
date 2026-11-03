// teks status query yang berjalan (status bar kanan bawah + notifikasi); tanpa vscode supaya bisa di-unit test

/** baris pertama yang berisi teks, maks 80 karakter */
export const firstLine = (sql: string) => {
  const line = sql.trim().split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};
export const where = (conn: string, db: string) => (db ? `${conn} / ${db}` : conn);
const secs = (start: number, now: number) => `${Math.max(0, Math.floor((now - start) / 1000))}s`;

/** status bar: undefined = tidak ada yang berjalan (disembunyikan); detik = query paling lama; tooltip satu baris per query, terlama dulu */
export function runningStatus(qs: { sql: string; conn: string; db: string; start: number }[], now: number): { text: string; tooltip: string[] } | undefined {
  if (!qs.length) return undefined;
  const sorted = [...qs].sort((a, b) => a.start - b.start);
  return {
    text: `$(loading~spin) ${qs.length} ${qs.length === 1 ? 'query' : 'queries'} running · ${secs(sorted[0].start, now)}`,
    tooltip: sorted.map((q) => `${firstLine(q.sql)} — ${where(q.conn, q.db)} · ${secs(q.start, now)}`),
  };
}

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

const ago = (at: number, now: number) => {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ago`;
  return new Date(at).toLocaleString();
};
const STATUS_ICON = { ok: '$(pass)', error: '$(error)', cancelled: '$(circle-slash)' };

/** item Quick Pick Query History (status bar kanan bawah) */
export function historyPick(e: { sql: string; conn: string; db: string; at: number; durationMs: number; status: 'ok' | 'error' | 'cancelled'; message?: string }, now: number) {
  return { label: `${STATUS_ICON[e.status]} ${firstLine(e.sql)}`, description: `${where(e.conn, e.db)} · ${ago(e.at, now)} · ${e.durationMs} ms`, detail: e.message };
}

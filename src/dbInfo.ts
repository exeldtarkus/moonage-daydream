import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';
import { webviewPage } from './webviewPage';

/** dashboard Database Info (SQL Server): satu query baca saja per bagian, dijalankan di database itu */
export interface DbInfoPart { key: 'summary' | 'objects' | 'files' | 'backups'; title: string; sql: string }
export type PartResult = { columns: string[]; rows: unknown[][] } | { error: string };

export const DB_INFO_PARTS: DbInfoPart[] = [
  {
    key: 'summary', title: 'Overview', sql: `SELECT d.name, d.state_desc AS state, d.recovery_model_desc AS recovery_model, d.collation_name AS collation,
  d.compatibility_level, d.create_date, d.is_read_only, d.user_access_desc AS user_access, SUSER_SNAME(d.owner_sid) AS owner
FROM sys.databases d WHERE d.database_id = DB_ID();`,
  },
  {
    key: 'objects', title: 'Objects', sql: `SELECT SUM(CASE WHEN type = 'U' THEN 1 ELSE 0 END) AS tables,
  SUM(CASE WHEN type = 'V' THEN 1 ELSE 0 END) AS views,
  SUM(CASE WHEN type IN ('P', 'PC') THEN 1 ELSE 0 END) AS procedures,
  SUM(CASE WHEN type IN ('FN', 'IF', 'TF', 'FS', 'FT') THEN 1 ELSE 0 END) AS functions
FROM sys.objects WHERE is_ms_shipped = 0;`,
  },
  {
    key: 'files', title: 'Files', sql: `SELECT name, type_desc AS type, physical_name,
  CAST(size AS BIGINT) * 8 / 1024.0 AS size_mb,
  CAST(FILEPROPERTY(name, 'SpaceUsed') AS BIGINT) * 8 / 1024.0 AS used_mb,
  CASE WHEN max_size = -1 THEN NULL ELSE CAST(max_size AS BIGINT) * 8 / 1024.0 END AS max_mb,
  CASE WHEN growth = 0 THEN 'none' WHEN is_percent_growth = 1 THEN CAST(growth AS VARCHAR(10)) + ' %'
    ELSE CAST(CAST(growth AS BIGINT) * 8 / 1024 AS VARCHAR(20)) + ' MB' END AS growth
FROM sys.database_files ORDER BY file_id;`,
  },
  {
    key: 'backups', title: 'Last backup', sql: `SELECT CASE type WHEN 'D' THEN 'Full' WHEN 'I' THEN 'Differential' WHEN 'L' THEN 'Log' ELSE type END AS kind,
  MAX(backup_finish_date) AS last_backup
FROM msdb.dbo.backupset WHERE database_name = DB_NAME() GROUP BY type ORDER BY MIN(type);`,
  },
];

/** baris hasil -> objek per nama kolom */
const records = (r: { columns: string[]; rows: unknown[][] }) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
  if (typeof v === 'string' && ISO.test(v)) return v.slice(0, 16).replace('T', ' ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/** MB -> teks ringkas (GB mulai 1024 MB) */
function size(mb: unknown): string {
  const n = Number(mb);
  if (mb === null || mb === undefined || !Number.isFinite(n)) return 'unlimited';
  return n >= 1024 ? `${+(n / 1024).toFixed(1)} GB` : `${+n.toFixed(1)} MB`;
}

function partBody(p: DbInfoPart, r: PartResult | undefined): string {
  if (!r) return '<p class="muted loading"><span class="spin" aria-hidden="true"></span>Loading…</p>';
  if ('error' in r) {
    return /permission|denied/i.test(r.error)
      ? `<p class="perm" role="note">No permission to read this section: ${esc(r.error)}</p>`
      : `<p class="fail" role="alert">${esc(r.error)}</p>`;
  }
  const rows = records(r);
  if (p.key === 'summary') {
    const d = rows[0] ?? {};
    const cards: [string, unknown][] = [['State', d.state], ['Recovery model', d.recovery_model], ['Collation', d.collation],
      ['Compatibility level', d.compatibility_level], ['Created', d.create_date], ['Read-only', d.is_read_only], ['User access', d.user_access], ['Owner', d.owner]];
    return `<div class="cards">${cards.map(([k, v]) => `<div class="card"><span>${k}</span><b>${esc(fmt(v))}</b></div>`).join('')}</div>`;
  }
  if (p.key === 'objects') {
    const d = rows[0] ?? {};
    return `<div class="stats">${['tables', 'views', 'procedures', 'functions'].map((k) => `<div class="stat"><b>${esc(fmt(d[k] ?? 0))}</b> <span>${k}</span></div>`).join('')}</div>`;
  }
  if (p.key === 'files') {
    if (!rows.length) return '<p class="muted">No files.</p>';
    return `<table class="files"><thead><tr><th>File</th><th>Type</th><th>Used / size</th><th>Max</th><th>Growth</th></tr></thead><tbody>${rows.map((f) => {
      const pct = Number(f.size_mb) > 0 ? Math.min(100, Math.round((Number(f.used_mb) / Number(f.size_mb)) * 100)) : 0;
      return `<tr><td><b>${esc(fmt(f.name))}</b><div class="path" title="${esc(fmt(f.physical_name))}">${esc(fmt(f.physical_name))}</div></td><td>${esc(fmt(f.type))}</td>`
        + `<td><div class="bar" role="img" aria-label="${pct}% used"><i style="width:${pct}%"></i></div>${esc(size(f.used_mb))} / ${esc(size(f.size_mb))} <span class="muted">(${pct}%)</span></td>`
        + `<td>${esc(size(f.max_mb))}</td><td>${esc(fmt(f.growth))}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  return rows.length
    ? `<ul class="backups">${rows.map((b) => `<li><span>${esc(fmt(b.kind))}</span><b>${esc(fmt(b.last_backup))}</b></li>`).join('')}</ul>`
    : '<p class="muted">No backup history in msdb for this database.</p>';
}

/**
 * halaman dashboard; results = hasil per bagian (belum ada = loading).
 * page -> ext: { type: 'refresh' } | { type: 'open', key: DbInfoPart['key'] | 'all' }
 */
export function dbInfoHtml(cspSource: string, t: { conn: string; db: string }, results: Record<string, PartResult>, updated?: string): string {
  const nonce = randomBytes(16).toString('base64');
  const sections = DB_INFO_PARTS.map((p) => `<section class="part ${p.key}" aria-labelledby="h-${p.key}">
<header><h2 id="h-${p.key}">${p.title}</h2></header>
${partBody(p, results[p.key])}
<details class="q"><summary>Show query</summary><pre>${esc(p.sql)}</pre><button data-open="${p.key}">Open in SQL Editor</button></details>
</section>`).join('\n');
  return webviewPage('dbInfo', {
    cspSource,
    nonce,
    conn: esc(t.conn),
    db: esc(t.db),
    updated: updated ? ` · updated ${esc(updated)}` : '',
    sections,
  });
}

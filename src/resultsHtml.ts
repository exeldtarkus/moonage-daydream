import { GRID_MAX_ROWS, PAGE_ROWS, QueryResult } from './db';

/** lebih dari sekian baris: baris disimpan di <template> (tidak di-layout) dan hanya yang dekat viewport dipasang di tabel */
export const VIRTUAL_ROWS = 300;
import { preview } from './sqlContext';
import { FORMATS } from './exporter';
import type { PlanStatement } from './plan';
import { pageJson, webviewPage } from './webviewPage';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return '<span class="null">(null)</span>';
  if (v instanceof Date) return esc(v.toISOString());
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString('hex').toUpperCase();
    return esc(`0x${hex}${v.length > 64 ? '…' : ''}`);
  }
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(String(v));
}

/** loading.uri = file yang query-nya berjalan (untuk tombol Cancel); cancelling = Cancel sudah diklik */
/** statement asal sebuah hasil (satu SELECT): dasar filter WHERE di toolbar; where = filter yang sedang aktif */
export interface Source {
  uri: string;
  sql: string;
  where?: string;
  /** teks mongosh (find satu koleksi): toolbar WHERE SQL tidak berlaku */
  mongo?: boolean;
}
/** Explain (estimated, query tidak dijalankan) / Analyze (actual, SELECT dijalankan lalu di-rollback) */
export interface PlanOutcome {
  plan: PlanStatement[];
  mode: 'estimated' | 'actual';
  xml: string[];
  durationMs: number;
  /** Analyze: jumlah baris hasil query per result set */
  rows?: number[];
}
export type Single = PlanOutcome | { result: QueryResult; source?: Source; editBlock?: string; genCols?: string[] } | { error: string; source?: Source } | { loading: true; uri?: string; cancelling?: boolean };
/** run paralel: satu Part per statement, diperbarui begitu statement itu selesai */
export interface Part {
  sql: string;
  o: Exclude<Single, PlanOutcome>;
}
export type Outcome = Single | { parts: Part[]; uri: string; start: number; end?: number };
export const CANCEL_COMMAND = 'moonageDaydream.cancelQuery';

/** tombol Cancel (command URI, webview tanpa script); index = statement tertentu pada run paralel */
const cancelBtn = (uri: string, cancelling?: boolean, index?: number) => cancelling
  ? '<span class="btn off" aria-disabled="true">Cancelling…</span>'
  : `<a class="btn" href="command:${CANCEL_COMMAND}?${esc(encodeURIComponent(JSON.stringify(index === undefined ? [uri] : [uri, index])))}">Cancel</a>`;

const spinner = (label: string) =>
  `<div class="spin"><i></i><i></i><i></i></div><div class="label">${label}<span class="dots"><b>.</b><b>.</b><b>.</b></span></div>`;

/** ikon jam footer (SVG inline: karakter ⏱ tidak ada di semua font) */
const CLOCK = '<svg class="clock" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5.5V9l2.2 1.4M6.5 1.5h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
/** tipe angka semua driver: decimal(12,2), int unsigned, int4, float8, double, long */
export const NUMERIC = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|money|smallmoney|int2|int4|int8|float4|float8|long)\b/;
/** ikon tipe di header kolom (gaya DBCode): # angka, abc teks, dt tanggal, 0x biner, bit */
function typeTag(type: string): string {
  if (NUMERIC.test(type)) return '#';
  if (/date|time/.test(type)) return 'dt';
  if (/binary|image|rowversion|bytea|blob|binData/.test(type)) return '0x';
  if (/^(bit|bool|boolean)$/.test(type)) return 'bit';
  return type ? 'abc' : '';
}

const PIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2h4l-.5 4 2.5 2.5v1H4v-1L6.5 6zM8 9.5V14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const EXPORT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 12.5h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FORMAT_OPTIONS = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
const FUNNEL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const DOTS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.5" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.5" r="1.3" fill="currentColor"/></svg>';

/** toolbar WHERE di atas grid (part = index query pada run paralel) */
function whereBar(where: string | undefined, part?: number): string {
  return `<form class="where"${part === undefined ? '' : ` data-part="${part}"`}><label>WHERE</label>`
    + `<input name="where" spellcheck="false" placeholder="e.g. name LIKE 'RF%'  (Enter to run again on the server)" value="${esc(where ?? '')}">`
    + `${where ? '<button type="button" class="clear" title="Clear filter">×</button>' : ''}</form>`;
}

/** canMore: statement asal diketahui (satu SELECT) -> tombol Load more di result set pertama */
/** editBlock: alasan result set tidak bisa diedit (dicek extension setelah hasil tampil) -> tombol edit nonaktif */
function resultHtml(r: QueryResult, canMore = false, editBlock?: string, genCols: string[] = []): string {
  const gen = new Set(genCols.map((g) => g.toLowerCase()));
  const sets = r.resultSets.map((s, i) => {
    // kolom angka rata kanan; tanpa info tipe: tebak dari nilai baris pertama
    const num = s.columns.map((_, c) => (s.types?.[c] ? NUMERIC.test(s.types[c]) : typeof s.rows[0]?.[c] === 'number'));
    const rows = s.rows
      .map((row, n) => `<tr><td class="n">${n + 1}</td>${row.map((v, c) => `<td${num[c] ? ' class="num"' : ''}>${cell(v)}</td>`).join('')}</tr>`).join('');
    const more = s.limited ? ` · auto limit ${s.limited}` : s.total > s.rows.length ? ` (showing first ${s.rows.length})` : '';
    const head = s.columns.map((c, k) => {
      const t = s.types?.[k] ?? '';
      return `<th data-c="${k}" data-name="${esc(c)}" data-type="${esc(t)}"${canMore && i === 0 && gen.has(c.toLowerCase()) ? ' data-gen="1"' : ''}${num[k] ? ' class="num"' : ''}${t ? ` title="${esc(t)}"` : ''}><span class="ty">${typeTag(t)}</span>${esc(c)}`
        + `<span class="hb"><button class="fbtn" data-c="${k}" title="Filter loaded rows">${FUNNEL}</button><button class="mbtn" data-c="${k}" title="Sort / hide">${DOTS}</button></span></th>`;
    }).join('');
    return `<div class="blk"><h3>Result ${i + 1} <span>${s.total} row(s)${more}</span></h3>
<div class="grid"><table class="rs" data-set="${i}"${canMore && i === 0 && !editBlock ? ' data-edit="1" title="Double-click a cell to edit; Save runs the changes in one transaction"' : ''}><thead><tr><th class="n"></th>${head}</tr></thead>${s.rows.length > VIRTUAL_ROWS
      ? `<tbody></tbody></table><template class="vrows">${rows}</template>` : `<tbody>${rows}</tbody></table>`}</div>
<div class="foot"><span>Rows: <b class="count" data-total="${s.rows.length}">${s.total}</b>${more}</span><span>${CLOCK}<b>${r.durationMs}ms</b></span>${canMore && i === 0
      ? editBlock ? `<span class="editbar off" title="Editing is off: ${esc(editBlock)}"><button class="addrow" disabled>Add row</button><button class="delrow" disabled>Delete rows</button></span>`
        : '<span class="editbar"><button class="addrow" title="Add a new row at the bottom">Add row</button><button class="delrow" title="Mark the selected rows for deletion">Delete rows</button><span class="pend" hidden><b class="ecount"></b> change(s)<button class="save" title="Run all changes in one transaction">Save</button><button class="genupd">Generate UPDATE script</button><button class="discard">Discard</button></span></span>' : ''}${canMore && i === 0 && (s.limited || s.total > s.rows.length) && s.rows.length < GRID_MAX_ROWS
      ? `<button class="morebtn" title="Run the query again and append the next ${PAGE_ROWS} rows (row order is only stable with ORDER BY)">Load more (+${PAGE_ROWS})</button>` : ''}<button class="xbtn" title="Export / save to file">${EXPORT_ICON}Export</button></div></div>`;
  }).join('');
  // jumlah baris per statement non-SELECT (urut), juga di samping result set SELECT: berjudul statement asalnya bila pasti
  const named = r.rowsAffected.flatMap((n, i) => {
    const st = r.affected?.[i];
    return st ? [`<div class="blk"><h3>Statement ${st.n} <span>${esc(preview(st.sql))}</span></h3><div class="aff">${n} row(s) affected</div></div>`] : [];
  }).join('');
  const msgs = [...r.messages, ...r.rowsAffected.flatMap((n, i) => (r.affected?.[i] ? [] : [`${n} row(s) affected`]))];
  if (!r.resultSets.length && !named && !msgs.length) msgs.push('Commands completed successfully.'); // DDL / EXEC tanpa hasil, seperti SSMS
  return `${sets}${named}${msgs.length ? `<div class="blk"><pre class="msg">${esc(msgs.join('\n'))}</pre></div>` : ''}`;
}

const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

function planHtml(o: PlanOutcome): string {
  const actual = o.mode === 'actual';
  const stmts = o.plan.map((st, i) => {
    const rows = st.nodes.map((n) => {
      const hot = n.pct >= 25 ? ' hot' : '';
      const off = actual && n.actualRows !== undefined && n.estRows > 0 && (n.actualRows / Math.max(1, n.executions ?? 1) > n.estRows * 10 || n.actualRows * 10 < n.estRows);
      return `<tr><td class="op" style="padding-left:${12 + n.depth * 18}px">${n.depth ? '<span class="tw">└</span>' : ''}<b>${esc(n.op)}</b>${n.logical && n.logical !== n.op ? ` <span class="lg">${esc(n.logical)}</span>` : ''}</td>`
        + `<td>${esc(n.object ?? '')}</td><td class="num">${fmtNum(n.estRows)}</td>`
        + (actual ? `<td class="num${off ? ' warn' : ''}"${off ? ' title="Actual rows differ >10x from the estimate (statistics may be stale)"' : ''}>${n.actualRows === undefined ? '' : fmtNum(n.actualRows)}</td><td class="num">${n.executions === undefined ? '' : fmtNum(n.executions)}</td>` : '')
        + `<td class="pct${hot}"><span class="track"><span class="cbar" style="width:${Math.min(100, n.pct).toFixed(1)}%"></span></span><span class="v">${n.pct.toFixed(1)}%</span></td></tr>`;
    }).join('');
    return `<h3>Statement ${i + 1} <span>${esc(preview(st.text))} · cost ${fmtNum(st.cost)}</span></h3>
<div class="grid"><table class="plan"><thead><tr><th>Operator</th><th>Object</th><th class="num">Est. rows</th>${actual ? '<th class="num">Actual rows</th><th class="num">Executions</th>' : ''}<th>Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
  const rows = o.rows?.length ? `<span>Query returned ${o.rows.map(fmtNum).join(' + ')} row(s)</span>` : '';
  return `<div class="planbar">${rows}<button class="xmlbtn" title="Open the raw execution plan XML">Open XML</button></div>${stmts || '<div class="msg">No plan returned.</div>'}`;
}

function partHtml(p: Part, i: number, uri: string, pinned: boolean): string {
  const o = p.o;
  const state = 'loading' in o ? (o.cancelling ? 'cancelling' : 'running') : 'error' in o ? 'failed' : `${o.result.durationMs} ms`;
  const head = `<h2>Query ${i + 1} <span>${esc(preview(p.sql))} · ${state}</span></h2>`;
  if ('loading' in o) return `<section data-part="${i}">${head}<div class="loading inline">${spinner(o.cancelling ? 'Cancelling query' : 'Running query')}${cancelBtn(uri, o.cancelling, i)}</div></section>`;
  return `<section data-part="${i}">${head}${pinned ? '' : whereBar(undefined, i)}${'error' in o ? `<div class="err">${esc(o.error)}</div>` : resultHtml(o.result, !pinned, o.editBlock, o.genCols)}</section>`;
}

/** pinned: snapshot di tab sendiri (tanpa toolbar WHERE / tombol Pin; filter, sort, export tetap) */
export function render(cspSource: string, title: string, o: Outcome, pinned = false): string {
  const nonce = Array.from({ length: 24 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
  let body: string;
  let status: string;
  if ('parts' in o) {
    const left = o.parts.filter((p) => 'loading' in p.o).length;
    const failed = o.parts.filter((p) => 'error' in p.o).length;
    status = left ? `Running ${left} of ${o.parts.length} queries in parallel…` : `${o.parts.length} queries done in ${(o.end ?? Date.now()) - o.start} ms${failed ? ` · ${failed} failed` : ''}`;
    body = o.parts.map((p, i) => partHtml(p, i, o.uri, pinned)).join('');
  } else if ('plan' in o) {
    status = `${o.mode === 'estimated' ? 'Explain (estimated plan, not executed)' : 'Analyze (actual plan, transaction rolled back)'} · ${o.durationMs} ms`;
    body = planHtml(o);
  } else if ('loading' in o) {
    status = 'Running…';
    body = `<div class="loading">
  ${spinner(o.cancelling ? 'Cancelling query' : 'Running query')}
  <div class="sub">${esc(title)}</div>
  ${o.uri ? cancelBtn(o.uri, o.cancelling) : ''}
</div>`;
  } else if ('error' in o) {
    status = 'Failed';
    body = `${o.source && !o.source.mongo && !pinned ? whereBar(o.source.where) : ''}<div class="err">${esc(o.error)}</div>`; // filter WHERE salah: bisa langsung diperbaiki
  } else {
    status = `Done in ${o.result.durationMs} ms`;
    body = `${o.source && !o.source.mongo && !pinned ? whereBar(o.source.where) : ''}${resultHtml(o.result, !!o.source && !pinned, o.editBlock, o.genCols)}`;
  }
  return webviewPage('results', {
    cspSource,
    nonce,
    bar: running(o) ? '<div class="bar"></div>' : '',
    top: 'loading' in o ? '' : `<div class="top">${pinned ? '📌 ' : ''}${esc(title)} · ${status}${pinned || running(o) ? '' : `<button class="pinbtn" title="Pin: keep this result in its own tab (next to the others) so new runs do not replace it">${PIN_ICON}Pin</button>`}</div>`,
    body,
    sideTabs: 'result' in o || 'parts' in o ? `<nav class="sidetabs"><button data-pane="cols">Columns</button><button data-pane="insp">Inspector</button></nav>
<aside id="side" hidden><div class="sidehead"><b id="sidetitle"></b><button class="sideclose" title="Close">×</button></div><div id="sidebody"></div></aside>` : '',
    data: pageJson(FORMAT_OPTIONS),
  });
}

const running = (o: Outcome) => ('parts' in o ? o.parts.some((p) => 'loading' in p.o) : 'loading' in o);

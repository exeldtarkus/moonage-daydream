import { GRID_MAX_ROWS, PAGE_ROWS, QueryResult, ResultSet } from './db';
import type { GridCache } from './cacheView';
import { MAX_CACHED_ROWS } from './resultCache';
import { preview } from './sqlContext';
import { FORMATS } from './exporter';
import type { PlanStatement } from './plan';
import { pageJson, webviewPage } from './webviewPage';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** teks sel grid (null = NULL); dikirim ke webview sebagai JSON, webview yang meng-escape */
export function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `0x${Buffer.from(v.subarray(0, 64)).toString('hex').toUpperCase()}${v.length > 64 ? '…' : ''}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
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
const COLS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h11v11h-11zM6.5 2.5v11M10 2.5v11" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const INSPECT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11M2.5 7h7M2.5 10.5h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="11" cy="10.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M13 12.5 15 14.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const SEARCH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.2 10.2 3.3 3.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const MINUS_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const SAVE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h8L13.5 5v8.5h-11zM5.5 2.5v4h5v-4M5 9.5h6v4H5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const SCRIPT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H6M10 3h1.5A1.5 1.5 0 0 1 13 4.5v7a1.5 1.5 0 0 1-1.5 1.5H10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const UNDO_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 7.5h6a3 3 0 1 1 0 6H6M3.5 7.5l2.5-2.5M3.5 7.5 6 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 5 4.5-5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EXPORT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 12.5h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const FORMAT_OPTIONS = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
const FUNNEL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const DOTS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3.5" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="12.5" r="1.3" fill="currentColor"/></svg>';

const WHERE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** filter WHERE di toolbar hasil (part = index query pada run paralel); tersembunyi sampai ikon WHERE diklik */
function whereBar(where: string | undefined, part?: number): string {
  return `<form class="where"${where ? ' data-on="1"' : ' hidden'}${part === undefined ? '' : ` data-part="${part}"`}><label>WHERE</label>`
    + `<input name="where" spellcheck="false" placeholder="e.g. name LIKE 'RF%'  (Enter to run again on the server)" value="${esc(where ?? '')}">`
    + `${where ? '<button type="button" class="clear" title="Clear filter">×</button>' : ''}</form>`;
}

/** kolom angka (rata kanan, sort angka): dari tipe driver, tanpa tipe = tebak dari nilai baris pertama */
export const isNumCol = (s: ResultSet, c: number) => (s.types?.[c] ? NUMERIC.test(s.types[c]) : typeof s.rows[0]?.[c] === 'number');

/** jumlah baris dengan titik pemisah ribuan: 1000000 -> 1.000.000 */
export const fmtCount = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

const LOAD_ALL_READONLY = 'rows loaded with Load all are read-only (run the query again without Load all to edit)';

/** kotak Search Output gaya Kibana "is one of": key jadi chip (digambar script grid), beberapa chip = OR, cocok di kolom mana pun */
const SEARCH_OUTPUT = '<div class="sout" role="search" hidden><div class="chips"><input class="skey" spellcheck="false" placeholder="type a value, Enter to add…  (&quot;exact&quot;, null)" aria-label="Search Output: type a value, Enter to add"></div>'
  + '<button class="sclear" title="Remove all search keys" hidden>Clear</button><span class="sbusy" hidden></span><span class="smatch" aria-live="polite"></span></div>';

/** navigasi halaman (menggulir grid ke halaman itu); jumlah halaman diisi script grid */
const PAGER = '<span class="pager"><button class="pprev" title="Previous page" aria-label="Previous page">‹</button>Page <input class="pnum" type="number" min="1" value="1" aria-label="Page number"> of <b class="pcount">1</b>'
  + '<button class="pnext" title="Next page" aria-label="Next page">›</button><select class="psize" aria-label="Rows per page"><option>100</option><option selected>500</option><option>1000</option></select></span>';

const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
/** judul result set hasil Load all: jumlah baris cache + ukuran RAM / disk + waktu snapshot, atau progres / cleared */
function cacheTitle(gc: GridCache): string {
  if (gc.cleared) return 'Result cache cleared, run the query again';
  const c = gc.view.cache;
  if (gc.loading) return `Loading ${fmtCount(gc.loading.rows)} rows…<button class="cancelload" title="Stop loading; the rows loaded so far stay">Cancel</button>`;
  const n = fmtCount(c.length);
  return `${c.partial ? `Partial: ${n} rows cached (limit reached)` : `${n} rows cached`} · RAM ${mb(c.memBytes)} MB · disk ${mb(c.diskBytes)} MB · snapshot ${new Date(gc.at).toLocaleTimeString()}`;
}
/** state awal grid mode cache (search / filter / sort tersimpan di host, tidak hilang saat panel digambar ulang) */
const cacheState = (gc: GridCache) => ({
  count: gc.cleared ? 0 : gc.view.count, total: gc.cleared ? 0 : gc.view.cache.length, keys: gc.view.keys, filters: gc.view.filters,
  sort: gc.view.sort, partial: gc.view.cache.partial, loading: !!gc.loading,
});

/** tombol edit grid di header hasil: ikon + tooltip; block = alasan hasil ini tidak bisa diedit */
const editBar = (block?: string) => (block
  ? `<span class="editbar off" title="Editing is off: ${esc(block)}"><button class="addrow" aria-label="Add row" disabled>${PLUS_ICON}</button><button class="delrow" aria-label="Delete rows" disabled>${MINUS_ICON}</button></span>`
  : `<span class="editbar"><button class="addrow" title="Add a new row at the bottom" aria-label="Add row">${PLUS_ICON}</button>`
    + `<button class="delrow" title="Mark the selected rows for deletion" aria-label="Delete rows">${MINUS_ICON}</button>`
    + `<span class="pend" hidden><b class="ecount"></b> change(s)<button class="save" title="Save: run all changes in one transaction" aria-label="Save">${SAVE_ICON}</button>`
    + `<button class="genupd" title="Generate UPDATE script" aria-label="Generate UPDATE script">${SCRIPT_ICON}</button>`
    + `<button class="discard" title="Discard the pending changes" aria-label="Discard">${UNDO_ICON}</button></span></span>`);

/** canMore: statement asal diketahui (satu SELECT) -> tombol Load more di result set pertama */
/** editBlock: alasan result set tidak bisa diedit (dicek extension setelah hasil tampil) -> tombol edit nonaktif */
function resultHtml(r: QueryResult, canMore = false, editBlock?: string, genCols: string[] = [], where?: { value?: string; part?: number }): string {
  const gen = new Set(genCols.map((g) => g.toLowerCase()));
  const sets = r.resultSets.map((s, i) => {
    const gc = s.cache;
    const block = gc ? LOAD_ALL_READONLY : editBlock;
    // kolom angka rata kanan; tanpa info tipe: tebak dari nilai baris pertama
    const num = s.columns.map((_, c) => isNumCol(s, c));
    const more = gc ? '' : s.limited ? ` · auto limit ${fmtCount(s.limited)}` : s.total > s.rows.length ? ` (showing first ${fmtCount(s.rows.length)})` : '';
    const head = s.columns.map((c, k) => {
      const t = s.types?.[k] ?? '';
      return `<th data-c="${k}" data-name="${esc(c)}" data-type="${esc(t)}"${canMore && i === 0 && gen.has(c.toLowerCase()) ? ' data-gen="1"' : ''}${num[k] ? ' class="num"' : ''}${t ? ` title="${esc(t)}"` : ''}><span class="hd"><span class="lbl"><span class="ty">${typeTag(t)}</span>${esc(c)}</span>`
        + `<span class="hb"><button class="fbtn" data-c="${k}" title="${gc ? 'Filter all cached rows' : 'Filter loaded rows'}">${FUNNEL}</button><button class="mbtn" data-c="${k}" title="Sort / hide">${DOTS}</button></span></span></th>`;
    }).join('');
    const truncated = !gc && (!!s.limited || s.total > s.rows.length);
    const title = gc ? cacheTitle(gc) : `${fmtCount(s.total)} row(s)${more}`;
    const whereOn = where && i === 0; // filter WHERE menjalankan ulang query asal: hanya result set pertama
    const tools = `<span class="rtools"><button class="searchbtn" title="Search Output (Ctrl+F)" aria-label="Search Output">${SEARCH_ICON}</button>`
      + `${whereOn ? `<button class="wherebtn${where.value ? ' on' : ''}" title="WHERE filter: run the query again on the server with an extra condition" aria-label="WHERE filter">${WHERE_ICON}</button>` : ''}`
      + `${canMore && i === 0 ? editBar(block) : ''}</span>`;
    const multi = r.resultSets.length > 1;
    const rhead = gc ? `<span class="rhead">${multi ? `Result ${i + 1} ` : ''}<span class="rtitle">${title}</span></span>`
      : multi ? `<span class="rhead">Result ${i + 1}</span>` : ''; // jumlah baris sudah ada di footer
    return `<div class="blk"><div class="rbar">${rhead}${tools}${whereOn ? whereBar(where.value, where.part) : ''}${SEARCH_OUTPUT}</div>
<div class="grid"><table class="rs" data-set="${i}"${gc ? ` data-cache="${esc(JSON.stringify(cacheState(gc)))}"` : ''}${canMore && i === 0 && !block ? ' data-edit="1" title="Double-click a cell to edit; Save runs the changes in one transaction"' : ''}><thead><tr><th class="n"></th>${head}</tr></thead><tbody></tbody></table>
<script type="application/json" class="rows">${pageJson(gc ? [] : s.rows.map((row) => row.map(cellText)))}</script></div>
<div class="foot"><span>Rows: <b class="count" data-total="${gc ? gc.view.cache.length : s.rows.length}">${fmtCount(gc ? gc.view.count : s.total)}</b>${more}</span><span>${CLOCK}<b>${r.durationMs}ms</b></span>${PAGER}${canMore && i === 0 && truncated && s.rows.length < GRID_MAX_ROWS
      ? `<button class="morebtn" title="Run the query again and append the next ${PAGE_ROWS} rows (row order is only stable with ORDER BY)">Load more (+${fmtCount(PAGE_ROWS)})</button>` : ''}${canMore && i === 0 && truncated
      ? `<button class="allbtn" title="Stream every row (up to ${fmtCount(MAX_CACHED_ROWS)}) into a local result cache; search, sort and export then work on all of them">Load all</button>` : ''}</div></div>`;
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
  const head = `<summary>${CHEVRON}<h2>Query ${i + 1} <span>${esc(preview(p.sql))} · ${state}</span></h2></summary>`;
  // tiap query bisa ditutup (details, default terbuka) supaya hasil yang banyak lebih mudah dibaca
  const body = 'loading' in o
    ? `<div class="loading inline">${spinner(o.cancelling ? 'Cancelling query' : 'Running query')}${cancelBtn(uri, o.cancelling, i)}</div>`
    : `${'error' in o ? `<div class="err">${esc(o.error)}</div>` : resultHtml(o.result, !pinned, o.editBlock, o.genCols, pinned ? undefined : { part: i })}`;
  return `<section data-part="${i}"><details class="qpart" open>${head}${body}</details></section>`;
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
    body = `<div class="err">${esc(o.error)}</div>`; // filter WHERE salah: bisa langsung diperbaiki
  } else {
    status = `Done in ${o.result.durationMs} ms`;
    body = resultHtml(o.result, !!o.source && !pinned, o.editBlock, o.genCols,
      o.source && !o.source.mongo && !pinned ? { value: o.source.where } : undefined);
  }
  return webviewPage('results', {
    cspSource,
    nonce,
    bar: running(o) ? '<div class="bar"></div>' : '',
    top: 'loading' in o ? '' : `<div class="top">${pinned ? '📌 ' : ''}${esc(title)} · ${status}${'parts' in o ? `<button class="pinbtn collapsebtn" title="Fold every query away; click again to open them all">${CHEVRON}<span class="lbl">Collapse all</span></button>` : ''}${pinned || running(o) ? '' : `<button class="pinbtn" title="Pin: keep this result in its own tab (next to the others) so new runs do not replace it">${PIN_ICON}Pin</button>`}</div>`,
    body,
    sideTabs: 'result' in o || 'parts' in o ? `<nav class="sidetabs"><button data-pane="cols" title="Show, hide and reorder columns">${COLS_ICON}Columns</button><button data-pane="insp" title="Inspect the selected row">${INSPECT_ICON}Inspector</button><button data-pane="exp" title="Export / save the active result to a file">${EXPORT_ICON}Export</button></nav>
<aside id="side" hidden><div class="sidehead"><b id="sidetitle"></b><button class="sideclose" title="Close">×</button></div><div id="sidesrc"></div><div id="sidebody"></div></aside>` : '',
    data: pageJson(FORMAT_OPTIONS),
  });
}

const running = (o: Outcome) => ('parts' in o ? o.parts.some((p) => 'loading' in p.o) : 'loading' in o);

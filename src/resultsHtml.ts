import { GRID_MAX_ROWS, PAGE_ROWS, QueryResult } from './db';

/** lebih dari sekian baris: baris disimpan di <template> (tidak di-layout) dan hanya yang dekat viewport dipasang di tabel */
export const VIRTUAL_ROWS = 300;
import { preview } from './sqlContext';
import { FORMATS } from './exporter';
import type { PlanStatement } from './plan';

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
export type Single = PlanOutcome | { result: QueryResult; source?: Source } | { error: string; source?: Source } | { loading: true; uri?: string; cancelling?: boolean };
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
function resultHtml(r: QueryResult, canMore = false): string {
  const sets = r.resultSets.map((s, i) => {
    // kolom angka rata kanan; tanpa info tipe: tebak dari nilai baris pertama
    const num = s.columns.map((_, c) => (s.types?.[c] ? NUMERIC.test(s.types[c]) : typeof s.rows[0]?.[c] === 'number'));
    const rows = s.rows
      .map((row, n) => `<tr><td class="n">${n + 1}</td>${row.map((v, c) => `<td${num[c] ? ' class="num"' : ''}>${cell(v)}</td>`).join('')}</tr>`).join('');
    const more = s.limited ? ` · auto limit ${s.limited}` : s.total > s.rows.length ? ` (showing first ${s.rows.length})` : '';
    const head = s.columns.map((c, k) => {
      const t = s.types?.[k] ?? '';
      return `<th data-c="${k}" data-name="${esc(c)}" data-type="${esc(t)}"${num[k] ? ' class="num"' : ''}${t ? ` title="${esc(t)}"` : ''}><span class="ty">${typeTag(t)}</span>${esc(c)}`
        + `<span class="hb"><button class="fbtn" data-c="${k}" title="Filter loaded rows">${FUNNEL}</button><button class="mbtn" data-c="${k}" title="Sort / hide">${DOTS}</button></span></th>`;
    }).join('');
    return `<h3>Result ${i + 1} <span>${s.total} row(s)${more}</span></h3>
<div class="grid"><table class="rs" data-set="${i}"${canMore && i === 0 ? ' data-edit="1" title="Double-click a cell to edit (generates an UPDATE script)"' : ''}><thead><tr><th class="n"></th>${head}</tr></thead>${s.rows.length > VIRTUAL_ROWS
      ? `<tbody></tbody></table><template class="vrows">${rows}</template>` : `<tbody>${rows}</tbody></table>`}</div>
<div class="foot"><span>Rows: <b class="count" data-total="${s.rows.length}">${s.total}</b>${more}</span><span>${CLOCK}<b>${r.durationMs}ms</b></span>${canMore && i === 0
      ? '<span class="editbar" hidden><b class="ecount"></b> change(s)<button class="genupd">Generate UPDATE script</button><button class="discard">Discard</button></span>' : ''}${canMore && i === 0 && (s.limited || s.total > s.rows.length) && s.rows.length < GRID_MAX_ROWS
      ? `<button class="morebtn" title="Run the query again and append the next ${PAGE_ROWS} rows (row order is only stable with ORDER BY)">Load more (+${PAGE_ROWS})</button>` : ''}<button class="xbtn" title="Export / save to file">${EXPORT_ICON}Export</button></div>`;
  }).join('');
  const msgs = [...r.messages, ...(r.resultSets.length ? [] : [`${r.rowsAffected.reduce((a, b) => a + b, 0)} row(s) affected`])];
  return `${sets}${msgs.length ? `<pre class="msg">${esc(msgs.join('\n'))}</pre>` : ''}`;
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
  return `<section data-part="${i}">${head}${pinned ? '' : whereBar(undefined, i)}${'error' in o ? `<div class="err">${esc(o.error)}</div>` : resultHtml(o.result, !pinned)}</section>`;
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
    body = `${o.source && !pinned ? whereBar(o.source.where) : ''}<div class="err">${esc(o.error)}</div>`; // filter WHERE salah: bisa langsung diperbaiki
  } else {
    status = `Done in ${o.result.durationMs} ms`;
    body = `${o.source && !pinned ? whereBar(o.source.where) : ''}${resultHtml(o.result, !!o.source && !pinned)}`;
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 8px 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .top { opacity: .85; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .pinbtn { margin-left: auto; padding: 1px 8px; border: 0; border-radius: 2px; cursor: pointer; font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  .pinbtn { display: inline-flex; align-items: center; gap: 4px; } .pinbtn svg { width: 12px; height: 12px; }
  .pinbtn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  h3 { font-size: 12px; margin: 12px 0 4px; } h3 span { font-weight: normal; opacity: .7; }
  /* grid gaya DBCode: header tebal + ikon tipe, baris lega selang-seling, angka rata kanan, footer Rows / waktu */
  .grid { overflow: auto; max-height: 70vh; border: 1px solid var(--vscode-panel-border); border-bottom: 0; }
  table { border-collapse: separate; border-spacing: 0; white-space: nowrap; min-width: 100%; }
  th, td { padding: 0 14px; height: 30px; text-align: left; border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, .15)); }
  th { position: sticky; top: 0; z-index: 1; height: 34px; font-weight: 600; font-family: var(--vscode-font-family);
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); }
  th .ty { margin-right: 6px; font-size: 10px; font-weight: normal; opacity: .55; font-family: var(--vscode-editor-font-family); }
  tbody tr:nth-child(even) td { background: var(--vscode-list-inactiveSelectionBackground, rgba(128, 128, 128, .06)); }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  .num { text-align: right; }
  .n { width: 1%; padding: 0 12px; color: var(--vscode-editorLineNumber-foreground); text-align: left; user-select: none;
    position: sticky; left: 0; background: var(--vscode-editor-background); border-right: 1px solid var(--vscode-panel-border); }
  th.n { z-index: 2; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); }
  .null { opacity: .5; }
  /* toolbar WHERE + tombol header + menu kolom */
  .where { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-family: var(--vscode-font-family); }
  .where label { font-size: 11px; font-weight: 600; opacity: .8; }
  .where input { flex: 1; min-width: 0; padding: 4px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  .where input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .where .clear, .hb button { border: 0; background: none; color: inherit; cursor: pointer; opacity: .6; padding: 2px; }
  .where .clear:hover, .hb button:hover, .hb button.on { opacity: 1; color: var(--vscode-textLink-foreground); }
  .hb { margin-left: 10px; white-space: nowrap; } .hb button { width: 18px; height: 18px; vertical-align: middle; }
  .hb svg { width: 13px; height: 13px; }
  .menu { position: fixed; z-index: 10; min-width: 190px; padding: 4px 0; overflow: auto; box-sizing: border-box; font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, .35); }
  .menu button { display: block; width: 100%; padding: 4px 14px; text-align: left; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
  .menu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
  .menu input { margin: 4px 10px; width: calc(100% - 20px); box-sizing: border-box; padding: 4px 6px; font: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  .menu hr { border: 0; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
  .foot .morebtn { margin-left: auto; padding: 1px 8px; border: 0; border-radius: 2px; cursor: pointer; font: inherit;
    color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
  .foot .morebtn:hover { background: var(--vscode-button-hoverBackground, #1177bb); } .foot .morebtn:disabled { opacity: .5; cursor: progress; }
  .foot .morebtn + .xbtn { margin-left: 8px; }
  .editbar { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-editorWarning-foreground, #cca700); }
  .editbar[hidden] { display: none; }
  .editbar button { padding: 1px 8px; border: 0; border-radius: 2px; cursor: pointer; font: inherit;
    color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  .editbar .genupd { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
  tbody td.edited { box-shadow: inset 2px 0 var(--vscode-editorWarning-foreground, #cca700); background: rgba(204, 167, 0, .12) !important; }
  tbody td input.cell { width: 100%; min-width: 80px; box-sizing: border-box; padding: 2px 4px; font: inherit; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder); }
  .foot .xbtn { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border: 0; border-radius: 2px; cursor: pointer;
    font: inherit; color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, transparent); }
  .foot .xbtn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .foot .xbtn svg { width: 12px; height: 12px; }
  tbody tr.sel td { background: var(--vscode-list-activeSelectionBackground, #094771) !important; color: var(--vscode-list-activeSelectionForeground, inherit); }
  tbody td { cursor: default; }
  tbody tr.vpad td { padding: 0; height: auto; border: 0; background: none !important; pointer-events: none; }
  .menu.export { padding: 10px 12px; min-width: 230px; }
  .menu.export label { display: block; margin: 6px 0 4px; font-weight: 600; }
  .menu select { width: 100%; padding: 4px; font: inherit; color: var(--vscode-dropdown-foreground, inherit);
    background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); }
  .menu .acts { display: flex; gap: 8px; margin-top: 12px; } .menu .acts button { flex: 1; margin: 0; }
  .menu button.second { text-align: center; padding: 6px; border-radius: 2px;
    color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  .menu button.second:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .menu button:disabled { opacity: .45; cursor: not-allowed; }
  .menu button.primary { margin-top: 12px; text-align: center; padding: 6px; border-radius: 2px;
    color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
  .menu button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  /* panel samping: Columns / Inspector (tab vertikal di tepi kanan) */
  .sidetabs { position: fixed; right: 0; top: 40px; display: flex; flex-direction: column; gap: 4px; z-index: 5; }
  .sidetabs button { writing-mode: vertical-rl; padding: 10px 3px; border: 0; border-radius: 3px 0 0 3px; cursor: pointer; font-family: var(--vscode-font-family); font-size: 11px;
    color: var(--vscode-foreground, inherit); background: var(--vscode-editorGroupHeader-tabsBackground, #252526); opacity: .75; }
  .sidetabs button:hover, .sidetabs button.on { opacity: 1; background: var(--vscode-list-hoverBackground, #2a2d2e); }
  body.side-open { padding-right: 300px; } body.side-open .sidetabs { right: 284px; }
  #side { position: fixed; top: 0; right: 0; bottom: 0; width: 284px; z-index: 6; overflow: auto; box-sizing: border-box; padding: 8px 10px;
    font-family: var(--vscode-font-family); font-size: 12px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-left: 1px solid var(--vscode-panel-border); }
  .sidehead { display: flex; align-items: center; margin-bottom: 8px; } .sidehead .sideclose { margin-left: auto; border: 0; background: none; color: inherit; cursor: pointer; font-size: 16px; }
  #side input[type=search] { width: 100%; box-sizing: border-box; padding: 4px 6px; margin-bottom: 6px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  #side .col { display: flex; align-items: center; gap: 6px; padding: 3px 2px; border-radius: 2px; }
  #side .col:hover { background: var(--vscode-list-hoverBackground); } #side .col a { color: inherit; text-decoration: none; cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #side .col .t, #side .kv .t { opacity: .5; font-size: 10px; }
  #side .col { cursor: grab; } #side .col .mv { border: 0; background: none; color: inherit; cursor: pointer; opacity: .5; padding: 0 2px; }
  #side .col .mv:hover { opacity: 1; }
  #side .acts2 { display: flex; gap: 6px; margin-bottom: 6px; } #side .acts2 button { flex: 1; padding: 3px; border: 0; border-radius: 2px; cursor: pointer; font: inherit;
    color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  #side .kv { padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); } #side .kv .k { font-weight: 600; }
  #side .kv .v { margin-top: 2px; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-word; }
  #side .hint { opacity: .6; }
  /* execution plan */
  .planbar { display: flex; align-items: center; gap: 12px; margin: 4px 0 8px; font-family: var(--vscode-font-family); font-size: 12px; }
  .planbar .xmlbtn { margin-left: auto; padding: 2px 10px; border: 0; border-radius: 2px; cursor: pointer; font: inherit;
    color: var(--vscode-button-secondaryForeground, inherit); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  table.plan td.op b { font-weight: 600; } table.plan .lg { opacity: .6; } table.plan .tw { opacity: .4; margin-right: 6px; }
  table.plan td.pct { min-width: 160px; }
  table.plan .track { display: inline-block; width: 90px; height: 10px; vertical-align: middle; border-radius: 2px; background: rgba(128, 128, 128, .15); }
  table.plan .cbar { display: block; height: 100%; border-radius: 2px; background: var(--vscode-charts-blue, #3794ff); }
  table.plan td.hot .cbar { background: var(--vscode-charts-red, #f14c4c); }
  table.plan .v { padding-left: 8px; }
  table.plan td.warn { color: var(--vscode-editorWarning-foreground, #cca700); font-weight: 600; }
  .foot .clock { width: 12px; height: 12px; margin-right: 4px; vertical-align: -2px; }
  .foot { display: flex; gap: 16px; padding: 6px 12px; font-family: var(--vscode-font-family); font-size: 12px; opacity: .8;
    border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); }
  .err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .msg { white-space: pre-wrap; opacity: .8; }
  /* loading: spinner tiga cincin di tengah + progress bar tipis di atas, hanya CSS (webview hasil tanpa script) */
  .loading { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .spin { position: relative; width: 48px; height: 48px; }
  .spin i { position: absolute; inset: 0; border-radius: 50%; border: 3px solid transparent; animation: spin 1.1s cubic-bezier(.5, .1, .5, .9) infinite; }
  .spin i:nth-child(1) { border-top-color: var(--vscode-progressBar-background, #0e70c0); }
  .spin i:nth-child(2) { inset: 7px; border-right-color: var(--vscode-textLink-foreground, #3794ff); animation-duration: 1.6s; animation-direction: reverse; }
  .spin i:nth-child(3) { inset: 14px; border-bottom-color: var(--vscode-charts-green, #89d185); animation-duration: .9s; }
  .label { font-family: var(--vscode-font-family); font-size: 13px; letter-spacing: .3px; }
  .dots b { font-weight: normal; animation: blink 1.2s infinite; }
  .dots b:nth-child(2) { animation-delay: .2s; } .dots b:nth-child(3) { animation-delay: .4s; }
  .sub { font-size: 11px; opacity: .55; }
  .btn { margin-top: 4px; padding: 4px 14px; border-radius: 2px; font-family: var(--vscode-font-family); font-size: 12px; text-decoration: none;
    color: var(--vscode-button-secondaryForeground, #fff); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  /* run paralel: tiap statement satu section, loading kecil sebaris */
  h2 { font-size: 13px; margin: 16px 0 6px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  section:first-of-type h2 { border-top: 0; padding-top: 0; margin-top: 4px; } h2 span { font-weight: normal; opacity: .7; }
  .loading.inline { position: static; flex-direction: row; justify-content: flex-start; padding: 10px 4px; }
  .loading.inline .spin { width: 24px; height: 24px; } .loading.inline .spin i { border-width: 2px; }
  .loading.inline .spin i:nth-child(2) { inset: 4px; } .loading.inline .spin i:nth-child(3) { inset: 8px; }
  .loading.inline .btn { margin: 0 0 0 8px; }
  .btn.off { opacity: .5; cursor: not-allowed; }
  .bar { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; }
  .bar::after { content: ''; position: absolute; top: 0; width: 30%; height: 100%; background: var(--vscode-progressBar-background, #0e70c0);
    animation: slide 1.4s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes blink { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
  @keyframes slide { from { left: -30%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .spin i, .dots b, .bar::after { animation-duration: 3s; } }
</style>
</head>
<body>
${running(o) ? '<div class="bar"></div>' : ''}${'loading' in o ? '' : `<div class="top">${pinned ? '📌 ' : ''}${esc(title)} · ${status}${pinned || running(o) ? '' : `<button class="pinbtn" title="Pin: keep this result in its own tab (next to the others) so new runs do not replace it">${PIN_ICON}Pin</button>`}</div>`}
${body}
<div id="menu" class="menu" hidden></div>
${'result' in o || 'parts' in o ? `<nav class="sidetabs"><button data-pane="cols">Columns</button><button data-pane="insp">Inspector</button></nav>
<aside id="side" hidden><div class="sidehead"><b id="sidetitle"></b><button class="sideclose" title="Close">×</button></div><div id="sidebody"></div></aside>` : ''}
<script nonce="${nonce}">const FORMAT_OPTIONS = ${JSON.stringify(FORMAT_OPTIONS)};${GRID_SCRIPT}</script>
</body>
</html>`;
}

const running = (o: Outcome) => ('parts' in o ? o.parts.some((p) => 'loading' in p.o) : 'loading' in o);

/**
 * script grid (webview): toolbar WHERE -> postMessage ke extension (query dijalankan ulang di server);
 * filter / sort / hide kolom hanya di baris yang sudah dimuat (DOM), tanpa ke server.
 */
const GRID_SCRIPT = `(() => {
  const vscode = acquireVsCodeApi();
  const menu = document.getElementById('menu');
  const state = new Map();
  const st = (t) => {
    if (!state.has(t)) {
      const tpl = t.nextElementSibling?.matches('template.vrows') ? t.nextElementSibling : null;
      const rows = tpl ? [...tpl.content.querySelectorAll('tr')] : [...t.tBodies[0].rows];
      state.set(t, { rows, view: rows, virtual: !!tpl, filters: {}, sort: null, hidden: new Set(), sel: new Set(), anchor: null });
    }
    return state.get(t);
  };
  /**
   * virtual scroll: hanya baris view (hasil filter / sort) di sekitar viewport yang dipasang di tbody, sisanya diganti spacer setinggi barisnya.
   * Baris lain tetap ada sebagai elemen terlepas (filter / sort / seleksi / edit / export tetap atas semua baris).
   */
  function render(t) {
    const s = st(t), body = t.tBodies[0];
    if (!s.virtual) { s.view.forEach((r) => body.appendChild(r)); return; }
    if (!s.top) {
      s.top = document.createElement('tr');
      s.top.className = 'vpad';
      s.top.innerHTML = '<td colspan="9999"></td>';
      s.bot = s.top.cloneNode(true);
    }
    const grid = t.closest('.grid'), h = s.rowH || 31;
    let from = Math.max(0, Math.floor((grid.scrollTop - t.tHead.offsetHeight) / h) - 40);
    from -= from % 2; // zebra (nth-child) tidak berganti saat scroll
    const to = Math.min(s.view.length, from + Math.ceil((grid.clientHeight || innerHeight) / h) + 80);
    s.top.firstChild.style.height = from * h + 'px';
    s.bot.firstChild.style.height = (s.view.length - to) * h + 'px';
    body.replaceChildren(s.top, ...s.view.slice(from, to), s.bot);
    if (!s.rowH && to > from) {
      s.rowH = s.view[from].getBoundingClientRect().height || h;
      if (s.rowH !== h) render(t);
    }
  }
  let scrolling = false;
  // scroll tidak bubble: tangkap di document lalu render tabel di .grid yang di-scroll (sekali per frame)
  document.addEventListener('scroll', (e) => {
    const t = e.target.classList?.contains('grid') && e.target.querySelector('table.rs');
    if (!t || !st(t).virtual || scrolling) return;
    scrolling = true;
    requestAnimationFrame(() => { scrolling = false; render(t); });
  }, true);
  document.querySelectorAll('table.rs').forEach((t) => st(t).virtual && render(t));
  const saved = vscode.getState() || {};
  /** baris terpilih (index asli) dalam urutan tampil sekarang */
  const selected = (t) => { const s = st(t); return s.rows.filter((r) => !r.hidden && s.sel.has(s.rows.indexOf(r))).map((r) => s.rows.indexOf(r)); };
  /** urutan kolom sekarang: index kolom asli per posisi (kolom bisa diurutkan ulang di panel Columns) */
  const order = (t) => [...t.tHead.rows[0].cells].slice(1).map((th) => +th.dataset.c);
  /** sel kolom asli c pada baris r (posisi bisa berubah setelah kolom dipindah) */
  const cellOf = (t, r, c) => r.cells[order(t).indexOf(c) + 1];
  const visibleCols = (t) => order(t).filter((c) => !st(t).hidden.has(c));
  /** pindahkan kolom asli c ke posisi (0-based) to: sel dipindah di header dan semua baris */
  function moveCol(t, c, to) {
    const from = order(t).indexOf(c);
    const n = order(t).length;
    to = Math.max(0, Math.min(n - 1, to));
    if (from < 0 || from === to) return;
    for (const r of [t.tHead.rows[0], ...st(t).rows]) {
      const cell = r.cells[from + 1];
      const ref = r.cells[to + (to > from ? 2 : 1)] ?? null;
      r.insertBefore(cell, ref);
    }
  }
  /** export / copy ke extension: baris terpilih (scope sel) atau semua data, kolom yang tidak disembunyikan */
  function send(t, type, format, scope, header) {
    const part = t.closest('section')?.dataset.part;
    vscode.postMessage({ type, format, scope, header, set: +t.dataset.set, part: part === undefined ? undefined : +part,
      rows: scope === 'sel' ? selected(t) : undefined, cols: visibleCols(t) });
  }
  /** Copy tidak tersedia untuk Excel (file biner) */
  function syncCopy() {
    const c = menu.querySelector('[data-a=xcopy]');
    if (c) c.disabled = document.getElementById('xf').value === 'xlsx';
  }
  function paintSel(t) { const s = st(t); s.rows.forEach((r, i) => r.classList.toggle('sel', s.sel.has(i))); }
  const text = (td) => (td.querySelector('.null') ? null : td.textContent);
  const match = (v, f) => (f.toLowerCase() === 'null' ? v === null : v !== null && v.toLowerCase().includes(f.toLowerCase()));
  function apply(t) {
    const s = st(t);
    let rows = s.rows.filter((r) => Object.entries(s.filters).every(([c, f]) => match(text(cellOf(t, r, +c)), f)));
    if (s.sort) {
      const { c, dir } = s.sort;
      const num = cellOf(t, t.tHead.rows[0], c).classList.contains('num');
      const key = (r) => text(cellOf(t, r, c));
      rows = [...rows].sort((a, b) => {
        const x = key(a), y = key(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // (null) selalu di bawah
        return dir * (num ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true }));
      });
    }
    s.rows.forEach((r) => (r.hidden = true));
    rows.forEach((r, i) => { r.hidden = false; r.cells[0].textContent = String(i + 1); });
    s.view = rows;
    render(t);
    const ord = order(t);
    for (const r of [t.tHead.rows[0], ...s.rows]) [...r.cells].forEach((td, i) => (td.hidden = i > 0 && s.hidden.has(ord[i - 1])));
    t.tHead.querySelectorAll('.fbtn').forEach((b) => b.classList.toggle('on', b.dataset.c in s.filters));
    t.tHead.querySelectorAll('.mbtn').forEach((b) => b.classList.toggle('on', s.sort?.c === +b.dataset.c));
    const count = t.closest('.grid').nextElementSibling.querySelector('.count');
    const filtered = rows.length !== s.rows.length;
    count.textContent = filtered ? rows.length + ' / ' + count.dataset.total + ' (filtered)' : count.dataset.total;
    if (pane === 'cols' && !document.activeElement?.matches?.('#colq')) renderSide();
  }
  /** popup di bawah tombol; tidak muat -> di atas tombol; tetap dalam layar (diukur setelah isi + class terpasang) */
  function open(btn, html, init, cls) {
    menu.className = 'menu' + (cls ? ' ' + cls : '');
    menu.innerHTML = html;
    menu.hidden = false;
    init?.();
    const r = btn.getBoundingClientRect();
    menu.style.maxHeight = innerHeight - 8 + 'px';
    const h = menu.offsetHeight, w = menu.offsetWidth;
    menu.style.left = Math.max(4, Math.min(r.left, innerWidth - w - 4)) + 'px';
    const top = r.bottom + 2 + h <= innerHeight ? r.bottom + 2 : r.top - h - 2;
    menu.style.top = Math.max(4, Math.min(top, innerHeight - h - 4)) + 'px';
  }
  // Shift+klik memperluas seleksi baris, bukan blok teks
  document.addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('tbody td')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    const tb = e.target.closest('table.rs');
    if (tb) active = tb;
    const go = e.target.closest('[data-goto]');
    if (go) { cellOf(tableOf(), tableOf().tHead.rows[0], +go.dataset.goto).scrollIntoView({ block: 'nearest', inline: 'center' }); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const t = tableOf(), c = +mv.dataset.c;
      moveCol(t, c, order(t).indexOf(c) + +mv.dataset.move);
      apply(t);
      renderSide();
      return;
    }
    const td = e.target.closest('tbody td');
    if (td && td.closest('table.rs')) {
      // pilih baris: klik = satu baris, Ctrl/Cmd+klik = tambah / kurangi, Shift+klik = rentang dari baris terakhir
      const t = td.closest('table'), s = st(t), tr = td.parentElement, i = s.rows.indexOf(tr);
      const visible = s.rows.filter((r) => !r.hidden);
      if (e.shiftKey && s.anchor !== null) {
        const a = visible.indexOf(s.rows[s.anchor]), z = visible.indexOf(tr);
        if (!(e.ctrlKey || e.metaKey)) s.sel.clear();
        visible.slice(Math.min(a, z), Math.max(a, z) + 1).forEach((r) => s.sel.add(s.rows.indexOf(r)));
      } else if (e.ctrlKey || e.metaKey) {
        s.sel.has(i) ? s.sel.delete(i) : s.sel.add(i);
        s.anchor = i;
      } else {
        s.sel = new Set([i]);
        s.anchor = i;
      }
      paintSel(t);
      if (pane === 'insp') renderSide();
      return;
    }
    const b = e.target.closest('button');
    if (!b) { if (!menu.contains(e.target)) menu.hidden = true; return; }
    if (b.dataset.pane) { openPane(b.dataset.pane); return; }
    if (b.classList.contains('sideclose')) { openPane(pane); return; }
    if (b.dataset.a === 'colsall' || b.dataset.a === 'colsnone') {
      const t = tableOf(), s = st(t);
      s.hidden = b.dataset.a === 'colsall' ? new Set() : new Set(order(t).slice(1)); // sisakan kolom pertama
      apply(t);
      renderSide();
      return;
    }
    const th = b.closest('th');
    if (b.classList.contains('xmlbtn')) { vscode.postMessage({ type: 'planXml' }); return; }
    if (b.classList.contains('pinbtn')) { vscode.postMessage({ type: 'pin' }); return; }
    if (b.classList.contains('genupd') || b.classList.contains('discard')) {
      const t = b.closest('.foot').previousElementSibling.querySelector('table'), s = st(t);
      if (b.classList.contains('genupd')) {
        const edits = [...s.edits].map(([k, value]) => { const [row, col] = k.split(':').map(Number); return { row, col, value }; });
        const part = t.closest('section')?.dataset.part;
        vscode.postMessage({ type: 'edits', set: +t.dataset.set, part: part === undefined ? undefined : +part, edits });
      } else {
        st(t).rows.flatMap((r) => [...r.querySelectorAll('td.edited')]).forEach((td) => { showCell(td, JSON.parse(td.dataset.orig)); td.classList.remove('edited'); });
        s.edits.clear();
        syncEdits(t);
      }
      return;
    }
    if (b.classList.contains('morebtn')) {
      const t = b.closest('.foot').previousElementSibling.querySelector('table');
      const part = t.closest('section')?.dataset.part;
      b.disabled = true;
      b.textContent = 'Loading…';
      vscode.postMessage({ type: 'more', set: +t.dataset.set, part: part === undefined ? undefined : +part });
      return;
    }
    if (b.classList.contains('xbtn')) {
      e.stopPropagation();
      const t = b.closest('.foot').previousElementSibling.querySelector('table');
      const n = selected(t).length;
      menu.table = t;
      open(b, '<label>Export</label><select id="xs"><option value="all">All Data</option><option value="sel"' + (n ? '' : ' disabled') + '>Current Selection (' + n + ' rows)</option></select>'
        + '<label>Format</label><select id="xf">' + FORMAT_OPTIONS + '</select>'
        + '<div class="acts"><button data-a="xsave" class="primary">Save</button><button data-a="xcopy" class="second" title="Copy to clipboard">Copy</button></div>', () => {
        document.getElementById('xs').value = n ? 'sel' : 'all';
        if (saved.format) document.getElementById('xf').value = saved.format;
        syncCopy();
      }, 'export');
      return;
    }
    if (b.classList.contains('fbtn') || b.classList.contains('mbtn')) {
      e.stopPropagation();
      const t = th.closest('table');
      const c = +b.dataset.c;
      const s = st(t);
      menu.table = t; menu.col = c;
      if (b.classList.contains('fbtn')) {
        open(b, '<input id="f" placeholder="contains…  (null = empty)" value="' + (s.filters[c] ?? '').replace(/"/g, '&quot;') + '"><hr><button data-a="clearf">Clear filter</button>', () => document.getElementById('f').focus());
      } else {
        open(b, '<button data-a="asc">Sort ascending</button><button data-a="desc">Sort descending</button><button data-a="nosort">Clear sort</button><hr>'
          + '<button data-a="hide">Hide column</button>' + (s.hidden.size ? '<button data-a="showall">Show all columns (' + s.hidden.size + ' hidden)</button>' : ''));
      }
      return;
    }
    if (menu.contains(b)) {
      const t = menu.table, c = menu.col, s = st(t);
      const a = b.dataset.a;
      if (a === 'xsave' || a === 'xcopy') {
        const format = document.getElementById('xf').value, scope = document.getElementById('xs').value;
        saved.format = format;
        vscode.setState(saved);
        send(t, a === 'xsave' ? 'export' : 'copy', format, scope);
        menu.hidden = true;
        return;
      }
      if (a === 'asc' || a === 'desc') s.sort = { c, dir: a === 'asc' ? 1 : -1 };
      if (a === 'nosort') s.sort = null;
      if (a === 'hide') s.hidden.add(c);
      if (a === 'showall') s.hidden.clear();
      if (a === 'clearf') delete s.filters[c];
      menu.hidden = true;
      apply(t);
      return;
    }
    if (b.classList.contains('clear')) {
      const form = b.closest('form');
      form.where.value = '';
      form.requestSubmit();
    }
  });
  // panel samping: Columns (tampil / sembunyi, cari, lompat ke kolom) dan Inspector (detail baris terpilih)
  const side = document.getElementById('side');
  let pane = null, active = null;
  const tableOf = () => (active && document.contains(active) ? active : document.querySelector('table.rs'));
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function renderSide() {
    if (!side || side.hidden) return;
    const t = tableOf();
    const body = document.getElementById('sidebody');
    document.getElementById('sidetitle').textContent = pane === 'cols' ? 'Columns' : 'Inspector';
    if (!t) { body.innerHTML = '<div class="hint">No result</div>'; return; }
    const s = st(t);
    const heads = [...t.tHead.rows[0].cells].slice(1);
    if (pane === 'cols') {
      const q = document.getElementById('colq')?.value ?? '';
      body.innerHTML = '<input type="search" id="colq" placeholder="Search columns…" value="' + esc(q) + '">'
        + '<div class="acts2"><button data-a="colsall">Show all</button><button data-a="colsnone">Hide all</button></div>'
        + heads.map((h) => {
          const c = +h.dataset.c;
          return h.dataset.name.toLowerCase().includes(q.toLowerCase())
            ? '<div class="col" draggable="true" data-c="' + c + '"><input type="checkbox" data-col="' + c + '"' + (s.hidden.has(c) ? '' : ' checked') + '><a data-goto="' + c + '">' + esc(h.dataset.name) + '</a><span class="t">' + esc(h.dataset.type) + '</span>'
              + '<button class="mv" data-move="-1" data-c="' + c + '" title="Move left">↑</button><button class="mv" data-move="1" data-c="' + c + '" title="Move right">↓</button></div>' : '';
        }).join('');
      const qi = document.getElementById('colq');
      if (q) { qi.focus(); qi.setSelectionRange(q.length, q.length); }
    } else {
      const i = s.anchor;
      const r = i === null ? null : s.rows[i];
      body.innerHTML = !r ? '<div class="hint">Select a row to inspect it.</div>'
        : '<div class="hint">Row ' + r.cells[0].textContent + '</div>' + heads.map((h, c) => {
          const td = r.cells[c + 1];
          const v = text(td);
          return '<div class="kv"><div class="k">' + esc(h.dataset.name) + ' <span class="t">' + esc(h.dataset.type) + '</span></div><div class="v' + (v === null ? ' null' : '') + '">' + (v === null ? '(null)' : esc(v)) + '</div></div>';
        }).join('');
    }
  }
  function openPane(p) {
    const same = pane === p && !side.hidden;
    pane = p;
    side.hidden = same;
    document.body.classList.toggle('side-open', !same);
    document.querySelectorAll('.sidetabs button').forEach((b) => b.classList.toggle('on', !same && b.dataset.pane === p));
    renderSide();
  }
  // edit sel (double-click): disimpan di state, script UPDATE dibuat extension; tidak ada yang dijalankan otomatis
  const editKey = (r, c) => r + ':' + c;
  const showCell = (td, v) => { td.innerHTML = v === null ? '<span class="null">(null)</span>' : esc(v); };
  function syncEdits(t) {
    const s = st(t);
    const bar = t.closest('.grid').nextElementSibling.querySelector('.editbar');
    if (!bar) return;
    bar.hidden = !s.edits?.size;
    bar.querySelector('.ecount').textContent = String(s.edits?.size ?? 0);
  }
  function commitCell(td, input, keep) {
    const t = td.closest('table'), s = st(t), tr = td.parentElement;
    const r = s.rows.indexOf(tr), c = order(t)[[...tr.cells].indexOf(td) - 1]; // index kolom asli (kolom bisa dipindah)
    const orig = JSON.parse(td.dataset.orig);
    const v = !keep ? orig : input.value === 'NULL' ? null : input.value;
    s.edits ??= new Map();
    if (v === orig) s.edits.delete(editKey(r, c)); else s.edits.set(editKey(r, c), v);
    td.classList.toggle('edited', s.edits.has(editKey(r, c)));
    showCell(td, v);
    syncEdits(t);
  }
  document.addEventListener('dblclick', (e) => {
    const td = e.target.closest('tbody td');
    const t = td?.closest('table[data-edit]');
    if (!td || !t || td.classList.contains('n') || td.querySelector('input')) return;
    td.dataset.orig ??= JSON.stringify(text(td));
    const cur = text(td);
    td.innerHTML = '<input class="cell" spellcheck="false">';
    const input = td.firstChild;
    input.value = cur === null ? 'NULL' : cur;
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => { if (!done) { done = true; commitCell(td, input, keep); } };
    input.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') { k.preventDefault(); finish(true); }
      if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); done = true; showCell(td, cur); } // done dulu: hapus input memicu blur
    });
    input.addEventListener('blur', () => finish(true));
  });
  // drag kolom di panel Columns: lepas di atas kolom lain -> pindah ke posisi itu
  let dragCol = null;
  document.addEventListener('dragstart', (e) => { const el = e.target.closest?.('#side .col'); if (el) { dragCol = +el.dataset.c; e.dataTransfer.effectAllowed = 'move'; } });
  document.addEventListener('dragover', (e) => { if (dragCol !== null && e.target.closest?.('#side .col')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const el = e.target.closest?.('#side .col');
    if (dragCol === null || !el) return;
    e.preventDefault();
    const t = tableOf();
    moveCol(t, dragCol, order(t).indexOf(+el.dataset.c));
    dragCol = null;
    apply(t);
    renderSide();
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'xf') syncCopy();
    if (e.target.dataset?.col !== undefined) {
      const t = tableOf(), s = st(t), c = +e.target.dataset.col;
      e.target.checked ? s.hidden.delete(c) : s.hidden.add(c);
      apply(t);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'colq') { renderSide(); return; }
    if (e.target.id !== 'f') return;
    const s = st(menu.table);
    if (e.target.value) s.filters[menu.col] = e.target.value; else delete s.filters[menu.col];
    apply(menu.table);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && e.target.id === 'f')) menu.hidden = true;
    // Ctrl/Cmd+C: baris terpilih sebagai TSV tanpa header (paste langsung ke spreadsheet); tidak saat mengetik di input
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.target.closest('input, select, textarea') && !String(getSelection())) {
      const t = [...document.querySelectorAll('table.rs')].find((x) => selected(x).length);
      if (!t) return;
      e.preventDefault();
      send(t, 'copy', 'tsv', 'sel', false);
    }
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    vscode.postMessage({ type: 'where', where: f.where.value, part: f.dataset.part === undefined ? undefined : +f.dataset.part });
  });
})();`;

import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';

/**
 * editor Columns (klik kanan tabel), seperti DBeaver: grid kolom bisa diedit (nama, tipe dari dropdown + ukuran, NOT NULL, default,
 * tambah / hapus), daftar Pending changes berisi langkah SQL yang akan dijalankan; Execute / Open in SQL Editor / Revert.
 * ext -> page: { type: 'load', cols, info, types, capabilities } | { type: 'script', sql, errors, count, steps } | { type: 'status', text, error? }
 * page -> ext: { type: 'ready' | 'refresh' | 'fkTables' } | { type: 'change' | 'execute' | 'open' | 'fkColumns', rows?, table?, schema?, name? }
 * FK responses carry the tables / columns needed by the editor.
 */
export function columnsHtml(cspSource: string, t: { conn: string; db: string; table: string }, readOnly: boolean, mode: 'edit' | 'create' = 'edit'): string {
  const create = mode === 'create';
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --fg: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, #8884);
    --bg: var(--vscode-editor-background); --raise: var(--vscode-sideBar-background, var(--bg)); --focus: var(--vscode-focusBorder);
    --accent: var(--vscode-textLink-foreground, #3794ff); --mono: var(--vscode-editor-font-family, monospace);
    --changed: var(--vscode-gitDecoration-modifiedResourceForeground, #d7ba7d); --added: var(--vscode-gitDecoration-addedResourceForeground, #81b88b);
    --deleted: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); --err: var(--vscode-errorForeground, #f48771);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; color: var(--fg); background: var(--bg); font-family: var(--vscode-font-family); font-size: 13px; }
  button { font: inherit; height: 28px; padding: 0 12px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  :focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }

  header { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 20px; padding: 18px 20px 14px; }
  .ident { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .ident svg { flex: none; width: 30px; height: 30px; color: var(--accent); }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.01em; font-family: var(--mono); overflow-wrap: anywhere; }
  .where { margin: 2px 0 0; color: var(--muted); }
  .summary { color: var(--muted); padding-bottom: 2px; }
  .summary b { color: var(--fg); font-weight: 600; }
  .actions { margin-left: auto; display: flex; gap: 8px; }
  .ro { color: var(--vscode-editorWarning-foreground); align-self: center; }
  #status { flex-basis: 100%; min-height: 0; color: var(--muted); }
  #status:empty { display: none; }
  #status.err { color: var(--err); }

  .grid { flex: 1; min-height: 140px; overflow: auto; padding: 0 20px 12px; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; }
  th { position: sticky; top: 0; z-index: 2; text-align: left; font-weight: 600; color: var(--muted); padding: 8px 8px; background: var(--bg); border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); vertical-align: middle; }
  td.mark { width: 4px; padding: 0; }
  tr > td.mark { box-shadow: inset 3px 0 0 transparent; }
  tr.changed > td.mark { box-shadow: inset 3px 0 0 var(--changed); }
  tr.added > td.mark { box-shadow: inset 3px 0 0 var(--added); }
  tr.deleted > td.mark { box-shadow: inset 3px 0 0 var(--deleted); }
  tr.added { background: color-mix(in srgb, var(--added) 7%, transparent); }
  tr.deleted { background: color-mix(in srgb, var(--deleted) 7%, transparent); }
  tr.deleted input, tr.deleted select { text-decoration: line-through; }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  td.num { width: 32px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }

  input[type=text], select { height: 26px; font: inherit; padding: 0 6px; border-radius: 3px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--line) 80%, transparent)); }
  input[type=text]:focus, select:focus { outline: none; border-color: var(--focus); }
  input:disabled, select:disabled { opacity: .55; }
  .name { width: 100%; min-width: 120px; font-weight: 500; }
  .type { display: flex; gap: 4px; min-width: 210px; }
  .type select { flex: 1; min-width: 110px; font-family: var(--mono); color: var(--vscode-symbolIcon-typeParameterForeground, var(--fg)); }
  .type .size { width: 72px; font-family: var(--mono); }
  .type .custom { flex: 1; font-family: var(--mono); }
  .dflt { width: 100%; min-width: 110px; font-family: var(--mono); }

  /* NOT NULL sebagai switch */
  .switch { position: relative; display: inline-block; width: 30px; height: 16px; vertical-align: middle; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .switch span { position: absolute; inset: 0; border-radius: 8px; background: color-mix(in srgb, var(--muted) 35%, transparent); transition: background .15s; pointer-events: none; }
  .switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); transition: transform .15s; }
  .switch input:checked + span { background: var(--accent); }
  .switch input:checked + span::after { transform: translateX(14px); }
  .switch input:focus-visible + span { outline: 1px solid var(--focus); outline-offset: 2px; }
  .switch input:disabled + span { opacity: .45; }

  .attrs { display: flex; flex-wrap: wrap; gap: 4px; min-width: 120px; }
  td.gripCell { width: 28px; padding: 3px 2px; }
  .grip { width: 24px; height: 26px; padding: 0; border: 0; color: var(--muted); background: transparent; touch-action: none; cursor: grab; }
  .grip:active:not(:disabled) { cursor: grabbing; }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 11px; white-space: nowrap;
    color: var(--muted); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); }
  .badge.key { color: var(--vscode-symbolIcon-keyForeground, var(--changed)); border-color: currentColor; }
  .badge.gen { color: var(--accent); border-color: currentColor; }
  .chip { height: 20px; padding: 0 8px; border-radius: 10px; font-size: 11px; color: var(--muted); background: transparent;
    border: 1px solid color-mix(in srgb, var(--muted) 45%, transparent); }
  .chip[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  .chip.fk[aria-pressed="true"] { background: var(--vscode-charts-purple, #8a5cc2); }
  .chip:disabled { opacity: .4; }
  tr.fkrow td { background: var(--raise); padding: 8px 8px 10px 44px; }
  .fkedit { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .fkedit label { color: var(--muted); }
  .keys { margin: 18px 0 8px; }
  .keys .khead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .keys h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .keys .hint { color: var(--muted); margin-right: auto; }
  .keys td { vertical-align: middle; }
  .keys .kcols { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
  .keys .kcol { display: inline-flex; align-items: center; gap: 2px; }
  .keys .kname { width: 170px; font-family: var(--mono); }
  .keys tr.ro td { color: var(--muted); }
  .keys .none { color: var(--muted); padding: 4px 0; }
  .newname { display: flex; align-items: center; gap: 6px; font-family: var(--mono); }
  .newname input { font-family: var(--mono); font-size: 15px; height: 30px; }
  #tableName { min-width: 220px; font-weight: 600; }
  .x { width: 28px; padding: 0; background: transparent; color: var(--muted); }
  .x:hover:not(:disabled) { color: var(--deleted); background: transparent; }

  [hidden] { display: none !important; }
  #splitter { height: 7px; flex: none; cursor: row-resize; border-top: 1px solid var(--line); background: var(--raise); }
  #splitter:hover, #splitter:focus-visible { background: color-mix(in srgb, var(--focus) 35%, var(--raise)); outline: none; }
  .pending { height: 38vh; min-height: 90px; flex: none; display: flex; flex-direction: column; background: var(--raise); }
  .pending .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 20px; }
  .pending h2 { margin: 0 auto 0 0; font-size: 14px; font-weight: 600; }
  .count { display: inline-block; min-width: 20px; margin-left: 6px; padding: 0 6px; border-radius: 10px; text-align: center; font-size: 11px; line-height: 18px;
    color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .count:empty { display: none; }
  #errors { margin: 0 20px; padding: 0; list-style: none; color: var(--err); }
  #errors li { padding: 2px 0; }
  #preview { flex: 1; overflow: auto; margin: 0; padding: 0 20px 16px; list-style: none; counter-reset: step; }
  #preview li { position: relative; padding: 8px 0 10px 34px; border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
  #preview li:first-child { border-top: 0; }
  #preview li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: 8px; width: 22px; height: 22px; border-radius: 50%;
    font-size: 11px; line-height: 22px; text-align: center; color: var(--bg); background: var(--muted); }
  #preview li.empty { padding-left: 0; }
  #preview li.empty::before { content: none; }
  .detail { margin: -2px 0 6px; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .detail li { padding: 0 !important; border: 0 !important; }
  .detail li::before { content: none !important; }
  #preview li.drop::before { background: var(--deleted); }
  #preview li.dropKey::before { background: var(--deleted); }
  #preview li.edit::before { background: var(--changed); }
  #preview li.add::before { background: var(--added); }
  #preview li.addKey::before { background: var(--added); }
  #preview li.move::before, #preview li.ai::before { background: var(--changed); }
  .what { margin: 2px 0 6px; font-weight: 600; }
  .what code { font-family: var(--mono); font-weight: 500; }
  .sql { margin: 0; padding: 8px 10px; border-radius: 4px; overflow-x: auto; white-space: pre; font-family: var(--mono); font-size: var(--vscode-editor-font-size, 12px);
    background: var(--vscode-textCodeBlock-background, var(--bg)); }
  .sql .kw { color: var(--vscode-symbolIcon-keywordForeground, var(--accent)); }
  .sql .str { color: var(--vscode-debugTokenExpression-string, var(--changed)); }
  .empty { padding: 6px 0; color: var(--muted); }
  @media (max-width: 640px) { header { padding: 14px 16px 10px; } .grid, .pending .head, #preview { padding-left: 16px; padding-right: 16px; } .actions { margin-left: 0; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<header>
  <div class="ident">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>
    <div><h1>${esc(t.table)}</h1><p class="where">${esc(t.conn)} / ${esc(t.db)}</p></div>
  </div>
  ${create ? '<div class="newname"><select id="tableSchema" aria-label="Schema"></select><span aria-hidden="true">.</span><input type="text" id="tableName" placeholder="table_name" aria-label="Table name" spellcheck="false" autocomplete="off" autofocus></div>' : ''}
  <div class="summary" id="summary"></div>
  <div class="actions">
    ${readOnly ? '<span class="ro">Read-only connection: columns cannot be changed</span>' : ''}
    ${create ? '' : '<button id="refresh" title="Reload columns from the server and discard unsaved changes">Refresh</button>'}
    ${readOnly ? '' : '<button id="addCol">Add column</button>'}
  </div>
  <div id="status">${create ? '' : 'Loading columns…'}</div>
</header>
<div class="grid" id="grid"></div>
<div id="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize Pending changes" tabindex="0"${readOnly ? ' hidden' : ''}></div>
<section class="pending" id="pending"${readOnly ? ' hidden' : ''}>
  <div class="head">
    <h2>${create ? 'Script' : 'Pending changes'}<span class="count" id="count"></span></h2>
    ${create ? '' : '<button id="revert" title="Discard all changes">Revert</button>'}
    <button id="openSql" title="Open the script in a SQL tab without running it">Open in SQL Editor</button>
    ${readOnly ? '' : `<button id="execute" class="primary" title="Run the script on the server">${create ? 'Create' : 'Execute'}</button>`}
  </div>
  <ul id="errors"></ul>
  <ol id="preview"></ol>
</section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const readOnly = ${readOnly ? 'true' : 'false'};
const mode = '${mode}';
let tables = [], schemas = [], fkActions = [], aiTypes = [], fkCols = {}, openFk = -1, canAi = true, canFk = true;
let keys = false, reorder = false, aiExisting = true, schema = '', orderNote = '', fkTablesRequested = false, fkSnapshot;
const fkKey = (fk) => fk.schema + '.' + fk.table;
const CUSTOM = '\\u0000custom';
let orig = [], rows = [], info = { columns: [], rows: [] }, types = [], newType = '', timer;
// key tabel (UNIQUE / FK satu atau lebih kolom); tkeys = state UI, origKeys = dari server
let tkeys = [], origKeys = [], keysTable = false;
const clone = (x) => JSON.parse(JSON.stringify(x));
const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const spec = (base) => types.find((x) => x.name === base);
// sama dengan splitType di db.ts
function split(type) {
  const m = /^\\s*([\\w ]+?)\\s*(?:\\((.*)\\))?\\s*$/.exec(type || '');
  const s = m && spec(m[1].toLowerCase());
  return s ? { base: s.name, args: s.args === 'values' ? (m[2] || '').trim() : (m[2] || '').replace(/\\s+/g, ''), known: true } : { base: type || '', args: '', known: false };
}
const sameFk = (a, b) => (!a && !b) || (!!a && !!b && ['schema', 'table', 'column', 'onDelete', 'onUpdate'].every((k) => (a[k] || '') === (b[k] || '')));
const same = (r) => {
  const o = orig.find((c) => c.name === r.orig);
  return o && o.name === r.name && o.type === r.type && o.nullable === r.nullable && (o.default || '') === (r.default || '')
    && !!o.pk === !!r.pk && !!o.ai === !!r.ai && !!o.unique === !!r.unique && sameFk(o.fk, r.fk);
};
const cls = (r) => (r.deleted ? 'deleted' : !r.orig ? (mode === 'create' ? '' : 'added') : same(r) ? '' : 'changed');
const hint = { length: (s) => '1-' + s.max + (s.allowMax ? ', max' : ''), precisionScale: () => 'p,s', precision: (s) => '1-' + s.max, scale: (s) => '0-' + s.max, values: () => "'a','b'" };

function typeCell(r, dis) {
  const t = split(r.type);
  const groups = [...new Set(types.map((x) => x.group))];
  const opts = groups.map((g) => '<optgroup label="' + h(g) + '">' + types.filter((x) => x.group === g)
    .map((x) => '<option value="' + h(x.name) + '"' + (t.known && t.base === x.name ? ' selected' : '') + (x.note ? ' title="' + h(x.note) + '"' : '') + '>' + h(x.name) + '</option>').join('') + '</optgroup>').join('')
    + '<option value="' + CUSTOM + '"' + (t.known ? '' : ' selected') + '>Custom type…</option>';
  const s = t.known && spec(t.base);
  const extra = !t.known ? '<input type="text" class="custom" data-k="custom" value="' + h(r.type) + '" placeholder="user-defined type" aria-label="Custom type"' + dis + '>'
    : s && s.args ? '<input type="text" class="size" data-k="size" value="' + h(t.args) + '" placeholder="' + hint[s.args](s) + '" aria-label="Size of ' + h(s.name) + '"' + dis + '>' : '';
  return '<div class="type"><select data-k="base" aria-label="Data type"' + dis + '>' + opts + '</select>' + extra + '</div>';
}
function attrs(extra, r, includePk = true) {
  return (includePk && r.pk ? '<span class="badge key">Primary key</span>' : '') + info.columns.map((k, j) => {
    const v = extra[j];
    if (v === null || v === undefined || v === '') return '';
    if (k === 'primary_key') return r.pk ? '' : '<span class="badge key">Primary key</span>';
    if (k === 'identity') return '<span class="badge gen" title="seed, increment">Identity ' + h(v) + '</span>';
    if (k === 'identity_mode') return '<span class="badge gen">identity ' + h(v) + '</span>';
    if (k === 'computed') return '<span class="badge gen" title="' + h(v) + '">Computed</span>';
    if (k === 'collation') return '<span class="badge" title="Collation">' + h(v) + '</span>';
    if (k === 'keys') return '<span class="badge">' + h(v) + '</span>';
    return '<span class="badge">' + h(k) + ': ' + h(v) + '</span>';
  }).join('');
}
// New Table: chip atribut PK / AI / UQ / FK (FK membuka baris editor di bawahnya)
function chips(r, i, lock) {
  const chip = (k, label, on, title) => {
    const ruleDisabled = k === 'ai' && !!r.orig && !aiExisting;
    const titleText = ruleDisabled ? 'Identity cannot be added to or removed from an existing column on SQL Server' : title;
    return '<button class="chip' + (k === 'fk' ? ' fk' : '') + '" data-chip="' + k + '" data-i="' + i + '" aria-pressed="' + !!on
      + '" aria-disabled="' + (lock || ruleDisabled ? 'true' : 'false') + '" title="' + h(titleText) + '"' + (lock ? ' disabled' : '') + '>' + label + '</button>';
  };
  const target = r.fk && r.fk.table
    ? 'FK → ' + (r.fk.schema && r.fk.schema !== (mode === 'create' ? $('tableSchema')?.value : schema) ? h(r.fk.schema + '.') : '')
      + h(r.fk.table + '.' + (r.fk.column || '?'))
    : 'FK…';
  return chip('pk', 'PK', r.pk, 'Primary key') + (canAi ? chip('ai', 'AI', r.ai, 'Auto increment / identity') : '') + chip('uq', 'UQ', r.unique, 'Unique')
    + (canFk ? chip('fk', target, !!r.fk, 'Foreign key') : '');
}
function fkRow(r, i) {
  const fk = r.fk || {};
  const opt = (v, label, sel) => '<option value="' + h(v) + '"' + (sel ? ' selected' : '') + '>' + h(label) + '</option>';
  const cols = fkCols[fkKey(fk)] || [];
  // tabel tujuan di schema lain tidak ada di daftar tabel: tetap ditampilkan supaya pilihan tidak hilang
  const list = fk.table && !tables.some((x) => x.name === fk.table && x.schema === fk.schema) ? [{ schema: fk.schema, name: fk.table }, ...tables] : tables;
  const act = (k) => '<select data-fk="' + k + '" aria-label="' + (k === 'onDelete' ? 'On delete' : 'On update') + '">' + fkActions.map((a) => opt(a, a, (fk[k] || fkActions[0]) === a)).join('') + '</select>';
  return '<tr role="group" aria-label="Foreign key for ' + h(r.name || '') + '" class="fkrow" data-fkrow="' + i + '"><td colspan="' + (reorder ? 9 : 8) + '"><div class="fkedit"><b>Foreign key ' + h(r.name || '') + '</b>'
    + '<label>references <select data-fk="table" aria-label="Referenced table">' + opt('', 'choose a table…', !fk.table) + list.map((x) => opt(x.schema + '\u0000' + x.name, (x.schema ? x.schema + '.' : '') + x.name, fk.table === x.name && fk.schema === x.schema)).join('') + '</select></label>'
    + '<label>column <select data-fk="column" aria-label="Referenced column">' + opt('', fk.table && !cols.length ? 'loading…' : 'choose a column…', !fk.column) + cols.map((c) => opt(c, c, fk.column === c)).join('') + '</select></label>'
    + '<label>on delete ' + act('onDelete') + '</label><label>on update ' + act('onUpdate') + '</label>'
    + '<button data-fkact="remove" data-i="' + i + '">Remove FK</button><button data-fkact="done" data-i="' + i + '">Done</button></div></td></tr>';
}
function row(r, i) {
  const lock = readOnly || r.deleted ? ' disabled' : '';
  const gen = lock || (r.generated ? ' disabled' : ''); // identity / computed: hanya nama
  const extra = r.orig ? info.rows[orig.findIndex((c) => c.name === r.orig)] || [] : [];
  const grip = reorder ? '<td class="gripCell"><button class="grip" data-grip aria-label="Move ' + h(r.name) + '" title="Drag, or Alt+↑ / Alt+↓"'
    + (lock ? ' disabled aria-disabled="true"' : '') + '>⋮⋮</button></td>' : '';
  const attributeHtml = mode === 'create' || keys
    ? chips(r, i, lock) + (mode === 'create' ? '' : attrs(extra, r, false)) : attrs(extra, r);
  return '<tr data-i="' + i + '" class="' + cls(r) + '">' + grip + '<td class="mark"></td><td class="num">' + (i + 1) + '</td>'
    + '<td><input type="text" class="name" data-k="name" value="' + h(r.name) + '" placeholder="column_name" aria-label="Column name"' + lock + '></td>'
    + '<td>' + typeCell(r, gen) + '</td>'
    + '<td><label class="switch" title="' + (r.pk ? 'Primary key columns are NOT NULL' : 'NOT NULL') + '"><input type="checkbox" data-k="notnull" aria-label="Not null"' + (r.nullable && !r.pk ? '' : ' checked') + (gen || (r.pk ? ' disabled' : '')) + '><span></span></label></td>'
    + '<td><input type="text" class="dflt" data-k="default" value="' + h(r.ai ? '' : r.default) + '" placeholder="' + (r.ai ? 'auto increment' : 'none') + '" aria-label="Default value"' + (gen || (r.ai ? ' disabled' : '')) + '></td>'
    + '<td><div class="attrs">' + attributeHtml + '</div></td>'
    + '<td>' + (readOnly ? '' : '<button class="x" data-del="' + i + '" title="' + (r.deleted ? 'Keep this column' : 'Delete column') + '" aria-label="' + (r.deleted ? 'Keep' : 'Delete') + ' ' + h(r.name || 'new column') + '">' + (r.deleted ? '↺' : '✕') + '</button>') + '</td></tr>';
}
const liveNames = () => rows.filter((r) => !r.deleted && r.name.trim()).map((r) => r.name.trim());
function keyCls(k) {
  if (k.readOnly) return 'ro';
  const o = k.orig === undefined ? undefined : origKeys[k.orig];
  if (!o) return 'added';
  const { orig: _o, ...cur } = k;
  return JSON.stringify(cur) === JSON.stringify(o) ? '' : 'changed';
}
function keyRow(k, i) {
  const opt = (v, label, sel) => '<option value="' + h(v) + '"' + (sel ? ' selected' : '') + '>' + h(label) + '</option>';
  const ref = k.ref || { schema: '', table: '', columns: [] };
  const target = (k.kind === 'fk' ? (ref.schema && ref.schema !== (mode === 'create' ? $('tableSchema')?.value : schema) ? ref.schema + '.' : '') + ref.table + ' (' + ref.columns.join(', ') + ')' : '');
  const type = (k.kind === 'unique' ? 'UNIQUE' : 'FOREIGN KEY') + (k.index ? ' <span class="badge" title="Unique index, not a constraint">index</span>' : '');
  if (k.readOnly || readOnly) {
    return '<tr class="' + keyCls(k) + '" data-ki="' + i + '"><td>' + type + (k.readOnly ? ' <span class="badge" title="Filtered, partial, prefix or expression index: change it in SQL">read-only</span>' : '') + '</td>'
      + '<td><code>' + h(k.name || '') + '</code></td><td>' + h(k.cols.join(', ')) + '</td><td>' + h(target) + '</td><td>' + h(ref.onDelete || '') + '</td><td>' + h(ref.onUpdate || '') + '</td><td></td></tr>';
  }
  const names = liveNames();
  const colSel = (c, j) => '<span class="kcol"><select data-kf="col" data-ki="' + i + '" data-kj="' + j + '" aria-label="Column ' + (j + 1) + ' of key ' + (i + 1) + '">'
    + (names.includes(c) ? '' : opt(c, c + ' (missing)', true)) + names.map((n) => opt(n, n, n === c)).join('') + '</select>'
    + '<button class="x" data-kact="uncol" data-ki="' + i + '" data-kj="' + j + '" title="Remove ' + h(c) + ' from the key" aria-label="Remove ' + h(c) + ' from key ' + (i + 1) + '">✕</button></span>';
  const add = '<select data-kf="addcol" data-ki="' + i + '" aria-label="Add a column to key ' + (i + 1) + '">' + opt('', '+ column', true)
    + names.filter((n) => !k.cols.includes(n)).map((n) => opt(n, n, false)).join('') + '</select>';
  let refCell = '', acts = '<td></td><td></td>';
  if (k.kind === 'fk') {
    const list = ref.table && !tables.some((x) => x.name === ref.table && x.schema === ref.schema) ? [{ schema: ref.schema, name: ref.table }, ...tables] : tables;
    const tcols = fkCols[fkKey(ref)] || [];
    refCell = '<div class="kcols"><select data-kf="table" data-ki="' + i + '" aria-label="Referenced table of key ' + (i + 1) + '">' + opt('', 'choose a table…', !ref.table)
      + list.map((x) => opt(x.schema + '\u0000' + x.name, (x.schema ? x.schema + '.' : '') + x.name, ref.table === x.name && ref.schema === x.schema)).join('') + '</select>'
      + k.cols.map((c, j) => '<select data-kf="refcol" data-ki="' + i + '" data-kj="' + j + '" aria-label="Referenced column for ' + h(c) + '">'
        + opt('', ref.table && !tcols.length ? 'loading…' : 'column for ' + c + '…', !ref.columns[j])
        + (ref.columns[j] && !tcols.includes(ref.columns[j]) ? opt(ref.columns[j], ref.columns[j], true) : '')
        + tcols.map((c2) => opt(c2, c2, ref.columns[j] === c2)).join('') + '</select>').join('') + '</div>';
    const act = (f) => '<td><select data-kf="' + f + '" data-ki="' + i + '" aria-label="' + (f === 'onDelete' ? 'On delete' : 'On update') + ' of key ' + (i + 1) + '">'
      + fkActions.map((a) => opt(a, a, (ref[f] || fkActions[0]) === a)).join('') + '</select></td>';
    acts = act('onDelete') + act('onUpdate');
  }
  // nama key yang sudah ada tidak diubah (ubah definisi = drop + add dengan nama sama)
  const name = k.orig !== undefined ? '<code>' + h(k.name) + '</code>'
    : '<input type="text" class="kname" data-kf="name" data-ki="' + i + '" value="' + h(k.name || '') + '" placeholder="automatic name" aria-label="Name of key ' + (i + 1) + '">';
  return '<tr class="' + keyCls(k) + '" data-ki="' + i + '"><td>' + type + '</td><td>' + name + '</td><td><div class="kcols">' + k.cols.map(colSel).join('') + add + '</div></td>'
    + '<td>' + refCell + '</td>' + acts + '<td><button class="x" data-kact="remove" data-ki="' + i + '" title="Remove key" aria-label="Remove key ' + (i + 1) + '">✕</button></td></tr>';
}
function keysHtml() {
  if (!keysTable) return '';
  const buttons = readOnly ? '' : '<button data-kact="add-unique">Add unique key</button>' + (canFk ? '<button data-kact="add-fk">Add foreign key</button>' : '');
  return '<section class="keys" aria-label="Table keys"><div class="khead"><h2>Keys</h2><span class="hint">UNIQUE and FOREIGN KEY on one or more columns, in order</span>' + buttons + '</div>'
    + (tkeys.length ? '<table><thead><tr><th>Type</th><th>Name</th><th>Columns</th><th>References</th><th>On delete</th><th>On update</th><th></th></tr></thead><tbody>'
      + tkeys.map(keyRow).join('') + '</tbody></table>' : '<p class="none">No keys with more than one column. Single-column UQ / FK stay on the column chips.</p>') + '</section>';
}
function renderKeys(focus) {
  if ($('keys')) $('keys').innerHTML = keysHtml();
  if (focus) document.querySelector(focus)?.focus();
}
function render() {
  $('grid').innerHTML = '<table><thead><tr>' + (reorder ? '<th></th>' : '') + '<th></th><th title="' + (!reorder ? h(orderNote) : '') + '">#</th><th>Name</th><th>Data type</th><th>Not null</th><th>Default</th><th>Attributes</th><th></th></tr></thead><tbody>'
    + rows.map((r, i) => row(r, i) + (i === openFk ? fkRow(r, i) : '')).join('') + '</tbody></table><div id="keys">' + keysHtml() + '</div>';
  if (mode === 'create') { $('summary').innerHTML = '<b>' + rows.length + '</b> column' + (rows.length === 1 ? '' : 's'); return; }
  const pkCount = orig.filter((c) => c.pk).length;
  $('summary').innerHTML = '<b>' + orig.length + '</b> column' + (orig.length === 1 ? '' : 's') + (pkCount ? ', <b>' + pkCount + '</b> in the primary key' : '');
}
const table = () => (mode === 'create' ? { schema: $('tableSchema').value, name: $('tableName').value } : undefined);
const send = (type) => vscode.postMessage({ type, rows, table: table(), tableKeys: tkeys.map(({ orig: _o, ...k }) => k) });
function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => send('change'), 120);
}
function onKey(e) {
  const el = e.target, i = +el.dataset.ki, k = tkeys[i], f = el.dataset.kf, j = +el.dataset.kj;
  if (!k) return;
  if (f === 'name') { k.name = el.value; changed(); return; }
  if (e.type !== 'change') return;
  if (f === 'col') k.cols[j] = el.value;
  else if (f === 'addcol') { if (!el.value) return; k.cols.push(el.value); if (k.ref) k.ref.columns.push(''); }
  else if (f === 'table') {
    const [s, n] = el.value.split('\u0000');
    k.ref = { ...k.ref, schema: s || '', table: n || '', columns: k.cols.map(() => '') };
    if (k.ref.table && !fkCols[fkKey(k.ref)]) vscode.postMessage({ type: 'fkColumns', schema: k.ref.schema, name: k.ref.table });
  } else if (f === 'refcol') k.ref.columns[j] = el.value;
  else if (f === 'onDelete' || f === 'onUpdate') k.ref[f] = el.value;
  render(); changed();
  document.querySelector('[data-kf="' + (f === 'table' ? 'refcol' : f) + '"][data-ki="' + i + '"]' + (f === 'col' || f === 'refcol' ? '[data-kj="' + j + '"]' : ''))?.focus();
}
function onEdit(e) {
  if (e.target.dataset.kf) return onKey(e);
  if (e.target.dataset.fk) return onFk(e);
  const el = e.target, tr = el.closest('tr[data-i]');
  if (!tr || !el.dataset.k) return;
  const r = rows[+tr.dataset.i], t = split(r.type), k = el.dataset.k;
  if (k === 'notnull') r.nullable = !el.checked;
  else if (k === 'name') {
    // nama kolom di key ikut berganti (key menyimpan nama kolom final)
    const prev = r.name.trim(), next = el.value.trim();
    r.name = el.value;
    if (prev && prev !== next && tkeys.some((x) => x.cols.includes(prev))) {
      tkeys.forEach((x) => { x.cols = x.cols.map((c) => (c === prev ? next : c)); });
      renderKeys();
    }
  }
  else if (k === 'default') r[k] = el.value;
  else if (k === 'custom') r.type = el.value;
  else if (k === 'size') r.type = t.base + (el.value.trim() ? '(' + el.value.trim() + ')' : '');
  else if (k === 'base' && e.type === 'change') {
    if (el.value === CUSTOM) r.type = t.known ? '' : r.type;
    else { const s = spec(el.value); r.type = s.name + (s.def ? '(' + s.def + ')' : ''); }
    tr.outerHTML = row(r, +tr.dataset.i); // kolom ukuran / custom ikut berganti
    document.querySelector('tr[data-i="' + tr.dataset.i + '"] ' + (el.value === CUSTOM ? '.custom' : '.size'))?.focus();
  }
  const cur = document.querySelector('tr[data-i="' + tr.dataset.i + '"]');
  if (cur) cur.className = cls(r);
  changed();
}
$('grid').addEventListener('input', onEdit);
$('grid').addEventListener('change', (e) => { if (e.target.dataset.k === 'base' || e.target.dataset.fk || e.target.dataset.kf) onEdit(e); });
function onFk(e) {
  const el = e.target, r = rows[openFk];
  if (!r || e.type !== 'change') return;
  const fk = r.fk = r.fk ? { ...r.fk } : { schema: '', table: '', column: '' };
  if (el.dataset.fk === 'table') {
    const [schema, name] = el.value.split('\u0000');
    Object.assign(fk, { schema: schema || '', table: name || '', column: '' });
    if (fk.table && !fkCols[fkKey(fk)]) vscode.postMessage({ type: 'fkColumns', schema: fk.schema, name: fk.table });
  } else fk[el.dataset.fk] = el.value;
  render(); changed();
  document.querySelector('[data-fk="' + (el.dataset.fk === 'table' ? 'column' : el.dataset.fk) + '"]')?.focus();
}
function moveRow(from, to, target) {
  if (!reorder || from < 0 || to < 0 || to >= rows.length || from === to) return;
  const active = target.closest('[data-k], [data-chip]') || target;
  const selector = active.dataset.k ? '[data-k="' + active.dataset.k + '"]'
    : active.dataset.chip ? '[data-chip="' + active.dataset.chip + '"]' : '.grip';
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  openFk = -1; fkSnapshot = undefined;
  render(); changed();
  $('live').textContent = moved.name + (to === 0 ? ' moved to first' : ' moved after ' + rows[to - 1].name);
  document.querySelector('tr[data-i="' + to + '"] ' + selector)?.focus();
}
$('grid').addEventListener('click', (e) => {
  const ka = e.target.closest('[data-kact]');
  if (ka) {
    const act = ka.dataset.kact, i = +ka.dataset.ki;
    let focus;
    if (act === 'add-unique' || act === 'add-fk') {
      tkeys.push(act === 'add-unique' ? { kind: 'unique', name: '', cols: [] } : { kind: 'fk', name: '', cols: [], ref: { schema: '', table: '', columns: [] } });
      if (act === 'add-fk' && mode === 'edit' && !tables.length && !fkTablesRequested) { fkTablesRequested = true; vscode.postMessage({ type: 'fkTables' }); }
      focus = '[data-kf="addcol"][data-ki="' + (tkeys.length - 1) + '"]';
    } else if (act === 'remove') { tkeys.splice(i, 1); focus = '[data-kact="add-unique"]'; }
    else if (act === 'uncol') {
      const j = +ka.dataset.kj;
      tkeys[i].cols.splice(j, 1);
      if (tkeys[i].ref) tkeys[i].ref.columns.splice(j, 1);
      focus = '[data-kf="addcol"][data-ki="' + i + '"]';
    }
    render(); changed();
    if (focus) document.querySelector(focus)?.focus();
    return;
  }
  const c = e.target.closest('[data-chip]'), a = e.target.closest('[data-fkact]');
  if (c || a) {
    if (c && c.getAttribute('aria-disabled') === 'true') return;
    const i = +(c || a).dataset.i, r = rows[i];
    if (a) {
      if (a.dataset.fkact === 'remove') delete r.fk;
      openFk = -1; fkSnapshot = undefined;
    }
    else if (c.dataset.chip === 'fk') {
      if (openFk === i) { openFk = -1; fkSnapshot = undefined; }
      else {
        openFk = i; fkSnapshot = r.fk ? { ...r.fk } : undefined;
        if (mode === 'edit' && !tables.length && !fkTablesRequested) {
          fkTablesRequested = true;
          vscode.postMessage({ type: 'fkTables' });
        }
      }
    }
    else if (c.dataset.chip === 'pk') r.pk = !r.pk;
    else if (c.dataset.chip === 'ai') { r.ai = !r.ai; if (r.ai) r.default = ''; }
    else if (c.dataset.chip === 'uq') r.unique = !r.unique;
    if (a && a.dataset.fkact === 'done') fkSnapshot = undefined;
    render(); changed();
    document.querySelector(a ? '[data-chip="fk"][data-i="' + i + '"]' : openFk === i && c.dataset.chip === 'fk' ? '[data-fk="table"]' : '[data-chip="' + c.dataset.chip + '"][data-i="' + i + '"]')?.focus();
    return;
  }
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const i = +b.dataset.del;
  if (rows[i].orig) rows[i].deleted = !rows[i].deleted; else rows.splice(i, 1); // kolom baru langsung dibuang
  if (openFk >= rows.length || openFk === i) openFk = -1;
  render(); changed();
});
$('addCol')?.addEventListener('click', () => {
  rows.push({ name: '', type: newType, nullable: true, default: '' });
  render(); changed();
  document.querySelector('tbody tr:last-child .name')?.focus();
  $('grid').scrollTop = $('grid').scrollHeight;
});
$('refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('revert')?.addEventListener('click', () => { rows = orig.map((c) => ({ ...c, orig: c.name })); tkeys = origKeys.map((k, i) => ({ ...clone(k), orig: i })); render(); changed(); });
$('tableName')?.addEventListener('input', changed);
$('tableSchema')?.addEventListener('change', changed);
$('grid').addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.grip'), tr = grip && grip.closest('tr[data-i]');
  if (!reorder || !grip || grip.disabled || !tr) return;
  grip.setPointerCapture(e.pointerId);
  grip.dataset.drag = tr.dataset.i;
});
$('grid').addEventListener('pointerup', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip || grip.dataset.drag === undefined) return;
  const from = +grip.dataset.drag;
  delete grip.dataset.drag;
  const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('tr');
  const to = hit?.dataset.i !== undefined ? +hit.dataset.i : hit?.dataset.fkrow !== undefined ? +hit.dataset.fkrow : -1;
  moveRow(from, to, grip);
});
$('grid').addEventListener('pointercancel', (e) => { const grip = e.target.closest('.grip'); if (grip) delete grip.dataset.drag; });
$('grid').addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (!reorder) return;
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    e.preventDefault();
    moveRow(+tr.dataset.i, +tr.dataset.i + (e.key === 'ArrowUp' ? -1 : 1), e.target);
    return;
  }
  if (e.key === 'Escape' && openFk >= 0) {
    const i = openFk, r = rows[i];
    if (fkSnapshot) r.fk = { ...fkSnapshot }; else delete r.fk;
    openFk = -1; fkSnapshot = undefined;
    render(); changed();
    document.querySelector('[data-chip="fk"][data-i="' + i + '"]')?.focus();
  }
});
$('openSql').addEventListener('click', () => send('open'));
$('execute')?.addEventListener('click', () => send('execute'));

// tinggi panel Pending changes: geser splitter (mouse / panah atas-bawah), disimpan di state webview
const pending = $('pending');
const setH = (px) => { pending.style.height = Math.max(90, Math.min(window.innerHeight - 160, px)) + 'px'; vscode.setState({ ...(vscode.getState() || {}), pendingH: pending.offsetHeight }); };
if (vscode.getState()?.pendingH) pending.style.height = vscode.getState().pendingH + 'px';
$('splitter').addEventListener('pointerdown', (e) => {
  const y0 = e.clientY, h0 = pending.offsetHeight, move = (ev) => setH(h0 + y0 - ev.clientY);
  e.target.setPointerCapture(e.pointerId);
  e.target.addEventListener('pointermove', move);
  e.target.addEventListener('pointerup', () => e.target.removeEventListener('pointermove', move), { once: true });
});
$('splitter').addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setH(pending.offsetHeight + (e.key === 'ArrowUp' ? 24 : -24)); } });

const KW = /\\b(ALTER|TABLE|ADD|DROP|COLUMN|CONSTRAINT|DEFAULT|FOR|EXEC|DECLARE|SELECT|FROM|WHERE|AND|IF|IS|NOT|NULL|BEGIN|END|SET|CHANGE|MODIFY|RENAME|TO|TYPE|USING|CREATE|INSERT|INTO|PRAGMA|COMMIT|PRIMARY|KEY|UNIQUE|FOREIGN|REFERENCES|IDENTITY|ON|DELETE|UPDATE|CASCADE|NO|ACTION|AFTER|FIRST|AUTO_INCREMENT|INDEX|GENERATED|BY|AS|TRANSACTION|XACT_ABORT|NOEXEC|GO)\\b/g;
const sqlHtml = (s) => h(s).replace(/(N?'(?:[^']|'')*')|\\b([A-Z_]+)\\b/g, (m, str, w) => str ? '<span class="str">' + str + '</span>' : (KW.lastIndex = 0, KW.test(w) ? '<span class="kw">' + w + '</span>' : w));
const what = (s) => s.title ? h(s.title) : s.kind === 'create' ? 'Create table <code>' + h(s.column) + '</code>'
  : s.kind === 'rebuild' ? 'Rebuild table <code>' + h(s.column) + '</code> (copy data to a new table)'
  : s.kind === 'drop' ? 'Delete <code>' + h(s.column) + '</code>'
  : s.kind === 'add' ? 'Add <code>' + h(s.column) + '</code>'
  : 'Change <code>' + h(s.column) + '</code>' + (s.to ? ' to <code>' + h(s.to) + '</code>' : '');
function status(text, error) { $('status').textContent = text; $('status').className = error ? 'err' : ''; }
window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'load') {
    orig = m.cols; info = m.info; types = m.types || []; newType = m.newType || '';
    rows = mode === 'create' ? m.rows : orig.map((c) => ({ ...c, orig: c.name }));
    keys = !!m.keys; reorder = !!m.reorder; aiExisting = !!m.aiExisting; aiTypes = m.aiTypes || [];
    fkActions = m.fkActions || []; schema = m.schema || ''; orderNote = m.orderNote || '';
    tables = m.tables || []; fkTablesRequested = false; fkSnapshot = undefined;
    keysTable = !!m.keysTable; origKeys = m.tableKeys || []; tkeys = origKeys.map((k, i) => ({ ...clone(k), orig: i }));
    if (reorder && !$('live')) document.body.insertAdjacentHTML('beforeend', '<div id="live" aria-live="polite" class="sr"></div>');
    if (mode === 'create') {
      schemas = m.schemas || [];
      // driver tanpa auto increment / foreign key (MongoDB): chip AI / FK disembunyikan
      canAi = m.ai !== false; canFk = m.fk !== false;
      $('tableSchema').innerHTML = schemas.map((x) => '<option' + (x === m.defaultSchema ? ' selected' : '') + '>' + h(x) + '</option>').join('');
      $('tableSchema').hidden = !schemas.length;
    } else { canAi = aiTypes.length > 0; canFk = fkActions.length > 0; }
    render(); status(''); changed();
  } else if (m.type === 'script') {
    $('preview').innerHTML = m.steps.length ? m.steps.map((s) => '<li class="' + s.kind + '"><p class="what">' + what(s) + '</p>'
      + (s.detail && s.detail.length ? '<ul class="detail">' + s.detail.map((d) => '<li>' + h(d) + '</li>').join('') + '</ul>' : '') + '<pre class="sql">' + sqlHtml(s.sql) + '</pre></li>').join('')
      : m.errors.length ? '' : '<li class="empty">' + (mode === 'create' ? 'Name the table and its columns, and the CREATE TABLE script shows up here.' : 'No pending changes. Edit a cell, add a column or delete one, and the SQL shows up here.') + '</li>';
    $('errors').innerHTML = m.errors.map((e) => '<li>' + h(e) + '</li>').join('');
    $('count').textContent = m.count || '';
    if ($('execute')) $('execute').disabled = !m.count;
    $('openSql').disabled = !m.count;
    if ($('revert')) $('revert').disabled = !m.count && !m.errors.length;
  } else if (m.type === 'fkTables') { tables = m.tables || []; render(); }
  else if (m.type === 'fkColumns') { fkCols[m.key] = m.columns; render(); }
  else if (m.type === 'status') status(m.text, m.error);
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

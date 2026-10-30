import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';

/**
 * editor Columns (klik kanan tabel), seperti DBeaver: grid kolom bisa diedit (nama, tipe dari dropdown + ukuran, NOT NULL, default,
 * tambah / hapus), daftar Pending changes berisi langkah SQL yang akan dijalankan; Execute / Open in SQL Editor / Revert.
 * ext -> page: { type: 'load', cols, info, types } | { type: 'script', sql, errors, count, steps } | { type: 'status', text, error? }
 * page -> ext: { type: 'ready' | 'refresh' } | { type: 'change' | 'execute' | 'open', rows }
 */
export function columnsHtml(cspSource: string, t: { conn: string; db: string; table: string }, readOnly: boolean): string {
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
  .badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 9px; font-size: 11px; white-space: nowrap;
    color: var(--muted); border: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); }
  .badge.key { color: var(--vscode-symbolIcon-keyForeground, var(--changed)); border-color: currentColor; }
  .badge.gen { color: var(--accent); border-color: currentColor; }
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
  #preview li.edit::before { background: var(--changed); }
  #preview li.add::before { background: var(--added); }
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
  <div class="summary" id="summary"></div>
  <div class="actions">
    ${readOnly ? '<span class="ro">Read-only connection: columns cannot be changed</span>' : ''}
    <button id="refresh" title="Reload columns from the server and discard unsaved changes">Refresh</button>
    ${readOnly ? '' : '<button id="addCol">Add column</button>'}
  </div>
  <div id="status">Loading columns…</div>
</header>
<div class="grid" id="grid"></div>
<div id="splitter" role="separator" aria-orientation="horizontal" aria-label="Resize Pending changes" tabindex="0"${readOnly ? ' hidden' : ''}></div>
<section class="pending" id="pending"${readOnly ? ' hidden' : ''}>
  <div class="head">
    <h2>Pending changes<span class="count" id="count"></span></h2>
    <button id="revert" title="Discard all changes">Revert</button>
    <button id="openSql" title="Open the script in a SQL tab without running it">Open in SQL Editor</button>
    ${readOnly ? '' : '<button id="execute" class="primary" title="Run these steps on the server">Execute</button>'}
  </div>
  <ul id="errors"></ul>
  <ol id="preview"></ol>
</section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const readOnly = ${readOnly ? 'true' : 'false'};
const CUSTOM = '\\u0000custom';
let orig = [], rows = [], info = { columns: [], rows: [] }, types = [], newType = '', timer;
const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const spec = (base) => types.find((x) => x.name === base);
// sama dengan splitType di db.ts
function split(type) {
  const m = /^\\s*([\\w ]+?)\\s*(?:\\((.*)\\))?\\s*$/.exec(type || '');
  const s = m && spec(m[1].toLowerCase());
  return s ? { base: s.name, args: s.args === 'values' ? (m[2] || '').trim() : (m[2] || '').replace(/\\s+/g, ''), known: true } : { base: type || '', args: '', known: false };
}
const same = (r) => { const o = orig.find((c) => c.name === r.orig); return o && o.name === r.name && o.type === r.type && o.nullable === r.nullable && (o.default || '') === (r.default || ''); };
const cls = (r) => (r.deleted ? 'deleted' : !r.orig ? 'added' : same(r) ? '' : 'changed');
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
function attrs(extra) {
  return info.columns.map((k, j) => {
    const v = extra[j];
    if (v === null || v === undefined || v === '') return '';
    if (k === 'primary_key') return '<span class="badge key">Primary key</span>';
    if (k === 'identity') return '<span class="badge gen" title="seed, increment">Identity ' + h(v) + '</span>';
    if (k === 'computed') return '<span class="badge gen" title="' + h(v) + '">Computed</span>';
    if (k === 'collation') return '<span class="badge" title="Collation">' + h(v) + '</span>';
    return '<span class="badge">' + h(k) + ': ' + h(v) + '</span>';
  }).join('');
}
function row(r, i) {
  const lock = readOnly || r.deleted ? ' disabled' : '';
  const gen = lock || (r.generated ? ' disabled' : ''); // identity / computed: hanya nama
  const extra = r.orig ? info.rows[orig.findIndex((c) => c.name === r.orig)] || [] : [];
  return '<tr data-i="' + i + '" class="' + cls(r) + '"><td class="mark"></td><td class="num">' + (i + 1) + '</td>'
    + '<td><input type="text" class="name" data-k="name" value="' + h(r.name) + '" placeholder="column_name" aria-label="Column name"' + lock + '></td>'
    + '<td>' + typeCell(r, gen) + '</td>'
    + '<td><label class="switch" title="NOT NULL"><input type="checkbox" data-k="notnull" aria-label="Not null"' + (r.nullable ? '' : ' checked') + gen + '><span></span></label></td>'
    + '<td><input type="text" class="dflt" data-k="default" value="' + h(r.default) + '" placeholder="none" aria-label="Default value"' + gen + '></td>'
    + '<td><div class="attrs">' + attrs(extra) + '</div></td>'
    + '<td>' + (readOnly ? '' : '<button class="x" data-del="' + i + '" title="' + (r.deleted ? 'Keep this column' : 'Delete column') + '" aria-label="' + (r.deleted ? 'Keep' : 'Delete') + ' ' + h(r.name || 'new column') + '">' + (r.deleted ? '↺' : '✕') + '</button>') + '</td></tr>';
}
function render() {
  $('grid').innerHTML = '<table><thead><tr><th></th><th>#</th><th>Name</th><th>Data type</th><th>Not null</th><th>Default</th><th>Attributes</th><th></th></tr></thead><tbody>'
    + rows.map(row).join('') + '</tbody></table>';
  const keys = info.rows.filter((x) => x[info.columns.indexOf('primary_key')]).length;
  $('summary').innerHTML = '<b>' + orig.length + '</b> column' + (orig.length === 1 ? '' : 's') + (keys ? ', <b>' + keys + '</b> in the primary key' : '');
}
function changed() {
  clearTimeout(timer);
  timer = setTimeout(() => vscode.postMessage({ type: 'change', rows }), 120);
}
function onEdit(e) {
  const el = e.target, tr = el.closest('tr[data-i]');
  if (!tr || !el.dataset.k) return;
  const r = rows[+tr.dataset.i], t = split(r.type), k = el.dataset.k;
  if (k === 'notnull') r.nullable = !el.checked;
  else if (k === 'name' || k === 'default') r[k] = el.value;
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
$('grid').addEventListener('change', (e) => { if (e.target.dataset.k === 'base') onEdit(e); });
$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const i = +b.dataset.del;
  if (rows[i].orig) rows[i].deleted = !rows[i].deleted; else rows.splice(i, 1); // kolom baru langsung dibuang
  render(); changed();
});
$('addCol')?.addEventListener('click', () => {
  rows.push({ name: '', type: newType, nullable: true, default: '' });
  render(); changed();
  document.querySelector('tbody tr:last-child .name')?.focus();
  $('grid').scrollTop = $('grid').scrollHeight;
});
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('revert').addEventListener('click', () => { rows = orig.map((c) => ({ ...c, orig: c.name })); render(); changed(); });
$('openSql').addEventListener('click', () => vscode.postMessage({ type: 'open', rows }));
$('execute')?.addEventListener('click', () => vscode.postMessage({ type: 'execute', rows }));

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

const KW = /\\b(ALTER|TABLE|ADD|DROP|COLUMN|CONSTRAINT|DEFAULT|FOR|EXEC|DECLARE|SELECT|FROM|WHERE|AND|IF|IS|NOT|NULL|BEGIN|END|SET|CHANGE|MODIFY|RENAME|TO|TYPE|USING|CREATE|INSERT|INTO|PRAGMA|COMMIT)\\b/g;
const sqlHtml = (s) => h(s).replace(/(N?'(?:[^']|'')*')|\\b([A-Z_]+)\\b/g, (m, str, w) => str ? '<span class="str">' + str + '</span>' : (KW.lastIndex = 0, KW.test(w) ? '<span class="kw">' + w + '</span>' : w));
const what = (s) => s.kind === 'rebuild' ? 'Rebuild table <code>' + h(s.column) + '</code> (copy data to a new table)'
  : s.kind === 'drop' ? 'Delete <code>' + h(s.column) + '</code>'
  : s.kind === 'add' ? 'Add <code>' + h(s.column) + '</code>'
  : 'Change <code>' + h(s.column) + '</code>' + (s.to ? ' to <code>' + h(s.to) + '</code>' : '');
function status(text, error) { $('status').textContent = text; $('status').className = error ? 'err' : ''; }
window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'load') {
    orig = m.cols; info = m.info; types = m.types || []; newType = m.newType || '';
    rows = orig.map((c) => ({ ...c, orig: c.name }));
    render(); status(''); changed();
  } else if (m.type === 'script') {
    $('preview').innerHTML = m.steps.length ? m.steps.map((s) => '<li class="' + s.kind + '"><p class="what">' + what(s) + '</p>'
      + (s.detail && s.detail.length ? '<ul class="detail">' + s.detail.map((d) => '<li>' + h(d) + '</li>').join('') + '</ul>' : '') + '<pre class="sql">' + sqlHtml(s.sql) + '</pre></li>').join('')
      : m.errors.length ? '' : '<li class="empty">No pending changes. Edit a cell, add a column or delete one, and the SQL shows up here.</li>';
    $('errors').innerHTML = m.errors.map((e) => '<li>' + h(e) + '</li>').join('');
    $('count').textContent = m.count || '';
    if ($('execute')) $('execute').disabled = !m.count;
    $('openSql').disabled = !m.count;
    $('revert').disabled = !m.count && !m.errors.length;
  } else if (m.type === 'status') status(m.text, m.error);
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

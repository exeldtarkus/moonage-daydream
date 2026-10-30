import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';

/**
 * form New Database (tab): nama + isian dari driver (NewDatabase.fields), bagian group bisa dilipat, script live di bawah.
 * ext -> page: { type: 'init', fields } | { type: 'script', sql, errors } | { type: 'status', text, error? }
 * page -> ext: { type: 'ready' } | { type: 'change' | 'create' | 'open', name, values }
 */
export function newDbHtml(cspSource: string, t: { conn: string; type: string }, readOnly: boolean): string {
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
    --accent: var(--vscode-textLink-foreground, #3794ff); --mono: var(--vscode-editor-font-family, monospace); --err: var(--vscode-errorForeground, #f48771);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px 24px; color: var(--fg); background: var(--bg); font-family: var(--vscode-font-family); font-size: 13px; max-width: 860px; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .where { margin: 2px 0 16px; color: var(--muted); }
  .ro { color: var(--vscode-editorWarning-foreground); margin-bottom: 12px; }
  .row { display: grid; grid-template-columns: minmax(120px, 190px) minmax(0, 1fr); gap: 4px 12px; align-items: center; margin: 8px 0; }
  .row label { color: var(--muted); }
  input { width: 100%; max-width: 440px; height: 28px; font: inherit; padding: 0 8px; border-radius: 3px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, color-mix(in srgb, var(--line) 80%, transparent)); }
  input:focus { outline: none; border-color: var(--focus); }
  #name { font-family: var(--mono); font-weight: 600; }
  details { margin: 14px 0 4px; border: 1px solid var(--line); border-radius: 4px; padding: 4px 12px; }
  summary { cursor: pointer; padding: 4px 0; color: var(--accent); }
  summary:focus-visible, :focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; }
  h2 { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 20px 0 6px; }
  #errors { margin: 0 0 6px; padding-left: 18px; color: var(--err); }
  #errors:empty { display: none; }
  pre { margin: 0; padding: 10px 12px; min-height: 40px; border-radius: 4px; background: var(--raise); border: 1px solid var(--line);
    font-family: var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; align-items: center; }
  button { font: inherit; height: 28px; padding: 0 14px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  #status { color: var(--muted); }
  #status.err { color: var(--err); }
  @media (max-width: 520px) { .row { grid-template-columns: 1fr; } body { padding: 14px; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<h1>New Database</h1>
<p class="where">${esc(t.conn)} · ${esc(t.type)}</p>
${readOnly ? '<p class="ro">Read-only connection: the database cannot be created here, use Open in SQL Editor to get the script.</p>' : ''}
<div class="row"><label for="name">Name</label><input id="name" type="text" autofocus spellcheck="false" autocomplete="off"></div>
<div id="fields"></div>
<h2>Script</h2>
<ul id="errors"></ul>
<pre id="preview"></pre>
<div class="actions">
  ${readOnly ? '' : '<button id="create" class="primary" disabled>Create</button>'}
  <button id="openSql" disabled>Open in SQL Editor</button>
  <span id="status" role="status"></span>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const h = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let fields = [], timer;
const values = () => Object.fromEntries(fields.map((f) => [f.key, $('f-' + f.key).value]));
const send = (type) => vscode.postMessage({ type, name: $('name').value, values: values() });
function field(f) {
  const items = f.items || [];
  const def = items.find((x) => x.value === '');
  const list = f.kind === 'choice' ? '<datalist id="dl-' + h(f.key) + '">' + items.filter((x) => x.value).map((x) => '<option value="' + h(x.value) + '">' + h(x.label || '') + '</option>').join('') + '</datalist>' : '';
  return '<div class="row"><label for="f-' + h(f.key) + '">' + h(f.label) + '</label><input id="f-' + h(f.key) + '" type="text" spellcheck="false" autocomplete="off"'
    + (f.kind === 'choice' ? ' list="dl-' + h(f.key) + '"' : '') + (f.kind === 'number' ? ' inputmode="numeric"' : '')
    + ' placeholder="' + h(def ? def.label : f.hint || '') + (f.kind === 'choice' && items.length > 1 ? ' · type to search ' + (items.length - 1) : '') + '">' + list + '</div>';
}
function changed() { clearTimeout(timer); timer = setTimeout(() => send('change'), 120); }
document.addEventListener('input', changed);
$('create')?.addEventListener('click', () => send('create'));
$('openSql').addEventListener('click', () => send('open'));
window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'init') {
    fields = m.fields;
    const groups = [...new Set(fields.map((f) => f.group || ''))];
    $('fields').innerHTML = groups.map((g) => g ? '<details><summary>' + h(g) + ' (optional: server default when empty)</summary>' + fields.filter((f) => f.group === g).map(field).join('') + '</details>'
      : fields.filter((f) => !f.group).map(field).join('')).join('');
    send('change');
  } else if (m.type === 'script') {
    $('preview').textContent = m.sql || (m.errors.length ? '' : '-- enter a database name');
    $('errors').innerHTML = m.errors.filter((e) => e !== 'Database name is required' || $('name').value).map((e) => '<li>' + h(e) + '</li>').join('');
    for (const id of ['create', 'openSql']) if ($(id)) $(id).disabled = !m.sql;
  } else if (m.type === 'status') {
    $('status').textContent = m.text; $('status').className = m.error ? 'err' : '';
  }
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

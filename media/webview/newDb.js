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
  return '<div class="row"><label for="f-' + h(f.key) + '">' + h(f.label) + '</label><input id="f-' + h(f.key) + '" type="' + (f.kind === 'password' ? 'password' : 'text') + '" spellcheck="false" autocomplete="off"'
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
    $('preview').textContent = m.sql || (m.errors.length ? '' : '-- enter a name');
    $('errors').innerHTML = m.errors.filter((e) => !/ name is required$/.test(e) || $('name').value).map((e) => '<li>' + h(e) + '</li>').join('');
    for (const id of ['create', 'openSql']) if ($(id)) $(id).disabled = !m.sql;
  } else if (m.type === 'status') {
    $('status').textContent = m.text; $('status').className = m.error ? 'err' : '';
  }
});
vscode.postMessage({ type: 'ready' });

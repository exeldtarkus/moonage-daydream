import { randomBytes } from 'crypto';
import { drivers } from './db';
import type { ConnectionInfo, DbType } from './db';
import { esc } from './resultsHtml';

export interface FormData {
  /** default mssql */
  type?: string;
  /** sqlite: path file database */
  file?: string;
  /** mongodb: database tempat user dibuat */
  authSource?: string;
  name: string;
  host: string;
  port: string;
  instance: string;
  user: string;
  password: string;
  database: string;
  trust: boolean;
  /** 'sql' (default) | 'windows' (NTLM) */
  auth?: string;
  domain?: string;
}

/** validasi form; return pesan error atau undefined */
export function validate(d: FormData, conns: { get(name: string): unknown }, oldName?: string): string | undefined {
  if (!d.name.trim()) return 'Connection name is required';
  if (d.name.trim() !== oldName && conns.get(d.name.trim())) return `Connection name "${d.name.trim()}" is already used`;
  if (d.type && !(d.type in drivers)) return `Unknown database type ${d.type}`;
  if (d.type === 'sqlite') return d.file?.trim() ? undefined : 'Database file is required';
  if (!d.host.trim()) return 'Host is required';
  if (!/^\d+$/.test(d.port) || +d.port < 1 || +d.port > 65535) return 'Port must be 1-65535';
  if (d.auth === 'windows' && !d.domain?.trim()) return 'Domain is required for Windows authentication';
  if (d.auth === 'windows' && !d.user.trim()) return 'Username is required for Windows authentication';
  return undefined;
}

export function toConnection(d: FormData): ConnectionInfo {
  const type = (d.type || 'mssql') as DbType;
  if (type === 'sqlite') return { name: d.name.trim(), type, host: '', port: 0, user: '', database: '', trustServerCertificate: false, file: d.file!.trim() };
  if (type !== 'mssql') {
    return {
      name: d.name.trim(), type, host: d.host.trim(), port: +d.port, user: d.user.trim(), database: d.database.trim(), trustServerCertificate: false,
      ...(type === 'mongodb' && d.authSource?.trim() ? { authSource: d.authSource.trim() } : {}),
    };
  }
  return {
    name: d.name.trim(), type, host: d.host.trim(), port: +d.port, instance: d.instance.trim() || undefined,
    user: d.user.trim(), database: d.database.trim(), trustServerCertificate: d.trust,
    ...(d.auth === 'windows' ? { auth: 'windows' as const, domain: d.domain?.trim() } : {}),
  };
}

export function formHtml(cspSource: string, old?: ConnectionInfo): string {
  const nonce = randomBytes(16).toString('base64');
  const v = (s: string | number | undefined) => `value="${esc(String(s ?? ''))}"`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 16px 24px; max-width: 760px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
  h2 { font-weight: 600; margin: 0 0 16px; }
  .row { display: grid; grid-template-columns: 180px 1fr; align-items: center; gap: 12px; margin-bottom: 12px; }
  label { font-weight: 600; } label .req { color: var(--vscode-textLink-foreground); }
  .row[hidden], .hint[hidden], .off { display: none !important; }
  select { padding: 5px 6px; font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); }
  input[type=text], input[type=password], input[type=number] { width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .hostport { display: grid; grid-template-columns: 1fr 110px; gap: 8px; }
  .pw { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .hint { grid-column: 2; margin-top: -8px; font-size: 12px; opacity: .7; }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
  .bar .sp { flex: 1; }
  button { padding: 6px 14px; font: inherit; border-radius: 2px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .5; cursor: default; }
  #status { margin-top: 12px; white-space: pre-wrap; }
  #status.ok { color: var(--vscode-testing-iconPassed, #73c991); } #status.err { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
<h2>${old ? `Edit: ${esc(old.name)}` : 'New connection'}</h2>
<form id="f">
  <div class="row"><label for="type">Database type</label><select id="type">${Object.entries(drivers).map(([k, d]) =>
    `<option value="${k}" data-port="${d.defaultPort}"${(old?.type ?? 'mssql') === k ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}</select></div>
  <div class="row file"><label for="file">Database file <span class="req">*</span></label><input type="text" id="file" ${v(old?.file)} placeholder="/path/to/database.sqlite"></div>
  <div class="row"><label for="name">Connection name <span class="req">*</span></label><input type="text" id="name" ${v(old?.name)} required></div>
  <div class="row net"><label for="host">Host <span class="req">*</span></label>
    <div class="hostport"><input type="text" id="host" ${v(old?.host ?? 'localhost')} required><input type="number" id="port" min="1" max="65535" ${v(old?.port ?? 1433)} title="Port"></div></div>
  <div class="row ms"><label for="instance">Instance name</label><input type="text" id="instance" ${v(old?.instance)} placeholder="e.g. SQLEXPRESS"></div>
  <div class="hint ms">When set, the port is resolved by SQL Server Browser (UDP 1434) and the port above is ignored.</div>
  <div class="row ms"><label for="auth">Authentication</label><select id="auth">
    <option value="sql"${old?.auth === 'windows' ? '' : ' selected'}>SQL Server login</option>
    <option value="windows"${old?.auth === 'windows' ? ' selected' : ''}>Windows (NTLM: domain \\ user + password)</option></select></div>
  <div class="row ms" id="domainrow"${old?.auth === 'windows' ? '' : ' hidden'}><label for="domain">Domain <span class="req">*</span></label><input type="text" id="domain" ${v(old?.domain)} placeholder="e.g. CORP"></div>
  <div class="row net"><label for="user">Username</label><input type="text" id="user" ${v(old?.user ?? 'sa')}></div>
  <div class="row net"><label for="password">Password</label>
    <div class="pw"><input type="password" id="password" placeholder="${old ? 'Leave empty to keep current password' : ''}"><button type="button" class="secondary" id="show">Show</button></div></div>
  <div class="row mongo"><label for="authSource">Auth database</label><input type="text" id="authSource" ${v(old?.authSource)} placeholder="e.g. admin (where the user was created)"></div>
  <div class="hint mongo">Host may also be a full connection string (mongodb:// or mongodb+srv:// for Atlas); username / password above are added to it.</div>
  <div class="row net"><label for="database">Database</label><input type="text" id="database" ${v(old?.database)} placeholder="empty = default database of the user"></div>
  <div class="row ms"><label for="trust">Trust server certificate</label><div><input type="checkbox" id="trust" ${old?.trustServerCertificate ?? true ? 'checked' : ''}> <span style="opacity:.7">for local / self-signed certificates</span></div></div>
  <div class="bar">
    <button type="button" class="secondary" id="test">Test</button>
    <span class="sp"></span>
    <button type="button" class="secondary" id="cancel">Cancel</button>
    <button type="submit" class="primary" id="save">Save connection</button>
  </div>
  <div id="status"></div>
</form>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const data = () => ({ name: $('name').value, host: $('host').value, port: $('port').value, instance: $('instance').value,
    user: $('user').value, password: $('password').value, database: $('database').value, trust: $('trust').checked,
    auth: $('auth').value, domain: $('domain').value, type: $('type').value, file: $('file').value, authSource: $('authSource').value });
  $('auth').onchange = () => { $('domainrow').hidden = $('auth').value !== 'windows'; };
  // baris sesuai tipe: SQLite cukup file; opsi instance / auth / sertifikat hanya SQL Server
  const showType = () => {
    const t = $('type').value;
    document.querySelectorAll('.file').forEach((e) => e.classList.toggle('off', t !== 'sqlite'));
    document.querySelectorAll('.net').forEach((e) => e.classList.toggle('off', t === 'sqlite'));
    document.querySelectorAll('.ms').forEach((e) => e.classList.toggle('off', t !== 'mssql'));
    document.querySelectorAll('.mongo').forEach((e) => e.classList.toggle('off', t !== 'mongodb'));
  };
  let lastPort = $('type').selectedOptions[0].dataset.port;
  $('type').onchange = () => {
    const opt = $('type').selectedOptions[0];
    if ($('port').value === lastPort || !$('port').value) $('port').value = opt.dataset.port; // port default ikut tipe, port yang diubah user dibiarkan
    // username contoh ikut tipe; yang sudah diketik user tidak diubah
    const users = { mssql: 'sa', postgres: 'postgres', mysql: 'root', mariadb: 'root', mongodb: '' };
    if (Object.values(users).includes($('user').value) && $('type').value in users) $('user').value = users[$('type').value];
    lastPort = opt.dataset.port;
    showType();
  };
  showType();
  const busy = (b) => ['test', 'save'].forEach((id) => ($(id).disabled = b));
  const status = (cls, text) => { $('status').className = cls; $('status').textContent = text; };
  $('show').onclick = () => { const p = $('password'); p.type = p.type === 'password' ? 'text' : 'password'; $('show').textContent = p.type === 'password' ? 'Show' : 'Hide'; };
  $('test').onclick = () => { busy(true); status('', 'Testing…'); vscode.postMessage({ type: 'test', data: data() }); };
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('f').onsubmit = (e) => { e.preventDefault(); busy(true); status('', 'Saving…'); vscode.postMessage({ type: 'save', data: data() }); };
  window.addEventListener('message', (e) => { busy(false); status(e.data.ok ? 'ok' : 'err', e.data.message); });
</script>
</body>
</html>`;
}

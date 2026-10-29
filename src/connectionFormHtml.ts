import { randomBytes } from 'crypto';
import { drivers } from './db';
import type { ConnectionInfo, DbType } from './db';
import { CONN_COLORS, colorLabel, cssColor, isConnColor } from './connColor';
import type { ConnColor } from './connColor';
import { esc } from './resultsHtml';

export interface FormData {
  /** default mssql */
  type?: string;
  /** sqlite: path file database */
  file?: string;
  /** mongodb: database tempat user dibuat */
  authSource?: string;
  /** folder di view Connections */
  group?: string;
  /** red / orange / ... ; kosong = tanpa warna */
  color?: string;
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
  if (d.group !== undefined && /^\s+$/.test(d.group)) return 'Group name is required';
  if (d.color && !isConnColor(d.color)) return `Unknown color ${d.color}`;
  if (d.type && !(d.type in drivers)) return `Unknown database type ${d.type}`;
  if (d.type === 'sqlite') return d.file?.trim() ? undefined : 'Database file is required';
  if (!d.host.trim()) return 'Host is required';
  if (!/^\d+$/.test(d.port) || +d.port < 1 || +d.port > 65535) return 'Port must be 1-65535';
  if (d.auth === 'windows' && !d.domain?.trim()) return 'Domain is required for Windows authentication';
  if (d.auth === 'windows' && !d.user.trim()) return 'Username is required for Windows authentication';
  return undefined;
}

export function toConnection(d: FormData): ConnectionInfo {
  const group = d.group?.trim();
  const c = connectionOf(d);
  return { ...c, ...(group ? { group } : {}), ...(isConnColor(d.color) ? { color: d.color } : {}) };
}

function connectionOf(d: FormData): ConnectionInfo {
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

/** deskripsi singkat di kartu pilih database */
const DB_HINT: Record<DbType, string> = {
  mssql: 'Microsoft SQL Server, Azure SQL', mysql: 'MySQL 5.7 / 8.x', mariadb: 'MariaDB 10.x / 11.x',
  postgres: 'PostgreSQL 12+', sqlite: 'Local database file', mongodb: 'MongoDB, Atlas (mongodb+srv)',
};
/** warna brand untuk aksen kartu */
const DB_BRAND: Record<DbType, string> = {
  mssql: '#cc2927', mysql: '#00758f', mariadb: '#c0765a', postgres: '#336791', sqlite: '#0f80cc', mongodb: '#47a248',
};
const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 13.5 13.5 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** username contoh per tipe (diganti saat ganti tipe selama belum diubah user) */
const DEFAULT_USER: Record<DbType, string> = { mssql: 'sa', mysql: 'root', mariadb: 'root', postgres: 'postgres', sqlite: '', mongodb: '' };

/**
 * Form koneksi dua langkah: (1) pilih database (kartu + logo), (2) form per bagian untuk tipe itu. Edit langsung ke langkah 2.
 * group: dropdown (tanpa group / group yang ada / New group… -> kolom isian); preset = group folder tempat Add Connection diklik.
 * logos: data URI svg per tipe (media/db), kosong = tanpa gambar.
 */
export function formHtml(cspSource: string, old?: ConnectionInfo, groups: string[] = [], preset?: string, logos: Partial<Record<DbType, string>> = {}): string {
  const group = old?.group ?? preset ?? '';
  const all = group && !groups.includes(group) ? [...groups, group].sort() : groups;
  const nonce = randomBytes(16).toString('base64');
  const v = (s: string | number | undefined) => `value="${esc(String(s ?? ''))}"`;
  const types = Object.entries(drivers) as [DbType, (typeof drivers)[DbType]][];
  const logo = (t: DbType, cls: string) => (logos[t] ? `<img class="${cls}" src="${logos[t]}" alt="">` : `<span class="${cls} nologo">${esc(drivers[t].label[0])}</span>`);
  const swatches = ['', ...Object.keys(CONN_COLORS)].map((c) =>
    `<button type="button" class="sw${(old?.color ?? '') === c ? ' on' : ''}" data-color="${c}" title="${c ? colorLabel(c as ConnColor) : 'None'}" aria-label="${c || 'no'} color"${c ? ` style="--c: ${cssColor(c as ConnColor)}"` : ''}></button>`).join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --gap: 14px; --radius: 6px; --border: var(--vscode-panel-border, rgba(128,128,128,.35)); }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
  main { max-width: 860px; margin: 0 auto; padding: 28px 28px 110px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; }
  .sub { margin: 0 0 22px; color: var(--vscode-descriptionForeground); }
  [hidden], .off { display: none !important; }
  /* langkah 1: hero + kartu database (aksen warna brand, animasi masuk, hover terangkat) */
  .hero { position: relative; padding: 30px 30px 26px; margin-bottom: 26px; border-radius: 14px; overflow: hidden; border: 1px solid var(--border);
    background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--vscode-focusBorder) 22%, transparent), transparent 60%),
      radial-gradient(90% 120% at 100% 100%, color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 18%, transparent), transparent 60%),
      var(--vscode-editorWidget-background, rgba(128,128,128,.06)); }
  .hero h1 { font-size: 24px; letter-spacing: -.01em; }
  .hero .sub { margin: 6px 0 0; font-size: 13.5px; }
  .hero .moon { position: absolute; right: 28px; top: 50%; width: 74px; height: 74px; margin-top: -37px; border-radius: 50%; opacity: .85;
    box-shadow: inset -18px -6px 0 0 color-mix(in srgb, var(--vscode-charts-yellow, #cca700) 85%, white); animation: float 6s ease-in-out infinite; }
  @keyframes float { 50% { transform: translateY(-6px) rotate(-6deg); } }
  .dbgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .db { --brand: var(--vscode-focusBorder); position: relative; display: flex; align-items: center; gap: 14px; padding: 18px 18px 18px 20px; text-align: left; font: inherit; color: inherit; cursor: pointer; overflow: hidden;
    background: linear-gradient(135deg, color-mix(in srgb, var(--brand) 10%, transparent), transparent 55%), var(--vscode-editorWidget-background, rgba(128,128,128,.06));
    border: 1px solid var(--border); border-radius: 12px; opacity: 0; animation: rise .45s cubic-bezier(.2,.7,.2,1) forwards; animation-delay: calc(var(--i) * 60ms);
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease; }
  .db::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--brand); opacity: .9; }
  .db:hover, .db:focus-visible { transform: translateY(-3px); outline: none; border-color: color-mix(in srgb, var(--brand) 70%, transparent);
    box-shadow: 0 10px 24px -12px color-mix(in srgb, var(--brand) 70%, transparent); }
  .db b { display: block; font-size: 14.5px; margin-bottom: 3px; }
  .db small { color: var(--vscode-descriptionForeground); }
  .db .go { position: absolute; right: 14px; bottom: 10px; font-size: 12px; color: var(--brand); opacity: 0; transform: translateX(-6px); transition: opacity .18s, transform .18s; }
  .db:hover .go, .db:focus-visible .go { opacity: 1; transform: none; }
  .db:hover .logo { transform: scale(1.06) rotate(-3deg); }
  .db .logo { transition: transform .2s ease; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .db, .hero .moon { animation: none; opacity: 1; } .db, .db .logo, .db .go { transition: none; } }
  /* tile terang di belakang logo: logo gelap (MariaDB, SQL Server) tetap terlihat di tema gelap */
  .logo, .logo-sm { flex: none; object-fit: contain; background: #fff; border-radius: 8px; box-shadow: 0 0 0 1px var(--border); }
  .logo { width: 44px; height: 44px; padding: 6px; }
  .logo-sm { width: 34px; height: 34px; padding: 4px; }
  .nologo { display: grid; place-items: center; border-radius: 8px; font-weight: 700; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  /* langkah 2: form */
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .head h1 { margin: 0; }
  .head .sp { flex: 1; }
  .link { background: none; border: 0; padding: 4px 6px; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; }
  .link:hover { text-decoration: underline; }
  section.card { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px 4px; margin-bottom: var(--gap);
    background: var(--vscode-editorWidget-background, transparent); }
  section.card h2 { margin: 0 0 14px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--gap); }
  .hostport { display: grid; grid-template-columns: 1fr 120px; gap: 0 var(--gap); }
  .field { margin-bottom: 14px; min-width: 0; }
  .field label { display: block; margin-bottom: 6px; font-weight: 600; }
  .req { color: var(--vscode-textLink-foreground); }
  .hint { margin-top: 5px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  input[type=text], input[type=password], input[type=number], select { width: 100%; height: 30px; padding: 4px 8px; font: inherit; border-radius: 3px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); }
  select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, var(--border)); }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .pw { position: relative; }
  .pw input { padding-right: 34px; }
  .eye { position: absolute; right: 3px; top: 3px; width: 26px; height: 24px; padding: 3px; border: 0; border-radius: 3px; cursor: pointer; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); opacity: .75; }
  .eye:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
  .eye svg { width: 18px; height: 18px; display: block; }
  .check { display: flex; align-items: center; gap: 8px; font-weight: normal !important; }
  .swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 30px; }
  .sw { width: 22px; height: 22px; padding: 0; border-radius: 50%; cursor: pointer; background: var(--c, transparent);
    border: 1px solid var(--border); box-shadow: 0 0 0 2px transparent; }
  .sw[data-color=""] { background: linear-gradient(135deg, transparent 45%, var(--vscode-errorForeground) 45%, var(--vscode-errorForeground) 55%, transparent 55%); }
  .sw.on { box-shadow: 0 0 0 2px var(--vscode-editor-background), 0 0 0 4px var(--vscode-focusBorder); }
  /* footer tetap terlihat */
  footer { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid var(--border); background: var(--vscode-editor-background); }
  footer .in { max-width: 860px; margin: 0 auto; padding: 12px 28px; display: flex; align-items: center; gap: 10px; }
  footer .sp { flex: 1; }
  button.btn { height: 30px; padding: 0 16px; font: inherit; border-radius: 3px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); }
  .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  #status { min-height: 18px; padding: 6px 10px; border-radius: 3px; white-space: pre-wrap; flex: 1; max-width: 520px; }
  #status:empty { padding: 0; }
  #status.ok { border-left: 3px solid var(--vscode-testing-iconPassed, #73c991); background: rgba(115,201,145,.1); }
  #status.err { border-left: 3px solid var(--vscode-errorForeground); background: rgba(241,76,76,.1); }
  #status.busy { color: var(--vscode-descriptionForeground); }
  @media (max-width: 620px) { .grid2, .hostport { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<div id="step1"${old ? ' hidden' : ''}>
  <div class="hero"><h1>New connection</h1><p class="sub">Pick a database to start. You can change it later.</p><span class="moon"></span></div>
  <div class="dbgrid">${types.map(([k, d], i) =>
    `<button type="button" class="db" data-type="${k}" data-port="${d.defaultPort}" style="--brand: ${DB_BRAND[k]}; --i: ${i}">${logo(k, 'logo')}<span><b>${esc(d.label)}</b><small>${esc(DB_HINT[k])}</small></span><span class="go">Connect →</span></button>`).join('')}</div>
</div>
<form id="f"${old ? '' : ' hidden'} autocomplete="off">
  <input type="hidden" id="type" value="${esc(old?.type ?? 'mssql')}">
  <div class="head">
    <span id="headLogo">${types.map(([k]) => `<span data-logo="${k}" hidden>${logo(k, 'logo-sm')}</span>`).join('')}</span>
    <h1 id="title">${old ? `Edit: ${esc(old.name)}` : 'New connection'}</h1>
    <span class="sp"></span>
    <button type="button" class="link" id="change">Change database</button>
  </div>

  <section class="card">
    <h2>Connection</h2>
    <div class="field"><label for="name">Connection name <span class="req">*</span></label><input type="text" id="name" ${v(old?.name)} required placeholder="e.g. orders-prod"></div>
    <div class="grid2">
      <div class="field"><label for="groupSel">Group</label><select id="groupSel">
        <option value=""${group ? '' : ' selected'}>No group</option>${all.map((g) => `<option value="${esc(g)}"${g === group ? ' selected' : ''}>${esc(g)}</option>`).join('')}
        <option value="__new__">New group…</option></select></div>
      <div class="field"><label>Color</label><div class="swatches" id="colors">${swatches}</div><input type="hidden" id="color" ${v(old?.color)}></div>
    </div>
    <div class="field" id="newGroupRow" hidden><label for="group">New group <span class="req">*</span></label><input type="text" id="group" placeholder="e.g. prod, non-prod (folder in Connections)"></div>
    <div class="hint">Group = folder in Connections. Color = colored name in Connections, colored bar and "you are using connection …" in the editor.</div>
    <div style="height:14px"></div>
  </section>

  <section class="card">
    <h2 id="serverTitle">Server</h2>
    <div class="field file"><label for="file">Database file <span class="req">*</span></label><input type="text" id="file" ${v(old?.file)} placeholder="/path/to/database.sqlite"></div>
    <div class="hostport net">
      <div class="field"><label for="host">Host <span class="req">*</span></label><input type="text" id="host" ${v(old?.host ?? 'localhost')}></div>
      <div class="field"><label for="port">Port</label><input type="number" id="port" min="1" max="65535" ${v(old?.port ?? 1433)}></div>
    </div>
    <div class="hint mongo" style="margin:-8px 0 14px">Host may also be a full connection string (mongodb:// or mongodb+srv:// for Atlas); username / password below are added to it.</div>
    <div class="field ms"><label for="instance">Instance name</label><input type="text" id="instance" ${v(old?.instance)} placeholder="e.g. SQLEXPRESS">
      <div class="hint">When set, the port is resolved by SQL Server Browser (UDP 1434) and the port above is ignored.</div></div>
  </section>

  <section class="card net">
    <h2>Authentication</h2>
    <div class="field ms"><label for="auth">Method</label><select id="auth">
      <option value="sql"${old?.auth === 'windows' ? '' : ' selected'}>SQL Server login</option>
      <option value="windows"${old?.auth === 'windows' ? ' selected' : ''}>Windows (NTLM: domain \\ user + password)</option></select></div>
    <div class="field ms" id="domainrow"${old?.auth === 'windows' ? '' : ' hidden'}><label for="domain">Domain <span class="req">*</span></label><input type="text" id="domain" ${v(old?.domain)} placeholder="e.g. CORP"></div>
    <div class="grid2">
      <div class="field"><label for="user">Username</label><input type="text" id="user" ${v(old?.user ?? DEFAULT_USER[old?.type ?? 'mssql'])}></div>
      <div class="field"><label for="password">Password</label>
        <div class="pw"><input type="password" id="password" placeholder="${old ? 'Leave empty to keep current password' : ''}"><button type="button" class="eye" id="show" title="Show password" aria-label="Show password">${EYE}</button></div></div>
    </div>
    <div class="field mongo"><label for="authSource">Auth database</label><input type="text" id="authSource" ${v(old?.authSource)} placeholder="e.g. admin (where the user was created)"></div>
  </section>

  <section class="card net">
    <h2>Options</h2>
    <div class="field"><label for="database">Database</label><input type="text" id="database" ${v(old?.database)} placeholder="empty = default database of the user"></div>
    <div class="field ms"><label class="check"><input type="checkbox" id="trust" ${old?.trustServerCertificate ?? true ? 'checked' : ''}> Trust server certificate <span class="hint" style="margin:0">(local / self-signed certificates)</span></label></div>
  </section>
</form>
</main>
<footer id="foot"${old ? '' : ' hidden'}><div class="in">
  <div id="status"></div>
  <span class="sp"></span>
  <button type="button" class="btn secondary" id="test">Test connection</button>
  <button type="button" class="btn secondary" id="cancel">Cancel</button>
  <button type="submit" form="f" class="btn primary" id="save">Save connection</button>
</div></footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const LABEL = ${JSON.stringify(Object.fromEntries(types.map(([k, d]) => [k, d.label])))};
  const USERS = ${JSON.stringify(DEFAULT_USER)};
  const editing = ${old ? 'true' : 'false'};
  const data = () => ({ name: $('name').value, host: $('host').value, port: $('port').value, instance: $('instance').value,
    user: $('user').value, password: $('password').value, database: $('database').value, trust: $('trust').checked,
    auth: $('auth').value, domain: $('domain').value, type: $('type').value, file: $('file').value, authSource: $('authSource').value,
    group: $('groupSel').value === '__new__' ? $('group').value || ' ' : $('groupSel').value, color: $('color').value }); // New group kosong -> ditolak validate
  // bagian / field sesuai tipe: SQLite cukup file; instance / auth / sertifikat hanya SQL Server; auth database hanya MongoDB
  const showType = () => {
    const t = $('type').value;
    document.querySelectorAll('.file').forEach((e) => e.classList.toggle('off', t !== 'sqlite'));
    document.querySelectorAll('.net').forEach((e) => e.classList.toggle('off', t === 'sqlite'));
    document.querySelectorAll('.ms').forEach((e) => e.classList.toggle('off', t !== 'mssql'));
    document.querySelectorAll('.mongo').forEach((e) => e.classList.toggle('off', t !== 'mongodb'));
    document.querySelectorAll('[data-logo]').forEach((e) => (e.hidden = e.dataset.logo !== t));
    $('serverTitle').textContent = t === 'sqlite' ? 'Database file' : 'Server';
    if (!editing) $('title').textContent = 'New ' + LABEL[t] + ' connection';
  };
  // langkah 1 -> 2: port & username contoh ikut tipe (nilai yang sudah diubah user dibiarkan)
  const choose = (btn) => {
    const prev = $('type').value;
    const prevPort = document.querySelector('.db[data-type="' + prev + '"]').dataset.port;
    if (!$('port').value || $('port').value === prevPort) $('port').value = btn.dataset.port;
    if (Object.values(USERS).includes($('user').value)) $('user').value = USERS[btn.dataset.type];
    $('type').value = btn.dataset.type;
    showType();
    $('step1').hidden = true; $('f').hidden = false; $('foot').hidden = false;
    (btn.dataset.type === 'sqlite' ? $('file') : $('name')).focus();
  };
  document.querySelectorAll('.db').forEach((b) => (b.onclick = () => choose(b)));
  $('change').onclick = () => { $('step1').hidden = false; $('f').hidden = true; $('foot').hidden = true; };
  document.querySelectorAll('.sw').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b));
    $('color').value = b.dataset.color;
  }));
  $('groupSel').onchange = () => { $('newGroupRow').hidden = $('groupSel').value !== '__new__'; if (!$('newGroupRow').hidden) $('group').focus(); };
  $('auth').onchange = () => { $('domainrow').hidden = $('auth').value !== 'windows'; };
  showType();
  const busy = (b) => ['test', 'save'].forEach((id) => ($(id).disabled = b));
  const status = (cls, text) => { $('status').className = cls; $('status').textContent = text; };
  const EYE = ${JSON.stringify(EYE)}, EYE_OFF = ${JSON.stringify(EYE_OFF)};
  $('show').onclick = () => {
    const p = $('password'), hidden = p.type === 'password';
    p.type = hidden ? 'text' : 'password';
    $('show').innerHTML = hidden ? EYE_OFF : EYE;
    $('show').title = $('show').ariaLabel = hidden ? 'Hide password' : 'Show password';
  };
  $('test').onclick = () => { busy(true); status('busy', 'Testing connection…'); vscode.postMessage({ type: 'test', data: data() }); };
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('f').onsubmit = (e) => { e.preventDefault(); busy(true); status('busy', 'Saving…'); vscode.postMessage({ type: 'save', data: data() }); };
  window.addEventListener('message', (e) => { busy(false); status(e.data.ok ? 'ok' : 'err', e.data.message); });
</script>
</body>
</html>`;
}

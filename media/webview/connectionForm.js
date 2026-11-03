  const PAGE = JSON.parse(document.getElementById('page-data').textContent);
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const LABEL = PAGE.labels;
  const USERS = PAGE.defaultUser;
  const editing = PAGE.editing;
  const data = () => ({ name: $('name').value, host: $('host').value, port: $('port').value, instance: $('instance').value,
    user: $('user').value, password: $('password').value, database: $('database').value, trust: $('trust').checked,
    auth: $('auth').value, domain: $('domain').value, type: $('type').value, file: $('file').value, authSource: $('authSource').value,
    group: $('groupSel').value === '__new__' ? $('group').value || ' ' : $('groupSel').value, color: $('color').value, // New group kosong -> ditolak validate
    ssl: $('ssl').checked, connectTimeout: $('timeout').value, readOnly: $('readonly').checked,
    options: [...document.querySelectorAll('.opt')].map((r) => [r.querySelector('.ok').value, r.querySelector('.ov').value]) });
  // sidebar: satu bagian tampil, ringkasan isi tiap bagian di bawah judulnya
  const show = (sec) => {
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.sec === sec));
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== sec));
  };
  document.querySelectorAll('.nav button').forEach((b) => (b.onclick = () => show(b.dataset.sec)));
  const summary = () => {
    const n = data().options.filter(([k]) => k.trim()).length;
    $('sum-connection').textContent = $('type').value === 'sqlite' ? 'Database file' : 'Host, login and database';
    $('sum-ssl').textContent = $('ssl').checked ? ($('trust').checked ? 'On · certificate trusted' : 'On') : 'Off';
    $('sum-timeouts').textContent = $('timeout').value ? $('timeout').value + ' s' : 'Defaults';
    $('sum-permissions').textContent = $('readonly').checked ? 'Read only' : 'Read & write';
    $('sum-driver').textContent = n ? n + ' setting(s)' : 'Defaults';
  };
  $('f').addEventListener('input', summary);
  $('f').addEventListener('change', summary);
  const OPT_ROW = PAGE.optRow;
  const bindRow = (r) => (r.querySelector('.rm').onclick = () => { r.remove(); summary(); });
  const addOpt = (k = '', val = '') => {
    $('opts').insertAdjacentHTML('beforeend', OPT_ROW);
    const r = $('opts').lastElementChild;
    r.querySelector('.ok').value = k; r.querySelector('.ov').value = val;
    bindRow(r);
    return r;
  };
  document.querySelectorAll('.opt').forEach(bindRow);
  $('addOpt').onclick = () => addOpt().querySelector('.ok').focus();
  // Import connection string: diurai di extension (parseConnectionString), hasilnya mengisi form
  $('importBtn').onclick = () => { $('importBox').hidden = false; $('importErr').textContent = ''; $('connstr').focus(); };
  $('importCancel').onclick = () => { $('importBox').hidden = true; };
  $('importApply').onclick = () => vscode.postMessage({ type: 'parse', text: $('connstr').value });
  const fill = (p) => {
    if (p.type !== $('type').value) { $('type').value = p.type; showType(); }
    const set = (id, val) => { if (val !== undefined) $(id).value = val; };
    set('host', p.host); set('port', p.port); set('instance', p.instance ?? ''); set('user', p.user); set('password', p.password); set('database', p.database);
    set('authSource', p.authSource);
    $('auth').value = p.auth === 'windows' ? 'windows' : 'sql'; $('domainrow').hidden = $('auth').value !== 'windows';
    if (p.ssl !== undefined) $('ssl').checked = p.ssl;
    if (p.trust !== undefined) $('trust').checked = p.trust;
    for (const [k, val] of Object.entries(p.options ?? {})) {
      const row = [...document.querySelectorAll('.opt')].find((r) => r.querySelector('.ok').value.trim() === k);
      if (row) row.querySelector('.ov').value = val; else addOpt(k, val);
    }
    $('importBox').hidden = true; $('connstr').value = '';
    summary();
    status('ok', 'Form filled from the connection string. Check it, then Test / Save.');
  };
  // bagian / field sesuai tipe: SQLite cukup file; instance / auth / sertifikat hanya SQL Server; auth database hanya MongoDB
  const showType = () => {
    const t = $('type').value;
    document.querySelectorAll('.file').forEach((e) => e.classList.toggle('off', t !== 'sqlite'));
    document.querySelectorAll('.net').forEach((e) => e.classList.toggle('off', t === 'sqlite'));
    document.querySelectorAll('.ms').forEach((e) => e.classList.toggle('off', t !== 'mssql'));
    document.querySelectorAll('.mongo').forEach((e) => e.classList.toggle('off', t !== 'mongodb'));
    // Consul: tanpa username; password = ACL token, database = datacenter
    document.querySelectorAll('.noconsul').forEach((e) => e.classList.toggle('off', t === 'consul'));
    $('pwLabel').textContent = t === 'consul' ? 'ACL token' : 'Password';
    $('dbLabel').textContent = t === 'consul' ? 'Datacenter' : 'Database';
    $('database').placeholder = t === 'consul' ? 'empty = datacenter of the agent' : 'empty = default database of the user';
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
    if (!editing) $('ssl').checked = btn.dataset.type === 'mssql'; // default: SQL Server encrypt, lainnya tanpa TLS
    showType();
    summary();
    $('step1').hidden = true; $('f').hidden = false; $('foot').hidden = false;
    (btn.dataset.type === 'sqlite' ? $('file') : $('name')).focus();
  };
  document.querySelectorAll('.db').forEach((b) => (b.onclick = () => choose(b)));
  // pencarian: semua kata harus cocok (nama, deskripsi, alias); Enter = kartu pertama, Esc = kosongkan
  const cards = [...document.querySelectorAll('.db')];
  const visible = () => cards.filter((c) => !c.hidden);
  const filter = () => {
    const words = $('dbq').value.toLowerCase().split(/\s+/).filter(Boolean);
    cards.forEach((c) => (c.hidden = !words.every((w) => c.dataset.search.includes(w))));
    const v = visible();
    cards.forEach((c) => c.classList.toggle('first', !!words.length && c === v[0]));
    $('nomatch').hidden = v.length > 0;
    $('nomatchq').textContent = $('dbq').value;
  };
  $('dbq').oninput = filter;
  $('dbq').onkeydown = (e) => {
    if (e.key === 'Enter' && visible()[0]) { e.preventDefault(); choose(visible()[0]); }
    if (e.key === 'Escape') { $('dbq').value = ''; filter(); }
  };
  if (!editing) $('dbq').focus();
  $('change').onclick = () => { $('step1').hidden = false; $('f').hidden = true; $('foot').hidden = true; $('dbq').focus(); };
  document.querySelectorAll('.sw').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b));
    $('color').value = b.dataset.color;
  }));
  $('groupSel').onchange = () => { $('newGroupRow').hidden = $('groupSel').value !== '__new__'; if (!$('newGroupRow').hidden) $('group').focus(); };
  $('auth').onchange = () => { $('domainrow').hidden = $('auth').value !== 'windows'; };
  showType();
  const busy = (b) => ['test', 'save'].forEach((id) => ($(id).disabled = b));
  const status = (cls, text) => { $('status').className = cls; $('status').textContent = text; };
  const { eye: EYE, eyeOff: EYE_OFF } = PAGE;
  $('show').onclick = () => {
    const p = $('password'), hidden = p.type === 'password';
    p.type = hidden ? 'text' : 'password';
    $('show').innerHTML = hidden ? EYE_OFF : EYE;
    $('show').title = $('show').ariaLabel = hidden ? 'Hide password' : 'Show password';
  };
  $('test').onclick = () => { busy(true); status('busy', 'Testing connection…'); vscode.postMessage({ type: 'test', data: data() }); };
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('f').onsubmit = (e) => { e.preventDefault(); busy(true); status('busy', 'Saving…'); vscode.postMessage({ type: 'save', data: data() }); };
  window.addEventListener('message', (e) => {
    if (e.data.type === 'parsed') return fill(e.data.data);
    if (e.data.type === 'parseError') { $('importErr').textContent = e.data.message; return; }
    busy(false); status(e.data.ok ? 'ok' : 'err', e.data.message);
  });
  summary();

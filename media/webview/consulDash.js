  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* Codicons */
  const ICON_HOME = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px;margin-right:2px"><path fill-rule="evenodd" clip-rule="evenodd" d="M8.36 1.37l6.36 5.8-.71.71L13 6.96V14h-4v-4H7v4H3V6.96L1.99 7.88l-.71-.71 6.36-5.8h.72zM4 6.05v6.95h2V9h4v4h2V6.05l-4-3.64-4 3.64z"/></svg>';
  const ICON_FOLDER = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10l-.5-.5zm-.5 10H2V3h4.29l.86.85.35.15H14v9z"/></svg>';
  const ICON_KEY = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 1h-4l-.5.5v2.79l-4.15 4.15-.35-.14-3.5 3.5.7.7 2.15-2.14.71.7-2.15 2.15.71.71 2.14-2.15.71.71-.85.85 1.41 1.42 4.63-4.63.14.35H15l.5-.5v-4l-.5-.5h-2V2h1.5l.5-.5V1h-.5zm-.5 4h-2.5l-.5.5v2h-1.79l-.36-.15-4.14 4.15-.71-.71 2.14-2.15-.7-.7-2.15 2.14-.71-.7 2.15-2.15-.71-.71-2.14 2.15-.71-.71 3.5-3.5.15.35 4.14-4.14V2h2.5v2.5l.5.5H14v2z"/></svg>';

  let kvPrefix = '';
  let activeEntry = null; // { key, value, modifyIndex, flags, session, format, size }
  let originalValue = '';

  function setRightView(view) { // 'empty' | 'editor' | 'new'
    $('paneEmpty').style.display = view === 'empty' ? 'flex' : 'none';
    $('paneEditor').style.display = view === 'editor' ? 'flex' : 'none';
    $('paneNewKey').style.display = view === 'new' ? 'flex' : 'none';
  }

  /* KV Browse (Left Pane) */
  function kvBrowse(prefix) {
    // filter hanya untuk folder yang sedang dibuka; Refresh (folder sama) tetap
    if (prefix !== kvPrefix) $('filter').value = '';
    kvPrefix = prefix;
    $('status').className = '';
    $('status').textContent = 'Loading…';
    $('kvList').innerHTML = '<div class="empty loading"><span class="spin"></span>Loading…</div>';
    vscode.postMessage({ type: 'kvBrowse', prefix: prefix });
  }

  function kvBreadcrumb(prefix) {
    const el = $('kvBreadcrumb');
    el.innerHTML = '';
    const root = document.createElement('a');
    root.innerHTML = ICON_HOME + ' /';
    root.title = 'Root folder';
    root.onclick = () => kvBrowse('');
    el.appendChild(root);

    const parts = prefix.split('/').filter(Boolean);
    let path = '';
    for (const part of parts) {
      path += part + '/';
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      el.appendChild(sep);
      const a = document.createElement('a');
      a.textContent = part;
      const p = path;
      a.onclick = () => kvBrowse(p);
      el.appendChild(a);
    }
  }

  function renderKvList(data) {
    $('status').className = '';
    $('status').textContent = 'Loaded ' + new Date().toLocaleTimeString();
    kvBreadcrumb(data.prefix);

    if (!data.folders.length && !data.keys.length) {
      $('kvList').innerHTML = '<div class="empty">Folder is empty</div>';
      return;
    }

    const tbl = document.createElement('table');
    tbl.innerHTML = '<thead><tr><th style="width:22px"></th><th>Name</th></tr></thead>';
    const tbody = document.createElement('tbody');

    for (const f of data.folders) {
      const name = f.replace(/\/$/, '').split('/').pop();
      const tr = document.createElement('tr');
      tr.className = 'kv-row kv-folder-row';
      tr.setAttribute('data-name', name.toLowerCase());
      tr.innerHTML = '<td class="kv-icon">' + ICON_FOLDER + '</td><td>' + esc(name) + '/</td>';
      tr.onclick = () => kvBrowse(f);
      tbody.appendChild(tr);
    }

    for (const k of data.keys) {
      const name = k.key.split('/').pop();
      const tr = document.createElement('tr');
      tr.className = 'kv-row kv-key-row';
      tr.setAttribute('data-key', k.key);
      tr.setAttribute('data-name', name.toLowerCase());
      if (activeEntry && activeEntry.key === k.key) tr.classList.add('selected');
      tr.innerHTML = '<td class="kv-icon">' + ICON_KEY + '</td><td>' + esc(name) + '</td>';
      tr.onclick = () => selectKey(k.key);
      tbody.appendChild(tr);
    }

    tbl.appendChild(tbody);
    $('kvList').innerHTML = '';
    $('kvList').appendChild(tbl);
    applyFilter();
  }

  /* Select and view Key (Right Pane) */
  function selectKey(key) {
    document.querySelectorAll('.kv-row').forEach((r) => r.classList.toggle('selected', r.getAttribute('data-key') === key));
    setRightView('editor');
    $('activeKeyName').textContent = key;
    $('saveBadge').className = '';
    $('saveBadge').textContent = 'Loading…';
    $('valEditor').value = '';
    $('valEditor').disabled = true;
    $('btnSave').disabled = true;
    vscode.postMessage({ type: 'kvGetValue', key: key });
  }

  function renderKvValue(data) {
    if (data.error) {
      $('saveBadge').className = 'err';
      $('saveBadge').textContent = data.error;
      $('valEditor').value = '';
      return;
    }
    activeEntry = data;
    originalValue = data.value;
    $('activeKeyName').textContent = data.key;
    $('metaFormat').textContent = 'Format: ' + data.format;
    $('metaSize').textContent = 'Size: ' + data.size;
    $('metaModifyIndex').textContent = 'ModifyIndex: ' + data.modifyIndex;
    $('metaFlags').textContent = 'Flags: ' + data.flags;
    if (data.session) {
      $('metaSession').style.display = '';
      $('metaSession').textContent = 'Session: ' + data.session;
    } else {
      $('metaSession').style.display = 'none';
    }
    $('valEditor').value = data.value;
    $('valEditor').disabled = false;
    $('btnSave').disabled = false;
    $('saveBadge').className = '';
    $('saveBadge').textContent = 'Saved ✓';
  }

  /* Editor change tracking */
  $('valEditor').addEventListener('input', () => {
    const isDirty = $('valEditor').value !== originalValue;
    $('saveBadge').className = isDirty ? 'dirty' : '';
    $('saveBadge').textContent = isDirty ? 'Modified ●' : 'Saved ✓';
  });

  /* Keyboard shortcut Ctrl+S / Cmd+S in editor */
  $('valEditor').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCurrentKey();
    }
    // Tab key support in textarea
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.target.selectionStart;
      const end = e.target.selectionEnd;
      e.target.value = e.target.value.substring(0, start) + '  ' + e.target.value.substring(end);
      e.target.selectionStart = e.target.selectionEnd = start + 2;
      e.target.dispatchEvent(new Event('input'));
    }
  });

  /* Save existing Key */
  function saveCurrentKey() {
    if (!activeEntry) return;
    const newVal = $('valEditor').value;
    $('saveBadge').className = '';
    $('saveBadge').textContent = 'Saving…';
    $('btnSave').disabled = true;
    vscode.postMessage({
      type: 'kvSave',
      key: activeEntry.key,
      value: newVal,
      cas: activeEntry.modifyIndex
    });
  }

  $('btnSave').onclick = saveCurrentKey;

  /* Delete Key */
  $('btnDelete').onclick = () => {
    if (!activeEntry) return;
    vscode.postMessage({ type: 'kvDelete', key: activeEntry.key });
  };

  /* Open in VS Code tab */
  $('btnOpenEditor').onclick = () => {
    if (activeEntry) vscode.postMessage({ type: 'kvOpenEditor', key: activeEntry.key });
  };

  /* Copy value */
  $('btnCopyValue').onclick = () => {
    const val = $('valEditor').value;
    navigator.clipboard.writeText(val).then(() => {
      $('btnCopyValue').textContent = 'Copied!';
      setTimeout(() => { $('btnCopyValue').textContent = 'Copy'; }, 1800);
    });
  };

  /* Close editor */
  $('btnCloseEditor').onclick = () => {
    activeEntry = null;
    document.querySelectorAll('.kv-row.selected').forEach((r) => r.classList.remove('selected'));
    setRightView('empty');
  };

  /* New Key Mode */
  $('btnNewKey').onclick = () => {
    setRightView('new');
    $('newKeyPrefix').textContent = kvPrefix ? kvPrefix : '/';
    $('inputNewKeyName').value = '';
    $('inputNewKeyValue').value = '';
    $('inputNewKeyName').focus();
  };

  $('btnCancelNew').onclick = () => {
    setRightView(activeEntry ? 'editor' : 'empty');
  };

  $('btnSaveNew').onclick = () => {
    const rawName = $('inputNewKeyName').value.trim();
    if (!rawName) {
      alert('Enter a key name');
      $('inputNewKeyName').focus();
      return;
    }
    const cleanName = rawName.replace(/^\/+/, '');
    const fullKey = kvPrefix + cleanName;
    const value = $('inputNewKeyValue').value;
    $('btnSaveNew').disabled = true;
    vscode.postMessage({
      type: 'kvSave',
      key: fullKey,
      value: value,
      cas: 0,
      isNew: true
    });
  };

  /* Filter in current folder */
  function applyFilter() {
    const q = ($('filter').value || '').trim().toLowerCase();
    document.querySelectorAll('.kv-row').forEach((r) => {
      const name = r.getAttribute('data-name') || '';
      r.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
  }

  $('filter').oninput = applyFilter;
  $('btnRefresh').onclick = () => {
    kvBrowse(kvPrefix);
    vscode.postMessage({ type: 'cluster' });
  };

  /* Cluster summary */
  function renderCluster(d) {
    const card = (lbl, val, title) => '<div class="card"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="lbl">' + lbl + '</div><div class="val">' + val + '</div></div>';
    const svcBad = d.services.filter((s) => s.critical).length, svcWarn = d.services.filter((s) => s.warning && !s.critical).length;
    const alive = d.members.filter((m) => m.status === 'alive').length;
    $('cluster').innerHTML =
      card('Leader', d.leader ? esc(d.leader) : '<span class="bad">none</span>') +
      card('Peers', d.peers) +
      card('Services', d.services.length + (svcBad ? ' <span class="bad">' + svcBad + ' critical</span>' : '') + (svcWarn ? ' <span class="warn">' + svcWarn + ' warning</span>' : ''),
        d.services.map((s) => s.name + (s.tags ? ' [' + s.tags + ']' : '') + ': ' + s.passing + ' passing, ' + s.warning + ' warning, ' + s.critical + ' critical').join('\n')) +
      card('Checks', '<span class="ok">' + d.checks.passing + '</span> / <span class="warn">' + d.checks.warning + '</span> / <span class="bad">' + d.checks.critical + '</span>', 'passing / warning / critical') +
      card('Nodes', d.nodes.length, d.nodes.map((n) => n.name + ' ' + n.address + ' (' + n.datacenter + ')').join('\n')) +
      card('Members', alive + '/' + d.members.length + ' alive', d.members.map((m) => m.name + ' ' + m.address + ': ' + m.status).join('\n')) +
      (d.errors.length ? card('Not available', '<span class="warn">' + d.errors.length + ' endpoint(s)</span>', d.errors.join('\n')) : '');
    $('failing').style.display = d.failing.length ? '' : 'none';
    $('failing').querySelector('summary').innerHTML = '<span class="bad">' + d.failing.length + ' failing check(s)</span>';
    $('failingRows').innerHTML = d.failing.map((c) => '<tr><td class="' + (c.status === 'critical' ? 'bad' : 'warn') + '">' + esc(c.status) + '</td><td>' + esc(c.node) +
      '</td><td>' + esc(c.service || '-') + '</td><td>' + esc(c.check) + '</td><td title="' + esc(c.output) + '">' + esc(c.output) + '</td></tr>').join('');
  }

  /* Webview Message Listener */
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'error' || m.type === 'kvError') {
      $('status').className = 'err';
      $('status').textContent = m.message;
      return;
    }
    if (m.type === 'cluster') {
      renderCluster(m.data);
      return;
    }
    if (m.type === 'clusterError') {
      $('cluster').innerHTML = '<div class="card"><div class="lbl">Cluster</div><div class="val bad">' + esc(m.message) + '</div></div>';
      return;
    }
    if (m.type === 'kv') {
      renderKvList(m);
      return;
    }
    if (m.type === 'kvValue') {
      renderKvValue(m);
      return;
    }
    if (m.type === 'kvSaveResult') {
      $('btnSave').disabled = false;
      $('btnSaveNew').disabled = false;
      if (m.success) {
        $('saveBadge').className = 'saved';
        $('saveBadge').textContent = 'Saved ✓ ' + new Date().toLocaleTimeString();
        if (activeEntry && activeEntry.key === m.key) {
          activeEntry.modifyIndex = m.modifyIndex;
          originalValue = $('valEditor').value;
          $('metaModifyIndex').textContent = 'ModifyIndex: ' + m.modifyIndex;
          $('metaSize').textContent = 'Size: ' + m.size;
          $('metaFormat').textContent = 'Format: ' + m.format;
        }
        if (m.isNew) {
          // New key created, re-browse and select it
          kvBrowse(kvPrefix);
          selectKey(m.key);
        }
      } else {
        $('saveBadge').className = 'err';
        $('saveBadge').textContent = m.error || 'Save failed';
      }
      return;
    }
    if (m.type === 'kvDeleteResult') {
      if (m.success) {
        activeEntry = null;
        setRightView('empty');
        kvBrowse(kvPrefix);
      }
      return;
    }
  });

  // Load root KV initially
  kvBrowse('');
  vscode.postMessage({ type: 'cluster' });

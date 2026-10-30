import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';

/** panel Consul Dashboard: ringkasan cluster (leader / services / checks / nodes / members) + 2-kolom KV (kiri: keys & folders, kanan: value editor) */
export function consulDashboardHtml(cspSource: string, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  
  /* Top bar */
  .top-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; flex-shrink: 0; }
  .top-bar h1 { font-size: 15px; margin: 0; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 12px; }
  #status.err { color: var(--vscode-errorForeground); }
  
  /* Buttons & Inputs */
  button { font: inherit; height: 26px; border-radius: 3px; padding: 0 12px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.danger { color: var(--vscode-errorForeground, #f48771); background: transparent; border: 1px solid var(--vscode-errorForeground, #f48771); }
  button.danger:hover { background: rgba(244, 135, 113, 0.15); }
  button:disabled { opacity: 0.5; cursor: default; }

  input[type="text"], input[type="search"] { font: inherit; height: 26px; padding: 0 8px; border-radius: 3px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
  input[type="text"]:focus, input[type="search"]:focus { border-color: var(--vscode-focusBorder); }

  /* 2-Column Split Layout */
  .split-layout { display: flex; flex: 1; min-height: 0; gap: 14px; }
  
  /* Left Pane: Keys & Folders */
  .pane-left { flex: 0 0 380px; min-width: 280px; max-width: 45%; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--vscode-panel-border); padding-right: 14px; }
  .left-toolbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
  .left-toolbar input[type="search"] { flex: 1; min-width: 0; }
  
  /* Breadcrumb */
  .kv-breadcrumb { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; margin-bottom: 8px; font-size: 12px; min-height: 24px; }
  .kv-breadcrumb a { display: inline-flex; align-items: center; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; padding: 2px 4px; border-radius: 3px; }
  .kv-breadcrumb a:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .kv-breadcrumb .sep { color: var(--vscode-descriptionForeground); margin: 0 2px; }

  /* Key List / Table */
  .list-container { flex: 1; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-sideBar-background, transparent); }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
  .empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
  .kv-row { cursor: pointer; user-select: none; }
  .kv-row:hover { background: var(--vscode-list-hoverBackground); }
  .kv-row.selected { background: var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.08)); font-weight: 500; }
  .kv-row .kv-icon { width: 22px; text-align: center; color: var(--vscode-descriptionForeground); }
  .kv-row .kv-icon svg { display: inline-block; vertical-align: -2px; }

  /* Right Pane: Value Editor & Actions */
  .pane-right { flex: 1; min-width: 320px; display: flex; flex-direction: column; min-height: 0; }
  .editor-header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; flex-shrink: 0; }
  .editor-title { font-weight: 600; font-size: 13px; word-break: break-all; margin-right: auto; display: flex; align-items: center; gap: 6px; }
  .editor-actions { display: flex; gap: 6px; align-items: center; }

  /* Metadata bar */
  .editor-meta { font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; flex-shrink: 0; }
  .editor-meta .tag { background: var(--vscode-badge-background, rgba(128,128,128,.15)); padding: 2px 6px; border-radius: 3px; }
  .editor-meta #saveBadge { margin-left: auto; font-weight: 500; }
  .editor-meta #saveBadge.dirty { color: var(--vscode-editorWarning-foreground, #cca700); }
  .editor-meta #saveBadge.saved { color: var(--vscode-testing-iconPassed, #73c991); }
  .editor-meta #saveBadge.err { color: var(--vscode-errorForeground); }

  /* Textarea Editor Box */
  .editor-box { flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; }
  .editor-textarea { flex: 1; width: 100%; height: 100%; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 10px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.5; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); resize: none; outline: none; tab-size: 2; white-space: pre; }
  .editor-textarea:focus { border-color: var(--vscode-focusBorder); }

  /* Empty state in right pane */
  .pane-placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); text-align: center; padding: 30px; border: 1px dashed var(--vscode-panel-border); border-radius: 6px; }
  .pane-placeholder p { margin: 6px 0; }

  /* Cluster summary */
  .cluster { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; flex-shrink: 0; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; min-width: 90px; }
  .card .lbl { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .card .val { font-size: 14px; font-weight: 600; word-break: break-all; }
  .ok { color: var(--vscode-testing-iconPassed, #73c991); }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .bad { color: var(--vscode-errorForeground, #f48771); }
  #failing { margin-bottom: 10px; flex-shrink: 0; font-size: 12px; }
  #failing summary { cursor: pointer; }
  #failing .list-container { max-height: 160px; margin-top: 6px; }
  #failing td { max-width: 360px; }

  /* New Key Form */
  .new-key-form { display: flex; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }
  .new-key-row { display: flex; flex-direction: column; gap: 4px; }
  .new-key-row label { font-size: 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="top-bar">
  <h1>Consul · ${esc(title)}</h1>
  <span id="status">Loading…</span>
</div>

<div id="cluster" class="cluster"><div class="card"><div class="lbl">Cluster</div><div class="val">Loading…</div></div></div>
<details id="failing" style="display:none"><summary></summary><div class="list-container"><table><thead><tr><th>Status</th><th>Node</th><th>Service</th><th>Check</th><th>Output</th></tr></thead><tbody id="failingRows"></tbody></table></div></details>

<div class="split-layout">
  <!-- Left Column: Key & Folder Browser -->
  <div class="pane-left">
    <div class="left-toolbar">
      <input type="search" id="filter" placeholder="Filter in folder…">
      <button id="btnNewKey" class="primary" title="Create a new key">+ New Key</button>
      <button id="btnRefresh" title="Refresh keys">↻</button>
    </div>
    <div id="kvBreadcrumb" class="kv-breadcrumb"></div>
    <div class="list-container">
      <div id="kvList"><div class="empty">Loading keys…</div></div>
    </div>
  </div>

  <!-- Right Column: Value Editor / New Key -->
  <div class="pane-right">
    <!-- Placeholder when nothing is selected -->
    <div id="paneEmpty" class="pane-placeholder">
      <svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor" opacity="0.4"><path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 1h-4l-.5.5v2.79l-4.15 4.15-.35-.14-3.5 3.5.7.7 2.15-2.14.71.7-2.15 2.15.71.71 2.14-2.15.71.71-.85.85 1.41 1.42 4.63-4.63.14.35H15l.5-.5v-4l-.5-.5h-2V2h1.5l.5-.5V1h-.5zm-.5 4h-2.5l-.5.5v2h-1.79l-.36-.15-4.14 4.15-.71-.71 2.14-2.15-.7-.7-2.15 2.14-.71-.7 2.15-2.15-.71-.71-2.14 2.15-.71-.71 3.5-3.5.15.35 4.14-4.14V2h2.5v2.5l.5.5H14v2z"/></svg>
      <p><b>No key selected</b></p>
      <p>Click a key on the left to view and edit its value, or click <b>+ New Key</b> to add a key.</p>
    </div>

    <!-- Active Key Editor -->
    <div id="paneEditor" style="display:none; flex:1; flex-direction:column; min-height:0;">
      <div class="editor-header">
        <span class="editor-title">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 1h-4l-.5.5v2.79l-4.15 4.15-.35-.14-3.5 3.5.7.7 2.15-2.14.71.7-2.15 2.15.71.71 2.14-2.15.71.71-.85.85 1.41 1.42 4.63-4.63.14.35H15l.5-.5v-4l-.5-.5h-2V2h1.5l.5-.5V1h-.5zm-.5 4h-2.5l-.5.5v2h-1.79l-.36-.15-4.14 4.15-.71-.71 2.14-2.15-.7-.7-2.15 2.14-.71-.7 2.15-2.15-.71-.71-2.14 2.15-.71-.71 3.5-3.5.15.35 4.14-4.14V2h2.5v2.5l.5.5H14v2z"/></svg>
          <span id="activeKeyName"></span>
        </span>
        <div class="editor-actions">
          <button id="btnSave" class="primary" title="Save changes to Consul (Ctrl+S)">Save</button>
          <button id="btnDelete" class="danger" title="Delete key from Consul">Delete</button>
          <button id="btnOpenEditor" title="Open in VS Code text editor tab">Open in Tab</button>
          <button id="btnCopyValue" title="Copy value to clipboard">Copy</button>
          <button id="btnCloseEditor" title="Close editor">✕</button>
        </div>
      </div>
      <div class="editor-meta">
        <span class="tag" id="metaFormat">Format: text</span>
        <span class="tag" id="metaSize">Size: 0 B</span>
        <span class="tag" id="metaModifyIndex">ModifyIndex: 0</span>
        <span class="tag" id="metaFlags">Flags: 0</span>
        <span class="tag" id="metaSession" style="display:none"></span>
        <span id="saveBadge"></span>
      </div>
      <div class="editor-box">
        <textarea id="valEditor" class="editor-textarea" spellcheck="false" placeholder="Empty value…"></textarea>
      </div>
    </div>

    <!-- New Key Form -->
    <div id="paneNewKey" style="display:none; flex:1; flex-direction:column; min-height:0;">
      <div class="editor-header">
        <span class="editor-title"><b>+ Create New Key</b></span>
        <div class="editor-actions">
          <button id="btnSaveNew" class="primary">Create Key</button>
          <button id="btnCancelNew">Cancel</button>
        </div>
      </div>
      <div class="new-key-form">
        <div class="new-key-row">
          <label>Key Path (relative to current folder):</label>
          <div style="display:flex;align-items:center;gap:4px">
            <span id="newKeyPrefix" style="color:var(--vscode-descriptionForeground);font-family:monospace;font-size:12px;"></span>
            <input type="text" id="inputNewKeyName" placeholder="e.g. app/config or database_url" style="flex:1">
          </div>
        </div>
        <div class="new-key-row" style="flex:1;min-height:0;display:flex;flex-direction:column">
          <label>Value:</label>
          <div class="editor-box">
            <textarea id="inputNewKeyValue" class="editor-textarea" spellcheck="false" placeholder="Enter key value here (JSON, YAML, or plain text)…"></textarea>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script nonce="${nonce}">
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
    kvPrefix = prefix;
    $('status').className = '';
    $('status').textContent = 'Loading…';
    $('kvList').innerHTML = '<div class="empty">Loading…</div>';
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
      const name = f.replace(/\\/$/, '').split('/').pop();
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
    const cleanName = rawName.replace(/^\\/+/, '');
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
        d.services.map((s) => s.name + (s.tags ? ' [' + s.tags + ']' : '') + ': ' + s.passing + ' passing, ' + s.warning + ' warning, ' + s.critical + ' critical').join('\\n')) +
      card('Checks', '<span class="ok">' + d.checks.passing + '</span> / <span class="warn">' + d.checks.warning + '</span> / <span class="bad">' + d.checks.critical + '</span>', 'passing / warning / critical') +
      card('Nodes', d.nodes.length, d.nodes.map((n) => n.name + ' ' + n.address + ' (' + n.datacenter + ')').join('\\n')) +
      card('Members', alive + '/' + d.members.length + ' alive', d.members.map((m) => m.name + ' ' + m.address + ': ' + m.status).join('\\n')) +
      (d.errors.length ? card('Not available', '<span class="warn">' + d.errors.length + ' endpoint(s)</span>', d.errors.join('\\n')) : '');
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
</script>
</body>
</html>`;
}

import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';

/** panel Consul Dashboard: ringkasan + tabel; data dikirim extension lewat postMessage ({ type: 'data', data: DashboardSummary } | { type: 'error' }) */
export function consulDashboardHtml(cspSource: string, title: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 12px 16px 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
  .bar h1 { font-size: 15px; margin: 0 12px 0 0; }
  .bar label { display: flex; gap: 6px; align-items: center; color: var(--vscode-descriptionForeground); }
  select, button { font: inherit; height: 26px; border-radius: 3px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); }
  button { padding: 0 12px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  #status { margin-left: auto; color: var(--vscode-descriptionForeground); }
  #status.err { color: var(--vscode-errorForeground); }
  #cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 12px; }
  .card small { color: var(--vscode-descriptionForeground); } .card b { display: block; font-size: 18px; margin-top: 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; max-width: 520px; overflow: hidden; text-overflow: ellipsis; }
  .critical, .failed { color: var(--vscode-errorForeground); } .warning, .leaving { color: var(--vscode-editorWarning-foreground, #cca700); } .passing, .alive { color: var(--vscode-testing-iconPassed, #73c991); }
  .empty { color: var(--vscode-descriptionForeground); padding: 6px 0; }
</style>
</head>
<body>
<div class="bar">
  <h1>Consul · ${esc(title)}</h1>
  <label>Refresh <select id="interval">${[5, 10, 30, 60].map((s) => `<option value="${s}000"${s === 10 ? ' selected' : ''}>${s}s</option>`).join('')}</select></label>
  <button id="pause">Pause</button>
  <span id="status">Loading…</span>
</div>
<div id="cards"></div>
<h2>Services</h2><div id="services"></div>
<h2>Failing checks</h2><div id="failing"></div>
<h2>Nodes</h2><div id="nodes"></div>
<h2>Members</h2><div id="members"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let paused = false;
  const table = (cols, rows, cls) => (rows.length ? '<table><thead><tr>' + cols.map((c) => '<th>' + esc(c[1]) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((r) => '<tr>' + cols.map((c) => '<td class="' + esc(cls && cls(r, c[0])) + '" title="' + esc(r[c[0]]) + '">' + esc(r[c[0]]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
    : '<div class="empty">None</div>');
  const health = (r, k) => (k === 'critical' && r.critical ? 'critical' : k === 'warning' && r.warning ? 'warning' : k === 'status' ? r.status : '');
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'error') { $('status').className = 'err'; $('status').textContent = m.message; return; }
    const d = m.data;
    $('status').className = ''; $('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
    const card = (label, value, cls) => '<div class="card"><small>' + esc(label) + '</small><b class="' + (cls || '') + '">' + esc(value) + '</b></div>';
    $('cards').innerHTML = card('Leader', d.leader || 'none', d.leader ? '' : 'critical') + card('Raft peers', d.peers) + card('Nodes', d.nodes.length) + card('Services', d.services.length)
      + card('Checks passing', d.checks.passing, 'passing') + card('Checks warning', d.checks.warning, d.checks.warning ? 'warning' : '') + card('Checks critical', d.checks.critical, d.checks.critical ? 'critical' : '');
    $('services').innerHTML = table([['name', 'Service'], ['tags', 'Tags'], ['passing', 'Passing'], ['warning', 'Warning'], ['critical', 'Critical']], d.services, health);
    $('failing').innerHTML = table([['status', 'Status'], ['node', 'Node'], ['service', 'Service'], ['check', 'Check'], ['output', 'Output']], d.failing, health);
    $('nodes').innerHTML = table([['name', 'Node'], ['address', 'Address'], ['datacenter', 'Datacenter']], d.nodes);
    $('members').innerHTML = table([['name', 'Member'], ['address', 'Address'], ['status', 'Status']], d.members, (r, k) => (k === 'status' ? r.status : ''));
  });
  $('interval').onchange = () => vscode.postMessage({ type: 'interval', ms: +$('interval').value });
  $('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; vscode.postMessage({ type: 'pause', paused }); };
</script>
</body>
</html>`;
}

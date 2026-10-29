import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';

const CHARTS: [string, string, string][] = [
  ['cpu', 'CPU %', 'SQL Server CPU usage (Resource Pool Stats)'], ['batch', 'Batch requests/sec', 'SQL Statistics: Batch Requests/sec'],
  ['waiting', 'Waiting tasks', 'User tasks waiting for a resource (sys.dm_os_waiting_tasks)'], ['io', 'Database I/O MB/s', 'Read and write MB/s, all database files'],
  ['conn', 'User connections', 'General Statistics: User Connections'], ['tran', 'Transactions/sec', 'Databases: Transactions/sec (_Total)'],
];
const TABS: [string, string][] = [['running', 'Running queries'], ['sessions', 'Sessions / Blocking'], ['waits', 'Top waits'], ['expensive', 'Expensive queries'], ['files', 'File I/O']];

// angka level server walau monitoring satu database (SQL Server tidak memecahnya per database)
const SERVER_WIDE = new Set(['cpu', 'batch', 'waits']);

/**
 * panel Live Monitor SQL Server: grafik SVG live + tabel; data dikirim extension lewat postMessage ({ type: 'sample' | 'error' }).
 * perDb: monitoring satu database -> grafik / tab yang tetap level server diberi label (server)
 */
export function monitorHtml(cspSource: string, title: string, perDb = false): string {
  const nonce = randomBytes(16).toString('base64');
  const label = (id: string, text: string) => (perDb && SERVER_WIDE.has(id) ? `${text} (server)` : text);
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
  .charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .chart { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; }
  .chart h2 { display: flex; justify-content: space-between; margin: 0 0 4px; font-size: 12px; font-weight: 600; }
  .chart h2 b { font-variant-numeric: tabular-nums; color: var(--vscode-charts-blue, #3794ff); }
  .chart svg { width: 100%; height: 90px; display: block; }
  .chart .grid { stroke: var(--vscode-panel-border); stroke-width: 1; }
  .chart .s0 { stroke: var(--vscode-charts-blue, #3794ff); fill: none; stroke-width: 1.6; }
  .chart .s1 { stroke: var(--vscode-charts-orange, #d18616); fill: none; stroke-width: 1.6; }
  .chart .ax { fill: var(--vscode-descriptionForeground); font-size: 10px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; }
  .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--vscode-foreground); }
  .tabs button.on { border-bottom-color: var(--vscode-focusBorder); }
  .tabs .sp { flex: 1; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); }
  tr.blk td { color: var(--vscode-errorForeground); }
  .wrap { max-height: 45vh; overflow: auto; }
  .kill { height: 20px; padding: 0 8px; font-size: 11px; }
  .empty { padding: 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="bar">
  <h1>Live Monitor · ${esc(title)}</h1>
  <label>Refresh <select id="interval">${[1, 2, 5, 10, 30, 60].map((s) => `<option value="${s}000"${s === 5 ? ' selected' : ''}>${s}s</option>`).join('')}</select></label>
  <label>Window <select id="window">${[1, 5, 15].map((m) => `<option value="${m}"${m === 5 ? ' selected' : ''}>${m} min</option>`).join('')}</select></label>
  <button id="pause">Pause</button>
  <span id="status">Collecting…</span>
</div>
<div class="charts">${CHARTS.map(([id, text, tip]) => `<div class="chart" data-chart="${id}" title="${esc(tip)}"><h2>${esc(label(id, text))} <b id="v-${id}">–</b></h2><svg viewBox="0 0 300 90" preserveAspectRatio="none"></svg></div>`).join('')}</div>
<div class="tabs">${TABS.map(([id, text], i) => `<button data-tab="${id}"${i ? '' : ' class="on"'}>${esc(label(id, text))}</button>`).join('')}<span class="sp"></span><button id="open" title="Open this table as a query (grid with filter / export)">Open as query</button></div>
<div class="wrap" id="table"><div class="empty">Waiting for the first sample…</div></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let points = [], last, tab = 'running', paused = false;
  // seri per grafik: [nama, ambil nilai]
  const SERIES = { cpu: [(p) => p.cpu], batch: [(p) => p.batchPerSec], waiting: [(p) => p.waiting], io: [(p) => p.readMBs, (p) => p.writeMBs], conn: [(p) => p.connections], tran: [(p) => p.tranPerSec] };
  const fmt = (v) => (v === null || v === undefined ? '–' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString());
  function draw() {
    const win = +$('window').value * 60000, now = points.length ? points[points.length - 1].t : 0;
    points = points.filter((p) => p.t >= now - win);
    for (const [id, fns] of Object.entries(SERIES)) {
      const svg = document.querySelector('[data-chart="' + id + '"] svg');
      const vals = fns.flatMap((f) => points.map(f)).filter((v) => v !== null && v !== undefined);
      const max = id === 'cpu' ? 100 : Math.max(1, ...vals) * 1.15;
      const x = (t) => 300 - ((now - t) / win) * 300, y = (v) => 88 - (v / max) * 84;
      const lines = fns.map((f, i) => {
        const pts = points.filter((p) => f(p) !== null && f(p) !== undefined).map((p) => x(p.t).toFixed(1) + ',' + y(f(p)).toFixed(1)).join(' ');
        return pts ? '<polyline class="s' + i + '" points="' + pts + '"/>' : '';
      }).join('');
      svg.innerHTML = [0.25, 0.5, 0.75].map((g) => '<line class="grid" x1="0" x2="300" y1="' + (88 - g * 84) + '" y2="' + (88 - g * 84) + '"/>').join('')
        + '<text class="ax" x="2" y="10">' + fmt(max) + '</text>' + lines;
      const lp = points[points.length - 1];
      $('v-' + id).textContent = lp ? fns.map((f) => fmt(f(lp))).join(' / ') : '–';
    }
  }
  function table() {
    const t = last && last[tab];
    if (!t || !t.rows.length) return void ($('table').innerHTML = '<div class="empty">' + (last ? (tab === 'waits' ? 'No waits since the previous sample.' : tab === 'running' ? 'No query is running right now (this monitor is not counted).' : 'Nothing to show.') : 'Waiting for the first sample…') + '</div>');
    const bi = t.columns.indexOf('blocked_by'), si = t.columns.indexOf('session_id');
    const kill = tab === 'sessions' || tab === 'running';
    const blockers = new Set(bi < 0 ? [] : t.rows.map((r) => r[bi]).filter((v) => v));
    $('table').innerHTML = '<table><thead><tr>' + (kill ? '<th></th>' : '') + t.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
      + t.rows.map((r) => '<tr' + (bi >= 0 && (r[bi] || blockers.has(r[si])) ? ' class="blk"' : '') + '>' + (kill ? '<td><button class="kill" data-id="' + esc(r[si]) + '">Kill</button></td>' : '')
        + r.map((v) => '<td title="' + esc(v) + '">' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
    document.querySelectorAll('.kill').forEach((b) => (b.onclick = () => vscode.postMessage({ type: 'kill', id: b.dataset.id })));
  }
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
    tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    table();
  }));
  $('interval').onchange = () => vscode.postMessage({ type: 'interval', ms: +$('interval').value });
  $('window').onchange = draw;
  $('pause').onclick = () => { paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; vscode.postMessage({ type: 'pause', paused }); };
  $('open').onclick = () => vscode.postMessage({ type: 'open', tab });
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'error') { $('status').className = 'err'; $('status').textContent = m.message; return; }
    if (m.type !== 'sample') return;
    $('status').className = ''; $('status').textContent = 'Updated ' + new Date(m.point.t).toLocaleTimeString();
    points.push(m.point); last = m; draw(); table();
  });
</script>
</body>
</html>`;
}

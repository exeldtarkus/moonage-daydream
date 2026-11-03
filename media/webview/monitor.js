  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let points = [], last, tab = 'running', paused = false;
  // grafik dari kit: id -> batas tetap (persen) atau skala otomatis; seri = point.values[id][i]
  const CHARTS = JSON.parse(document.getElementById('page-data').textContent);
  const fmt = (v) => (v === null || v === undefined ? '–' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString());
  function draw() {
    const win = +$('window').value * 60000, now = points.length ? points[points.length - 1].t : 0;
    points = points.filter((p) => p.t >= now - win);
    for (const [id, fixed] of Object.entries(CHARTS)) {
      const svg = document.querySelector('[data-chart="' + id + '"] svg');
      const n = Math.max(1, ...points.map((p) => (p.values[id] || []).length));
      const fns = Array.from({ length: n }, (_, i) => (p) => (p.values[id] || [])[i]);
      const vals = fns.flatMap((f) => points.map(f)).filter((v) => v !== null && v !== undefined);
      const max = fixed || Math.max(1, ...vals) * 1.15;
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
    const t = last && last.tables[tab];
    if (t && t.message) return void ($('table').innerHTML = '<div class="empty">' + esc(t.message) + '</div>');
    if (!t || !t.rows.length) return void ($('table').innerHTML = '<div class="empty">' + (last ? (tab === 'waits' ? 'No waits since the previous sample.' : tab === 'running' ? 'No query is running right now (this monitor is not counted).' : 'Nothing to show.') : 'Waiting for the first sample…') + '</div>');
    // kolom session id yang di-Kill per tab; Blocking = sesi pemblokir
    const KILL = { sessions: 'session_id', running: 'session_id', blocking: 'blocking_id' };
    const bi = t.columns.indexOf('blocked_by'), si = t.columns.indexOf(KILL[tab] || 'session_id');
    const kill = !!KILL[tab] && si >= 0;
    const blockers = new Set(bi < 0 ? [] : t.rows.map((r) => r[bi]).filter((v) => v));
    $('table').innerHTML = '<table><thead><tr>' + (kill ? '<th></th>' : '') + t.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>'
      + t.rows.map((r) => '<tr' + (bi >= 0 && (r[bi] || blockers.has(r[si])) ? ' class="blk"' : '') + '>' + (kill ? '<td><button class="kill" data-id="' + esc(r[si]) + '">' + (tab === 'blocking' ? 'Kill blocker' : 'Kill') + '</button></td>' : '')
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

const FORMAT_OPTIONS = JSON.parse(document.getElementById('page-data').textContent);
(() => {
  const vscode = acquireVsCodeApi();
  const menu = document.getElementById('menu');
  const state = new Map();
  const st = (t) => {
    if (!state.has(t)) {
      const tpl = t.nextElementSibling?.matches('template.vrows') ? t.nextElementSibling : null;
      const rows = tpl ? [...tpl.content.querySelectorAll('tr')] : [...t.tBodies[0].rows];
      state.set(t, { rows, view: rows, virtual: !!tpl, filters: {}, sort: null, hidden: new Set(), sel: new Set(), anchor: null });
    }
    return state.get(t);
  };
  /**
   * virtual scroll: hanya baris view (hasil filter / sort) di sekitar viewport yang dipasang di tbody, sisanya diganti spacer setinggi barisnya.
   * Baris lain tetap ada sebagai elemen terlepas (filter / sort / seleksi / edit / export tetap atas semua baris).
   */
  function render(t) {
    const s = st(t), body = t.tBodies[0];
    if (!s.virtual) { s.view.forEach((r) => body.appendChild(r)); return; }
    if (!s.top) {
      s.top = document.createElement('tr');
      s.top.className = 'vpad';
      s.top.innerHTML = '<td colspan="9999"></td>';
      s.bot = s.top.cloneNode(true);
    }
    const grid = t.closest('.grid'), h = s.rowH || 31;
    let from = Math.max(0, Math.floor((grid.scrollTop - t.tHead.offsetHeight) / h) - 40);
    from -= from % 2; // zebra (nth-child) tidak berganti saat scroll
    const to = Math.min(s.view.length, from + Math.ceil((grid.clientHeight || innerHeight) / h) + 80);
    s.top.firstChild.style.height = from * h + 'px';
    s.bot.firstChild.style.height = (s.view.length - to) * h + 'px';
    body.replaceChildren(s.top, ...s.view.slice(from, to), s.bot);
    if (!s.rowH && to > from) {
      s.rowH = s.view[from].getBoundingClientRect().height || h;
      if (s.rowH !== h) render(t);
    }
  }
  let scrolling = false;
  // scroll tidak bubble: tangkap di document lalu render tabel di .grid yang di-scroll (sekali per frame)
  document.addEventListener('scroll', (e) => {
    const t = e.target.classList?.contains('grid') && e.target.querySelector('table.rs');
    if (!t || !st(t).virtual || scrolling) return;
    scrolling = true;
    requestAnimationFrame(() => { scrolling = false; render(t); });
  }, true);
  document.querySelectorAll('table.rs').forEach((t) => st(t).virtual && render(t));
  const saved = vscode.getState() || {};
  /** baris terpilih (index asli) dalam urutan tampil sekarang */
  const selected = (t) => { const s = st(t); return s.rows.filter((r) => !r.hidden && s.sel.has(s.rows.indexOf(r))).map((r) => s.rows.indexOf(r)); };
  /** urutan kolom sekarang: index kolom asli per posisi (kolom bisa diurutkan ulang di panel Columns) */
  const order = (t) => [...t.tHead.rows[0].cells].slice(1).map((th) => +th.dataset.c);
  /** sel kolom asli c pada baris r (posisi bisa berubah setelah kolom dipindah) */
  const cellOf = (t, r, c) => r.cells[order(t).indexOf(c) + 1];
  const visibleCols = (t) => order(t).filter((c) => !st(t).hidden.has(c));
  /** pindahkan kolom asli c ke posisi (0-based) to: sel dipindah di header dan semua baris */
  function moveCol(t, c, to) {
    const from = order(t).indexOf(c);
    const n = order(t).length;
    to = Math.max(0, Math.min(n - 1, to));
    if (from < 0 || from === to) return;
    for (const r of [t.tHead.rows[0], ...st(t).rows]) {
      const cell = r.cells[from + 1];
      const ref = r.cells[to + (to > from ? 2 : 1)] ?? null;
      r.insertBefore(cell, ref);
    }
  }
  /** export / copy ke extension: baris terpilih (scope sel) atau semua data, kolom yang tidak disembunyikan */
  function send(t, type, format, scope, header) {
    const part = t.closest('section')?.dataset.part;
    vscode.postMessage({ type, format, scope, header, set: +t.dataset.set, part: part === undefined ? undefined : +part,
      rows: scope === 'sel' ? selected(t) : undefined, cols: visibleCols(t) });
  }
  /** Copy tidak tersedia untuk Excel (file biner) */
  function syncCopy() {
    const c = menu.querySelector('[data-a=xcopy]');
    if (c) c.disabled = document.getElementById('xf').value === 'xlsx';
  }
  function paintSel(t) { const s = st(t); s.rows.forEach((r, i) => r.classList.toggle('sel', s.sel.has(i))); }
  const text = (td) => (td.querySelector('.null') ? null : td.textContent);
  const match = (v, f) => (f.toLowerCase() === 'null' ? v === null : v !== null && v.toLowerCase().includes(f.toLowerCase()));
  function apply(t) {
    const s = st(t);
    let rows = s.rows.filter((r) => Object.entries(s.filters).every(([c, f]) => match(text(cellOf(t, r, +c)), f)));
    if (s.sort) {
      const { c, dir } = s.sort;
      const num = cellOf(t, t.tHead.rows[0], c).classList.contains('num');
      const key = (r) => text(cellOf(t, r, c));
      rows = [...rows].sort((a, b) => {
        const x = key(a), y = key(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // (null) selalu di bawah
        return dir * (num ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true }));
      });
    }
    s.rows.forEach((r) => (r.hidden = true));
    rows.forEach((r, i) => { r.hidden = false; r.cells[0].textContent = String(i + 1); });
    s.view = rows;
    render(t);
    const ord = order(t);
    for (const r of [t.tHead.rows[0], ...s.rows, ...(t.tBodies[1]?.rows ?? [])]) [...r.cells].forEach((td, i) => (td.hidden = i > 0 && s.hidden.has(ord[i - 1])));
    t.tHead.querySelectorAll('.fbtn').forEach((b) => b.classList.toggle('on', b.dataset.c in s.filters));
    t.tHead.querySelectorAll('.mbtn').forEach((b) => b.classList.toggle('on', s.sort?.c === +b.dataset.c));
    const count = t.closest('.grid').nextElementSibling.querySelector('.count');
    const filtered = rows.length !== s.rows.length;
    count.textContent = filtered ? rows.length + ' / ' + count.dataset.total + ' (filtered)' : count.dataset.total;
    if (pane === 'cols' && !document.activeElement?.matches?.('#colq')) renderSide();
  }
  /** popup di bawah tombol; tidak muat -> di atas tombol; tetap dalam layar (diukur setelah isi + class terpasang) */
  function open(btn, html, init, cls) {
    menu.className = 'menu' + (cls ? ' ' + cls : '');
    menu.innerHTML = html;
    menu.hidden = false;
    init?.();
    const r = btn.getBoundingClientRect();
    menu.style.maxHeight = innerHeight - 8 + 'px';
    const h = menu.offsetHeight, w = menu.offsetWidth;
    menu.style.left = Math.max(4, Math.min(r.left, innerWidth - w - 4)) + 'px';
    const top = r.bottom + 2 + h <= innerHeight ? r.bottom + 2 : r.top - h - 2;
    menu.style.top = Math.max(4, Math.min(top, innerHeight - h - 4)) + 'px';
  }
  // Shift+klik memperluas seleksi baris, bukan blok teks
  document.addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('tbody td')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    const tb = e.target.closest('table.rs');
    if (tb) active = tb;
    const go = e.target.closest('[data-goto]');
    if (go) { cellOf(tableOf(), tableOf().tHead.rows[0], +go.dataset.goto).scrollIntoView({ block: 'nearest', inline: 'center' }); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const t = tableOf(), c = +mv.dataset.c;
      moveCol(t, c, order(t).indexOf(c) + +mv.dataset.move);
      apply(t);
      renderSide();
      return;
    }
    const td = e.target.closest('tbody td');
    if (td && td.closest('table.rs')) {
      // pilih baris: klik = satu baris, Ctrl/Cmd+klik = tambah / kurangi, Shift+klik = rentang dari baris terakhir
      const t = td.closest('table'), s = st(t), tr = td.parentElement, i = s.rows.indexOf(tr);
      if (!td.classList.contains('n')) { s.cur?.classList.remove('cur'); td.classList.add('cur'); s.cur = td; }
      const visible = s.rows.filter((r) => !r.hidden);
      if (e.shiftKey && s.anchor !== null) {
        const a = visible.indexOf(s.rows[s.anchor]), z = visible.indexOf(tr);
        if (!(e.ctrlKey || e.metaKey)) s.sel.clear();
        visible.slice(Math.min(a, z), Math.max(a, z) + 1).forEach((r) => s.sel.add(s.rows.indexOf(r)));
      } else if (e.ctrlKey || e.metaKey) {
        s.sel.has(i) ? s.sel.delete(i) : s.sel.add(i);
        s.anchor = i;
      } else {
        s.sel = new Set([i]);
        s.anchor = i;
      }
      paintSel(t);
      if (pane === 'insp') renderSide();
      return;
    }
    const b = e.target.closest('button');
    if (!b) { if (!menu.contains(e.target)) menu.hidden = true; return; }
    if (b.dataset.pane) { openPane(b.dataset.pane); return; }
    if (b.classList.contains('sideclose')) { openPane(pane); return; }
    if (b.dataset.a === 'colsall' || b.dataset.a === 'colsnone') {
      const t = tableOf(), s = st(t);
      s.hidden = b.dataset.a === 'colsall' ? new Set() : new Set(order(t).slice(1)); // sisakan kolom pertama
      apply(t);
      renderSide();
      return;
    }
    const th = b.closest('th');
    if (b.classList.contains('xmlbtn')) { vscode.postMessage({ type: 'planXml' }); return; }
    if (b.classList.contains('pinbtn')) { vscode.postMessage({ type: 'pin' }); return; }
    if (b.classList.contains('addrow')) { addRow(b.closest('.foot').previousElementSibling.querySelector('table')); return; }
    if (b.classList.contains('delrow')) { markDelete(b.closest('.foot').previousElementSibling.querySelector('table')); return; }
    if (b.classList.contains('save')) {
      const t = b.closest('.foot').previousElementSibling.querySelector('table'), s = st(t);
      const edits = [...(s.edits ?? [])].map(([k, value]) => { const [row, col] = k.split(':').map(Number); return { row, col, value }; });
      const inserts = newRows(t).map((tr) => { const v = []; tr.querySelectorAll('input.cell').forEach((i) => { v[+i.dataset.c] = i.value; }); return Array.from(v, (x) => x ?? ''); });
      const part = t.closest('section')?.dataset.part;
      vscode.postMessage({ type: 'saveGrid', set: +t.dataset.set, part: part === undefined ? undefined : +part, edits, deletes: [...(s.deletes ?? [])], inserts });
      return;
    }
    if (b.classList.contains('genupd') || b.classList.contains('discard')) {
      const t = b.closest('.foot').previousElementSibling.querySelector('table'), s = st(t);
      if (b.classList.contains('genupd')) {
        const edits = [...(s.edits ?? [])].map(([k, value]) => { const [row, col] = k.split(':').map(Number); return { row, col, value }; });
        const part = t.closest('section')?.dataset.part;
        vscode.postMessage({ type: 'edits', set: +t.dataset.set, part: part === undefined ? undefined : +part, edits });
      } else {
        st(t).rows.flatMap((r) => [...r.querySelectorAll('td.edited')]).forEach((td) => { showCell(td, JSON.parse(td.dataset.orig)); td.classList.remove('edited'); });
        s.edits?.clear(); // belum ada edit sel (hanya Delete rows / Add row): map belum dibuat
        s.deletes?.clear();
        st(t).rows.forEach((r) => r.classList.remove('todelete'));
        t.tBodies[1]?.remove();
        syncEdits(t);
      }
      return;
    }
    if (b.classList.contains('morebtn')) {
      const t = b.closest('.foot').previousElementSibling.querySelector('table');
      const part = t.closest('section')?.dataset.part;
      b.disabled = true;
      b.textContent = 'Loading…';
      vscode.postMessage({ type: 'more', set: +t.dataset.set, part: part === undefined ? undefined : +part });
      return;
    }
    if (b.classList.contains('xbtn')) {
      e.stopPropagation();
      const t = b.closest('.foot').previousElementSibling.querySelector('table');
      const n = selected(t).length;
      menu.table = t;
      open(b, '<label>Export</label><select id="xs"><option value="all">All Data</option><option value="sel"' + (n ? '' : ' disabled') + '>Current Selection (' + n + ' rows)</option></select>'
        + '<label>Format</label><select id="xf">' + FORMAT_OPTIONS + '</select>'
        + '<div class="acts"><button data-a="xsave" class="primary">Save</button><button data-a="xcopy" class="second" title="Copy to clipboard">Copy</button></div>', () => {
        document.getElementById('xs').value = n ? 'sel' : 'all';
        if (saved.format) document.getElementById('xf').value = saved.format;
        syncCopy();
      }, 'export');
      return;
    }
    if (b.classList.contains('fbtn') || b.classList.contains('mbtn')) {
      e.stopPropagation();
      const t = th.closest('table');
      const c = +b.dataset.c;
      const s = st(t);
      menu.table = t; menu.col = c;
      if (b.classList.contains('fbtn')) {
        open(b, '<input id="f" placeholder="contains…  (null = empty)" value="' + (s.filters[c] ?? '').replace(/"/g, '&quot;') + '"><hr><button data-a="clearf">Clear filter</button>', () => document.getElementById('f').focus());
      } else {
        open(b, '<button data-a="asc">Sort ascending</button><button data-a="desc">Sort descending</button><button data-a="nosort">Clear sort</button><hr>'
          + '<button data-a="hide">Hide column</button>' + (s.hidden.size ? '<button data-a="showall">Show all columns (' + s.hidden.size + ' hidden)</button>' : ''));
      }
      return;
    }
    if (menu.contains(b)) {
      const t = menu.table, c = menu.col, s = st(t);
      const a = b.dataset.a;
      if (a === 'xsave' || a === 'xcopy') {
        const format = document.getElementById('xf').value, scope = document.getElementById('xs').value;
        saved.format = format;
        vscode.setState(saved);
        send(t, a === 'xsave' ? 'export' : 'copy', format, scope);
        menu.hidden = true;
        return;
      }
      if (a === 'asc' || a === 'desc') s.sort = { c, dir: a === 'asc' ? 1 : -1 };
      if (a === 'nosort') s.sort = null;
      if (a === 'hide') s.hidden.add(c);
      if (a === 'showall') s.hidden.clear();
      if (a === 'clearf') delete s.filters[c];
      menu.hidden = true;
      apply(t);
      return;
    }
    if (b.classList.contains('clear')) {
      const form = b.closest('form');
      form.where.value = '';
      form.requestSubmit();
    }
  });
  // panel samping: Columns (tampil / sembunyi, cari, lompat ke kolom) dan Inspector (detail baris terpilih)
  const side = document.getElementById('side');
  let pane = null, active = null;
  const tableOf = () => (active && document.contains(active) ? active : document.querySelector('table.rs'));
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function renderSide() {
    if (!side || side.hidden) return;
    const t = tableOf();
    const body = document.getElementById('sidebody');
    document.getElementById('sidetitle').textContent = pane === 'cols' ? 'Columns' : 'Inspector';
    if (!t) { body.innerHTML = '<div class="hint">No result</div>'; return; }
    const s = st(t);
    const heads = [...t.tHead.rows[0].cells].slice(1);
    if (pane === 'cols') {
      const q = document.getElementById('colq')?.value ?? '';
      body.innerHTML = '<input type="search" id="colq" placeholder="Search columns…" value="' + esc(q) + '">'
        + '<div class="acts2"><button data-a="colsall">Show all</button><button data-a="colsnone">Hide all</button></div>'
        + heads.map((h) => {
          const c = +h.dataset.c;
          return h.dataset.name.toLowerCase().includes(q.toLowerCase())
            ? '<div class="col" draggable="true" data-c="' + c + '"><input type="checkbox" data-col="' + c + '"' + (s.hidden.has(c) ? '' : ' checked') + '><a data-goto="' + c + '">' + esc(h.dataset.name) + '</a><span class="t">' + esc(h.dataset.type) + '</span>'
              + '<button class="mv" data-move="-1" data-c="' + c + '" title="Move left">↑</button><button class="mv" data-move="1" data-c="' + c + '" title="Move right">↓</button></div>' : '';
        }).join('');
      const qi = document.getElementById('colq');
      if (q) { qi.focus(); qi.setSelectionRange(q.length, q.length); }
    } else {
      const i = s.anchor;
      const r = i === null ? null : s.rows[i];
      body.innerHTML = !r ? '<div class="hint">Select a row to inspect it.</div>'
        : '<div class="hint">Row ' + r.cells[0].textContent + '</div>' + heads.map((h, c) => {
          const td = r.cells[c + 1];
          const v = text(td);
          return '<div class="kv"><div class="k">' + esc(h.dataset.name) + ' <span class="t">' + esc(h.dataset.type) + '</span></div><div class="v' + (v === null ? ' null' : '') + '">' + (v === null ? '(null)' : esc(v)) + '</div></div>';
        }).join('');
    }
  }
  function openPane(p) {
    const same = pane === p && !side.hidden;
    pane = p;
    side.hidden = same;
    document.body.classList.toggle('side-open', !same);
    document.querySelectorAll('.sidetabs button').forEach((b) => b.classList.toggle('on', !same && b.dataset.pane === p));
    renderSide();
  }
  // edit sel (double-click): disimpan di state, script UPDATE dibuat extension; tidak ada yang dijalankan otomatis
  const editKey = (r, c) => r + ':' + c;
  const showCell = (td, v) => { td.innerHTML = v === null ? '<span class="null">(null)</span>' : esc(v); };
  function syncEdits(t) {
    const s = st(t);
    const bar = t.closest('.grid').nextElementSibling.querySelector('.editbar');
    if (!bar) return;
    const n = (s.edits?.size ?? 0) + (s.deletes?.size ?? 0) + newRows(t).length;
    bar.querySelector('.pend').hidden = !n;
    bar.querySelector('.ecount').textContent = String(n);
  }
  const newRows = (t) => [...(t.tBodies[1]?.rows ?? [])];
  /** baris baru di tbody terpisah (tidak ikut filter / sort); sel per kolom hasil, kosong = default server, NULL = NULL */
  function addRow(t) {
    const s = st(t);
    const nb = t.tBodies[1] ?? Object.assign(t.appendChild(document.createElement('tbody')), { className: 'newrows' });
    const tr = nb.insertRow();
    tr.insertCell().textContent = '+';
    tr.cells[0].className = 'n';
    for (const c of order(t)) {
      const td = tr.insertCell();
      td.hidden = s.hidden.has(c);
      // kolom generated (computed / identity): diisi server, tidak bisa diketik
      td.innerHTML = t.tHead.querySelector('th[data-c="' + c + '"]')?.dataset.gen ? '<input class="cell" data-c="' + c + '" placeholder="generated" disabled>'
        : '<input class="cell" spellcheck="false" data-c="' + c + '" placeholder="default">';
    }
    tr.querySelector('input.cell:not([hidden])')?.focus();
    syncEdits(t);
  }
  /** baris terpilih ditandai hapus (dicoret); tandai lagi = batal */
  function markDelete(t) {
    const s = st(t);
    s.deletes ??= new Set();
    const sel = selected(t);
    const all = sel.length && sel.every((r) => s.deletes.has(r));
    for (const r of sel) { if (all) s.deletes.delete(r); else s.deletes.add(r); s.rows[r].classList.toggle('todelete', !all); }
    syncEdits(t);
  }
  document.addEventListener('input', (e) => { const t = e.target.closest?.('tbody.newrows')?.closest('table'); if (t) syncEdits(t); });
  function commitCell(td, input, keep) {
    const t = td.closest('table'), s = st(t), tr = td.parentElement;
    const r = s.rows.indexOf(tr), c = order(t)[[...tr.cells].indexOf(td) - 1]; // index kolom asli (kolom bisa dipindah)
    const orig = JSON.parse(td.dataset.orig);
    const v = !keep ? orig : input.value === 'NULL' ? null : input.value;
    s.edits ??= new Map();
    if (v === orig) s.edits.delete(editKey(r, c)); else s.edits.set(editKey(r, c), v);
    td.classList.toggle('edited', s.edits.has(editKey(r, c)));
    showCell(td, v);
    syncEdits(t);
  }
  document.addEventListener('dblclick', (e) => {
    const td = e.target.closest('tbody td');
    const t = td?.closest('table[data-edit]');
    if (!td || !t || td.classList.contains('n') || td.querySelector('input')) return;
    if (t.tHead.rows[0].cells[td.cellIndex]?.dataset.gen) return; // kolom generated: tidak bisa diedit
    td.dataset.orig ??= JSON.stringify(text(td));
    const cur = text(td);
    td.innerHTML = '<input class="cell" spellcheck="false">';
    const input = td.firstChild;
    input.value = cur === null ? 'NULL' : cur;
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => { if (!done) { done = true; commitCell(td, input, keep); } };
    input.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') { k.preventDefault(); finish(true); }
      if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); done = true; showCell(td, cur); } // done dulu: hapus input memicu blur
    });
    input.addEventListener('blur', () => finish(true));
  });
  // drag kolom di panel Columns: lepas di atas kolom lain -> pindah ke posisi itu
  let dragCol = null;
  document.addEventListener('dragstart', (e) => { const el = e.target.closest?.('#side .col'); if (el) { dragCol = +el.dataset.c; e.dataTransfer.effectAllowed = 'move'; } });
  document.addEventListener('dragover', (e) => { if (dragCol !== null && e.target.closest?.('#side .col')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    const el = e.target.closest?.('#side .col');
    if (dragCol === null || !el) return;
    e.preventDefault();
    const t = tableOf();
    moveCol(t, dragCol, order(t).indexOf(+el.dataset.c));
    dragCol = null;
    apply(t);
    renderSide();
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'xf') syncCopy();
    if (e.target.dataset?.col !== undefined) {
      const t = tableOf(), s = st(t), c = +e.target.dataset.col;
      e.target.checked ? s.hidden.delete(c) : s.hidden.add(c);
      apply(t);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'colq') { renderSide(); return; }
    if (e.target.id !== 'f') return;
    const s = st(menu.table);
    if (e.target.value) s.filters[menu.col] = e.target.value; else delete s.filters[menu.col];
    apply(menu.table);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && e.target.id === 'f')) menu.hidden = true;
    // Ctrl/Cmd+C: baris terpilih sebagai TSV tanpa header (paste langsung ke spreadsheet); tidak saat mengetik di input
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.target.closest('input, select, textarea') && !String(getSelection())) {
      const t = [...document.querySelectorAll('table.rs')].find((x) => selected(x).length);
      if (!t) return;
      e.preventDefault();
      send(t, 'copy', 'tsv', 'sel', false);
    }
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    vscode.postMessage({ type: 'where', where: f.where.value, part: f.dataset.part === undefined ? undefined : +f.dataset.part });
  });
})();

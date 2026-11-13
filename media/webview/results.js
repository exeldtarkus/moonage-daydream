const FORMAT_OPTIONS = JSON.parse(document.getElementById('page-data').textContent);
(() => {
  const vscode = acquireVsCodeApi();
  const menu = document.getElementById('menu');
  const state = new Map();
  /**
   * state grid per tabel: data = baris (teks / null) dari JSON, view = index baris setelah filter / sort,
   * order = urutan kolom asli per posisi, edits 'baris:kolom' -> nilai baru, deletes / sel = index baris asli.
   */
  /**
   * mode cache (Load all, table[data-cache]): baris ada di extension host; c.pages = halaman PG baris [nomor asli, ...nilai] yang
   * sudah diterima, rmap / pos = nilai dan posisi tampil per nomor baris asli, gen = versi tampilan (balasan lama diabaikan).
   * Search / filter / sort dihitung host (cview), webview hanya menggambar baris di sekitar viewport.
   */
  const PG = 200;
  /** jumlah baris dengan titik pemisah ribuan (sama dengan fmtCount di resultsHtml.ts) */
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const st = (t) => {
    if (!state.has(t)) {
      const heads = [...t.tHead.rows[0].cells].slice(1);
      const data = JSON.parse(t.nextElementSibling.textContent);
      const cs = t.dataset.cache ? JSON.parse(t.dataset.cache) : null;
      state.set(t, { data, view: data.map((_, i) => i), order: heads.map((th) => +th.dataset.c), num: heads.map((th) => th.classList.contains('num')),
        filters: cs ? cs.filters : {}, sort: cs ? cs.sort : null, keys: cs ? cs.keys : [], hidden: new Set(), sel: new Set(), anchor: null, cur: null, edits: new Map(), deletes: new Set(),
        c: cs && { count: cs.count, total: cs.total, partial: cs.partial, loading: cs.loading, gen: 0, pages: new Map(), rmap: new Map(), pos: new Map(), req: new Set() } });
    }
    return state.get(t);
  };
  /** batas nilai "panjang": dipotong di grid dan punya popup double-click */
  const PEEK_MIN = 60;
  const editKey = (r, c) => r + ':' + c;
  /** nilai sel yang tampil: hasil edit bila ada, selain itu data asli (mode cache: halaman yang sudah diterima) */
  const val = (s, r, c) => (s.c ? (s.c.rmap.get(r)?.[c] ?? null) : s.edits.has(editKey(r, c)) ? s.edits.get(editKey(r, c)) : s.data[r][c]);
  /** jumlah baris tampil, posisi tampil nomor baris asli, nomor baris asli di posisi p (mode cache: hanya halaman yang sudah ada) */
  const viewLen = (s) => (s.c ? s.c.count : s.view.length);
  const posOf = (s, r) => (s.c ? s.c.pos.get(r) ?? -1 : s.view.indexOf(r));
  const rAt = (s, p) => (s.c ? s.c.pages.get(Math.floor(p / PG))?.[p % PG]?.[0] : s.view[p]);
  /** key Search Output: "teks" = sama persis, null = sel NULL, selain itu mengandung (tidak peka huruf besar / kecil); sama dengan host */
  const parseKeys = (ks) => ks.map((k) => k.trim()).filter(Boolean).map((k) => (k.length >= 2 && k[0] === '"' && k.endsWith('"') ? { e: k.slice(1, -1) }
    : k.toLowerCase() === 'null' ? { n: 1 } : { c: k.toLowerCase() }));
  const keyHit = (v, k) => (k.n ? v === null : v === null ? false : k.e !== undefined ? v === k.e : v.toLowerCase().includes(k.c));
  const ids = (t) => { const part = t.closest('section')?.dataset.part; return { set: +t.dataset.set, part: part === undefined ? undefined : +part }; };
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** nilai panjang dibungkus .cv supaya kolomnya tidak melebar (dipotong ellipsis); nilai penuh: double-click / Inspector */
  const cellHtml = (v) => (v === null ? '<span class="null">(null)</span>' : v.length > PEEK_MIN ? '<span class="cv">' + esc(v) + '</span>' : esc(v));
  function rowHtml(s, r, pos) {
    const cls = (s.sel.has(r) ? ' sel' : '') + (s.deletes.has(r) ? ' todelete' : '');
    return '<tr data-r="' + r + '"' + (cls ? ' class="' + cls.trim() + '"' : '') + '><td class="n">' + (pos + 1) + '</td>' + s.order.map((c) => {
      const k = editKey(r, c), v = val(s, r, c);
      const hit = s.pk?.length && !s.hidden.has(c) && s.pk.some((x) => keyHit(v, x)); // sel yang cocok dengan key Search Output
      const tc = [s.num[c] && 'num', s.edits.has(k) && 'edited', s.cur === k && 'cur', hit && 'hit'].filter(Boolean).join(' ');
      return '<td' + (tc ? ' class="' + tc + '"' : '') + (s.hidden.has(c) ? ' hidden' : '') + '>' + cellHtml(v) + '</td>';
    }).join('') + '</tr>';
  }
  /** baris mode cache yang halamannya belum datang: nomor saja, halaman diminta ke host sekali */
  function phRow(t, s, p) {
    const pg = Math.floor(p / PG);
    if (!s.c.req.has(pg)) {
      s.c.req.add(pg);
      vscode.postMessage({ type: 'cpage', ...ids(t), start: pg * PG, count: PG, gen: s.c.gen });
    }
    return '<tr class="ph"><td class="n">' + (p + 1) + '</td><td colspan="' + s.order.length + '">…</td></tr>';
  }
  /** tinggi scroll maksimal: elemen lebih tinggi dari ±33 juta px tidak digambar browser, 5 juta baris diskalakan */
  const MAXH = 15e6;
  /** geometri virtual scroll: first = posisi baris di atas viewport; scaled = tinggi baris dipadatkan supaya muat MAXH */
  function geo(t) {
    const s = st(t), grid = t.closest('.grid'), h = s.rowH || 31, n = viewLen(s);
    const vh = grid.clientHeight || innerHeight, vis = Math.ceil(vh / h), full = n * h, H = Math.min(full, MAXH);
    const top = Math.max(0, grid.scrollTop - t.tHead.offsetHeight);
    const first = full <= MAXH ? Math.floor(top / h) : Math.floor((top / Math.max(1, H - vh)) * Math.max(0, n - vis));
    return { s, grid, h, n, vh, vis, full, H, top, first: Math.min(first, Math.max(0, n - 1)) };
  }
  /** gulir grid supaya baris posisi p ada di atas */
  function scrollToPos(t, p) {
    const g = geo(t);
    // +0.5 baris: pembulatan ke bawah di geo() tetap jatuh di baris p
    g.grid.scrollTop = t.tHead.offsetHeight + (g.full <= MAXH ? p * g.h : ((p + 0.5) / Math.max(1, g.n - g.vis)) * (g.H - g.vh));
  }
  /**
   * virtual scroll: hanya baris view di sekitar viewport yang dibuat sebagai DOM dari data, sisanya diganti spacer setinggi barisnya
   * (filter / sort / seleksi / edit / export tetap atas semua baris di data; mode cache: baris diminta per halaman ke host).
   */
  function render(t) {
    const { s, h, n, vis, full, H, top, first } = geo(t), body = t.tBodies[0];
    let from = Math.max(0, first - 40);
    from -= from % 2; // zebra (nth-child) tidak berganti saat scroll
    const to = Math.min(n, first + vis + 80);
    const padTop = full <= MAXH ? from * h : Math.max(0, top - (first - from) * h);
    const pad = (px) => '<tr class="vpad"><td colspan="9999" style="height:' + px + 'px"></td></tr>';
    let rows = '';
    for (let p = from; p < to; p++) {
      const r = rAt(s, p);
      rows += r === undefined ? phRow(t, s, p) : rowHtml(s, r, p);
    }
    body.innerHTML = pad(padTop) + rows + pad(Math.max(0, H - padTop - (to - from) * h));
    if (!s.rowH && to > from && body.rows[1]) {
      s.rowH = body.rows[1].getBoundingClientRect().height || h;
      if (s.rowH !== h) render(t);
    }
    syncPager(t, first);
    // pemisah pertama di toolbar dibuat sampai garis kolom nomor baris (hitung dari posisi, bukan lebar sel: border toolbar ikut)
    const bar = t.closest('.blk')?.querySelector('.rbar');
    const ncol = bar && t.tHead.rows[0].cells[0].getBoundingClientRect().right - bar.getBoundingClientRect().left - 1;
    if (ncol > 0) bar.style.setProperty('--ncol', ncol + 'px');
  }
  /** pager di footer: halaman dari baris paling atas; ukuran halaman disimpan per webview */
  function syncPager(t, first) {
    const foot = t.closest('.grid').nextElementSibling, size = +(saved.psize || 500), n = viewLen(st(t));
    const pages = Math.max(1, Math.ceil(n / size)), cur = Math.min(pages, Math.floor(first / size) + 1);
    foot.querySelector('.pcount').textContent = fmt(pages);
    const inp = foot.querySelector('.pnum');
    inp.max = pages;
    if (document.activeElement !== inp) inp.value = cur;
    foot.querySelector('.psize').value = String(size);
  }
  let scrolling = false;
  // scroll tidak bubble: tangkap di document lalu render tabel di .grid yang di-scroll (sekali per frame)
  document.addEventListener('scroll', (e) => {
    const t = e.target.classList?.contains('grid') && e.target.querySelector('table.rs');
    if (!t || scrolling) return;
    scrolling = true;
    requestAnimationFrame(() => {
      scrolling = false;
      // sel yang sedang diedit disimpan dulu sebelum barisnya diganti
      if (document.activeElement?.matches('table.rs tbody:first-of-type input.cell')) document.activeElement.blur();
      render(t);
    });
  }, true);
  const saved = vscode.getState() || {};
  document.querySelectorAll('table.rs').forEach((t) => { const s = st(t); s.pk = parseKeys(s.keys); render(t); renderChips(t); syncCount(t); });
  /** baris terpilih (index asli) dalam urutan tampil sekarang (mode cache: posisi yang belum diketahui di akhir) */
  const selected = (t) => {
    const s = st(t);
    if (!s.c) return s.view.filter((r) => s.sel.has(r));
    const p = (r) => { const x = posOf(s, r); return x < 0 ? Infinity : x; };
    return [...s.sel].sort((a, b) => p(a) - p(b));
  };
  /** urutan kolom sekarang: index kolom asli per posisi (kolom bisa diurutkan ulang di panel Columns) */
  const order = (t) => st(t).order;
  const headOf = (t, c) => t.tHead.querySelector('th[data-c="' + c + '"]');
  const visibleCols = (t) => order(t).filter((c) => !st(t).hidden.has(c));
  /** pindahkan kolom asli c ke posisi (0-based) to: urutan state, header dan baris baru (Add row); baris data digambar ulang */
  function moveCol(t, c, to) {
    const ord = order(t), from = ord.indexOf(c);
    to = Math.max(0, Math.min(ord.length - 1, to));
    if (from < 0 || from === to) return;
    for (const r of [t.tHead.rows[0], ...newRows(t)]) r.insertBefore(r.cells[from + 1], r.cells[to + (to > from ? 2 : 1)] ?? null);
    ord.splice(to, 0, ...ord.splice(from, 1));
  }
  /** export / copy ke extension: baris terpilih (scope sel) atau semua data, kolom yang tidak disembunyikan */
  function send(t, type, format, scope, header) {
    vscode.postMessage({ type, format, scope, header, ...ids(t), rows: scope === 'sel' ? selected(t) : undefined, cols: visibleCols(t) });
  }
  /** Copy tidak tersedia untuk Excel (file biner) */
  function syncCopy() {
    const c = document.querySelector('[data-a=xcopy]');
    if (c) c.disabled = document.getElementById('xf').value === 'xlsx';
  }
  /** tandai baris terpilih di DOM tanpa menggambar ulang (gambar ulang di tengah klik merusak double-click edit) */
  function paintSel(t) { const s = st(t); for (const tr of t.tBodies[0].rows) if (tr.dataset.r) tr.classList.toggle('sel', s.sel.has(+tr.dataset.r)); }
  const match = (v, f) => (f.toLowerCase() === 'null' ? v === null : v !== null && v.toLowerCase().includes(f.toLowerCase()));
  /** jumlah baris di footer + teks "N of M rows" Search Output */
  function syncCount(t) {
    const s = st(t), blk = t.closest('.blk');
    const count = t.closest('.grid').nextElementSibling.querySelector('.count');
    const n = viewLen(s), total = s.c ? s.c.total : s.data.length;
    const filtered = s.keys.length || Object.keys(s.filters).length;
    count.textContent = s.c ? fmt(n) + (filtered ? ' / ' + fmt(total) + ' (filtered)' : '')
      : filtered ? fmt(n) + ' / ' + fmt(count.dataset.total) + ' (filtered)' : fmt(count.dataset.total);
    blk.querySelector('.smatch').textContent = filtered
      ? fmt(n) + ' of ' + (s.c?.partial ? 'the first ' : '') + fmt(total) + ' rows' + (s.c ? '' : ' (loaded)') : '';
  }
  /** chip Search Output dari s.keys; mode cache saat Load all berjalan: input nonaktif */
  function renderChips(t) {
    const s = st(t), box = t.closest('.blk').querySelector('.sout .chips'), inp = box.querySelector('.skey');
    box.querySelectorAll('.chip').forEach((c) => c.remove());
    s.keys.forEach((k, i) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.i = i;
      b.setAttribute('aria-label', 'Remove search key ' + k);
      b.textContent = k + ' ×';
      box.insertBefore(b, inp);
    });
    t.closest('.blk').querySelector('.sclear').hidden = !s.keys.length;
    inp.disabled = !!s.c?.loading;
    inp.title = s.c?.loading ? 'Search, filter and sort are available when loading finishes (or after Cancel)' : '';
  }
  /** mode cache: minta host menghitung ulang tampilan (search / filter / kolom tampil / sort); balasan cview */
  function requestView(t) {
    const s = st(t);
    if (s.c.loading) return;
    s.c.gen++;
    vscode.postMessage({ type: 'cview', ...ids(t), keys: s.keys, filters: s.filters, cols: visibleCols(t), sort: s.sort, gen: s.c.gen });
  }
  function apply(t) {
    const s = st(t);
    s.pk = parseKeys(s.keys);
    if (s.c) {
      requestView(t);
      const ord = order(t);
      for (const r of [t.tHead.rows[0]]) [...r.cells].forEach((td, i) => (td.hidden = i > 0 && s.hidden.has(ord[i - 1])));
      render(t);
      syncHead(t);
      return;
    }
    const cols = visibleCols(t);
    let rows = s.data.map((_, i) => i).filter((r) => Object.entries(s.filters).every(([c, f]) => match(val(s, r, +c), f))
      && (!s.pk.length || cols.some((c) => s.pk.some((k) => keyHit(val(s, r, c), k)))));
    if (s.sort) {
      const { c, dir } = s.sort;
      const num = s.num[c];
      const key = (r) => val(s, r, c);
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // (null) selalu di bawah
        return dir * (num ? Number(x) - Number(y) : x.localeCompare(y, undefined, { numeric: true }));
      });
    }
    s.view = rows;
    const ord = order(t);
    for (const r of [t.tHead.rows[0], ...newRows(t)]) [...r.cells].forEach((td, i) => (td.hidden = i > 0 && s.hidden.has(ord[i - 1])));
    render(t);
    syncHead(t);
    syncCount(t);
  }
  /** tanda filter / sort aktif di header + panel Columns */
  function syncHead(t) {
    const s = st(t);
    t.tHead.querySelectorAll('.fbtn').forEach((b) => b.classList.toggle('on', b.dataset.c in s.filters));
    t.tHead.querySelectorAll('.mbtn').forEach((b) => b.classList.toggle('on', s.sort?.c === +b.dataset.c));
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
  /** hanya satu isian aktif di toolbar: membuka WHERE menutup Search Output, dan sebaliknya */
  function closeField(blk, sel) {
    const el = blk?.querySelector(sel);
    if (!el || el.hidden) return;
    if (sel === '.sout') openSearch(blk, 'toggle'); else openWhere(blk, 'toggle');
  }
  /** Search Output disembunyikan sampai dibuka lewat ikon search atau Ctrl+F; menutupnya juga membuang key supaya tidak ada filter tersembunyi */
  function openSearch(blk, mode) {
    const sout = blk?.querySelector('.sout');
    if (!sout) return;
    const close = mode === 'toggle' && !sout.hidden;
    if (!close) closeField(blk, 'form.where');
    sout.hidden = close;
    blk.querySelector('.searchbtn')?.classList.toggle('on', !close);
    const t = blk.querySelector('table.rs');
    if (!close) return void sout.querySelector('.skey').focus();
    const s = t && st(t);
    if (s && s.keys.length) { s.keys = []; renderChips(t); apply(t); }
  }
  /** filter WHERE: tersembunyi sampai ikon diklik; ikon tetap menyala selama filternya terisi */
  function openWhere(blk, mode) {
    const form = blk?.querySelector('form.where');
    if (!form) return;
    const close = mode === 'toggle' && !form.hidden;
    if (!close) closeField(blk, '.sout');
    form.hidden = close;
    blk.querySelector('.wherebtn')?.classList.toggle('on', !close || !!form.where.value);
    if (!close) form.where.focus();
  }
  // Ctrl / Cmd + F di panel hasil: buka Search Output hasil yang sedang dilihat (bukan Find bawaan webview)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      const t = tableOf();
      if (!t) return;
      e.preventDefault();
      openSearch(t.closest('.blk'), 'open');
    }
  });
  // Shift+klik memperluas seleksi baris, bukan blok teks
  document.addEventListener('mousedown', (e) => { if (e.shiftKey && e.target.closest('tbody td')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    const tb = e.target.closest('table.rs');
    if (tb) {
      const moved = tb !== active;
      active = tb;
      if (moved && side && !side.hidden) renderSide(); // panel samping selalu mengikuti hasil yang disentuh
    }
    const go = e.target.closest('[data-goto]');
    if (go) { headOf(tableOf(), +go.dataset.goto).scrollIntoView({ block: 'nearest', inline: 'center' }); return; }
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
      const t = td.closest('table'), s = st(t), tr = td.parentElement;
      if (!tr.dataset.r) return; // baris baru (Add row) / spacer
      const i = +tr.dataset.r;
      if (!td.classList.contains('n')) { t.tBodies[0].querySelector('td.cur')?.classList.remove('cur'); td.classList.add('cur'); s.cur = editKey(i, order(t)[td.cellIndex - 1]); }
      if (e.shiftKey && s.anchor !== null) {
        const a = posOf(s, s.anchor), z = posOf(s, i);
        if (!(e.ctrlKey || e.metaKey)) s.sel.clear();
        // shortcut: mode cache hanya memilih baris dari halaman yang sudah diterima; rentang sangat jauh perlu host bila dibutuhkan
        if (a >= 0) for (let p = Math.min(a, z); p <= Math.max(a, z); p++) { const r = rAt(s, p); if (r !== undefined) s.sel.add(r); }
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
    const blkTable = () => b.closest('.blk')?.querySelector('table.rs');
    if (b.classList.contains('chip') || b.classList.contains('sclear')) {
      const t = blkTable(), s = st(t);
      if (b.classList.contains('chip')) s.keys.splice(+b.dataset.i, 1); else s.keys = [];
      renderChips(t);
      apply(t);
      t.closest('.blk').querySelector('.skey').focus();
      return;
    }
    if (b.classList.contains('searchbtn')) { openSearch(b.closest('.blk'), 'toggle'); return; }
    if (b.classList.contains('wherebtn')) { openWhere(b.closest('.blk'), 'toggle'); return; }
    if (b.classList.contains('allbtn')) {
      b.disabled = true;
      b.textContent = 'Loading…';
      vscode.postMessage({ type: 'loadAll', ...ids(blkTable()) });
      return;
    }
    if (b.classList.contains('cancelload')) { b.disabled = true; vscode.postMessage({ type: 'cancelLoad', ...ids(blkTable()) }); return; }
    if (b.classList.contains('cbcancel')) { b.disabled = true; vscode.postMessage({ type: 'cancelView', ...ids(blkTable()) }); return; }
    if (b.classList.contains('pprev') || b.classList.contains('pnext')) {
      const t = blkTable(), size = +(saved.psize || 500), cur = +b.parentElement.querySelector('.pnum').value || 1;
      const pages = Math.max(1, Math.ceil(viewLen(st(t)) / size));
      scrollToPos(t, (Math.max(1, Math.min(pages, cur + (b.classList.contains('pnext') ? 1 : -1))) - 1) * size);
      return;
    }
    if (b.classList.contains('xmlbtn')) { vscode.postMessage({ type: 'planXml' }); return; }
    if (b.classList.contains('collapsebtn')) { // tutup / buka semua query sekaligus
      const parts = [...document.querySelectorAll('details.qpart')];
      const close = parts.some((d) => d.open);
      parts.forEach((d) => { d.open = !close; });
      b.classList.toggle('closed', close);
      b.querySelector('.lbl').textContent = close ? 'Expand all' : 'Collapse all';
      return;
    }
    if (b.classList.contains('pinbtn')) { vscode.postMessage({ type: 'pin' }); return; }
    if (b.classList.contains('addrow')) { addRow(blkTable()); return; }
    if (b.classList.contains('delrow')) { markDelete(blkTable()); return; }
    if (b.classList.contains('save')) {
      const t = blkTable(), s = st(t);
      const edits = [...s.edits].map(([k, value]) => { const [row, col] = k.split(':').map(Number); return { row, col, value }; });
      const inserts = newRows(t).map((tr) => { const v = []; tr.querySelectorAll('input.cell').forEach((i) => { v[+i.dataset.c] = i.value; }); return Array.from(v, (x) => x ?? ''); });
      const part = t.closest('section')?.dataset.part;
      vscode.postMessage({ type: 'saveGrid', set: +t.dataset.set, part: part === undefined ? undefined : +part, edits, deletes: [...s.deletes], inserts });
      return;
    }
    if (b.classList.contains('genupd') || b.classList.contains('discard')) {
      const t = blkTable(), s = st(t);
      if (b.classList.contains('genupd')) {
        const edits = [...s.edits].map(([k, value]) => { const [row, col] = k.split(':').map(Number); return { row, col, value }; });
        const part = t.closest('section')?.dataset.part;
        vscode.postMessage({ type: 'edits', set: +t.dataset.set, part: part === undefined ? undefined : +part, edits });
      } else discardEdits(t);
      return;
    }
    if (b.classList.contains('morebtn')) {
      const t = blkTable();
      const part = t.closest('section')?.dataset.part;
      b.disabled = true;
      b.textContent = 'Loading…';
      vscode.postMessage({ type: 'more', set: +t.dataset.set, part: part === undefined ? undefined : +part });
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
    if (b.dataset.a === 'xsave' || b.dataset.a === 'xcopy') { // panel Export di rail kanan: hasil yang terakhir disentuh
      const t = tableOf();
      if (!t) return;
      const format = document.getElementById('xf').value, scope = document.getElementById('xs').value;
      saved.format = format;
      vscode.setState(saved);
      send(t, b.dataset.a === 'xsave' ? 'export' : 'copy', format, scope);
      return;
    }
    if (menu.contains(b)) {
      if (b.classList.contains('peekcopy')) return; // popup nilai sel: ditangani handler peek, bukan menu kolom
      const t = menu.table, c = menu.col, s = st(t);
      const a = b.dataset.a;
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
  /** daftar semua grid hasil di halaman (multi query / beberapa result set) untuk pemilih di panel samping */
  const sideTables = () => [...document.querySelectorAll('table.rs')];
  function sideSources() {
    const box = document.getElementById('sidesrc');
    if (!box) return;
    const all = sideTables(), cur = tableOf();
    if (all.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<select class="srcsel" aria-label="Result to work on">' + all.map((t, i) => {
      const part = t.closest('section')?.dataset.part;
      const label = (part === undefined ? '' : 'Query ' + (+part + 1) + ' · ') + 'Result ' + (+t.dataset.set + 1)
        + ' (' + fmt(viewLen(st(t))) + ' rows)';
      return '<option value="' + i + '"' + (t === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('') + '</select>';
  }
  function renderSide() {
    if (!side || side.hidden) return;
    const t = tableOf();
    const body = document.getElementById('sidebody');
    document.getElementById('sidetitle').textContent = pane === 'cols' ? 'Columns' : pane === 'insp' ? 'Inspector' : 'Export';
    sideSources();
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
    } else if (pane === 'exp') {
      // pilihan sama dengan menu export lama: cakupan baris + format, Save ke file / Copy ke clipboard
      const n = selected(t).length;
      const scopes = s.c ? '<option value="cache">All cached (' + fmt(s.c.total) + ' rows' + (s.c.partial ? ', partial' : '') + ')</option>'
        + '<option value="view"' + (s.keys.length || Object.keys(s.filters).length || s.sort ? '' : ' disabled') + '>Filtered rows (' + fmt(s.c.count) + ')</option>'
        + '<option value="sel"' + (n ? '' : ' disabled') + '>Current Selection (' + n + ' rows)</option><option value="server">All Data from server (no limit)</option>'
        : '<option value="all">All Data</option><option value="sel"' + (n ? '' : ' disabled') + '>Current Selection (' + n + ' rows)</option>';
      body.innerHTML = '<div class="hint">Export to your computer.</div><div class="xform"><label>Export</label><select id="xs">' + scopes + '</select>'
        + '<label>Format</label><select id="xf">' + FORMAT_OPTIONS + '</select>'
        + '<div class="acts"><button data-a="xsave" class="primary">Save</button><button data-a="xcopy" class="second" title="Copy to clipboard">Copy</button></div></div>';
      document.getElementById('xs').value = n ? 'sel' : s.c ? (s.keys.length || Object.keys(s.filters).length || s.sort ? 'view' : 'cache') : 'all';
      if (saved.format) document.getElementById('xf').value = saved.format;
      syncCopy();
    } else {
      const r = s.anchor, pos = r === null ? -1 : posOf(s, r);
      body.innerHTML = pos < 0 ? '<div class="hint">Select a row to inspect it.</div>'
        : '<div class="hint">Row ' + (pos + 1) + '</div>' + heads.map((h) => {
          const v = val(s, r, +h.dataset.c);
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
  const showCell = (td, v) => { td.innerHTML = cellHtml(v); };
  function syncEdits(t) {
    const s = st(t);
    const bar = t.closest('.blk').querySelector('.editbar');
    if (!bar) return;
    const n = s.edits.size + s.deletes.size + newRows(t).length;
    bar.querySelector('.pend').hidden = !n;
    bar.querySelector('.ecount').textContent = String(n);
  }
  const newRows = (t) => [...(t.tBodies[1]?.rows ?? [])];
  /** buang semua perubahan grid yang belum disimpan (tombol Discard / tombol Esc); mengembalikan jumlah yang dibuang */
  function discardEdits(t) {
    const s = st(t);
    const n = s.edits.size + s.deletes.size + newRows(t).length;
    if (!n) return 0;
    s.edits.clear();
    s.deletes.clear();
    t.tBodies[1]?.remove();
    apply(t); // filter / sort bisa bergantung pada nilai yang diedit
    syncEdits(t);
    return n;
  }

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
      td.innerHTML = headOf(t, c)?.dataset.gen ? '<input class="cell" data-c="' + c + '" placeholder="generated" disabled>'
        : '<input class="cell" spellcheck="false" data-c="' + c + '" placeholder="default">';
    }
    // gulirkan baris baru ke layar + fokus ke sel pertama yang boleh diisi (kolom generated tidak bisa difokus)
    tr.scrollIntoView({ block: 'nearest' });
    [...tr.querySelectorAll('input.cell:not([disabled])')].find((i) => !i.parentElement.hidden)?.focus();
    syncEdits(t);
  }
  /** baris terpilih ditandai hapus (dicoret); tandai lagi = batal */
  function markDelete(t) {
    const s = st(t);
    const sel = selected(t);
    if (!sel.length) return void vscode.postMessage({ type: 'info', text: 'Select one or more rows first, then use Delete rows to mark them for deletion.' });
    const all = sel.every((r) => s.deletes.has(r));
    for (const r of sel) { if (all) s.deletes.delete(r); else s.deletes.add(r); }
    render(t);
    syncEdits(t);
  }
  document.addEventListener('input', (e) => { const t = e.target.closest?.('tbody.newrows')?.closest('table'); if (t) syncEdits(t); });
  function commitCell(td, input, keep) {
    const t = td.closest('table'), s = st(t);
    const r = +td.parentElement.dataset.r, c = order(t)[td.cellIndex - 1]; // index kolom asli (kolom bisa dipindah)
    const orig = s.data[r][c];
    const v = !keep ? val(s, r, c) : input.value === 'NULL' ? null : input.value;
    if (v === orig) s.edits.delete(editKey(r, c)); else s.edits.set(editKey(r, c), v);
    td.classList.toggle('edited', s.edits.has(editKey(r, c)));
    showCell(td, v);
    syncEdits(t);
  }
  document.addEventListener('dblclick', (e) => {
    const td = e.target.closest('tbody td');
    const t = td?.closest('table[data-edit]');
    if (!td || !t || td.classList.contains('n') || td.querySelector('input') || !td.parentElement.dataset.r) return;
    if (t.tHead.rows[0].cells[td.cellIndex]?.dataset.gen) return; // kolom generated: tidak bisa diedit
    const cur = val(st(t), +td.parentElement.dataset.r, order(t)[td.cellIndex - 1]);
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
  /**
   * popup nilai sel (double-click): nilai panjang / JSON ditampilkan penuh, JSON di-pretty-print + berwarna.
   * Jalan berdampingan dengan edit sel: di grid yang bisa diedit input tetap muncul, popup hanya untuk dibaca.
   */
  const JTOK = /"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
  function hiJson(txt) {
    let out = '', last = 0;
    for (const m of txt.matchAll(JTOK)) {
      const cls = m[0].endsWith(':') ? 'k' : m[0][0] === '"' ? 's' : /^[-\d]/.test(m[0]) ? 'n' : 'b';
      out += esc(txt.slice(last, m.index)) + '<span class="' + cls + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(txt.slice(last));
  }
  /** isi popup sel: JSON -> pretty print berwarna, teks panjang / banyak baris -> apa adanya; null = tidak perlu popup */
  function peekText(v) {
    if (v === null) return null;
    const t = String(v).trim();
    if (t[0] === '{' || t[0] === '[') {
      try { return hiJson(JSON.stringify(JSON.parse(t), null, 2)); } catch { /* bukan JSON: ditampilkan sebagai teks biasa */ }
    }
    return t.length > PEEK_MIN || t.includes('\n') ? esc(String(v)) : null;
  }
  const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M10 1H3a1 1 0 0 0-1 1v9h2V3h6V1zm3 3H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1zm-.5 9.5h-6v-8h6v8z"/></svg>';
  const PEEK_BAR = '<div class="peekbar"><button class="peekcopy" title="Copy value">' + COPY_ICON + 'Copy</button></div>';
  /** popup nilai sel: dipakai hover maupun double-click; nilai mentah disimpan untuk tombol Copy */
  function peekShow(td) {
    const t = td.closest('table.rs');
    if (!t || td.classList.contains('n') || !td.parentElement.dataset.r || td.querySelector('input')) return; // sel yang sedang diedit: tidak diganggu
    if (!menu.hidden && !menu.classList.contains('peek')) return; // menu lain (filter / export) sedang terbuka
    const v = val(st(t), +td.parentElement.dataset.r, order(t)[td.cellIndex - 1]);
    const html = peekText(v);
    if (!html) return;
    peekTd = td;
    menu.peekValue = v;
    open(td, PEEK_BAR + '<pre class="peek">' + html + '</pre>', null, 'peek');
  }
  const HOVER_MS = 500;
  let peekTd = null, showT = null, hideT = null;
  const peekHide = () => { if (menu.classList.contains('peek')) { menu.hidden = true; peekTd = null; } };
  document.addEventListener('mouseover', (e) => {
    clearTimeout(showT);
    clearTimeout(hideT);
    if (menu.contains(e.target)) return; // mouse di dalam popup (mis. menuju tombol Copy): biarkan terbuka
    const td = e.target.closest?.('tbody td');
    if (!td) { hideT = setTimeout(peekHide, 300); return; }
    if (td !== peekTd) showT = setTimeout(() => peekShow(td), HOVER_MS);
  });
  document.addEventListener('dblclick', (e) => {
    const td = e.target.closest('tbody td');
    if (td) { clearTimeout(showT); peekShow(td); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.peekcopy')) return;
    vscode.postMessage({ type: 'copyValue', value: menu.peekValue });
    peekHide();
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
    if (e.target.classList?.contains('srcsel')) { active = sideTables()[+e.target.value]; renderSide(); return; }
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
    const s = st(menu.table), t = menu.table;
    if (e.target.value) s.filters[menu.col] = e.target.value; else delete s.filters[menu.col];
    // mode cache: filter dihitung host atas semua baris, tunggu ketikan berhenti 250 ms
    if (s.c) { clearTimeout(s.debounce); s.debounce = setTimeout(() => apply(t), 250); } else apply(t);
  });
  document.addEventListener('change', (e) => {
    const t = e.target.closest?.('.foot')?.previousElementSibling?.querySelector('table.rs');
    if (!t) return;
    if (e.target.classList.contains('psize')) { saved.psize = +e.target.value; vscode.setState(saved); render(t); }
    if (e.target.classList.contains('pnum')) scrollToPos(t, (Math.max(1, +e.target.value || 1) - 1) * +(saved.psize || 500));
  });
  document.addEventListener('keydown', (e) => {
    // Search Output: Enter / koma = tambah chip, Backspace di input kosong = hapus chip terakhir
    if (e.target.classList?.contains('skey')) {
      const t = e.target.closest('.blk').querySelector('table.rs'), s = st(t), v = e.target.value.trim();
      if ((e.key === 'Enter' || e.key === ',') && v) {
        e.preventDefault();
        if (!s.keys.includes(v)) s.keys.push(v);
        e.target.value = '';
      } else if (e.key === 'Backspace' && !e.target.value && s.keys.length) {
        s.keys.pop();
      } else return;
      renderChips(t);
      apply(t);
      return;
    }
    if (e.key === 'Escape' || (e.key === 'Enter' && e.target.id === 'f')) menu.hidden = true;
    if (e.key === 'Escape') { // Esc = Discard: buang perubahan grid yang belum disimpan
      const t = [tableOf(), ...document.querySelectorAll('table.rs')].find((x) => x && st(x).edits.size + st(x).deletes.size + newRows(x).length);
      const n = t && discardEdits(t);
      if (n) vscode.postMessage({ type: 'info', text: `Discarded ${n} pending change(s).` });
      return;
    }
    // Ctrl/Cmd+C: baris terpilih dalam format setting grid.copyFormat (default JSON); tidak saat mengetik di input
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && !e.target.closest('input, select, textarea') && !String(getSelection())) {
      const t = [...document.querySelectorAll('table.rs')].find((x) => selected(x).length);
      if (!t) return;
      e.preventDefault();
      send(t, 'copy', 'shortcut', 'sel', false); // format dari setting moonageDaydream.grid.copyFormat
    }
  });
  /** pesan dari host untuk grid mode cache: halaman baris, tampilan baru, progres Load all / search / sort */
  const tableFor = (m) => [...document.querySelectorAll('table.rs')].find((t) => { const x = ids(t); return x.set === m.set && x.part === (m.part ?? undefined); });
  window.addEventListener('message', (ev) => {
    const m = ev.data, t = m && tableFor(m), s = t && st(t);
    if (!s?.c) return;
    const busy = t.closest('.blk').querySelector('.sbusy');
    if (m.type === 'cpage') {
      if (m.gen !== s.c.gen) return; // tampilan sudah berganti
      const pg = Math.floor(m.start / PG);
      s.c.pages.set(pg, m.rows);
      m.rows.forEach((row, i) => { s.c.rmap.set(row[0], row.slice(1)); s.c.pos.set(row[0], m.start + i); });
      render(t);
    } else if (m.type === 'cview') {
      if (m.gen !== s.c.gen) return;
      Object.assign(s.c, { count: m.count, pages: new Map(), rmap: new Map(), pos: new Map(), req: new Set() });
      s.sort = m.sort; // Cancel sort: urutan lama tetap
      busy.hidden = true;
      if (m.error) busy.hidden = false, busy.textContent = m.error;
      render(t);
      syncHead(t);
      syncCount(t);
    } else if (m.type === 'cbusy') {
      busy.hidden = false;
      busy.innerHTML = esc(m.text) + '<button class="cbcancel">Cancel</button>';
    } else if (m.type === 'cload') {
      // Load all berjalan: baris bertambah, halaman terakhir (mungkin belum penuh) diminta ulang
      const last = Math.floor(s.c.count / PG);
      for (const pg of [...s.c.pages.keys()]) if (pg >= last) { s.c.pages.delete(pg); s.c.req.delete(pg); }
      s.c.req.delete(last);
      Object.assign(s.c, { count: m.rows, total: m.rows });
      t.closest('.blk').querySelector('.rtitle').firstChild.textContent = 'Loading ' + fmt(m.rows) + ' rows…';
      render(t);
      syncCount(t);
    }
  });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    vscode.postMessage({ type: 'where', where: f.where.value, part: f.dataset.part === undefined ? undefined : +f.dataset.part });
  });
})();

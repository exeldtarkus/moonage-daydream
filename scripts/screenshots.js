// Gambar README: render HTML webview (hasil query, plan, form koneksi) di Chromium headless dengan data contoh, plus icon dari images/icon.svg.
// run: npm run compile && node scripts/screenshots.js   (playwright-core: env PW, global npm, atau cache npx terbaru)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'images', 'screenshots');
const { render } = require(path.join(root, 'out', 'resultsHtml'));
const { formHtml } = require(path.join(root, 'out', 'connectionFormHtml'));
const { parsePlan } = require(path.join(root, 'out', 'plan'));

function findPlaywright() {
  if (process.env.PW) return process.env.PW;
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  for (const d of [path.join(npmRoot, 'playwright-core'), path.join(npmRoot, 'playwright', 'node_modules', 'playwright-core')]) {
    if (fs.existsSync(d)) return d;
  }
  const npx = path.join(process.env.HOME, '.npm', '_npx');
  const found = fs.existsSync(npx) ? fs.readdirSync(npx).map((d) => path.join(npx, d, 'node_modules', 'playwright-core'))
    .filter((d) => fs.existsSync(d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
  if (!found.length) throw new Error('playwright-core not found: set PW=<path> or run `npx playwright install chromium`');
  return found[0];
}

// VS Code Dark+ theme variables
const THEME = `:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-foreground:#cccccc;
--vscode-editor-font-family:'Consolas','DejaVu Sans Mono','Courier New',monospace;--vscode-editor-font-size:13px;
--vscode-font-family:'Segoe UI','DejaVu Sans',sans-serif;--vscode-editorLineNumber-foreground:#858585;--vscode-panel-border:#3c3c3c;
--vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-input-border:#3c3c3c;--vscode-button-background:#0e639c;
--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#1177bb;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ccc;
--vscode-button-secondaryHoverBackground:#45494e;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-inactiveSelectionBackground:#37373d55;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-editorGroupHeader-tabsBackground:#252526;
--vscode-editorWidget-background:#252526;--vscode-editorWidget-border:#454545;--vscode-menu-background:#252526;--vscode-menu-foreground:#ccc;
--vscode-menu-border:#454545;--vscode-menu-selectionBackground:#04395e;--vscode-menu-separatorBackground:#454545;--vscode-sideBar-background:#252526;
--vscode-dropdown-background:#3c3c3c;--vscode-dropdown-foreground:#ccc;--vscode-dropdown-border:#3c3c3c;--vscode-focusBorder:#007fd4;
--vscode-textLink-foreground:#3794ff;--vscode-errorForeground:#f48771;--vscode-editorWarning-foreground:#cca700;--vscode-progressBar-background:#0e70c0;
--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-charts-red:#f14c4c;--vscode-charts-orange:#d18616;
--vscode-charts-yellow:#cca700;--vscode-charts-purple:#b180d7;--vscode-descriptionForeground:#9d9d9d;--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;--vscode-testing-iconPassed:#73c991;
font-family:var(--vscode-font-family);font-size:13px}`;

const prepare = (html) => html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace(/const vscode = acquireVsCodeApi\(\);/, 'const vscode = { postMessage() {}, getState() {}, setState() {} };')
  .replace('<style>', '<style>' + THEME);

// data contoh (toko fiktif)
const CITIES = ['Bandung', 'Surabaya', 'Medan', 'Denpasar', 'Makassar', 'Yogyakarta', 'Semarang', 'Malang'];
const NAMES = ['Ayu Lestari', 'Budi Santoso', 'Citra Dewi', 'Dimas Pratama', 'Eka Putri', 'Fajar Nugroho', 'Gita Maharani', 'Hendra Wijaya',
  'Indah Permata', 'Joko Susilo', 'Kartika Sari', 'Lukman Hakim', 'Maya Anggraini', 'Nanda Saputra', 'Oki Firmansyah', 'Putri Ramadhani'];
const STATUS = ['paid', 'shipped', 'delivered', 'cancelled'];
const orders = Array.from({ length: 2000 }, (_, i) => [
  10001 + i, NAMES[(i * 7) % NAMES.length], CITIES[(i * 3) % CITIES.length], STATUS[(i * 5) % 11 % 4],
  Math.round(((i * 7919) % 4800 + 150) * 1000), i % 9 === 4 ? null : `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T${String(8 + (i % 10)).padStart(2, '0')}:${String((i * 13) % 60).padStart(2, '0')}:00.000Z`,
]);
const ordersSet = { columns: ['order_id', 'customer', 'city', 'status', 'total', 'paid_at'], types: ['int', 'nvarchar(80)', 'nvarchar(40)', 'varchar(12)', 'decimal(12,0)', 'datetime2'], rows: orders.slice(0, 100), total: 100, limited: 100 };
const result = (sets, ms = 38) => ({ resultSets: sets, rowsAffected: [], messages: [], durationMs: ms });
const SQL = 'SELECT order_id, customer, city, status, total, paid_at FROM sales.orders ORDER BY order_id';

const PLAN_XML = `<ShowPlanXML><BatchSequence><Batch><Statements>
<StmtSimple StatementText="SELECT c.city, SUM(o.total) FROM sales.orders o JOIN sales.customers c ON c.id = o.customer_id GROUP BY c.city" StatementSubTreeCost="2.4">
<QueryPlan><RelOp PhysicalOp="Hash Match" LogicalOp="Aggregate" EstimateRows="8" EstimatedTotalSubtreeCost="2.4">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="8" ActualExecutions="1"/></RunTimeInformation>
<RelOp PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="20000" EstimatedTotalSubtreeCost="1.9">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="19874" ActualExecutions="1"/></RunTimeInformation>
<RelOp PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="1600" EstimatedTotalSubtreeCost="0.25">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="1600" ActualExecutions="1"/></RunTimeInformation>
<IndexScan><Object Schema="[sales]" Table="[customers]" Index="[PK_customers]"/></IndexScan></RelOp>
<RelOp PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="20000" EstimatedTotalSubtreeCost="1.1">
<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="19874" ActualExecutions="1"/></RunTimeInformation>
<IndexScan><Object Schema="[sales]" Table="[orders]" Index="[IX_orders_customer]"/></IndexScan></RelOp>
</RelOp></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;

(async () => {
  const { chromium } = require(findPlaywright());
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = async (html, { w = 1280, h = 720 } = {}) => {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.setContent(prepare(html));
      await p.waitForTimeout(150);
      return p;
    };
    const shot = async (p, name, clip) => {
      await p.waitForTimeout(200);
      await p.screenshot({ path: path.join(outDir, name), clip });
      console.log('wrote images/screenshots/' + name);
      await p.close();
    };

    // 1. hero: grid dengan tipe kolom, auto limit, WHERE, footer
    let p = await page(render('csp', 'shop / sales', { result: result([ordersSet]), source: { uri: 'file:///orders.sql', sql: SQL } }));
    await p.click('tbody tr:nth-child(3) td:nth-child(3)');
    await p.click('tbody tr:nth-child(5) td:nth-child(3)', { modifiers: ['Shift'] });
    await shot(p, 'results.png');

    // 2. filter per kolom + menu sort / hide
    p = await page(render('csp', 'shop / sales', { result: result([ordersSet]), source: { uri: 'file:///orders.sql', sql: SQL, where: "status = 'paid'" } }));
    await p.click('.fbtn[data-c="2"]');
    await p.fill('#f', 'ban');
    await p.waitForTimeout(100);
    await shot(p, 'filter.png', { x: 0, y: 0, width: 1280, height: 460 });

    // 3. export / copy
    p = await page(render('csp', 'shop / sales', { result: result([ordersSet]), source: { uri: 'file:///orders.sql', sql: SQL } }), { h: 760 });
    await p.click('.xbtn');
    await shot(p, 'export.png');

    // 4. beberapa SELECT paralel, satu masih berjalan
    const cities = { columns: ['city', 'orders', 'revenue'], types: ['nvarchar(40)', 'int', 'decimal(14,0)'],
      rows: CITIES.map((c, i) => [c, 240 + ((i * 37) % 90), (1200 + i * 173) * 1_000_000]), total: CITIES.length };
    p = await page(render('csp', 'shop / sales', {
      parts: [
        { sql: 'SELECT city, COUNT(*) AS orders, SUM(total) AS revenue FROM sales.orders GROUP BY city;', o: { result: result([cities], 64) } },
        { sql: "SELECT * FROM sales.orders WHERE status = 'shipped';", o: { loading: true } },
      ], uri: 'file:///report.sql', start: Date.now() - 2400,
    }), { h: 640 });
    await shot(p, 'parallel.png');

    // 5. Explain / Analyze (actual plan)
    const xml = [PLAN_XML];
    p = await page(render('csp', 'shop / sales · Analyze', { plan: xml.flatMap(parsePlan), mode: 'actual', xml, durationMs: 182, rows: [8] }), { h: 420 });
    await shot(p, 'plan.png');

    // 6. panel samping: Columns + Inspector baris terpilih
    p = await page(render('csp', 'shop / sales', { result: result([ordersSet]), source: { uri: 'file:///orders.sql', sql: SQL } }));
    await p.click('tbody tr:nth-child(2) td:nth-child(2)');
    const tabs = await p.$$('.sidetabs button');
    if (tabs[1]) await tabs[1].click();
    await shot(p, 'inspector.png');

    // 7. form koneksi (tipe database, group, warna)
    const logos = Object.fromEntries(fs.readdirSync(path.join(root, 'media', 'db')).filter((f) => f.endsWith('.svg'))
      .map((f) => [f.replace('.svg', ''), `data:image/svg+xml;base64,${fs.readFileSync(path.join(root, 'media', 'db', f)).toString('base64')}`]));
    p = await page(formHtml('csp', undefined, ['non-prod', 'prod'], undefined, logos), { w: 960, h: 360 });
    await shot(p, 'new-connection.png');
    p = await page(formHtml('csp', { name: 'shop-pg', type: 'postgres', host: 'db.example.com', port: 5432, user: 'app', database: 'shop', trustServerCertificate: false, group: 'prod', color: 'red' },
      ['non-prod', 'prod'], undefined, logos), { w: 960, h: 820 });
    await shot(p, 'connection.png');

    // icon 128x128 dari SVG
    const icon = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await icon.setContent(`<style>html,body{margin:0;background:transparent}</style>${fs.readFileSync(path.join(root, 'images', 'icon.svg'), 'utf8')}`);
    await icon.screenshot({ path: path.join(root, 'images', 'icon.png'), omitBackground: true });
    console.log('wrote images/icon.png');
    await icon.close();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error('screenshots - failed:', e.stack || e);
  process.exitCode = 1;
});

// Live Monitor (webview): grafik + tabel aktivitas server tiap interval
import * as vscode from 'vscode';
import { Node } from './explorer';
import { ResultSet, drivers } from './db';
import { monitorKit } from './monitorKits';
import { monitorHtml } from './monitorHtml';
import { permissionHint } from './mssqlTree';
import { showError } from './gridEdit';
import { conns, log, openScript, trackPanel } from './extension';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

/** Live Monitor (SQL Server): grafik + tabel dari MONITOR_SQL tiap interval; tidak menumpuk request, berhenti saat tab tersembunyi / ditutup */
export function liveMonitor(n?: Node) {
  if (n?.kind !== 'conn' && n?.kind !== 'db') return;
  const node = n;
  const found = monitorKit(node.c.type);
  if (!found) return void vscode.window.showInformationMessage(`Live Monitor is not available for ${drivers[node.c.type].label}`);
  const kit = found; // tetap ter-narrow di dalam fungsi tick
  // klik kanan database = monitoring database itu saja; koneksi = seluruh server
  const db = node.kind === 'db' ? node.db : undefined;
  const parts = kit.parts(db);
  const title = db ? `${node.c.name} / ${db}` : node.c.name;
  // SQL Server: DMV dibaca dari master; MySQL / PostgreSQL: database koneksi (statistik server tetap terbaca)
  const c = node.c.type === 'mssql' ? { ...node.c, database: 'master' } : node.c;
  const d = drivers[node.c.type];
  const panel = trackPanel(node.c.name, vscode.window.createWebviewPanel('moonageDaydream.monitor', `Monitor: ${title}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  panel.webview.html = monitorHtml(panel.webview.cspSource, title, db !== undefined, kit);
  let interval = 5000;
  let paused = false;
  let disposed = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  let prev: { res: Record<string, ResultSet[] | Error>; t: number } | undefined;
  const schedule = () => {
    if (!disposed && !timer) timer = setTimeout(tick, interval);
  };
  async function tick() {
    timer = undefined;
    if (disposed) return;
    if (paused || !panel.visible || busy) return schedule(); // tersembunyi / pause: tidak ada query ke server
    busy = true;
    try {
      const pw = await conns.password(node.c.name);
      const res: Record<string, ResultSet[] | Error> = {};
      for (const part of parts) {
        try {
          res[part.id] = (await d.run(c, pw, part.sql)).resultSets;
        } catch (e) {
          if (!part.optional) throw e;
          // bagian opsional (performance_schema / pg_stat_statements tidak aktif): pesan di tab-nya, grafik tetap jalan
          log.error(`liveMonitor ${part.id} - EXCEPTION CAUGHT | ${node.c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
          res[part.id] = e instanceof Error ? e : new Error(String(e));
        }
      }
      const t = Date.now();
      const s = kit.sample(res, t, prev, db);
      prev = { res, t };
      void panel.webview.postMessage({ type: 'sample', ...s });
    } catch (e) {
      log.error(`liveMonitor - EXCEPTION CAUGHT | ${node.c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'error', message: (node.c.type === 'mssql' && permissionHint('monitor', e)) || errMsg(e) });
    } finally {
      busy = false;
      schedule();
    }
  }
  const restart = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    void tick();
  };
  panel.onDidChangeViewState(() => panel.visible && !paused && restart());
  panel.onDidDispose(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
  });
  panel.webview.onDidReceiveMessage(async (m: { type: string; ms?: number; paused?: boolean; id?: string; tab?: string }) => {
    if (m.type === 'interval' && m.ms) {
      interval = Math.min(60000, Math.max(1000, m.ms));
      restart();
    } else if (m.type === 'pause') {
      paused = !!m.paused;
      if (!paused) restart();
    } else if (m.type === 'open' && m.tab && kit.query(m.tab, db)) {
      await openScript(node.c, c.database, kit.query(m.tab, db)!, true);
    } else if (m.type === 'kill' && m.id) {
      const ok = await vscode.window.showWarningMessage(`Kill session ${m.id} on ${node.c.name}? Its open transaction is rolled back.`, { modal: true }, 'Kill');
      if (!ok) return;
      try {
        await d.run(c, await conns.password(node.c.name), kit.kill(m.id));
        log.info(`kill session ${m.id} (live monitor): ${node.c.name}`);
        restart();
      } catch (e) {
        log.error(`liveMonitor kill - EXCEPTION CAUGHT | ${node.c.name} / ${m.id}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        showError(`Kill session failed: ${errMsg(e)}`);
      }
    }
  });
  void tick();
}

import { randomBytes } from 'crypto';
import { esc } from './resultsHtml';
import { monitorKit } from './monitorKits';
import type { MonitorKit } from './monitorKits';
import { pageJson, webviewPage } from './webviewPage';

/**
 * panel Live Monitor: grafik SVG live + tabel dari kit database (monitorKits); data lewat postMessage
 * ({ type: 'sample', point: { t, values }, tables } | { type: 'error' }). perDb: grafik / tab level server diberi label (server).
 */
export function monitorHtml(cspSource: string, title: string, perDb = false, kit: MonitorKit = monitorKit('mssql')!): string {
  const nonce = randomBytes(16).toString('base64');
  const label = (text: string, serverWide?: boolean) => (perDb && serverWide ? `${text} (server)` : text);
  return webviewPage('monitor', {
    cspSource,
    nonce,
    title: esc(title),
    intervalOptions: [1, 2, 5, 10, 30, 60].map((s) => `<option value="${s}000"${s === 5 ? ' selected' : ''}>${s}s</option>`).join(''),
    windowOptions: [1, 5, 15].map((m) => `<option value="${m}"${m === 5 ? ' selected' : ''}>${m} min</option>`).join(''),
    charts: kit.charts.map((c) => `<div class="chart" data-chart="${c.id}" title="${esc(c.tip)}"><h2>${esc(label(c.label, c.serverWide))} <b id="v-${c.id}">–</b></h2><svg viewBox="0 0 300 90" preserveAspectRatio="none"></svg></div>`).join(''),
    tabs: kit.tabs.map(([id, text, serverWide], i) => `<button data-tab="${id}"${i ? '' : ' class="on"'}>${esc(label(text, serverWide))}</button>`).join(''),
    data: pageJson(Object.fromEntries(kit.charts.map((c) => [c.id, c.max ?? null]))),
  });
}

import type { QueryResult } from './db';
import { preview } from './sqlContext';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return '<span class="null">NULL</span>';
  if (v instanceof Date) return esc(v.toISOString());
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 64)).toString('hex').toUpperCase();
    return esc(`0x${hex}${v.length > 64 ? '…' : ''}`);
  }
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(String(v));
}

/** loading.uri = file yang query-nya berjalan (untuk tombol Cancel); cancelling = Cancel sudah diklik */
export type Single = { result: QueryResult } | { error: string } | { loading: true; uri?: string; cancelling?: boolean };
/** run paralel: satu Part per statement, diperbarui begitu statement itu selesai */
export interface Part {
  sql: string;
  o: Single;
}
export type Outcome = Single | { parts: Part[]; uri: string; start: number; end?: number };
export const CANCEL_COMMAND = 'moonageDaydream.cancelQuery';

/** tombol Cancel (command URI, webview tanpa script); index = statement tertentu pada run paralel */
const cancelBtn = (uri: string, cancelling?: boolean, index?: number) => cancelling
  ? '<span class="btn off" aria-disabled="true">Cancelling…</span>'
  : `<a class="btn" href="command:${CANCEL_COMMAND}?${esc(encodeURIComponent(JSON.stringify(index === undefined ? [uri] : [uri, index])))}">Cancel</a>`;

const spinner = (label: string) =>
  `<div class="spin"><i></i><i></i><i></i></div><div class="label">${label}<span class="dots"><b>.</b><b>.</b><b>.</b></span></div>`;

function resultHtml(r: QueryResult): string {
  const sets = r.resultSets.map((s, i) => {
    const rows = s.rows
      .map((row, n) => `<tr><td class="n">${n + 1}</td>${row.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`).join('');
    const more = s.total > s.rows.length ? ` (showing first ${s.rows.length})` : '';
    return `<h3>Result ${i + 1} <span>${s.total} row(s)${more}</span></h3>
<div class="grid"><table><thead><tr><th class="n">#</th>${s.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
  const msgs = [...r.messages, ...(r.resultSets.length ? [] : [`${r.rowsAffected.reduce((a, b) => a + b, 0)} row(s) affected`])];
  return `${sets}${msgs.length ? `<pre class="msg">${esc(msgs.join('\n'))}</pre>` : ''}`;
}

function partHtml(p: Part, i: number, uri: string): string {
  const o = p.o;
  const state = 'loading' in o ? (o.cancelling ? 'cancelling' : 'running') : 'error' in o ? 'failed' : `${o.result.durationMs} ms`;
  const head = `<h2>Query ${i + 1} <span>${esc(preview(p.sql))} · ${state}</span></h2>`;
  if ('loading' in o) return `<section>${head}<div class="loading inline">${spinner(o.cancelling ? 'Cancelling query' : 'Running query')}${cancelBtn(uri, o.cancelling, i)}</div></section>`;
  return `<section>${head}${'error' in o ? `<div class="err">${esc(o.error)}</div>` : resultHtml(o.result)}</section>`;
}

export function render(cspSource: string, title: string, o: Outcome): string {
  let body: string;
  let status: string;
  if ('parts' in o) {
    const left = o.parts.filter((p) => 'loading' in p.o).length;
    const failed = o.parts.filter((p) => 'error' in p.o).length;
    status = left ? `Running ${left} of ${o.parts.length} queries in parallel…` : `${o.parts.length} queries done in ${(o.end ?? Date.now()) - o.start} ms${failed ? ` · ${failed} failed` : ''}`;
    body = o.parts.map((p, i) => partHtml(p, i, o.uri)).join('');
  } else if ('loading' in o) {
    status = 'Running…';
    body = `<div class="loading">
  ${spinner(o.cancelling ? 'Cancelling query' : 'Running query')}
  <div class="sub">${esc(title)}</div>
  ${o.uri ? cancelBtn(o.uri, o.cancelling) : ''}
</div>`;
  } else if ('error' in o) {
    status = 'Failed';
    body = `<div class="err">${esc(o.error)}</div>`;
  } else {
    status = `Done in ${o.result.durationMs} ms`;
    body = resultHtml(o.result);
  }
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<style>
  body { margin: 0; padding: 8px 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .top { opacity: .7; margin-bottom: 8px; }
  h3 { font-size: 12px; margin: 12px 0 4px; } h3 span { font-weight: normal; opacity: .7; }
  .grid { overflow: auto; max-height: 70vh; border: 1px solid var(--vscode-panel-border); }
  table { border-collapse: collapse; white-space: nowrap; }
  th, td { padding: 2px 8px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .n { color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
  .null { opacity: .5; font-style: italic; }
  .err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .msg { white-space: pre-wrap; opacity: .8; }
  /* loading: spinner tiga cincin di tengah + progress bar tipis di atas, hanya CSS (webview hasil tanpa script) */
  .loading { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .spin { position: relative; width: 48px; height: 48px; }
  .spin i { position: absolute; inset: 0; border-radius: 50%; border: 3px solid transparent; animation: spin 1.1s cubic-bezier(.5, .1, .5, .9) infinite; }
  .spin i:nth-child(1) { border-top-color: var(--vscode-progressBar-background, #0e70c0); }
  .spin i:nth-child(2) { inset: 7px; border-right-color: var(--vscode-textLink-foreground, #3794ff); animation-duration: 1.6s; animation-direction: reverse; }
  .spin i:nth-child(3) { inset: 14px; border-bottom-color: var(--vscode-charts-green, #89d185); animation-duration: .9s; }
  .label { font-family: var(--vscode-font-family); font-size: 13px; letter-spacing: .3px; }
  .dots b { font-weight: normal; animation: blink 1.2s infinite; }
  .dots b:nth-child(2) { animation-delay: .2s; } .dots b:nth-child(3) { animation-delay: .4s; }
  .sub { font-size: 11px; opacity: .55; }
  .btn { margin-top: 4px; padding: 4px 14px; border-radius: 2px; font-family: var(--vscode-font-family); font-size: 12px; text-decoration: none;
    color: var(--vscode-button-secondaryForeground, #fff); background: var(--vscode-button-secondaryBackground, #3a3d41); }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  /* run paralel: tiap statement satu section, loading kecil sebaris */
  h2 { font-size: 13px; margin: 16px 0 6px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  section:first-of-type h2 { border-top: 0; padding-top: 0; margin-top: 4px; } h2 span { font-weight: normal; opacity: .7; }
  .loading.inline { position: static; flex-direction: row; justify-content: flex-start; padding: 10px 4px; }
  .loading.inline .spin { width: 24px; height: 24px; } .loading.inline .spin i { border-width: 2px; }
  .loading.inline .spin i:nth-child(2) { inset: 4px; } .loading.inline .spin i:nth-child(3) { inset: 8px; }
  .loading.inline .btn { margin: 0 0 0 8px; }
  .btn.off { opacity: .5; cursor: not-allowed; }
  .bar { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; }
  .bar::after { content: ''; position: absolute; top: 0; width: 30%; height: 100%; background: var(--vscode-progressBar-background, #0e70c0);
    animation: slide 1.4s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes blink { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
  @keyframes slide { from { left: -30%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .spin i, .dots b, .bar::after { animation-duration: 3s; } }
</style>
</head>
<body>
${running(o) ? '<div class="bar"></div>' : ''}${'loading' in o ? '' : `<div class="top">${esc(title)} · ${status}</div>`}
${body}
</body>
</html>`;
}

const running = (o: Outcome) => ('parts' in o ? o.parts.some((p) => 'loading' in p.o) : 'loading' in o);

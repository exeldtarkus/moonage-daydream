import * as vscode from 'vscode';
import type { Connections } from './connections';
import { ConnectionInfo, drivers } from './db';
import { FormData, formHtml, toConnection, validate } from './connectionFormHtml';

/** Test connection: testSql driver (server, database) lewat pool sementara (tidak mengganggu pool koneksi tersimpan) */
export async function testConnection(c: ConnectionInfo, password: string, log: vscode.LogOutputChannel): Promise<{ ok: boolean; message: string }> {
  const tmp = { ...c, name: `__test__${Date.now()}` };
  const t = Date.now();
  try {
    const r = await drivers[c.type].run(tmp, password, drivers[c.type].testSql);
    const [server, db] = r.resultSets[0].rows[0] as string[];
    return { ok: true, message: `Connected to ${server} / ${db} in ${Date.now() - t} ms` };
  } catch (e) {
    log.error(`testConnection - EXCEPTION CAUGHT | ${c.name}: ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    await drivers[c.type].close(tmp.name).catch((e: unknown) =>
      log.error(`testConnection close - EXCEPTION CAUGHT | ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`));
  }
}

const panels = new Map<string, vscode.WebviewPanel>();

/**
 * Form Add / Edit Connection sebagai tab editor (Test = `SELECT 1`, Save).
 * `save` dipanggil dengan password final (kosong saat edit = password lama).
 */
export function openConnectionForm(
  conns: Connections,
  log: vscode.LogOutputChannel,
  save: (c: ConnectionInfo, password: string, old?: ConnectionInfo) => Promise<void>,
  old?: ConnectionInfo,
): vscode.WebviewPanel {
  const key = old?.name ?? '';
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    return existing;
  }
  const panel = vscode.window.createWebviewPanel('moonageDaydream.connection', old ? `Edit: ${old.name}` : 'New Connection',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));
  panel.webview.html = formHtml(panel.webview.cspSource, old);

  const finalPassword = async (d: FormData) => (old && !d.password ? conns.password(old.name) : d.password);
  const reply = (msg: object) => panel.webview.postMessage(msg);

  panel.webview.onDidReceiveMessage(async (msg: { type: string; data: FormData }) => {
    if (msg.type === 'cancel') return panel.dispose();
    const error = validate(msg.data, conns, old?.name);
    if (error) return reply({ type: 'status', ok: false, message: error });
    const c = toConnection(msg.data);
    if (msg.type === 'test') {
      reply({ type: 'status', ...(await testConnection(c, await finalPassword(msg.data), log)) });
    } else if (msg.type === 'save') {
      await save(c, await finalPassword(msg.data), old);
      panel.dispose();
    }
  });
  return panel;
}

// Consul Dashboard (webview): ringkasan cluster + KV browse / view / edit / hapus
import * as vscode from 'vscode';
import { ConnectionInfo } from './db';
import { backupWriter, openConsulKey } from './consulView';
import { ConsulClient, consulTarget, dashboardData, deleteKv, detectFormat, kvChildren, saveKv } from './consul';
import { consulDashboardHtml } from './consulDashHtml';
import { showError } from './gridEdit';
import { conns, explorer, extCtx, log, trackPanel } from './extension';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

/** Consul Dashboard: ringkasan cluster (saat dibuka / Refresh) + KV (Key & Value): browse folder, view nilai & metadata, edit, save, add, delete */
export function consulDashboard(c: ConnectionInfo) {
  const panel = trackPanel(c.name, vscode.window.createWebviewPanel('moonageDaydream.consulDashboard', `Consul: ${c.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  panel.webview.html = consulDashboardHtml(panel.webview.cspSource, c.database ? `${c.name} / ${c.database}` : c.name);
  let cachedClient: ConsulClient | undefined;
  const getClient = async () => {
    if (!cachedClient) cachedClient = new ConsulClient(consulTarget(c), await conns.password(c.name));
    return cachedClient;
  };

  async function cluster() {
    try {
      void panel.webview.postMessage({ type: 'cluster', data: await dashboardData(await getClient()) });
    } catch (e) {
      log.error(`consulDashboard cluster - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'clusterError', message: errMsg(e) });
    }
  }

  /** KV browse: list folders + keys satu level di bawah prefix secara instan (1 request) */
  async function kvBrowse(prefix: string) {
    try {
      const client = await getClient();
      const allKeys = await client.keys(prefix);
      const { folders, keys: leafKeys } = kvChildren(allKeys, prefix);
      void panel.webview.postMessage({ type: 'kv', prefix, folders, keys: leafKeys.map((key) => ({ key, value: '' })) });
    } catch (e) {
      log.error(`consulDashboard kvBrowse - EXCEPTION CAUGHT | ${c.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'kvError', message: errMsg(e) });
    }
  }

  /** KV get value: ambil satu key dengan metadata lengkap saat diklik */
  async function kvGetValue(key: string) {
    try {
      const client = await getClient();
      const entry = await client.get(key);
      if (!entry) {
        void panel.webview.postMessage({ type: 'kvValue', key, error: `Key "${key}" not found` });
        return;
      }
      const format = detectFormat(entry.value);
      const size = Buffer.byteLength(entry.value, 'utf8');
      void panel.webview.postMessage({
        type: 'kvValue', key: entry.key, value: entry.value, flags: entry.flags, modifyIndex: entry.modifyIndex, session: entry.session,
        format, size: size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`,
      });
    } catch (e) {
      log.error(`consulDashboard kvGetValue - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      void panel.webview.postMessage({ type: 'kvValue', key, error: errMsg(e) });
    }
  }

  /** KV save: simpan perubahan / buat key baru dengan validasi format, backup, dan CAS */
  async function kvSave(key: string, value: string, cas: number, isNew?: boolean) {
    if (c.readOnly) {
      void panel.webview.postMessage({ type: 'kvSaveResult', success: false, key, error: `Connection "${c.name}" is read-only` });
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Save "${key}" to Consul?`, {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\n${isNew ? 'New key.' : 'The current value is backed up first.'} The change is applied at once (Consul has no transactions).`,
    }, 'Save');
    if (ok !== 'Save') {
      void panel.webview.postMessage({ type: 'kvSaveResult', success: false, key, error: 'Save cancelled' });
      return;
    }
    try {
      const client = await getClient();
      const r = await saveKv(client, key, value, cas, backupWriter(extCtx, c.name, key));
      const updated = await client.get(key);
      const size = Buffer.byteLength(value, 'utf8');
      const format = detectFormat(value);
      void panel.webview.postMessage({
        type: 'kvSaveResult',
        success: true,
        key,
        modifyIndex: updated?.modifyIndex ?? 0,
        size: size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`,
        format,
        isNew: !!isNew,
      });
      explorer.refresh();
      vscode.window.showInformationMessage(`Saved "${key}" to Consul.${r.backup ? ` Backup: ${r.backup}` : ''}`);
    } catch (e) {
      log.error(`consulDashboard kvSave - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      showError(`Save failed: ${errMsg(e)}`);
      void panel.webview.postMessage({ type: 'kvSaveResult', success: false, key, error: errMsg(e) });
    }
  }

  /** KV delete: hapus key setelah konfirmasi dan backup */
  async function handleKvDelete(key: string) {
    if (c.readOnly) {
      vscode.window.showWarningMessage(`The connection "${c.name}" is read-only`);
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Delete key "${key}" from Consul?`, {
      modal: true, detail: `${c.name}${c.database ? ` / ${c.database}` : ''}\n\nExisting value is backed up first (consul kv export format).`,
    }, 'Delete');
    if (ok !== 'Delete') return;
    try {
      const client = await getClient();
      const r = await deleteKv(client, key, backupWriter(extCtx, c.name, key));
      log.info(`consul dashboard delete ${c.name} / ${key}: backup ${r.backup ?? '-'}`);
      vscode.window.showInformationMessage(`Deleted "${key}" from Consul.${r.backup ? ` Backup: ${r.backup}` : ''}`);
      void panel.webview.postMessage({ type: 'kvDeleteResult', success: true, key });
      explorer.refresh();
    } catch (e) {
      log.error(`consulDashboard kvDelete - EXCEPTION CAUGHT | ${c.name} / ${key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      showError(`Delete failed: ${errMsg(e)}`);
      void panel.webview.postMessage({ type: 'kvDeleteResult', success: false, key, error: errMsg(e) });
    }
  }

  panel.webview.onDidReceiveMessage((m: { type: string; prefix?: string; key?: string; value?: string; cas?: number; isNew?: boolean }) => {
    if (m.type === 'cluster') {
      void cluster();
    } else if (m.type === 'kvBrowse') {
      void kvBrowse(m.prefix ?? '');
    } else if (m.type === 'kvGetValue' && m.key) {
      void kvGetValue(m.key);
    } else if (m.type === 'kvSave' && m.key !== undefined && m.value !== undefined) {
      void kvSave(m.key, m.value, m.cas ?? 0, m.isNew);
    } else if (m.type === 'kvDelete' && m.key) {
      void handleKvDelete(m.key);
    } else if (m.type === 'kvOpenEditor' && m.key) {
      void openConsulKey(c, m.key).catch((e: unknown) => {
        log.error(`consulDashboard kvOpenEditor - EXCEPTION CAUGHT | ${c.name} / ${m.key}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        showError(`Open key failed: ${errMsg(e)}`);
      });
    }
  });
}

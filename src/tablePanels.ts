// editor Columns dan New Table (webview), termasuk tabel Keys
import * as vscode from 'vscode';
import { Node } from './explorer';
import { ColumnRow, ConnectionInfo, Driver, NewColumn, TableKey, createTable, readKeys, columnChanges, columnsConfirm, execScript, showColumns, drivers } from './db';
import { columnsHtml } from './columnsHtml';
import { gridMeta, showError } from './gridEdit';
import { conns, explorer, log, openScript, trackPanel } from './extension';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

/** New Table per koneksi / database (dibuka lagi = tab yang sama di-reveal) */
export const newTablePanels = new Map<string, vscode.WebviewPanel>();

/** klik kanan database / folder Tables -> New Table…: grid kolom + chip PK / AI / UQ / FK, script CREATE TABLE live, Create (konfirmasi) */
export function newTable(n?: Node) {
  if (n?.kind !== 'db' && !(n?.kind === 'mfolder' && n.folder === 'tables') && !(n?.kind === 'folder' && n.objKind === 'table')) return;
  const db = n.db;
  if (!db) return;
  // menu dipasang per kelompok koneksi (conn.live = MySQL / MariaDB / PostgreSQL): driver yang belum didukung diberi tahu
  if (!drivers[n.c.type].columnDdl?.create) return void vscode.window.showInformationMessage(`New Table is not available for ${drivers[n.c.type].label} yet.`);
  const conn = n.c;
  const d = drivers[conn.type];
  const ddl = d.columnDdl!;
  const key = `${conn.name}\u0000${db}`;
  const open = newTablePanels.get(key);
  if (open) return open.reveal();
  const panel = trackPanel(conn.name, vscode.window.createWebviewPanel('moonageDaydream.newTable', `New Table: ${db}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  newTablePanels.set(key, panel);
  panel.onDidDispose(() => newTablePanels.delete(key));
  panel.webview.html = columnsHtml(panel.webview.cspSource, { conn: conn.name, db, table: 'New table' }, !!conn.readOnly, 'create');
  const c = { ...conn, database: db };
  const post = (m: unknown) => void panel.webview.postMessage(m);
  panel.webview.onDidReceiveMessage(async (m: { type: string; rows?: NewColumn[]; tableKeys?: TableKey[]; table?: { schema: string; name: string }; schema?: string; name?: string }) => {
    if (m.type === 'ready') {
      let tables: { schema: string; name: string }[] = [];
      try {
        tables = await d.objects(c, await conns.password(conn.name), db, 'table');
      } catch (e) {
        // daftar tabel untuk FK gagal: tabel tetap bisa dibuat, FK tidak bisa dipilih
        log.error(`newTable tables - EXCEPTION CAUGHT | ${conn.name} / ${db}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        post({ type: 'status', text: `Could not list tables for foreign keys: ${errMsg(e)}`, error: true });
      }
      let schemas = [...new Set([d.defaultSchema, ...tables.map((x) => x.schema)].filter(Boolean))].sort();
      if (d.schemas) {
        try {
          schemas = await d.schemas(c, await conns.password(conn.name), db);
        } catch (e) {
          // daftar schema dari server gagal (mis. izin): pakai schema dari tabel yang ada
          log.error(`newTable schemas - EXCEPTION CAUGHT | ${conn.name} / ${db}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        }
      }
      const intType = ddl.aiTypes?.find((x) => /^int(eger)?$/.test(x)) ?? ddl.newType;
      // tanpa auto increment (MongoDB): baris awal _id objectId
      const first = !ddl.aiTypes && ddl.types.some((x) => x.name === 'objectId') ? { name: '_id', type: 'objectId' } : { name: 'id', type: intType };
      return post({ type: 'load', cols: [], info: { columns: [], rows: [] }, types: ddl.types, newType: ddl.newType, tables, schemas, defaultSchema: d.defaultSchema,
        fkActions: ddl.fkActions ?? [], ai: !!ddl.aiTypes, fk: !!ddl.fkActions, keysTable: !!ddl.fkActions, rows: [{ ...first, nullable: false, default: '', pk: true, ai: !!ddl.aiTypes }] });
    }
    if (m.type === 'fkColumns') {
      try {
        const columns = await fkColumnList(d, c, await conns.password(conn.name), db, m.schema ?? '', m.name ?? '');
        return post({ type: 'fkColumns', key: `${m.schema ?? ''}.${m.name}`, columns });
      } catch (e) {
        log.error(`newTable fkColumns - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${m.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        return post({ type: 'status', text: `Could not read columns of ${m.name}: ${errMsg(e)}`, error: true });
      }
    }
    const t = { schema: m.table?.schema ?? d.defaultSchema, name: m.table?.name ?? '' };
    const r = createTable(ddl, t, m.rows ?? [], m.tableKeys ?? []);
    const label = `${t.schema ? `${t.schema}.` : ''}${t.name.trim()}`;
    if (m.type === 'change') return post({ type: 'script', ...r, count: r.sql ? 1 : 0, steps: r.sql ? [{ kind: 'create', column: label, sql: r.sql }] : [] });
    if (!r.sql) return;
    if (m.type === 'open') return openScript(conn, db, r.sql);
    if (m.type !== 'execute' || conn.readOnly) return;
    const ok = await vscode.window.showWarningMessage(`Create table ${label} on ${conn.name} / ${db}?`, { modal: true, detail: r.sql }, 'Create');
    if (!ok) return;
    try {
      post({ type: 'status', text: 'Creating…' });
      await d.run(c, await conns.password(conn.name), r.sql);
      log.info(`newTable: ${conn.name} / ${db} / ${label}`);
      explorer.refresh();
      vscode.window.showInformationMessage(`Table ${label} created on ${conn.name} / ${db}.`);
      panel.dispose();
    } catch (e) {
      log.error(`newTable execute - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${label}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      post({ type: 'status', text: `Create failed: ${errMsg(e)}`, error: true });
      showError(`New Table failed: ${errMsg(e)}`);
    }
  });
}

/** editor Columns per tabel (satu tab per koneksi / database / tabel) */
export const columnPanels = new Map<string, vscode.WebviewPanel>();

export async function fkColumnList(d: Driver, c: ConnectionInfo, pw: string, db: string, schema: string, name: string): Promise<string[]> {
  const obj = { schema, name };
  const [cols, pk] = await Promise.all([d.columns(c, pw, db, obj), d.primaryKey(c, pw, db, obj)]);
  const pkSet = new Set(pk);
  return [
    ...pk.filter((column) => cols.some((c) => c.name === column)),
    ...cols.map((c) => c.name).filter((name) => !pkSet.has(name)),
  ];
}

/**
 * klik kanan tabel -> Columns: grid kolom bisa diedit, script ALTER tampil di SQL preview (seperti DBeaver);
 * Execute menjalankan script setelah konfirmasi, Open in SQL Editor = tab SQL tanpa dijalankan.
 */
export function columnsEditor(n?: Node) {
  if (n?.kind !== 'obj' || !drivers[n.c.type].columnDdl) return;
  const { c: conn, db, obj } = n;
  const d = drivers[conn.type];
  const ddl = d.columnDdl!;
  const table = `${obj.schema ? `${obj.schema}.` : ''}${obj.name}`;
  const key = `${conn.name}\u0000${db}\u0000${table}`;
  const open = columnPanels.get(key);
  if (open) return open.reveal();
  const panel = trackPanel(conn.name, vscode.window.createWebviewPanel('moonageDaydream.columns', `Columns: ${table}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true }));
  columnPanels.set(key, panel);
  panel.onDidDispose(() => columnPanels.delete(key));
  panel.webview.html = columnsHtml(panel.webview.cspSource, { conn: conn.name, db, table }, !!conn.readOnly);
  const c = { ...conn, database: db }; // script memakai nama dua bagian: dijalankan di database tabel
  let original: ColumnRow[] = [];
  let originalKeys: TableKey[] = [];
  let info: ReturnType<typeof showColumns>['info'] = { columns: [], rows: [] };
  const post = (m: unknown) => void panel.webview.postMessage(m);
  async function load() {
    try {
      post({ type: 'status', text: 'Loading…' });
      const rs = (await d.run(c, await conns.password(conn.name), ddl.show(obj))).resultSets[0];
      const shown = showColumns(rs ?? { columns: [], rows: [] });
      const { cols } = shown;
      original = cols;
      info = shown.info;
      // key lebih dari satu kolom untuk tabel Keys (driver tanpa query keys: kosong)
      originalKeys = ddl.keys ? readKeys((await d.run(c, await conns.password(conn.name), ddl.keys(obj))).resultSets[0] ?? { columns: [], rows: [] }) : [];
      post({ type: 'load', cols, info, tableKeys: originalKeys, keysTable: !!ddl.keys, types: ddl.types, newType: ddl.newType, keys: !!ddl.addPk, reorder: !!ddl.move,
        aiExisting: !!ddl.setAi, aiTypes: ddl.aiTypes ?? [], fkActions: ddl.fkActions ?? [], schema: obj.schema,
        orderNote: ddl.addPk && !ddl.move ? `Column order cannot be changed on ${d.label} (needs a table rebuild)` : '' });
    } catch (e) {
      log.error(`columnsEditor load - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${table}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      post({ type: 'status', text: `Load failed: ${errMsg(e)}`, error: true });
    }
  }
  panel.webview.onDidReceiveMessage(async (m: { type: string; rows?: ColumnRow[]; tableKeys?: TableKey[]; schema?: string; name?: string }) => {
    if (m.type === 'ready' || m.type === 'refresh') return load();
    if (m.type === 'fkTables') {
      try {
        const tables = await d.objects(c, await conns.password(conn.name), db, 'table');
        return post({ type: 'fkTables', tables });
      } catch (e) {
        log.error(`columnsEditor fkTables - EXCEPTION CAUGHT | ${conn.name} / ${db}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        return post({ type: 'status', text: `Could not list tables for foreign keys: ${errMsg(e)}`, error: true });
      }
    }
    if (m.type === 'fkColumns') {
      try {
        const columns = await fkColumnList(d, c, await conns.password(conn.name), db, m.schema ?? '', m.name ?? '');
        return post({ type: 'fkColumns', key: `${m.schema ?? ''}.${m.name ?? ''}`, columns });
      } catch (e) {
        log.error(`columnsEditor fkColumns - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${m.name}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        return post({ type: 'status', text: `Could not read columns of ${m.name}: ${errMsg(e)}`, error: true });
      }
    }
    // pesan tanpa tableKeys (UI lama) = key tidak berubah
    const r = columnChanges(ddl, obj, original, m.rows ?? [], m.tableKeys ?? originalKeys, originalKeys);
    if (m.type === 'change') return post({ type: 'script', ...r });
    if (!r.sql) return;
    if (m.type === 'open') return openScript(conn, db, r.sql);
    if (m.type !== 'execute' || conn.readOnly) return;
    const ok = await vscode.window.showWarningMessage(`Apply ${r.count} column change(s) to ${table} on ${conn.name} / ${db}?`,
      { modal: true, detail: columnsConfirm(ddl, r.steps, m.rows ?? [], originalKeys) }, 'Execute');
    if (!ok) return;
    try {
      post({ type: 'status', text: 'Executing…' });
      await execScript(d, c, await conns.password(conn.name), r.sql, conn.type === 'mssql');
      log.info(`columnsEditor execute: ${conn.name} / ${db} / ${table}: ${r.count} change(s)`);
      gridMeta.clear(); // PK / kolom generated bisa berubah
      await load();
      post({ type: 'status', text: `Saved ${r.count} change(s)` });
      explorer.refresh();
    } catch (e) {
      log.error(`columnsEditor execute - EXCEPTION CAUGHT | ${conn.name} / ${db} / ${table}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
      post({ type: 'status', text: `Execute failed: ${errMsg(e)}`, error: true });
      showError(`Columns: execute failed: ${errMsg(e)}`);
    }
  });
}

// grid hasil: edit sel / baris, Save, script UPDATE, Load more, penanda bisa-diedit
import * as vscode from 'vscode';
import { ConnectionInfo, PAGE_ROWS, drivers, schemaOf } from './db';
import { ResultMessage } from './results';
import type { Outcome, Source } from './resultsHtml';
import { mongoChanges, mongoFindCollection } from './mongo';
import { addWhere, updateScript, changeStatements, tableRefs } from './sqlContext';
import { ttlCache } from './memo';
import { applyWhere, conns, fileConn, log, openTx, results } from './extension';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStack = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));

/** notifikasi error + tombol Show Log (detail lengkap ada di output channel "Moonage Daydream", sudah dicatat pemanggil) */
export function showError(message: string): void {
  void vscode.window.showErrorMessage(message, 'Show Log').then((pick) => { if (pick) log.show(true); });
}

export class NotEditable extends Error {}
// metadata tabel untuk penanda edit grid (PK, schema, kolom generated): dipakai ulang 60 detik setelah SELECT; Save / script selalu baca ulang
export const gridMeta = ttlCache(60_000);

/** tabel / koleksi asal result set yang diedit: SELECT satu tabel + primary key, atau find() satu koleksi MongoDB (_id) */
export async function gridTarget(m: ResultMessage, o = results.current?.outcome, cached = false) {
  if (!o) throw new NotEditable('No result to edit');
  const part = 'parts' in o && m.part !== undefined ? o.parts[m.part] : undefined;
  const single = part ? part.o : o;
  if (!('result' in single)) throw new NotEditable('No result to edit');
  const rs = single.result.resultSets[m.set ?? 0];
  const src: Source | undefined = part && 'parts' in o ? { uri: o.uri, sql: part.sql } : 'source' in single ? single.source : undefined;
  const c = src && fileConn(vscode.Uri.parse(src.uri));
  if (!rs || !src || !c) throw new NotEditable('Editing needs the result of a single SELECT');
  const d = drivers[c.type];
  if (src.mongo) {
    const coll = mongoFindCollection(src.sql);
    if (!coll) throw new NotEditable('Editing needs a find() on one collection');
    if (!rs.columns.includes('_id')) throw new NotEditable('The _id field must be part of the result to edit documents');
    const db = c.database || d.defaultDb;
    return { c, d, pw: await conns.password(c.name), rs, src, pk: ['_id'], table: coll, label: `${db}.${coll}`, mongo: true, generated: [] as string[] };
  }
  if (!['mssql', 'mysql', 'postgres', 'sqlite'].includes(d.dialect)) throw new NotEditable(`Editing rows is not available for ${d.label} yet`);
  const refs = tableRefs(src.sql);
  if (refs.length !== 1) throw new NotEditable('Editing needs a SELECT from exactly one table (no JOIN)');
  const parts = refs[0].parts;
  const name = parts[parts.length - 1];
  // MySQL: `db.tabel` (schema = database); lainnya `db.schema.tabel` / `schema.tabel`
  const db = parts.length === 3 || (d.dialect === 'mysql' && parts.length === 2) ? parts[0] : c.database || d.defaultDb;
  const pw = await conns.password(c.name);
  const key = `${c.name}\u0000${db}\u0000`;
  const schema = d.dialect === 'mysql' ? db : (parts.length >= 2 && parts[parts.length - 2])
    || (await gridMeta.get(`${key}tables`, () => d.objects(c, pw, db, 'table'), !cached)).find((x) => x.name.toLowerCase() === name.toLowerCase())?.schema || schemaOf(c, db);
  const tkey = `${key}${schema}\u0000${name}\u0000`;
  const pk = await gridMeta.get(`${tkey}pk`, () => d.primaryKey(c, pw, db, { schema, name }), !cached);
  if (!pk.length) throw new NotEditable(`${schema}.${name} has no primary key, so rows cannot be identified safely`);
  const q = d.quote;
  const table = d.dialect === 'mssql' ? `${q(db)}.${q(schema)}.${q(name)}` : d.dialect === 'mysql' ? `${q(db)}.${q(name)}`
    : d.dialect === 'postgres' ? `${q(schema)}.${q(name)}` : q(name);
  if (!pk.every((k) => rs.columns.some((x) => k.toLowerCase() === x.toLowerCase()))) throw new NotEditable(`The primary key (${pk.join(', ')}) must be part of the SELECT to edit rows`);
  // kolom generated / computed / identity: tidak boleh diisi di baris baru / diedit
  const generated = (await gridMeta.get(`${tkey}cols`, () => d.columns(c, pw, db, { schema, name }), !cached)).filter((x) => x.generated).map((x) => x.name);
  return { c, d, pw, rs, src, pk, table, label: `${db}.${schema}.${name}`, mongo: false, generated };
}

/**
 * setelah hasil tampil: result set yang tidak bisa diedit (atau koneksi read-only) diberi alasan -> tombol edit nonaktif + tooltip.
 * Error lain (mis. gagal membaca primary key) dicatat dan tombol tetap aktif: Save akan melaporkannya.
 */
export async function markEditable(o: Outcome) {
  const singles = 'parts' in o ? o.parts.map((p, part) => ({ s: p.o, part })) : [{ s: o, part: undefined }];
  let changed = false;
  for (const { s, part } of singles) {
    if (!('result' in s) || !s.result.resultSets.length) continue;
    try {
      const t = await gridTarget({ type: 'saveGrid', set: 0, part } as ResultMessage, o, true);
      if (t.c.readOnly) throw new NotEditable(`${t.c.name} is a read-only connection`);
      if (t.generated.length) {
        s.genCols = t.generated;
        changed = true;
      }
    } catch (e) {
      if (!(e instanceof NotEditable)) {
        log.error(`markEditable - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        continue;
      }
      s.editBlock = e.message;
      changed = true;
    }
  }
  if (changed && results.current?.outcome === o) results.refresh();
}

/**
 * Edit grid -> script UPDATE di tab baru (BEGIN TRAN, WHERE primary key); tidak pernah dijalankan otomatis.
 * Syarat: statement asal SELECT dari satu tabel yang punya primary key, kolom PK ikut di-SELECT.
 */
export async function editScript(m: ResultMessage): Promise<vscode.TextDocument | undefined> {
  if (!m.edits?.length) return;
  try {
    const t = await gridTarget(m);
    const script = t.mongo ? mongoChanges(t.table, t.rs.columns, t.rs.types ?? [], t.rs.rows, { edits: m.edits }).join('\n')
      : updateScript(t.table, t.rs.columns, t.rs.types ?? [], t.rs.rows, t.pk, m.edits, t.d.quote, t.d.dialect);
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: script });
    await conns.bind(doc.uri.toString(), { conn: t.c.name, db: t.c.database || undefined });
    await vscode.window.showTextDocument(doc, { preview: false });
    log.info(`edit script: ${m.edits.length} cell(s) on ${t.label}`);
    return doc;
  } catch (e) {
    log.error(`editScript - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    showError(`Cannot generate UPDATE script: ${errMsg(e)}`);
  }
}

/**
 * Save di grid: edit sel + hapus baris + baris baru jadi satu transaksi (gagal = rollback), setelah konfirmasi modal;
 * sukses = query asal dijalankan ulang. Mengembalikan true bila tersimpan.
 */
export async function saveGrid(m: ResultMessage): Promise<boolean> {
  const ch = { edits: m.edits ?? [], deletes: m.deletes ?? [], inserts: m.inserts ?? [] };
  if (!ch.edits.length && !ch.deletes.length && !ch.inserts.length) return false;
  let c: ConnectionInfo | undefined;
  try {
    const t = await gridTarget(m);
    c = t.c;
    if (c.readOnly) throw new Error(`${c.name} is read-only`);
    const stmts = t.mongo ? mongoChanges(t.table, t.rs.columns, t.rs.types ?? [], t.rs.rows, ch)
      : changeStatements(t.table, t.rs.columns, t.rs.types ?? [], t.rs.rows, t.pk, ch, t.d.quote, t.d.dialect, t.generated);
    if (!stmts.length) return false;
    const how = t.mongo ? 'MongoDB has no transaction here: commands run one by one and stop at the first error (earlier ones stay saved).'
      : 'One transaction; any error rolls everything back.';
    const detail = `${t.label}: ${ch.edits.length ? `${new Set(ch.edits.map((e) => e.row)).size} row(s) updated, ` : ''}${new Set(ch.deletes).size} deleted, ${ch.inserts.length} inserted. ${how}\n\n${stmts.join('\n')}`;
    const ok = await vscode.window.showWarningMessage(`Save changes to ${t.label} on ${c.name}?`, { modal: true, detail: detail.length > 4000 ? `${detail.slice(0, 4000)}\n…` : detail }, 'Save');
    if (ok !== 'Save') return false;
    if (t.mongo) {
      // shortcut: tanpa transaksi (perlu replica set); perintah dijalankan berurutan, berhenti di error pertama
      let done = 0;
      try {
        for (const st of stmts) {
          await t.d.run(c, t.pw, st);
          done++;
        }
      } catch (e) {
        log.error(`saveGrid mongo - EXCEPTION CAUGHT | ${c.name}: ${done} of ${stmts.length} saved: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
        showError(`Save stopped after ${done} of ${stmts.length} command(s): ${errMsg(e)}`);
        await applyWhere('', m.part);
        return false;
      }
      log.info(`saveGrid: ${t.label} ${stmts.length} command(s)`);
      await applyWhere('', m.part);
      return true;
    }
    const session = await t.d.session(c, t.pw);
    try {
      for (const st of stmts) await session.run(st);
      await session.commit();
    } catch (e) {
      try {
        await session.rollback();
      } catch (re) {
        log.error(`saveGrid rollback - EXCEPTION CAUGHT | ${c.name}: ${errMsg(re)} - stack-trace: ${errStack(re)}`);
      }
      throw e;
    } finally {
      await session.close();
    }
    log.info(`saveGrid: ${t.label} ${stmts.length} statement(s)`);
    await applyWhere(t.src.where ?? '', m.part);
    return true;
  } catch (e) {
    log.error(`saveGrid - EXCEPTION CAUGHT | ${c?.name ?? ''}: ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    showError(`Save failed (nothing was changed): ${errMsg(e)}`);
    return false;
  }
}

/**
 * Load more: statement asal (+ WHERE aktif) dijalankan ulang, baris yang sudah dimuat dilewati, PAGE_ROWS berikutnya ditambahkan.
 * shortcut: urutan baris hanya stabil dengan ORDER BY; tanpa itu SQL Server boleh mengembalikan urutan lain.
 */
export async function loadMore(m: ResultMessage): Promise<number | undefined> {
  const o = results.current?.outcome;
  if (!o || m.set !== 0) return;
  const part = 'parts' in o && m.part !== undefined ? o.parts[m.part] : undefined;
  const single = part ? part.o : o;
  if (!('result' in single)) return;
  const rs = single.result.resultSets[0];
  const src: Source | undefined = part && 'parts' in o ? { uri: o.uri, sql: part.sql } : 'source' in single ? single.source : undefined;
  const c = src && fileConn(vscode.Uri.parse(src.uri));
  if (!rs || !src || !c) return;
  const offset = rs.rows.length;
  try {
    const sql = src.where ? addWhere(src.sql, src.where) : src.sql;
    const tx = openTx(src.uri, c);
    const next = (await (tx ? tx.run(sql, undefined, offset + PAGE_ROWS, offset)
      : drivers[c.type].run(c, await conns.password(c.name), sql, undefined, offset + PAGE_ROWS, offset))).resultSets[0];
    rs.rows.push(...(next?.rows ?? []));
    if (rs.limited) {
      rs.total = next?.total ?? rs.total; // auto limit: total = baris yang terbaca sejauh ini
      rs.limited = next?.limited ? offset + PAGE_ROWS : undefined;
    }
    log.info(`load more: +${next?.rows.length ?? 0} rows (now ${rs.rows.length})`);
    return next?.rows.length ?? 0;
  } catch (e) {
    log.error(`loadMore - EXCEPTION CAUGHT | ${errMsg(e)} - stack-trace: ${errStack(e)}`);
    showError(`Load more failed: ${errMsg(e)}`);
  } finally {
    results.refresh();
  }
}

import * as vscode from 'vscode';
import type { Connections } from './connections';
import { Column, ConnectionInfo, DbObject, ObjectKind, drivers } from './db';
import { ident, identifierChain, statementAt, tableRefs } from './sqlContext';

type Obj = DbObject & { kind: ObjectKind };
// shortcut: cache metadata 5 menit per koneksi / database; Refresh di Connections mengosongkannya
const TTL = 5 * 60_000;

/**
 * Autocomplete database / schema / tabel / view, termasuk lintas database (`DB.schema.table`, `DB..table`),
 * dan kolom dari tabel di FROM / JOIN statement di kursor (semua kolom, atau milik `alias.` / `tabel.`).
 * Koneksi + database diambil dari binding file (CodeLens), sama seperti saat Execute.
 */
export class SqlCompletion implements vscode.CompletionItemProvider {
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private conns: Connections, private fileConn: (uri: vscode.Uri) => ConnectionInfo | undefined, private log: vscode.LogOutputChannel) {}

  clear(): void {
    this.cache.clear();
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch((e: unknown) => {
      this.cache.delete(key); // gagal tidak di-cache, dicoba lagi saat autocomplete berikutnya
      this.log.error(`SqlCompletion.cached - EXCEPTION CAUGHT | ${key.replace('\n', ' / ')}: ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
    });
    return value;
  }

  private async databases(c: ConnectionInfo): Promise<string[]> {
    return this.cached(`${c.name}\ndatabases`, async () => drivers[c.type].databases(c, await this.conns.password(c.name)));
  }

  private async objects(c: ConnectionInfo, db: string): Promise<Obj[]> {
    return this.cached(`${c.name}\n${db}`, async () => {
      const pw = await this.conns.password(c.name);
      const d = drivers[c.type];
      const [tables, views] = await Promise.all([d.objects(c, pw, db, 'table'), d.objects(c, pw, db, 'view')]);
      return [...tables.map((o) => ({ ...o, kind: 'table' as const })), ...views.map((o) => ({ ...o, kind: 'view' as const }))];
    });
  }

  /** kolom tabel di FROM / JOIN statement; alias = hanya tabel dengan alias / nama itu */
  private async columns(c: ConnectionInfo, current: string, stmt: string, alias?: string): Promise<{ table: string; col: Column }[]> {
    const refs = tableRefs(stmt).filter((r) => !alias || [r.alias, r.parts[r.parts.length - 1]].some((a) => a?.toLowerCase() === alias.toLowerCase()));
    const lists = await Promise.all(refs.map(async (r) => {
      const name = r.parts[r.parts.length - 1];
      const db = r.parts.length === 3 ? r.parts[0] : current;
      // tanpa schema: cari schema tabel itu di database-nya (default dbo)
      const schema = (r.parts.length >= 2 && r.parts[r.parts.length - 2])
        || (await this.objects(c, db)).find((o) => o.name.toLowerCase() === name.toLowerCase())?.schema || 'dbo';
      const cols = await this.cached(`${c.name}\n${db}\n${schema}.${name}`, async () =>
        drivers[c.type].columns(c, await this.conns.password(c.name), db, { schema, name }));
      return cols.map((col) => ({ table: r.alias ?? name, col }));
    }));
    return lists.flat();
  }

  private colItem(x: { table: string; col: Column }, range: vscode.Range): vscode.CompletionItem {
    return Object.assign(new vscode.CompletionItem({ label: x.col.name, description: `${x.col.type} · ${x.table}` }, vscode.CompletionItemKind.Field), {
      insertText: ident(x.col.name), range, sortText: `0${x.col.name}`,
    });
  }

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const c = this.fileConn(doc.uri);
    if (!c) return [];
    const { parts, word } = identifierChain(doc.lineAt(pos.line).text.slice(0, pos.character));
    const range = new vscode.Range(pos.translate(0, -word.length - (doc.lineAt(pos.line).text[pos.character - word.length - 1] === '[' ? 1 : 0)), pos);
    const current = c.database || 'master'; // shortcut: koneksi tanpa database default dianggap master
    try {
      const stmt = statementAt(doc.getText(), doc.offsetAt(pos));
      if (parts.length === 0) {
        const [cols, dbs, objs] = await Promise.all([this.columns(c, current, stmt), this.databases(c), this.objects(c, current)]);
        return [...cols.map((x) => this.colItem(x, range)), ...dbs.map((db) => this.dbItem(db, range)), ...objs.map((o) => this.objItem(o, range, true))];
      }
      if (parts.length === 1) {
        // `X.`: X database (-> schema) atau schema di database file ini (-> tabel)
        const [dbs, objs] = await Promise.all([this.databases(c), this.objects(c, current)]);
        const db = dbs.find((d) => d.toLowerCase() === parts[0].toLowerCase());
        const items = objs.filter((o) => o.schema.toLowerCase() === parts[0].toLowerCase()).map((o) => this.objItem(o, range, false));
        // `alias.` / `tabel.`: kolom tabel itu
        items.unshift(...(await this.columns(c, current, stmt, parts[0])).map((x) => this.colItem(x, range)));
        if (db) {
          const schemas = [...new Set((await this.objects(c, db)).map((o) => o.schema))].sort();
          items.push(...schemas.map((s) => Object.assign(new vscode.CompletionItem(s, vscode.CompletionItemKind.Folder), {
            detail: `schema in ${db}`, insertText: ident(s), range,
            command: { command: 'editor.action.triggerSuggest', title: '' }, // langsung lanjut ke tabel setelah titik diketik
          })));
        }
        return items;
      }
      // `DB.schema.` atau `DB..` (schema default dbo)
      const [db, schema] = parts;
      const objs = await this.objects(c, db);
      return objs.filter((o) => o.schema.toLowerCase() === (schema || 'dbo').toLowerCase()).map((o) => this.objItem(o, range, false));
    } catch (e) {
      this.log.error(`SqlCompletion - EXCEPTION CAUGHT | ${c.name}: ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
      return [];
    }
  }

  private dbItem(db: string, range: vscode.Range): vscode.CompletionItem {
    return Object.assign(new vscode.CompletionItem(db, vscode.CompletionItemKind.Module), { detail: 'database', insertText: ident(db), range, sortText: `2${db}` });
  }

  /** withSchema: tanpa titik sebelumnya, sisipkan `schema.nama` tapi tetap bisa dicari dengan nama saja */
  private objItem(o: Obj, range: vscode.Range, withSchema: boolean): vscode.CompletionItem {
    const label = withSchema ? `${o.schema}.${o.name}` : o.name;
    return Object.assign(new vscode.CompletionItem({ label, description: o.kind }, o.kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class), {
      insertText: withSchema ? `${ident(o.schema)}.${ident(o.name)}` : ident(o.name),
      filterText: withSchema ? `${o.name} ${o.schema}.${o.name}` : o.name,
      range,
      sortText: `1${o.name}`,
    });
  }
}

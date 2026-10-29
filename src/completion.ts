import * as vscode from 'vscode';
import type { Connections } from './connections';
import { Column, ConnectionInfo, DbObject, ObjectKind, drivers, schemaOf } from './db';
import { ident, identifierChain, statementAt, tableRefs } from './sqlContext';

type Obj = DbObject & { kind: ObjectKind };

/** keyword T-SQL yang sering dipakai (multi kata disisipkan utuh) */
const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'AS', 'ON',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'CROSS APPLY', 'OUTER APPLY',
  'GROUP BY', 'ORDER BY', 'HAVING', 'ASC', 'DESC', 'TOP', 'DISTINCT', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'WITH', 'WITH (NOLOCK)',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'OUTPUT', 'INTO',
  'DECLARE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'BEGIN TRAN', 'EXEC', 'IF', 'WHILE', 'RETURN', 'GO', 'OFFSET', 'FETCH NEXT', 'ROWS ONLY', 'NULL', 'OVER', 'PARTITION BY'];
/** fungsi T-SQL: disisipkan dengan kurung, kursor di dalam */
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ISNULL', 'COALESCE', 'NULLIF', 'CAST', 'CONVERT', 'TRY_CONVERT', 'TRY_CAST',
  'GETDATE', 'SYSDATETIME', 'DATEADD', 'DATEDIFF', 'DATEPART', 'DATENAME', 'EOMONTH', 'FORMAT', 'YEAR', 'MONTH', 'DAY',
  'LEN', 'DATALENGTH', 'SUBSTRING', 'LEFT', 'RIGHT', 'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER', 'REPLACE', 'CHARINDEX', 'CONCAT', 'STRING_AGG', 'STUFF',
  'ROUND', 'ABS', 'CEILING', 'FLOOR', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'IIF', 'NEWID', 'OBJECT_ID', 'DB_NAME', 'SCOPE_IDENTITY'];

/** keyword / fungsi: huruf mengikuti setting format.keywordCase (preserve = ikuti huruf yang diketik) */
export function keywordItems(word: string, keywordCase: string, range: vscode.Range): vscode.CompletionItem[] {
  const lower = keywordCase === 'lower' || (keywordCase === 'preserve' && word !== '' && word === word.toLowerCase());
  const k = (t: string) => (lower ? t.toLowerCase() : t);
  return [
    ...KEYWORDS.map((kw) => Object.assign(new vscode.CompletionItem(k(kw), vscode.CompletionItemKind.Keyword), { range, sortText: `3${kw}` })),
    ...FUNCTIONS.map((f) => Object.assign(new vscode.CompletionItem({ label: k(f), description: 'function' }, vscode.CompletionItemKind.Function), {
      range, sortText: `4${f}`, insertText: new vscode.SnippetString(`${k(f)}($1)`),
    })),
  ];
}
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
      // tanpa schema: cari schema tabel itu di database-nya (default dbo / public / main; MySQL: schema = database)
      const mysql = drivers[c.type].dialect === 'mysql';
      const tdb = mysql && r.parts.length === 2 ? r.parts[0] : db;
      const schema = mysql ? tdb : (r.parts.length >= 2 && r.parts[r.parts.length - 2])
        || (await this.objects(c, db)).find((o) => o.name.toLowerCase() === name.toLowerCase())?.schema || schemaOf(c, db);
      const cols = await this.cached(`${c.name}\n${tdb}\n${schema}.${name}`, async () =>
        drivers[c.type].columns(c, await this.conns.password(c.name), tdb, { schema, name }));
      return cols.map((col) => ({ table: r.alias ?? name, col }));
    }));
    return lists.flat();
  }

  private colItem(x: { table: string; col: Column }, range: vscode.Range, q: (n: string) => string): vscode.CompletionItem {
    return Object.assign(new vscode.CompletionItem({ label: x.col.name, description: `${x.col.type} · ${x.table}` }, vscode.CompletionItemKind.Field), {
      insertText: ident(x.col.name, q), range, sortText: `0${x.col.name}`,
    });
  }

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const { parts, word } = identifierChain(doc.lineAt(pos.line).text.slice(0, pos.character));
    const range = new vscode.Range(pos.translate(0, -word.length - (doc.lineAt(pos.line).text[pos.character - word.length - 1] === '[' ? 1 : 0)), pos);
    const kwCase = vscode.workspace.getConfiguration('moonageDaydream.format', doc).get('keywordCase', 'upper');
    // keyword tetap ada tanpa koneksi / saat metadata gagal dimuat
    const keywords = () => (parts.length ? [] : rank(keywordItems(word, kwCase, range), word));
    const c = this.fileConn(doc.uri);
    if (!c) return keywords();
    const q = drivers[c.type].quote;
    const current = c.database || drivers[c.type].defaultDb; // shortcut: koneksi tanpa database dianggap master / mysql / postgres
    try {
      const stmt = statementAt(doc.getText(), doc.offsetAt(pos));
      if (parts.length === 0) {
        const [cols, dbs, objs] = await Promise.all([this.columns(c, current, stmt), this.databases(c), this.objects(c, current)]);
        return rank([...cols.map((x) => this.colItem(x, range, q)), ...dbs.map((db) => this.dbItem(db, range, q)), ...objs.map((o) => this.objItem(o, range, true, q)),
          ...keywordItems(word, kwCase, range)], word);
      }
      if (parts.length === 1) {
        // `X.`: X database (-> schema) atau schema di database file ini (-> tabel)
        const [dbs, objs] = await Promise.all([this.databases(c), this.objects(c, current)]);
        const db = dbs.find((d) => d.toLowerCase() === parts[0].toLowerCase());
        const items = objs.filter((o) => o.schema.toLowerCase() === parts[0].toLowerCase()).map((o) => this.objItem(o, range, false, q));
        // `alias.` / `tabel.`: kolom tabel itu
        items.unshift(...(await this.columns(c, current, stmt, parts[0])).map((x) => this.colItem(x, range, q)));
        if (db && drivers[c.type].dialect === 'mysql') {
          // MySQL `db.`: langsung tabel / view database itu
          items.push(...(await this.objects(c, db)).map((o) => this.objItem(o, range, false, q)));
        } else if (db) {
          const schemas = [...new Set((await this.objects(c, db)).map((o) => o.schema))].sort();
          items.push(...schemas.map((s) => Object.assign(new vscode.CompletionItem(s, vscode.CompletionItemKind.Folder), {
            detail: `schema in ${db}`, insertText: ident(s, q), range,
            command: { command: 'editor.action.triggerSuggest', title: '' }, // langsung lanjut ke tabel setelah titik diketik
          })));
        }
        return rank(items, word);
      }
      // `DB.schema.` atau `DB..` (schema default dbo)
      const [db, schema] = parts;
      const objs = await this.objects(c, db);
      return rank(objs.filter((o) => o.schema.toLowerCase() === (schema || schemaOf(c, db)).toLowerCase()).map((o) => this.objItem(o, range, false, q)), word);
    } catch (e) {
      this.log.error(`SqlCompletion - EXCEPTION CAUGHT | ${c.name}: ${e instanceof Error ? e.message : e} - stack-trace: ${e instanceof Error ? e.stack : e}`);
      return keywords();
    }
  }

  private dbItem(db: string, range: vscode.Range, q: (n: string) => string): vscode.CompletionItem {
    return Object.assign(new vscode.CompletionItem(db, vscode.CompletionItemKind.Module), { detail: 'database', insertText: ident(db, q), range, sortText: `2${db}` });
  }

  /** withSchema: tanpa titik sebelumnya, sisipkan `schema.nama` tapi tetap bisa dicari dengan nama saja */
  private objItem(o: Obj, range: vscode.Range, withSchema: boolean, q: (n: string) => string): vscode.CompletionItem {
    const label = withSchema ? `${o.schema}.${o.name}` : o.name;
    return Object.assign(new vscode.CompletionItem({ label, description: o.kind }, o.kind === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class), {
      insertText: withSchema ? `${ident(o.schema, q)}.${ident(o.name, q)}` : ident(o.name, q),
      filterText: withSchema ? `${o.name} ${o.schema}.${o.name}` : o.name,
      range,
      sortText: `1${o.name}`,
    });
  }
}

/**
 * Urutan saran tidak tergantung huruf besar / kecil: filterText mengikuti gaya huruf yang diketik
 * (VS Code memberi skor lebih tinggi pada huruf yang sama persis), nama yang sama persis dipilih & di paling atas.
 */
export function rank(items: vscode.CompletionItem[], word: string): vscode.CompletionItem[] {
  const fold = (t: string) => (word === word.toUpperCase() && word !== word.toLowerCase() ? t.toUpperCase() : t.toLowerCase());
  for (const i of items) {
    const label = typeof i.label === 'string' ? i.label : i.label.label;
    i.filterText = fold(i.filterText ?? label);
    if (word && label.split('.').pop()!.toLowerCase() === word.toLowerCase()) {
      i.preselect = true;
      i.sortText = ` ${i.sortText ?? label}`;
    }
  }
  return items;
}

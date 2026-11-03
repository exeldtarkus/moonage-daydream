import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyFilters, filterKey, loadObjects, matchFilter, treeParent } from '../treeFilter';
import type { Node } from '../explorer';
import type { ConnectionInfo } from '../db';

const c = { name: 'lab', type: 'mysql' } as ConnectionInfo;
const ms = { name: 'ms', type: 'mssql' } as ConnectionInfo;
const obj = (db: string, name: string, schema = ''): Node => ({ kind: 'obj', c, db, objKind: 'table', obj: { schema, name } });
const names = (ns: Node[]) => ns.map((n) => (n.kind === 'db' ? n.db : n.kind === 'obj' ? n.obj.name : n.kind));

test('tree filter: contains, case-insensitive, empty = everything', () => {
  assert.equal(matchFilter('Order_Item', 'order'), true);
  assert.equal(matchFilter('customers', 'order'), false);
  assert.equal(matchFilter('x', undefined), true);
  assert.equal(matchFilter('x', '  '), true);
});

test('tree filter: connection filter narrows databases, database filter narrows objects in every folder, folder filter its own items', () => {
  const f = new Map<string, string>();
  const get = (k: string) => f.get(k);
  const conn: Node = { kind: 'conn', c };
  const dbs: Node[] = ['shop', 'shop_archive', 'hr'].map((db) => ({ kind: 'db', c, db }));
  f.set(filterKey(conn)!, 'SHOP');
  assert.deepEqual(names(applyFilters(conn, dbs, get)), ['shop', 'shop_archive']);

  const db: Node = { kind: 'db', c, db: 'shop' };
  const folders: Node[] = [{ kind: 'folder', c, db: 'shop', objKind: 'table' }, { kind: 'folder', c, db: 'shop', objKind: 'view' }];
  f.set(filterKey(db)!, 'order');
  assert.equal(applyFilters(db, folders, get).length, 2, 'folders themselves are never hidden');
  const tables = [obj('shop', 'orders'), obj('shop', 'order_item'), obj('shop', 'customers')];
  assert.deepEqual(names(applyFilters(folders[0], tables, get)), ['orders', 'order_item']);
  f.set(filterKey(folders[0])!, 'item');
  assert.deepEqual(names(applyFilters(folders[0], tables, get)), ['order_item'], 'database and folder filters both apply');
  assert.deepEqual(names(applyFilters({ kind: 'folder', c, db: 'hr', objKind: 'table' }, [obj('hr', 'customers')], get)), ['customers'], 'other database not affected');
});

test('tree filter: SQL Server folders filter their rows (schema.name), connection filter applies to the Databases folder', () => {
  const f = new Map<string, string>();
  const get = (k: string) => f.get(k);
  const dbsFolder: Node = { kind: 'mfolder', c: ms, folder: 'databases' };
  f.set(filterKey({ kind: 'conn', c: ms })!, 'bima');
  assert.deepEqual(names(applyFilters(dbsFolder, [{ kind: 'db', c: ms, db: 'BIMA_HERITAGE' }, { kind: 'db', c: ms, db: 'master' }], get)), ['BIMA_HERITAGE']);
  const tables: Node = { kind: 'mfolder', c: ms, folder: 'tables', db: 'BIMA_HERITAGE' };
  f.set(filterKey(tables)!, 'dbo.ord');
  const rows: Node[] = [{ kind: 'mfolder', c: ms, folder: 'systemTables', db: 'BIMA_HERITAGE' }, { kind: 'obj', c: ms, db: 'BIMA_HERITAGE', objKind: 'table', obj: { schema: 'dbo', name: 'orders' } },
    { kind: 'obj', c: ms, db: 'BIMA_HERITAGE', objKind: 'table', obj: { schema: 'sales', name: 'orders' } }];
  assert.deepEqual(names(applyFilters(tables, rows, get)), ['mfolder', 'orders']);
  assert.equal(filterKey({ kind: 'conn', c: { name: 'kv', type: 'consul' } as ConnectionInfo }), undefined, 'Consul has no filter');
});

test('find object: loads every database x kind, keeps going after a failure, stops when cancelled', async () => {
  const got: string[] = [];
  const failed: string[] = [];
  await loadObjects(['a', 'b', 'c'], ['table', 'view'], async (db: string, kind: string) => {
    if (db === 'b') throw new Error('denied');
    return [{ schema: '', name: `${db}_${kind}` }];
  }, (db, kind, objs) => got.push(...objs.map((o) => o.name)), (db, e) => failed.push(`${db}:${(e as Error).message}`), () => false, 2);
  assert.deepEqual(got.sort(), ['a_table', 'a_view', 'c_table', 'c_view']);
  assert.deepEqual(failed, ['b:denied', 'b:denied']);
  let calls = 0;
  await loadObjects(['a', 'b', 'c'], ['table'], async () => { calls++; return []; }, () => undefined, () => undefined, () => calls >= 1, 1);
  assert.equal(calls, 1);
});

test('reveal: parent chain of an object up to its connection (and group)', () => {
  const g = { ...c, group: 'lab group' } as ConnectionInfo;
  const chain = (n: Node | undefined): string[] => {
    const out: string[] = [];
    for (let x = n; x; x = treeParent(x)) out.push(x.kind === 'mfolder' ? `ms:${x.folder}` : x.kind === 'folder' ? `folder:${x.objKind}` : x.kind === 'db' ? `db:${x.db}` : x.kind === 'obj' ? `obj:${x.obj.name}` : x.kind === 'conn' ? `conn:${x.c.name}` : x.kind === 'group' ? `group:${x.group}` : x.kind);
    return out;
  };
  assert.deepEqual(chain({ kind: 'obj', c: g, db: 'shop', objKind: 'view', obj: { schema: '', name: 'v' } }), ['obj:v', 'folder:view', 'db:shop', 'conn:lab', 'group:lab group']);
  assert.deepEqual(chain({ kind: 'obj', c: ms, db: 'B', objKind: 'table', obj: { schema: 'dbo', name: 't' } }), ['obj:t', 'ms:tables', 'db:B', 'ms:databases', 'conn:ms']);
  assert.deepEqual(chain({ kind: 'obj', c: ms, db: 'B', objKind: 'procedure', obj: { schema: 'dbo', name: 'p' } }), ['obj:p', 'ms:procedures', 'ms:programmability', 'db:B', 'ms:databases', 'conn:ms']);
  assert.deepEqual(chain({ kind: 'obj', c: ms, db: 'B', objKind: 'view', obj: { schema: 'dbo', name: 'v' } }), ['obj:v', 'ms:views', 'db:B', 'ms:databases', 'conn:ms']);
});

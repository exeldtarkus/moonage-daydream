import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyFilters, connStateChange, connText, filterKey, matchFilter, treeParent } from '../treeFilter';
import type { Node } from '../explorer';
import { groupEnv, type ConnectionInfo } from '../db';

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

test('keyboard: Ctrl+Alt+F filters the selected Connections node, Ctrl+Alt+O opens Find Object anywhere', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- package.json dibaca apa adanya
  const pkg = require('../../package.json') as { contributes: { keybindings: { command: string; key: string; mac?: string; when?: string }[] } };
  const kb = (cmd: string) => pkg.contributes.keybindings.find((k) => k.command === cmd);
  assert.deepEqual(kb('moonageDaydream.filterNode'), { command: 'moonageDaydream.filterNode', key: 'ctrl+alt+f', mac: 'cmd+alt+f', when: 'focusedView == moonageDaydream.explorer' });
  assert.deepEqual(kb('moonageDaydream.findObject'), { command: 'moonageDaydream.findObject', key: 'ctrl+alt+o', mac: 'cmd+alt+o' });
});

test('group environment: guessed from the group name, an explicit choice wins (none = plain folder)', () => {
  const guess = (name: string) => groupEnv(name, {});
  assert.equal(guess('Production'), 'production');
  assert.equal(guess('prod-jkt'), 'production');
  assert.equal(guess('UAT'), 'uat');
  assert.equal(guess('Pre-Prod'), 'uat', 'pre-production is not production');
  assert.equal(guess('staging'), 'uat');
  assert.equal(guess('local docker'), 'local');
  assert.equal(guess('Development'), 'development');
  assert.equal(guess('dev team'), 'development');
  assert.equal(guess('customers'), undefined);
  assert.equal(groupEnv('customers', { customers: { env: 'production' } }), 'production');
  assert.equal(groupEnv('Production', { Production: { env: 'none' } }), undefined);
});

test('connection row text: label is the name in brackets (colored by the connection), details after " - "', () => {
  assert.deepEqual(connText('test-db', 'SQL Server', '10.1.40.129\\UAT02', { active: true }),
    { label: '[ test-db ]', description: '- SQL Server · 10.1.40.129\\UAT02 · active' });
  assert.deepEqual(connText('local-mysql (docker)', 'MySQL', '127.0.0.1:23306', { noConfirm: true }),
    { label: '[ local-mysql (docker) ]', description: '- MySQL · 127.0.0.1:23306 · no commit confirm' });
});

test('connection state: only the connections that changed are redrawn; a disconnect asks for a full redraw', () => {
  assert.deepEqual(connStateChange(['a'], ['a', 'b']), { connected: ['b'], disconnected: [] });
  assert.deepEqual(connStateChange(['a', 'b'], ['b', 'c']), { connected: ['c'], disconnected: ['a'] });
  assert.deepEqual(connStateChange([], []), { connected: [], disconnected: [] });
});

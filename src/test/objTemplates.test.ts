import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { folderContext, objectTemplates } from '../objTemplates';
import { objContext } from '../db';
import { splitStatements } from '../sqlContext';
import { parseShell } from '../mongo';

const labels = (type: Parameters<typeof objectTemplates>[0], what: Parameters<typeof objectTemplates>[1]) =>
  objectTemplates(type, what, { db: 'shop', obj: { schema: 'shop', name: 'orders' } }).map((t) => t.label);

test('object templates: what each database offers', () => {
  assert.deepEqual(labels('mysql', 'view'), ['View']);
  assert.deepEqual(labels('mysql', 'procedure'), ['Stored procedure', 'Function']);
  assert.deepEqual(labels('mariadb', 'trigger'), ['Trigger']);
  assert.deepEqual(labels('postgres', 'view'), ['View', 'Materialized view']);
  assert.deepEqual(labels('postgres', 'procedure'), ['Function', 'Procedure']);
  assert.deepEqual(labels('postgres', 'trigger'), ['Trigger']);
  assert.deepEqual(labels('sqlite', 'view'), ['View']);
  assert.deepEqual(labels('sqlite', 'procedure'), []);
  assert.deepEqual(labels('sqlite', 'trigger'), ['Trigger']);
  assert.deepEqual(labels('mongodb', 'view'), ['View']);
  assert.deepEqual(labels('mongodb', 'procedure'), []);
  assert.deepEqual(labels('mongodb', 'trigger'), []);
  assert.deepEqual(labels('mssql', 'view'), [], 'SQL Server uses its own Object Explorer templates');
});

test('object templates: each splits into the expected statements (no DELIMITER needed)', () => {
  const ctx = { db: 'shop', obj: { schema: 'public', name: 'orders' } };
  const n = (type: Parameters<typeof objectTemplates>[0], what: Parameters<typeof objectTemplates>[1], dialect: Parameters<typeof splitStatements>[1]) =>
    objectTemplates(type, what, ctx).map((t) => splitStatements(t.sql, dialect).length);
  assert.deepEqual(n('mysql', 'view', 'mysql'), [1]);
  assert.deepEqual(n('mysql', 'procedure', 'mysql'), [1, 1]);
  assert.deepEqual(n('mysql', 'trigger', 'mysql'), [1]);
  assert.deepEqual(n('postgres', 'view', 'postgres'), [1, 1]);
  assert.deepEqual(n('postgres', 'procedure', 'postgres'), [1, 1]);
  assert.deepEqual(n('postgres', 'trigger', 'postgres'), [2], 'trigger function + CREATE TRIGGER');
  assert.deepEqual(n('sqlite', 'view', 'sqlite'), [1]);
  assert.deepEqual(n('sqlite', 'trigger', 'sqlite'), [1]);
});

test('object templates: names quoted per database and bound to the table / schema', () => {
  const my = objectTemplates('mysql', 'trigger', { db: 'sh`op', obj: { schema: 'sh`op', name: 'orders' } })[0].sql;
  assert.match(my, /CREATE TRIGGER `sh``op`\.`trg_orders_before_insert`\nBEFORE INSERT ON `sh``op`\.`orders`\nFOR EACH ROW/);
  const pg = objectTemplates('postgres', 'trigger', { db: 'shop', obj: { schema: 'sales', name: 'Orders' } })[0].sql;
  assert.match(pg, /CREATE OR REPLACE FUNCTION sales\."trg_Orders_change"\(\)\nRETURNS trigger/);
  assert.match(pg, /AFTER INSERT OR UPDATE OR DELETE ON sales\."Orders"\nFOR EACH ROW EXECUTE FUNCTION sales\."trg_Orders_change"\(\);/);
  assert.match(objectTemplates('postgres', 'view', { db: 'shop' })[1].sql, /^CREATE MATERIALIZED VIEW public\.mv_new/m);
  assert.match(objectTemplates('mysql', 'procedure', { db: 'shop' })[0].sql, /IN p_id INT, OUT p_name VARCHAR\(100\), INOUT p_counter INT/);
  assert.match(objectTemplates('mysql', 'procedure', { db: 'shop' })[1].sql, /RETURNS INT\nDETERMINISTIC/);
  assert.match(objectTemplates('sqlite', 'trigger', { db: 'main', obj: { schema: '', name: 'or"ders' } })[0].sql, /AFTER INSERT ON "or""ders"/);
  assert.match(objectTemplates('mongodb', 'view', { db: 'shop' })[0].sql, /^db\.createView\("vw_new", "sourceCollection", \[/);
});

test('object templates: folder and table context values drive the (+) and New Trigger menus', () => {
  assert.equal(folderContext('mysql', 'view'), 'folder.view.new');
  assert.equal(folderContext('sqlite', 'procedure'), 'folder.procedure');
  assert.equal(folderContext('postgres', 'table'), 'folder.table');
  assert.equal(objContext('table', { def: false, ms: false, cols: true, trg: true }), 'table.trg.cols');
  assert.equal(objContext('view', { def: true, ms: false, cols: false, trg: true }), 'view.def', 'trigger only on tables');
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items = pkg.contributes.menus['view/item/context'] as { command: string; when: string; group?: string }[];
  const plus = items.filter((m) => m.command === 'moonageDaydream.newObject' && m.group === 'inline').map((m) => m.when).join(' ');
  assert.ok(plus.includes('folder\\\\.(view|procedure)\\\\.new') || plus.includes('folder\\.(view|procedure)\\.new'), plus);
  const trg = items.find((m) => m.command === 'moonageDaydream.newTrigger');
  assert.ok(trg && /trg/.test(trg.when));
  // menu lama tetap cocok dengan context baru
  const re = (cmd: string) => new RegExp(items.find((m) => m.command === cmd && /viewItem =~/.test(m.when))!.when.match(/viewItem =~ \/(.+)\/$/)![1]);
  assert.ok(re('moonageDaydream.editColumns').test('table.trg.cols'));
});

test('split: SQLite trigger body BEGIN ... END stays one statement, the next statement is separate', () => {
  const s = splitStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (1); END;\nSELECT 1;', 'sqlite');
  assert.deepEqual(s, ['CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (1); END;', 'SELECT 1;']);
});

test('MongoDB view template parses as a createView command (name, source, pipeline)', () => {
  const ops = parseShell(objectTemplates('mongodb', 'view', { db: 'shop' })[0].sql);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].method, 'createView');
  assert.deepEqual(ops[0].args.slice(0, 2), ['vw_new', 'sourceCollection']);
  assert.ok(Array.isArray(ops[0].args[2]));
});

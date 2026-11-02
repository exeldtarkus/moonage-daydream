import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NEW_OBJECT_FOLDERS, newObjectTemplates } from '../msTemplates';

const one = (folder: string, ctx = {}) => newObjectTemplates(folder, ctx).map((t) => t.label);
const sql = (folder: string, i = 0, ctx = {}) => newObjectTemplates(folder, ctx)[i].sql;

test('new object: one template per folder, a choice for functions and types', () => {
  assert.deepEqual(one('procedures'), ['Stored procedure']);
  assert.deepEqual(one('functions'), ['Scalar function', 'Inline table-valued function', 'Multi-statement table-valued function']);
  assert.deepEqual(one('scalarFunctions'), ['Scalar function']);
  assert.deepEqual(one('tvf'), ['Inline table-valued function', 'Multi-statement table-valued function']);
  assert.deepEqual(one('types'), ['User-defined data type', 'User-defined table type']);
  for (const f of ['serverTriggers', 'dbTriggers', 'sequences', 'views', 'tTriggers']) assert.equal(one(f).length, 1, f);
  assert.deepEqual(newObjectTemplates('tables', {}), []);
});

test('new object: templates create the right object kind', () => {
  assert.match(sql('serverTriggers'), /^CREATE TRIGGER \[\w+\]\nON ALL SERVER\nFOR /m);
  assert.match(sql('procedures'), /^CREATE PROCEDURE \[dbo\]\.\[\w+\]/m);
  assert.match(sql('functions', 0), /RETURNS INT/);
  assert.match(sql('functions', 1), /RETURNS TABLE\nAS\nRETURN/);
  assert.match(sql('functions', 2), /RETURNS @Result TABLE/);
  assert.match(sql('dbTriggers'), /\nON DATABASE\nFOR /);
  assert.match(sql('types', 0), /^CREATE TYPE \[dbo\]\.\[\w+\] FROM /m);
  assert.match(sql('types', 1), /AS TABLE/);
  for (const k of ['START WITH', 'INCREMENT BY', 'MINVALUE', 'MAXVALUE', 'CYCLE', 'CACHE']) assert.ok(sql('sequences').includes(k), k);
  assert.match(sql('views'), /^CREATE VIEW \[dbo\]\.\[\w+\]\n-- WITH SCHEMABINDING/m);
});

test('new object: table trigger uses AFTER, view trigger INSTEAD OF, names quoted', () => {
  const t = sql('tTriggers', 0, { obj: { schema: 'sales', name: 'order]s' } });
  assert.match(t, /CREATE TRIGGER \[sales\]\.\[TR_order\]\]s_Change\]\nON \[sales\]\.\[order\]\]s\]\nAFTER INSERT, UPDATE, DELETE/);
  const v = sql('tTriggers', 0, { obj: { schema: 'dbo', name: 'v1' }, view: true });
  assert.match(v, /ON \[dbo\]\.\[v1\]\nINSTEAD OF INSERT/);
});

test('new object: (+) inline button on every folder with templates and on Linked Servers', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items = pkg.contributes.menus['view/item/context'] as { command: string; when: string; group?: string }[];
  const plus = items.find((m) => m.command === 'moonageDaydream.newObject' && m.group === 'inline');
  assert.ok(plus, 'inline newObject menu');
  for (const f of NEW_OBJECT_FOLDERS) assert.ok(plus!.when.includes(f), f);
  assert.ok(items.some((m) => m.command === 'moonageDaydream.newLinkedServer' && m.group === 'inline' && m.when.includes('linkedServers')));
  assert.ok(pkg.contributes.commands.some((c: { command: string; icon?: string }) => c.command === 'moonageDaydream.newObject' && c.icon === '$(add)'));
});

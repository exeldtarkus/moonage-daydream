import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkDbName, drivers } from '../db';

const ms = drivers.mssql.newDatabase!;

test('new database: name is required, trimmed length limit per database', () => {
  assert.equal(checkDbName(' ', 128), 'Database name is required');
  assert.equal(checkDbName('a'.repeat(129), 128), 'Database name is at most 128 characters');
  assert.equal(checkDbName('shop_dev', 128), undefined);
  assert.equal(ms.maxName, 128);
});

test('new database: SQL Server script = CREATE DATABASE (+ COLLATE) (+ recovery model), names quoted', () => {
  assert.equal(ms.script('shop', {}), 'CREATE DATABASE [shop];');
  assert.equal(ms.script('sh]op', { collation: 'Latin1_General_100_CI_AS_SC_UTF8', recovery: 'SIMPLE' }),
    'CREATE DATABASE [sh]]op] COLLATE Latin1_General_100_CI_AS_SC_UTF8;\nALTER DATABASE [sh]]op] SET RECOVERY SIMPLE;');
  assert.equal(ms.script('shop', { collation: '', recovery: 'FULL' }), 'CREATE DATABASE [shop];\nALTER DATABASE [shop] SET RECOVERY FULL;');
  assert.throws(() => ms.script('shop', { collation: 'x; DROP DATABASE y' }), /Invalid collation/);
  assert.throws(() => ms.script('shop', { recovery: 'FAST' }), /Invalid recovery model/);
});

test('new database: SQL Server options = collation (from the server) then recovery model, default first', async () => {
  assert.deepEqual(ms.options.map((o) => o.key), ['collation', 'recovery']);
  const sqls: string[] = [];
  const fake = { run: async (sql: string) => (sqls.push(sql), { resultSets: [{ columns: ['name', 'description'], rows: [['Latin1_General_CI_AS', 'Latin1 ...']] }] }) };
  const coll = await ms.options[0].items(fake.run);
  assert.match(sqls[0], /FROM sys\.fn_helpcollations\(\)/);
  assert.deepEqual(coll[0], { label: '(server default)', value: '' });
  assert.deepEqual(coll[1], { label: 'Latin1_General_CI_AS', value: 'Latin1_General_CI_AS', description: 'Latin1 ...' });
  const rec = await ms.options[1].items(fake.run);
  assert.deepEqual(rec.map((r) => r.value), ['', 'SIMPLE', 'FULL', 'BULK_LOGGED']);
});

test('menus: New Database on SQL Server connections only (for now), command title', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (viewItem: string) => items.some((it) => it.command === 'moonageDaydream.newDatabase'
    && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(viewItem));
  assert.ok(shown('conn.mssql.on') && shown('conn.mssql.off'));
  assert.ok(!shown('conn.consul.on'));
  assert.ok(shown('ms.databases'), 'right-click the Databases folder (SQL Server)');
  assert.ok(!shown('ms.systemDatabases'), 'not on System Databases');
  assert.ok(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === 'moonageDaydream.newDatabase' && c.title === 'New Database…'));
  for (const t of Object.keys(drivers) as (keyof typeof drivers)[]) {
    if (drivers[t].newDatabase) assert.ok(shown(t === 'mssql' ? 'conn.mssql.on' : ['mysql', 'mariadb', 'postgres'].includes(t) ? 'conn.live.on' : 'conn.on'), `${t} has the menu`);
  }
});

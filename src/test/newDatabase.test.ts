import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkDbName, drivers, newDatabaseScript } from '../db';
import { newDbHtml } from '../newDbHtml';

const ms = drivers.mssql.newDatabase!;
const ok = (name: string, v: Record<string, string> = {}) => newDatabaseScript(ms, name, v);

test('new database: name is required, trimmed length limit per database', () => {
  assert.equal(checkDbName(' ', 128), 'Database name is required');
  assert.equal(checkDbName('a'.repeat(129), 128), 'Database name is at most 128 characters');
  assert.equal(checkDbName('shop_dev', 128), undefined);
  assert.equal(ms.maxName, 128);
  assert.deepEqual(ok(' '), { sql: '', errors: ['Database name is required'] });
});

test('new database: SQL Server fields (form order, Files section folded, choices from the server)', async () => {
  assert.deepEqual(ms.fields.map((f) => [f.key, f.kind, f.group ?? '']), [
    ['collation', 'choice', ''], ['recovery', 'choice', ''], ['owner', 'choice', ''],
    ['dataSize', 'number', 'Files'], ['dataGrowth', 'number', 'Files'], ['dataPath', 'text', 'Files'],
    ['logSize', 'number', 'Files'], ['logGrowth', 'number', 'Files'], ['logPath', 'text', 'Files'],
  ]);
  const sqls: string[] = [];
  const run = async (sql: string) => (sqls.push(sql), { resultSets: [{ rows: [['Latin1_General_CI_AS', 'Latin1 ...']] }] });
  const coll = await ms.fields[0].items!(run);
  assert.match(sqls[0], /FROM sys\.fn_helpcollations\(\)/);
  assert.deepEqual(coll[0], { value: '', label: '(server default)' });
  assert.deepEqual(coll[1], { value: 'Latin1_General_CI_AS', label: 'Latin1 ...' });
  assert.deepEqual((await ms.fields[1].items!(run)).map((r) => r.value), ['', 'SIMPLE', 'FULL', 'BULK_LOGGED']);
  await ms.fields[2].items!(run);
  assert.match(sqls.at(-1)!, /FROM sys\.server_principals/);
});

test('new database: SQL Server script = CREATE DATABASE (+ files, collation) + recovery + owner, names / paths quoted', () => {
  assert.deepEqual(ok('shop'), { sql: 'CREATE DATABASE [shop];', errors: [] });
  assert.equal(ok('sh]op', { collation: 'Latin1_General_100_CI_AS_SC_UTF8', recovery: 'SIMPLE', owner: "sa'x" }).sql, [
    'CREATE DATABASE [sh]]op]',
    '  COLLATE Latin1_General_100_CI_AS_SC_UTF8;',
    'ALTER DATABASE [sh]]op] SET RECOVERY SIMPLE;',
    "ALTER AUTHORIZATION ON DATABASE::[sh]]op] TO [sa'x];",
  ].join('\n'));
  // file: NAME wajib di klausa ON / LOG ON; FILENAME hanya bila folder diisi (nama file dari nama database)
  assert.equal(ok('shop', { dataSize: '64', dataGrowth: '64', logSize: '16', logPath: "D:\\Logs\\o'k\\" }).sql, [
    'CREATE DATABASE [shop]',
    '  ON (NAME = [shop], SIZE = 64MB, FILEGROWTH = 64MB)',
    "  LOG ON (NAME = [shop_log], FILENAME = N'D:\\Logs\\o''k\\shop_log.ldf', SIZE = 16MB);",
  ].join('\n'));
  assert.equal(ok('shop', { dataPath: '/var/opt/mssql/data' }).sql, "CREATE DATABASE [shop]\n  ON (NAME = [shop], FILENAME = N'/var/opt/mssql/data/shop.mdf');");
});

test('new database: SQL Server validation (sizes, collation, recovery)', () => {
  assert.deepEqual(ok('shop', { dataSize: '0', logGrowth: 'abc' }).errors, ['Data file size: whole number of MB, at least 1', 'Log file growth: whole number of MB, at least 1']);
  assert.deepEqual(ok('shop', { collation: 'x; DROP DATABASE y' }).errors, ['Invalid collation: x; DROP DATABASE y']);
  assert.deepEqual(ok('shop', { recovery: 'FAST' }).errors, ['Invalid recovery model: FAST']);
  assert.equal(ok('shop', { recovery: 'FAST' }).sql, '');
});

test('new database form: name, fields from the driver, Files folded, script preview, Create / Open in SQL Editor; read-only has no Create', () => {
  const h = newDbHtml('csp-src', { conn: 'local <x>', type: 'SQL Server' }, false);
  assert.match(h, /Content-Security-Policy[^>]+script-src 'nonce-/);
  assert.ok(h.includes('local &lt;x&gt;'), 'connection escaped');
  for (const id of ['name', 'fields', 'preview', 'create', 'openSql', 'errors']) assert.match(h, new RegExp(`id="${id}"`), id);
  assert.match(h, /<details/, 'folded group');
  const ro = newDbHtml('csp-src', { conn: 'x', type: 'SQL Server' }, true);
  assert.doesNotMatch(ro, /id="create"/);
  assert.match(ro, /read-only/i);
});

test('menus: New Database on SQL Server connections and the Databases folder, command title', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  const shown = (viewItem: string) => items.some((it) => it.command === 'moonageDaydream.newDatabase'
    && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test(viewItem));
  assert.ok(shown('conn.mssql.on') && shown('conn.mssql.off'));
  assert.ok(!shown('conn.consul.on'));
  assert.ok(shown('ms.databases'), 'right-click the Databases folder (SQL Server)');
  assert.ok(!shown('ms.systemDatabases'), 'not on System Databases');
  assert.ok(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === 'moonageDaydream.newDatabase' && c.title === 'New Database…'));
});

const my = drivers.mysql.newDatabase!;
test('new database: MySQL / MariaDB = character set + collation (from the server), name up to 64', async () => {
  assert.equal(drivers.mariadb.newDatabase, my, 'MariaDB shares it');
  assert.equal(my.maxName, 64);
  assert.deepEqual(my.fields.map((f) => [f.key, f.kind]), [['charset', 'choice'], ['collation', 'choice']]);
  const sqls: string[] = [];
  const run = async (sql: string) => (sqls.push(sql), { resultSets: [{ rows: [['utf8mb4', 'UTF-8 Unicode']] }] });
  assert.deepEqual((await my.fields[0].items!(run))[1], { value: 'utf8mb4', label: 'UTF-8 Unicode' });
  await my.fields[1].items!(run);
  assert.match(sqls[0], /information_schema\.character_sets/);
  assert.match(sqls[1], /information_schema\.collations/);
  assert.deepEqual(newDatabaseScript(my, 'sh`op', {}), { sql: 'CREATE DATABASE `sh``op`;', errors: [] });
  assert.equal(newDatabaseScript(my, 'shop', { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }).sql, 'CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;');
  assert.deepEqual(newDatabaseScript(my, 'shop', { charset: 'latin1', collation: 'utf8mb4_bin' }).errors, ['Collation utf8mb4_bin does not belong to character set latin1']);
  assert.deepEqual(newDatabaseScript(my, 'shop', { charset: 'x y' }).errors, ['Invalid character set: x y']);
  assert.deepEqual(newDatabaseScript(my, 'a'.repeat(65), {}).errors, ['Database name is at most 64 characters']);
});

test('menus: New Database also on MySQL / MariaDB / PostgreSQL connections (conn.live)', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const items: { command: string; when?: string }[] = pkg.contributes.menus['view/item/context'];
  assert.ok(items.some((it) => it.command === 'moonageDaydream.newDatabase' && new RegExp(/viewItem =~ \/(.+?)\/(?:\s|$)/.exec(it.when ?? '')![1]).test('conn.live.on')));
});

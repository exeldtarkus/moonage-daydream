import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { maskSecrets, newDatabaseScript } from '../db';
import { linkedServerForm, testLinkedServerSql } from '../mssql';
import { newDbHtml } from '../newDbHtml';

const ls = linkedServerForm;
const run = (name: string, v: Record<string, string> = {}) => newDatabaseScript(ls, name, v);

test('linked server: SQL Server by network name, current security context', () => {
  const r = run('REPORTS01');
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    "EXEC master.dbo.sp_addlinkedserver @server = N'REPORTS01', @srvproduct = N'SQL Server';",
    "EXEC master.dbo.sp_addlinkedsrvlogin @rmtsrvname = N'REPORTS01', @useself = N'True', @locallogin = NULL;",
  ].join('\n'));
});

test('linked server: alias with data source, provider, catalog, remote login and options', () => {
  const r = run("rep'x", { datasrc: 'db01\\SQL2022,1433', provider: '', catalog: 'sales', login: 'remote', rmtuser: 'reader', rmtpassword: "p'w", rpc_out: 'true', data_access: 'false' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.sql, [
    "EXEC master.dbo.sp_addlinkedserver @server = N'rep''x', @srvproduct = N'', @provider = N'MSOLEDBSQL', @datasrc = N'db01\\SQL2022,1433', @catalog = N'sales';",
    "EXEC master.dbo.sp_addlinkedsrvlogin @rmtsrvname = N'rep''x', @useself = N'False', @locallogin = NULL, @rmtuser = N'reader', @rmtpassword = N'p''w';",
    "EXEC master.dbo.sp_serveroption @server = N'rep''x', @optname = N'rpc out', @optvalue = N'true';",
    "EXEC master.dbo.sp_serveroption @server = N'rep''x', @optname = N'data access', @optvalue = N'false';",
  ].join('\n'));
});

test('linked server: validation (name noun, remote login user, option values, provider without data source)', () => {
  assert.deepEqual(run(' ').errors, ['Linked server name is required']);
  assert.ok(run('x', { login: 'remote' }).errors.includes('Remote login needs a remote user'));
  assert.ok(run('x', { rpc: 'yes' }).errors.includes('RPC must be true or false'));
  assert.ok(run('x', { provider: 'MSOLEDBSQL' }).errors.includes('Provider and catalog need a data source'));
  assert.ok(run('x', { login: 'other' }).errors.includes('Login must be current security context or remote login'));
});

test('linked server: password is masked for preview / editor, real value only for execute', () => {
  const v = { login: 'remote', rmtuser: 'u', rmtpassword: 'secret' };
  const shown = newDatabaseScript(ls, 'x', maskSecrets(ls, v)).sql;
  assert.match(shown, /@rmtpassword = N'\*\*\*'/);
  assert.doesNotMatch(shown, /secret/);
  assert.match(run('x', v).sql, /@rmtpassword = N'secret'/);
  assert.deepEqual(maskSecrets(ls, { login: 'remote', rmtpassword: '' }).rmtpassword, '');
});

test('linked server: test query and form page', () => {
  assert.equal(testLinkedServerSql("a'b"), "EXEC master.dbo.sp_testlinkedserver N'a''b';");
  const h = newDbHtml('csp', { conn: 'c', type: 'SQL Server', title: 'New Linked Server' }, false);
  assert.match(h, /<h1>New Linked Server<\/h1>/);
  assert.ok(h.includes("f.kind === 'password' ? 'password' : 'text'"));
  assert.match(newDbHtml('csp', { conn: 'c', type: 'x' }, false), /<h1>New Database<\/h1>/);
});

test('linked server: command and menus on SQL Server connections and the Linked Servers folder', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'moonageDaydream.newLinkedServer'));
  const whens = pkg.contributes.menus['view/item/context'].filter((m: { command: string }) => m.command === 'moonageDaydream.newLinkedServer').map((m: { when: string }) => m.when).join(' ');
  assert.match(whens, /conn\\\\\.mssql|conn\\\.mssql|conn\.mssql/);
  assert.match(whens, /ms\\\\\.linkedServers|ms\\\.linkedServers|ms\.linkedServers/);
});

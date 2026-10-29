import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FormData, formHtml, toConnection, validate } from '../connectionFormHtml';

const ok: FormData = { name: 'uat', host: '192.0.2.10', port: '1433', instance: ' SQLEXPRESS ', user: 'sa', password: 'x', database: '', trust: true };
const taken = { get: (n: string) => (n === 'used' ? {} : undefined) };

test('validate form', () => {
  assert.equal(validate(ok, taken), undefined);
  assert.match(validate({ ...ok, name: ' ' }, taken)!, /name is required/);
  assert.match(validate({ ...ok, name: 'used' }, taken)!, /already used/);
  assert.equal(validate({ ...ok, name: 'used' }, taken, 'used'), undefined); // edit tanpa ganti nama
  assert.match(validate({ ...ok, host: '' }, taken)!, /Host/);
  assert.match(validate({ ...ok, port: '70000' }, taken)!, /Port/);
});

test('toConnection trims and drops empty instance', () => {
  assert.equal(toConnection(ok).instance, 'SQLEXPRESS');
  assert.equal(toConnection({ ...ok, instance: '' }).instance, undefined);
  assert.equal(toConnection(ok).port, 1433);
});

test('formHtml escapes values and never renders the password', () => {
  const html = formHtml('csp', { ...toConnection(ok), name: 'a"<b>' });
  assert.ok(html.includes('value="a&quot;&lt;b&gt;"') && !html.includes('a"<b>'));
  assert.ok(html.includes('Leave empty to keep current password') && !html.includes('value="x"'));
});

test('Windows authentication (NTLM): validation and connection fields', () => {
  const win = { ...ok, auth: 'windows', domain: ' CORP ', user: 'jdoe' };
  assert.equal(validate({ ...win, domain: '' }, { get: () => undefined }), 'Domain is required for Windows authentication');
  assert.equal(validate(win, { get: () => undefined }), undefined);
  const c = toConnection(win);
  assert.equal(c.auth, 'windows');
  assert.equal(c.domain, 'CORP');
  assert.equal(toConnection(ok).auth, undefined, 'SQL login stays default');
  assert.ok(formHtml('csp', c).includes('<option value="windows" selected>') && !formHtml('csp', c).includes('id="domainrow" hidden'));
});

test('connection group: trimmed, empty = no group, suggestions in the form', () => {
  assert.equal(toConnection({ ...ok, group: ' prod ' }).group, 'prod');
  assert.ok(!('group' in toConnection({ ...ok, group: ' ' })));
  const html = formHtml('csp', { ...toConnection(ok), group: 'non-prod' }, ['non-prod', 'prod<x>']);
  assert.ok(html.includes('<option value="non-prod" selected>non-prod</option>') && html.includes('<option value="prod&lt;x&gt;">prod&lt;x&gt;</option>'), 'dropdown, escaped');
  assert.ok(html.includes('<option value="__new__">New group…</option>') && html.includes('<option value="">No group</option>'), 'new / no group options');
  const preset = formHtml('csp', undefined, ['dev'], 'prod');
  assert.ok(preset.includes('<option value="prod" selected>prod</option>'), 'Add Connection on a group folder preselects it');
  assert.ok(formHtml('csp', undefined, ['dev']).includes('<option value="" selected>No group</option>'), 'new connection: no group by default');
  assert.equal(validate({ ...ok, group: ' ' }, { get: () => undefined }), 'Group name is required');
});

test('connection color: dropdown, validation, banner text', async () => {
  const { bannerText } = await import('../connColor');
  assert.equal(toConnection({ ...ok, color: 'red' }).color, 'red');
  assert.ok(!('color' in toConnection({ ...ok, color: '' })));
  assert.equal(validate({ ...ok, color: 'chartreuse' }, { get: () => undefined }), 'Unknown color chartreuse');
  const { CONN_COLORS, cssColor } = await import('../connColor');
  assert.equal(Object.keys(CONN_COLORS).length, 15, 'palette size');
  assert.equal(cssColor('pink'), 'var(--vscode-terminal-ansiBrightMagenta)');
  const { CONN_HEX, gutterSvg } = await import('../connColor');
  assert.deepEqual(Object.keys(CONN_HEX), Object.keys(CONN_COLORS), 'hex for every color');
  assert.ok(Buffer.from(gutterSvg('teal').split(',')[1], 'base64').toString().includes('fill="#11a8cd"'), 'gutter svg uses the hex');
  assert.ok(formHtml('csp').includes('data-color="teal" title="Teal"'), 'all swatches rendered');
  const html = formHtml('csp', { ...toConnection(ok), color: 'green' });
  assert.ok(html.includes('class="sw on" data-color="green"') && html.includes('id="color" value="green"'), 'color swatch selected');
  assert.equal(bannerText({ name: 'orders-db', group: 'prod' }), 'you are using connection prod - orders-db');
  assert.equal(bannerText({ name: 'local' }), 'you are using connection local');
});

test('two-step form: database cards for a new connection, form directly when editing', () => {
  const fresh = formHtml('csp', undefined, [], undefined, { mysql: 'data:image/svg+xml;base64,AA==' });
  assert.ok(fresh.includes('<div id="step1">') && fresh.includes('<form id="f" hidden'), 'new: step 1 visible, form hidden');
  for (const t of ['mssql', 'mysql', 'mariadb', 'postgres', 'sqlite', 'mongodb']) assert.ok(fresh.includes(`data-type="${t}"`), t);
  assert.ok(fresh.includes('<img class="logo" src="data:image/svg+xml;base64,AA=="'), 'logo from data URI');
  assert.ok(fresh.includes("img-src data:"), 'CSP allows data: images only');
  const edit = formHtml('csp', toConnection(ok));
  assert.ok(edit.includes('<div id="step1" hidden>') && edit.includes('<form id="f" autocomplete'), 'edit: form directly');
});

test('database picker search terms include aliases', () => {
  const html = formHtml('csp');
  assert.ok(html.includes('id="dbq"'), 'search box');
  assert.ok(/data-type="postgres"[^>]*data-search="[^"]*\bpg\b/.test(html) && /data-type="mongodb"[^>]*data-search="[^"]*atlas/.test(html), 'aliases searchable');
  assert.ok(html.includes('Default port 1433') && html.includes('Connect →'), 'action row');
});

test('SSL/TLS, timeout, read-only and driver settings: validation and connection fields', () => {
  const none = { get: () => undefined };
  assert.match(validate({ ...ok, connectTimeout: '0' }, none)!, /timeout must be 1-3600/);
  assert.match(validate({ ...ok, connectTimeout: 'abc' }, none)!, /timeout must be 1-3600/);
  assert.equal(validate({ ...ok, connectTimeout: '' }, none), undefined, 'empty = driver default');
  assert.match(validate({ ...ok, options: [[' ', 'x']] }, none)!, /Driver setting name is required/);
  assert.match(validate({ ...ok, options: [['appName', 'a'], [' appName ', 'b']] }, none)!, /"appName" is set twice/);
  assert.equal(validate({ ...ok, options: [['', '']] }, none), undefined, 'empty row is ignored');

  const c = toConnection({ ...ok, ssl: false, connectTimeout: ' 30 ', readOnly: true, options: [[' appName ', 'moonage'], ['', '']] });
  assert.deepEqual([c.ssl, c.connectTimeout, c.readOnly, c.options], [false, 30, true, { appName: 'moonage' }]);
  const plain = toConnection(ok);
  assert.ok(!('connectTimeout' in plain) && !('readOnly' in plain) && !('options' in plain), 'defaults are not stored');
  const pg = toConnection({ ...ok, type: 'postgres', port: '5432', ssl: true, trust: true });
  assert.deepEqual([pg.ssl, pg.trustServerCertificate], [true, true], 'trust certificate for every database type');
});

test('formHtml: sections (Connection, SSL/TLS, Timeouts, Permissions, Driver settings) and import connection string', () => {
  const html = formHtml('csp');
  for (const sec of ['connection', 'ssl', 'timeouts', 'permissions', 'driver']) assert.ok(html.includes(`data-sec="${sec}"`), `nav ${sec}`);
  assert.ok(html.includes('Import connection string') && html.includes('id="connstr"'));
  const edit = formHtml('csp', { ...toConnection(ok), ssl: false, connectTimeout: 45, readOnly: true, options: { appName: 'a"b' } });
  assert.ok(!/id="ssl"[^>]*checked/.test(edit) && /id="readonly"[^>]*checked/.test(edit) && edit.includes('id="timeout" value="45"'));
  assert.ok(edit.includes('value="appName"') && edit.includes('value="a&quot;b"'), 'driver settings rows, escaped');
  assert.ok(/id="ssl"[^>]*checked/.test(formHtml('csp', toConnection(ok))), 'SQL Server: SSL on by default');
});

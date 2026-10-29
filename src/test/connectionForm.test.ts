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
  assert.equal(validate({ ...ok, color: 'pink' }, { get: () => undefined }), 'Unknown color pink');
  const html = formHtml('csp', { ...toConnection(ok), color: 'green' });
  assert.ok(html.includes('<option value="green" selected>Green</option>') && html.includes('<option value="">None</option>'));
  assert.equal(bannerText({ name: 'orders-db', group: 'prod' }), 'you are using connection prod - orders-db');
  assert.equal(bannerText({ name: 'local' }), 'you are using connection local');
});

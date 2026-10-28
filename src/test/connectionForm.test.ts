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

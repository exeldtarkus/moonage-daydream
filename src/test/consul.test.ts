import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConsulClient, backupJson, consulUrl, decodeKv, detectFormat, kvChildren, validateFormat } from '../consul';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** fetch palsu: catat request, jawab sesuai path */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const f = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ method: init.method ?? 'GET', url, headers: init.headers ?? {}, body: init.body });
    const u = new URL(url);
    const r = routes[`${init.method ?? 'GET'} ${u.pathname}`] ?? { status: 404, body: '' };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, text: async () => text, json: async () => JSON.parse(text) };
  };
  return { f: f as unknown as typeof fetch, calls };
}

const conn = { host: 'consul.example.com', port: 8500, ssl: false, datacenter: 'dc1' };

test('consul: URL with datacenter and query, key path encoded per segment', () => {
  assert.equal(consulUrl(conn, '/v1/kv/app/config', { keys: true, separator: '/' }), 'http://consul.example.com:8500/v1/kv/app/config?dc=dc1&keys&separator=%2F');
  assert.equal(consulUrl({ ...conn, ssl: true, datacenter: undefined }, '/v1/status/leader'), 'https://consul.example.com:8500/v1/status/leader');
  assert.equal(consulUrl(conn, `/v1/kv/${'a b/é'.split('/').map(encodeURIComponent).join('/')}`), 'http://consul.example.com:8500/v1/kv/a%20b/%C3%A9?dc=dc1');
});

test('consul: KV folders and keys of one level, values decoded, format detected / validated', () => {
  assert.deepEqual(kvChildren(['app/', 'app/config/', 'app/name', 'app/port'], 'app/'), { folders: ['app/config/'], keys: ['app/name', 'app/port'] });
  assert.deepEqual(kvChildren(['app/', 'db/', 'readme'], ''), { folders: ['app/', 'db/'], keys: ['readme'] });
  assert.equal(decodeKv({ Value: b64('{"a":1} é') }), '{"a":1} é');
  assert.equal(decodeKv({ Value: null }), '', 'folder / empty key');
  assert.equal(detectFormat('{ "a": 1 }'), 'json');
  assert.equal(detectFormat('[1, 2]'), 'json');
  assert.equal(detectFormat('server:\n  port: 8080\n'), 'yaml');
  assert.equal(detectFormat('plain value'), 'text');
  assert.equal(validateFormat('json', '{"a":1}'), undefined);
  assert.match(validateFormat('json', '{"a":')!, /Invalid JSON/);
  assert.equal(validateFormat('text', '{"a":'), undefined, 'text is not validated');
});

test('consul client: token header, get value with ModifyIndex, put with CAS, delete recurse', async () => {
  const { f, calls } = fakeFetch({
    'GET /v1/kv/app/name': { body: [{ Key: 'app/name', Value: b64('shop'), ModifyIndex: 42, Flags: 0, Session: '' }] },
    'PUT /v1/kv/app/name': { body: 'true' },
    'DELETE /v1/kv/app/': { body: 'true' },
    'GET /v1/status/leader': { body: '"10.0.0.1:8300"' },
  });
  const c = new ConsulClient(conn, 'secret-token', f);
  assert.deepEqual(await c.get('app/name'), { key: 'app/name', value: 'shop', modifyIndex: 42, flags: 0, session: '' });
  assert.equal(calls[0].headers['X-Consul-Token'], 'secret-token');
  assert.equal(await c.put('app/name', 'shop-2', 42), true);
  assert.equal(calls[1].url, 'http://consul.example.com:8500/v1/kv/app/name?dc=dc1&cas=42');
  assert.equal(calls[1].body, 'shop-2');
  assert.equal(await c.delete('app/', true), true);
  assert.match(calls[2].url, /\/v1\/kv\/app\/\?dc=dc1&recurse$/);
  assert.equal(await c.leader(), '10.0.0.1:8300');
  assert.equal(new ConsulClient(conn, '', f) && (await new ConsulClient(conn, '', f).leader(), calls.at(-1)!.headers['X-Consul-Token']), undefined, 'no token header without a token');
});

test('consul client: missing key, CAS conflict, ACL denied, server error', async () => {
  const { f } = fakeFetch({
    'PUT /v1/kv/app/name': { body: 'false' },
    'GET /v1/kv/secret': { status: 403, body: 'Permission denied' },
    'GET /v1/kv/boom': { status: 500, body: 'rpc error' },
  });
  const c = new ConsulClient(conn, 't', f);
  assert.equal(await c.get('missing'), undefined, '404 = no key');
  assert.equal(await c.put('app/name', 'x', 7), false, 'changed by someone else since it was opened');
  await assert.rejects(c.get('secret'), /No permission.*ACL token.*key:read/);
  await assert.rejects(c.get('boom'), /Consul 500: rpc error/);
});

test('consul: backup in consul kv export format (restore with consul kv import)', async () => {
  const entries = [{ Key: 'app/name', Value: b64('shop'), Flags: 0 }, { Key: 'app/', Value: null, Flags: 0 }];
  assert.deepEqual(JSON.parse(backupJson(entries)), [{ key: 'app/name', flags: 0, value: b64('shop') }, { key: 'app/', flags: 0, value: '' }]);
  const { f, calls } = fakeFetch({ 'GET /v1/kv/app/': { body: entries } });
  assert.deepEqual(await new ConsulClient(conn, 't', f).export('app/'), entries);
  assert.match(calls[0].url, /\/v1\/kv\/app\/\?dc=dc1&recurse$/);
});

test('consul: key uri moonage-consul://<connection>/<key> round trip', async () => {
  const { consulUri, parseConsulUri } = await import('../consul');
  const u = consulUri('consul prod', 'app/config é');
  assert.equal(u, 'moonage-consul://consul%20prod/app/config%20%C3%A9');
  assert.deepEqual(parseConsulUri(u), { conn: 'consul prod', key: 'app/config é' });
});

test('consul: save = validate, backup the current value, PUT with CAS; conflict / invalid refused', async () => {
  const { saveKv } = await import('../consul');
  const backups: string[] = [];
  const { f, calls } = fakeFetch({
    'GET /v1/kv/app/config': { body: [{ Key: 'app/config', Value: b64('{"a":1}'), Flags: 0, ModifyIndex: 9 }] },
    'PUT /v1/kv/app/config': { body: 'true' },
  });
  const c = new ConsulClient(conn, 't', f);
  const r = await saveKv(c, 'app/config', '{"a":2}', 9, async (json) => { backups.push(json); return '/backups/x.json'; });
  assert.deepEqual(r, { backup: '/backups/x.json' });
  assert.deepEqual(JSON.parse(backups[0]), [{ key: 'app/config', flags: 0, value: b64('{"a":1}') }], 'backup before the change');
  assert.ok(calls.some((x) => x.method === 'PUT' && /cas=9/.test(x.url) && x.body === '{"a":2}'));
  await assert.rejects(saveKv(c, 'app/config', '{"a":', 9, async () => ''), /Invalid JSON/, 'invalid JSON (current value is JSON) never sent');
  const { f: f2 } = fakeFetch({ 'GET /v1/kv/app/config': { body: [{ Key: 'app/config', Value: b64('x'), Flags: 0, ModifyIndex: 12 }] }, 'PUT /v1/kv/app/config': { body: 'false' } });
  await assert.rejects(saveKv(new ConsulClient(conn, 't', f2), 'app/config', 'y', 9, async () => ''), /changed in Consul since you opened it/);
  const { f: f3, calls: c3 } = fakeFetch({ 'PUT /v1/kv/new/key': { body: 'true' } });
  assert.deepEqual(await saveKv(new ConsulClient(conn, 't', f3), 'new/key', 'v', 0, async () => 'never'), { backup: undefined }, 'new key: nothing to back up');
  assert.match(c3.at(-1)!.url, /cas=0$/, 'new key only if it does not exist yet');
});

test('consul: delete = count + backup every key under it, then DELETE (recurse for folders)', async () => {
  const { deleteKv } = await import('../consul');
  const entries = [{ Key: 'app/', Value: null, Flags: 0 }, { Key: 'app/a', Value: b64('1'), Flags: 0 }, { Key: 'app/b', Value: b64('2'), Flags: 0 }];
  const { f, calls } = fakeFetch({ 'GET /v1/kv/app/': { body: entries }, 'DELETE /v1/kv/app/': { body: 'true' } });
  let saved = '';
  const r = await deleteKv(new ConsulClient(conn, 't', f), 'app/', async (json) => { saved = json; return '/b/app.json'; });
  assert.deepEqual(r, { deleted: 3, backup: '/b/app.json' });
  assert.equal(JSON.parse(saved).length, 3);
  assert.match(calls.at(-1)!.url, /\/v1\/kv\/app\/\?dc=dc1&recurse$/);
});

test('consul driver: Test connection asks the leader; any other text is refused (not SQL)', async () => {
  const { consulDriver } = await import('../consul');
  const { f, calls } = fakeFetch({ 'GET /v1/status/leader': { body: '"10.0.0.5:8300"' } });
  const old = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const c = { name: 'c', type: 'consul' as const, host: 'consul.example.com', port: 8500, user: '', database: 'dc1', trustServerCertificate: false };
    const r = await consulDriver.run(c, 'tok', consulDriver.testSql);
    assert.deepEqual(r.resultSets[0].rows[0], ['10.0.0.5:8300', 'dc1']);
    assert.equal(calls[0].headers['X-Consul-Token'], 'tok');
    await assert.rejects(consulDriver.run(c, 'tok', 'SELECT 1'), /no SQL/);
  } finally {
    globalThis.fetch = old;
  }
});

test('consul dashboard: leader / peers, member status, health per service, check totals', async () => {
  const { dashboardSummary } = await import('../consul');
  const s = dashboardSummary({
    leader: '10.0.0.1:8300', peers: ['10.0.0.1:8300', '10.0.0.2:8300', '10.0.0.3:8300'],
    members: [{ Name: 'srv-1', Addr: '10.0.0.1', Status: 1 }, { Name: 'srv-2', Addr: '10.0.0.2', Status: 4 }, { Name: 'cli-1', Addr: '10.0.0.9', Status: 3 }],
    services: { consul: [], web: ['v2', 'blue'], db: [] },
    nodes: [{ Node: 'srv-1', Address: '10.0.0.1', Datacenter: 'dc1' }],
    health: [
      { Node: 'srv-1', CheckID: 'serfHealth', Name: 'Serf', Status: 'passing', ServiceName: '', Output: '' },
      { Node: 'srv-1', CheckID: 'web-1', Name: 'web http', Status: 'passing', ServiceName: 'web', Output: '' },
      { Node: 'srv-2', CheckID: 'web-2', Name: 'web http', Status: 'critical', ServiceName: 'web', Output: 'connection refused' },
      { Node: 'srv-2', CheckID: 'db-1', Name: 'db tcp', Status: 'warning', ServiceName: 'db', Output: 'slow' },
    ],
  });
  assert.deepEqual([s.leader, s.peers], ['10.0.0.1:8300', 3]);
  assert.deepEqual(s.members.map((m) => [m.name, m.status]), [['srv-1', 'alive'], ['srv-2', 'failed'], ['cli-1', 'left']]);
  assert.deepEqual(s.services, [
    { name: 'consul', tags: '', passing: 0, warning: 0, critical: 0 },
    { name: 'db', tags: '', passing: 0, warning: 1, critical: 0 },
    { name: 'web', tags: 'v2, blue', passing: 1, warning: 0, critical: 1 },
  ], 'sorted, worst checks visible');
  assert.deepEqual(s.checks, { passing: 2, warning: 1, critical: 1 });
  assert.deepEqual(s.failing.map((c) => [c.node, c.check, c.status, c.output]), [['srv-2', 'web http', 'critical', 'connection refused'], ['srv-2', 'db tcp', 'warning', 'slow']]);
  assert.equal(s.nodes.length, 1);
});

test('consul dashboard panel: refresh choices, pause, sections, escaped title', async () => {
  const { consulDashboardHtml } = await import('../consulDashHtml');
  const html = consulDashboardHtml('csp', 'consul <prod>');
  for (const s of ['5', '10', '30', '60']) assert.ok(html.includes(`<option value="${s}000"`), `refresh ${s}s`);
  assert.ok(html.includes('id="pause"'));
  for (const id of ['cards', 'services', 'failing', 'nodes', 'members']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('consul &lt;prod&gt;') && !html.includes('consul <prod>'));
});

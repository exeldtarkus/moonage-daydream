import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearCache, dirSize, pruneMeta, readMeta, refreshMeta, removeMeta } from '../metaCache';
import type { DbObject, ListKind } from '../db';

const objects: Record<string, Partial<Record<ListKind, DbObject[]>>> = {
  shop: { table: [{ schema: '', name: 'orders' }], view: [{ schema: '', name: 'v_orders' }], procedure: [] },
  'hr/2026': { table: [{ schema: 'dbo', name: 'staff' }] },
};
const src = (dbs: string[], fail?: string) => ({
  databases: async () => dbs,
  objects: async (db: string, kind: ListKind) => { if (db === fail) throw new Error('denied'); return objects[db]?.[kind] ?? []; },
});

test('metadata cache: one chunk file per connection + database, read back as records for Find Object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-meta-'));
  try {
    const errors: string[] = [];
    await refreshMeta(dir, 'lab/1', src(['shop', 'hr/2026']), (db, e) => errors.push(`${db}:${(e as Error).message}`));
    assert.deepEqual(errors, []);
    const files = readdirSync(join(dir, encodeURIComponent('lab/1'))).sort();
    assert.deepEqual(files, [encodeURIComponent('hr/2026') + '.json', 'shop.json'].sort());
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, encodeURIComponent('lab/1'), 'shop.json')).mode & 0o777, 0o600);
    await refreshMeta(dir, 'other', src(['shop']), () => undefined);
    const recs = (await readMeta(dir)).map((r) => `${r.conn}|${r.db}|${r.kind}|${r.schema}.${r.name}`).sort();
    assert.deepEqual(recs, [
      'lab/1|hr/2026|db|.hr/2026', 'lab/1|hr/2026|table|dbo.staff', 'lab/1|shop|db|.shop', 'lab/1|shop|table|.orders', 'lab/1|shop|view|.v_orders',
      'other|shop|db|.shop', 'other|shop|table|.orders', 'other|shop|view|.v_orders',
    ]);
    assert.deepEqual((await readMeta(dir, 'other')).length, 3, 'one connection only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata cache: refresh drops databases that are gone, keeps the old chunk of a database that failed, remove deletes a connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-meta-'));
  try {
    await refreshMeta(dir, 'lab', src(['shop', 'hr/2026']), () => undefined);
    const failed: string[] = [];
    await refreshMeta(dir, 'lab', src(['hr/2026'], 'hr/2026'), (db) => failed.push(db));
    assert.deepEqual(failed, ['hr/2026']);
    assert.deepEqual((await readMeta(dir, 'lab')).map((r) => `${r.db}|${r.name}`).sort(), ['hr/2026|hr/2026', 'hr/2026|staff'], 'shop dropped, hr kept from the old chunk');
    await removeMeta(dir, 'lab');
    assert.deepEqual(await readMeta(dir), []);
    assert.deepEqual(await readMeta(join(dir, 'missing')), [], 'no cache folder yet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata cache: prune deletes the cache of connections that no longer exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-meta-'));
  try {
    await refreshMeta(dir, 'keep/1', src(['shop']), () => undefined);
    await refreshMeta(dir, 'gone', src(['shop']), () => undefined);
    await pruneMeta(dir, ['keep/1', 'never cached']);
    assert.deepEqual(readdirSync(dir), [encodeURIComponent('keep/1')]);
    await pruneMeta(join(dir, 'missing'), []); // folder belum ada: tidak error
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear cache: reports the size, then deletes the whole cache folder (missing folder = 0 bytes, no error)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'md-meta-'));
  try {
    const cache = join(dir, 'moonage-cache');
    await refreshMeta(join(cache, 'metadata'), 'lab', src(['shop', 'hr/2026']), () => undefined);
    const size = await dirSize(cache);
    assert.ok(size > 50, `size ${size}`);
    await clearCache(cache);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(await dirSize(cache), 0);
    await clearCache(cache);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

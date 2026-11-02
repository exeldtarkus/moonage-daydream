import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ttlCache } from '../memo';

test('ttlCache: reuses a value until it expires, fresh loads refresh it, failures are not kept', async () => {
  let now = 0, calls = 0;
  const cache = ttlCache(1000, () => now);
  const load = async () => ++calls;
  assert.equal(await cache.get('k', load), 1);
  assert.equal(await cache.get('k', load), 1);
  now = 1001;
  assert.equal(await cache.get('k', load), 2);
  // fresh: selalu memuat ulang dan menyimpan hasil terbaru
  assert.equal(await cache.get('k', load, true), 3);
  assert.equal(await cache.get('k', load), 3);
  await assert.rejects(cache.get('bad', async () => { throw new Error('x'); }));
  assert.equal(await cache.get('bad', async () => 7), 7);
  cache.clear();
  assert.equal(await cache.get('k', load), 4);
});

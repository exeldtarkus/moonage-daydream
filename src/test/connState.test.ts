import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { idleConnections } from '../db';

test('idleConnections: connected, unused for N minutes, not busy (query running / open transaction)', () => {
  const min = 60_000;
  const lastUsed = new Map([['a', 0], ['b', 9 * min], ['busy', 0], ['closed', 0]]);
  const open = (name: string) => name !== 'closed';
  assert.deepEqual(idleConnections(10 * min, lastUsed, 5, open, new Set(['busy'])), ['a'], 'b used 1 minute ago, busy has work, closed already closed');
  assert.deepEqual(idleConnections(10 * min, lastUsed, 0, open, new Set()), [], '0 = auto disconnect off');
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { arrangeOpen, moveInOrder } from '../openOrder';

const it = (uri: string) => ({ uri });
const uris = (xs: { uri: string }[]) => xs.map((x) => x.uri);

test('open order: pinned first, then the saved order, new tabs at the end in tab order', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map(it);
  const r = arrangeOpen(items, ['c', 'x', 'a'], ['d']);
  assert.deepEqual(uris(r), ['d', 'c', 'a', 'b', 'e']);
  assert.deepEqual(r.map((x: { pinned: boolean }) => x.pinned), [true, false, false, false, false]);
  assert.deepEqual(uris(arrangeOpen(items, [], [])), ['a', 'b', 'c', 'd', 'e'], 'no saved order = tab order');
  assert.deepEqual(uris(arrangeOpen(items, ['e', 'd'], ['b', 'e'])), ['e', 'b', 'd', 'a', 'c'], 'pinned keep the saved order among themselves');
});

test('open order: drop before the target, several at once, on empty space = end; result lists only open items', () => {
  const shown = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveInOrder(shown, ['d'], 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveInOrder(shown, ['a', 'c'], 'd'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveInOrder(shown, ['b'], undefined), ['a', 'c', 'd', 'b']);
  assert.deepEqual(moveInOrder(shown, ['b'], 'b'), shown, 'drop on itself: unchanged');
});

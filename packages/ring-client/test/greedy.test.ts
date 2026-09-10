import assert from 'node:assert/strict';
import test from 'node:test';

import type { Denomination } from '@opaque/protocol-types';
import { greedyDecompose, greedySelectNotes } from '../src/greedy.ts';

test('greedy decomposition takes the maximum count at each descending denomination', () => {
  assert.deepEqual(greedyDecompose(47_000_000n), [20_000_000, 20_000_000, 5_000_000, 2_000_000]);
});

test('greedy selection minimizes selected eligible notes and refuses an exact payment it cannot cover', () => {
  const notes: Denomination[] = [20_000_000, 20_000_000, 10_000_000, 5_000_000, 2_000_000, 1_000_000];
  assert.deepEqual(greedySelectNotes(47_000_000n, notes), [20_000_000, 20_000_000, 5_000_000, 2_000_000]);
  assert.throws(() => greedySelectNotes(47_000_000n, [20_000_000, 20_000_000, 5_000_000] as Denomination[]), /cannot cover/);
});

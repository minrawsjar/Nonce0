import assert from 'node:assert/strict';
import test from 'node:test';

import type { Denomination } from '@opaque/protocol-types';
import { greedyDecompose, greedySelectNotes } from '../src/greedy.ts';

test('greedy decomposition takes the maximum count at each descending denomination', () => {
  assert.deepEqual(greedyDecompose(47_000_000n), [20_000_000, 20_000_000, 5_000_000, 2_000_000]);
  assert.deepEqual(greedyDecompose(70_000_000n), [50_000_000, 20_000_000]);
  assert.deepEqual(greedyDecompose(125_000_000n), [100_000_000, 20_000_000, 5_000_000]);
});

test('greedy selection minimizes selected eligible notes and refuses an exact payment it cannot cover', () => {
  const notes: Denomination[] = [20_000_000, 20_000_000, 10_000_000, 5_000_000, 2_000_000, 1_000_000];
  assert.deepEqual(greedySelectNotes(47_000_000n, notes), [20_000_000, 20_000_000, 5_000_000, 2_000_000]);
  assert.throws(() => greedySelectNotes(47_000_000n, [20_000_000, 20_000_000, 5_000_000] as Denomination[]), /cannot cover/);
});

test('the approved seven-bucket policy is greedy-optimal through the deposit limit', () => {
  const buckets = [1, 2, 5, 10, 20, 50, 100];
  const best = Array<number>(1_001).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  for (let amount = 1; amount <= 1_000; amount++) {
    best[amount] = Math.min(...buckets.filter((bucket) => bucket <= amount).map((bucket) => best[amount - bucket]! + 1));
    assert.equal(greedyDecompose(BigInt(amount * 1_000_000)).length, best[amount], `${amount} USDC`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAmount } from './index.ts';

const SIZES = [1, 2, 5, 10, 20, 50, 100];
const held = (entries: [number, number][]) => new Map(entries);

test('a deposit is the greedy split', () => {
  assert.deepEqual([...makeAmount(123, SIZES)!], [[100, 1], [20, 1], [2, 1], [1, 1]]);
});

test('a send finds the exact combination greedy misses', () => {
  assert.deepEqual([...makeAmount(60, SIZES, held([[50, 1], [20, 3]]))!], [[20, 3]]);
  assert.deepEqual([...makeAmount(6, SIZES, held([[5, 1], [2, 3]]))!], [[2, 3]]);
  assert.deepEqual([...makeAmount(70, SIZES, held([[50, 1], [20, 3]]))!], [[50, 1], [20, 1]]);
});

test('a send uses the fewest notes, and refuses what nothing makes', () => {
  assert.deepEqual([...makeAmount(10, SIZES, held([[5, 2], [2, 5], [1, 10]]))!], [[5, 2]]);
  assert.equal(makeAmount(30, SIZES, held([[100, 1]])), undefined);
  assert.equal(makeAmount(3, SIZES, held([[2, 2]])), undefined);
});

test('a send matches brute force on every small holding', () => {
  const small = [1, 2, 5, 10];
  for (let mask = 0; mask < 4 ** small.length; mask++) {
    const have = new Map(small.map((d, i) => [d, Math.floor(mask / 4 ** i) % 4]));
    for (let amount = 1; amount <= 40; amount++) {
      let fewest = Infinity;
      const walk = (i: number, rest: number, n: number): void => {
        if (rest === 0) { fewest = Math.min(fewest, n); return; }
        if (i === small.length) return;
        for (let k = 0; k <= have.get(small[i]!)! && k * small[i]! <= rest; k++) walk(i + 1, rest - k * small[i]!, n + k);
      };
      walk(0, amount, 0);
      const got = makeAmount(amount, small, have);
      const count = got === undefined ? Infinity : [...got.values()].reduce((a, b) => a + b, 0);
      if (got !== undefined) assert.equal([...got].reduce((sum, [d, k]) => sum + d * k, 0), amount);
      if (got !== undefined) for (const [d, k] of got) assert.ok(k <= have.get(d)!);
      assert.equal(count, fewest, `${amount} from ${[...have]}`);
    }
  }
});

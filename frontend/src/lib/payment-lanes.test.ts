import assert from 'node:assert/strict';
import test from 'node:test';

import { runPaymentLanes } from './payment-lanes.ts';

test('runs no more than four note payments at a time and keeps going after one fails', async () => {
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const completed: number[] = [];

  const results = await runPaymentLanes([1, 2, 3, 4], 4, async (note) => {
    active++;
    peak = Math.max(peak, active);
    started.push(note);
    await new Promise((resolve) => setTimeout(resolve, note === 1 ? 20 : 2));
    active--;
    if (note === 2) throw new Error('attester unavailable');
    completed.push(note);
    return note;
  });

  assert.equal(peak, 4);
  assert.deepEqual(started.sort(), [1, 2, 3, 4]);
  assert.deepEqual(completed.sort(), [1, 3, 4]);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('does not treat an undefined item as the end of a queue', async () => {
  const seen: unknown[] = [];
  const results = await runPaymentLanes<unknown, string>([undefined, 'last'], 1, async (item) => {
    seen.push(item);
    return String(item);
  });

  assert.deepEqual(seen, [undefined, 'last']);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { healthWindow, nodeId } from '../../chain/relay-directory.ts';

test('node_id_is_the_directory_id_right_padded', () => {
  assert.equal(nodeId('R1'), `0x5231${'00'.repeat(30)}`);
});

test('health_is_measured_over_the_window_not_since_boot', () => {
  const relay = { relayId: 'R1' as never, accepted: 0, released: 0, batches: 0, undelivered: 0 };
  const window = healthWindow([relay]);

  assert.deepEqual(window()[0], { nodeId: nodeId('R1'), reliabilityBps: 10_000, batchOccupancy: 0, recentSelections: 0 }, 'idle is not failing');

  Object.assign(relay, { accepted: 12, released: 10, batches: 4, undelivered: 1 });
  const busy = window()[0]!;
  assert.equal(busy.reliabilityBps, 9_000);
  assert.equal(busy.batchOccupancy, 3); // 10 / 4, rounded
  assert.equal(busy.recentSelections, 12);

  Object.assign(relay, { accepted: 13, released: 11, batches: 5 });
  assert.deepEqual(window()[0], { nodeId: nodeId('R1'), reliabilityBps: 10_000, batchOccupancy: 1, recentSelections: 1 }, 'an old failure has aged out');
});

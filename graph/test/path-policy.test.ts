import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure, type RelayNode } from '@opaque/protocol-types';
import { MarkovPathPolicy } from '../src/path-policy.ts';

const node = (index: number): RelayNode => ({
  id: `relay-${index}` as never, endpoint: `https://relay-${index}.example`, kemPublicKey: `0x${'11'.repeat(32)}` as never,
  keyEpoch: 1n, operatorId: `operator-${index}`, reliabilityScore: 9_000 as never,
  batchOccupancy: 2, recentSelectionCount: 0, lastSeenAt: 1_000n as never,
});

test('path selection refuses exactly three relays: that would be a standing circuit', () => {
  const policy = new MarkovPathPolicy({ random: () => 0 });
  assert.throws(
    () => policy.selectPath({ nodes: [1, 2, 3].map(node), directoryVersion: '1', observedAt: 1_000n as never }),
    (error: unknown) => error instanceof ProtocolFailure && error.code === 'INSUFFICIENT_RELAYS',
  );
});

test('path selection draws three distinct operators from a six-relay pool', () => {
  const policy = new MarkovPathPolicy({ random: () => 0 });
  const path = policy.selectPath({ nodes: [1, 2, 3, 4, 5, 6].map(node), directoryVersion: '1', observedAt: 1_000n as never });
  assert.deepEqual(path.nodes.map((entry) => entry.operatorId), ['operator-1', 'operator-2', 'operator-3']);
});

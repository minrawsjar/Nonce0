import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address, RelayNode, RingSnapshot } from '@opaque/protocol-types';
import { asChainId, asDenomination, asUnixSeconds } from '@opaque/protocol-types/codecs.js';
import { evaluatePublicReadiness } from '../src/privacy-score.ts';

const scope = { chainId: asChainId(5_042_002n), pool: `0x${'11'.repeat(20)}` as Address, denomination: asDenomination(20_000_000) };
const ring = (count: number): RingSnapshot => ({ scope, candidates: Array.from({ length: count }, (_, index) => ({ commitment: `0x${index.toString(16).padStart(64, '0')}` as never, enrolledAtBlock: 1n, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null })), indexedThroughBlock: 12n, observedAt: asUnixSeconds(1_000n), policyVersion: 'opaque-privacy-v1' });
const relay = (id: number, operatorId = `operator-${id}`): RelayNode => ({ id: `relay-${id}` as never, endpoint: `https://relay-${id}.example`, kemPublicKey: `0x${'22'.repeat(32)}` as never, keyEpoch: 1n, operatorId, reliabilityScore: 9_000 as never, batchOccupancy: 2, recentSelectionCount: 0, lastSeenAt: asUnixSeconds(1_000n) });

test('readiness cannot average a weak ring bucket away with healthy relays', () => {
  const conditions = evaluatePublicReadiness(ring(4), { nodes: [1, 2, 3, 4, 5, 6].map((id) => relay(id)), directoryVersion: '1', observedAt: asUnixSeconds(1_000n) });
  assert.equal(conditions.ringFreshnessScore, 5_000);
  assert.equal(conditions.privacyScore, 5_000);
});

test('readiness rejects a six-node mesh controlled by fewer than three operators', () => {
  const conditions = evaluatePublicReadiness(ring(8), { nodes: [1, 2, 3, 4, 5, 6].map((id) => relay(id, id < 4 ? 'operator-a' : 'operator-b')), directoryVersion: '1', observedAt: asUnixSeconds(1_000n) });
  assert.equal(conditions.meshHealthScore, 0);
  assert.equal(conditions.privacyScore, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address, PoolScope, RingSnapshot } from '@opaque/protocol-types';
import { asChainId } from '@opaque/protocol-types/codecs.js';
import { selectDecoys } from '../src/selection.ts';

const scope: PoolScope = { chainId: asChainId(5_042_002n), pool: `0x${'11'.repeat(20)}` as Address, denomination: 20_000_000 };
const candidate = (n: number) => ({
  commitment: `0x${n.toString(16).padStart(2, '0').repeat(32)}` as RingSnapshot['candidates'][number]['commitment'],
  enrolledAtBlock: BigInt(n),
  timesUsedInRing: 0,
  fundingCluster: null,
  hasOtherActivity: true,
});

test('selection draws seven same-denomination decoys and fails closed below eight members', () => {
  const snapshot: RingSnapshot = {
    scope,
    candidates: Array.from({ length: 8 }, (_, i) => candidate(i + 1)),
    indexedThroughBlock: 100n,
    observedAt: 100n as RingSnapshot['observedAt'],
    policyVersion: 'v2',
  };
  const decoys = selectDecoys({ scope, snapshot, exclude: candidate(1).commitment, randomInt: () => 0 });
  assert.equal(decoys.length, 7);
  assert.throws(
    () => selectDecoys({ ...{ scope, snapshot: { ...snapshot, candidates: [candidate(1)] }, exclude: candidate(1).commitment }, randomInt: () => 0 }),
    /INSUFFICIENT_ANONYMITY/,
  );
});

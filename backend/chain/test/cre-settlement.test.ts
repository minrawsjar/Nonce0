import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address } from '@opaque/protocol-types';

import { authorizationArgs, batchSettlementArgs } from '../cre-settlement.ts';

const authorization = {
  id: `0x${'01'.repeat(32)}`, spendHash: `0x${'02'.repeat(32)}`, nullifier: `0x${'03'.repeat(32)}`,
  pool: `0x${'11'.repeat(20)}` as Address, recipient: `0x${'aa'.repeat(20)}` as Address,
  feeCollector: `0x${'bb'.repeat(20)}` as Address, grossAmount: 2_000_000n, feeAmount: 10_000n,
  feeBps: 50, expiresAt: 1_760_000_300n,
};

test('encodes the exact gate and atomic-batch arguments', () => {
  const [published] = authorizationArgs(authorization);
  assert.deepEqual(published, authorization);
  assert.deepEqual(batchSettlementArgs([authorization]), [[authorization.pool], [authorization.id]]);
});

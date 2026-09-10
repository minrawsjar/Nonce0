import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address, PrivateSpend, UnixSeconds } from '@opaque/protocol-types';
import { asPrivateSpend, derivePaymentContext } from '@opaque/protocol-types/codecs.js';

import { authorizePayment } from '../authorize-payment.ts';

const NOW = 1_760_000_000n as UnixSeconds;
const RECIPIENT = `0x${'aa'.repeat(20)}` as Address;
const FEES = `0x${'bb'.repeat(20)}` as Address;
const scope = (denomination: 1_000_000 | 2_000_000) => ({
  chainId: 5_042_002n as never,
  pool: `0x${(denomination === 1_000_000 ? '11' : '22').repeat(20)}` as Address,
  denomination,
});
const spend = (denomination: 1_000_000 | 2_000_000, nullifier: string): PrivateSpend => {
  const s = scope(denomination);
  return asPrivateSpend({
    mode: 'RING_8', scope: { ...s, chainId: '5042002' }, recipient: RECIPIENT,
    nullifier: `0x${nullifier.repeat(64).slice(0, 64)}`,
    paymentContext: derivePaymentContext(s, RECIPIENT), verifierId: `0x${'cc'.repeat(32)}`,
    proof: '0xdeadbeef', ring: Array.from({ length: 8 }, (_, i) => `0x${String(i).repeat(64).slice(0, 64)}`),
  });
};

test('publishes one exact CRE authorization only after every ring spend verifies', async () => {
  const published: unknown[] = [];
  const result = await authorizePayment({
    intentId: 'intent-1' as never,
    spends: [spend(2_000_000, '1'), spend(1_000_000, '2')],
    feeBps: 50,
    feeCollector: FEES,
    expiresAt: (NOW + 300n) as UnixSeconds,
    now: NOW,
    verifyRingSpend: async () => true,
    publish: async (authorization) => void published.push(authorization),
  });
  assert.equal(published.length, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.grossAmount, 2_000_000n);
  assert.equal(result[0]!.feeAmount, 10_000n);
  assert.equal(result[1]!.grossAmount, 1_000_000n);
  assert.notEqual(result[0]!.id, result[1]!.id);
});

test('rejects a whole payment before publication when any ring proof fails', async () => {
  let published = 0;
  await assert.rejects(() => authorizePayment({
    intentId: 'intent-2' as never,
    spends: [spend(1_000_000, '3'), spend(2_000_000, '4')], feeBps: 50, feeCollector: FEES,
    expiresAt: (NOW + 300n) as UnixSeconds, now: NOW,
    verifyRingSpend: async (_, index) => index === 0,
    publish: async () => { published++; },
  }), /PROOF_REJECTED/);
  assert.equal(published, 0);
});

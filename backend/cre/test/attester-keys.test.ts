import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hex } from '@opaque/protocol-types';
import { asAddress, asChainId } from '@opaque/protocol-types/codecs.js';
import { encodeSignature, keyGen, pqDigest, sign, forsSchemeId } from '@opaque/pq-wallet';
import { PQKeyRegistry, userActionPayload } from '../../../packages/pq-wallet/src/registry.ts';

import { attesterCommitment, attesterSeed, createAttesterKeys } from '../attester-keys.ts';

// The pq-wallet in-memory registry mirrors PQKeyRegistry.sol byte for byte
// (both pinned by the same vectors), so rotation and takeover signatures that
// pass here are the ones the contract accepts.
const chainId = 31337n;
const attester = asAddress(`0x${'5a'.repeat(20)}`);
const master = new Uint8Array(32).fill(0x42);
const policy = { deadline: 'observe-only', allowLateRotation: true, pendingDisableOnRotation: 'preserve', repeatedDisable: 'restart' } as const;

function world(maxUses: bigint) {
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(master, 0), nextCommitment: attesterCommitment(master, 1), maxUses, rotationDeadline: 1_000n });
  const calls: string[] = [];
  const keys = createAttesterKeys({
    master, attester, chainId, maxUses, rotateWhenLeft: 1n, now: () => 100n,
    readState: async () => {
      const s = registry.stateOf(attester)!;
      return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses };
    },
    rotate: async (next, m, deadline, sig) => { calls.push('rotate'); registry.rotate(attester, next, m, deadline, sig); },
    takeover: async (next, m, sig) => { calls.push('takeover'); registry.takeover(attester, next, m, sig); },
  });
  // Stand-in for an attestation: whatever key current() hands back signs.
  const attest = async () => {
    const { forsSeed, useCount } = await keys.current();
    const key = keyGen(forsSeed);
    const payload = userActionPayload('0x1234');
    const digest = pqDigest({ chainId: asChainId(chainId), walletAddress: attester, schemeId: forsSchemeId(key.publicKey.params), useCount, payload });
    registry.consume(attester, '0x1234' as Hex, encodeSignature(key.publicKey, sign(key.secretKey, digest)));
  };
  return { registry, keys, calls, attest };
}

test('rotates_before_the_budget_runs_out_and_keeps_signing', async () => {
  const { registry, calls, attest } = world(3n);
  await attest();
  await attest(); // one left: the next current() rotates first
  await attest();
  assert.deepEqual(calls, ['rotate']);
  const s = registry.stateOf(attester)!;
  assert.equal(s.pkCommitment, attesterCommitment(master, 1), 'generation 1 is active');
  assert.equal(s.nextCommitment, attesterCommitment(master, 2), 'and generation 2 is committed');
  assert.equal(s.useCount, 1n, 'the new key has signed once');
});

test('an_exhausted_key_hands_over_to_the_next_generation', async () => {
  const { registry, calls, attest } = world(2n);
  // Burn the budget behind the manager's back, as a second process might.
  for (const count of [0n, 1n]) {
    const key = keyGen(attesterSeed(master, 0));
    const digest = pqDigest({ chainId: asChainId(chainId), walletAddress: attester, schemeId: forsSchemeId(key.publicKey.params), useCount: count, payload: userActionPayload('0x99') });
    registry.consume(attester, '0x99' as Hex, encodeSignature(key.publicKey, sign(key.secretKey, digest)));
  }
  assert.equal(registry.stateOf(attester)!.useCount, 2n);
  await attest();
  assert.deepEqual(calls, ['takeover']);
  assert.equal(registry.stateOf(attester)!.pkCommitment, attesterCommitment(master, 1));
  assert.equal(registry.stateOf(attester)!.useCount, 2n, 'takeover spent index 0, the attestation index 1');
});

test('refuses_a_registered_key_it_did_not_derive', async () => {
  const registry = new PQKeyRegistry({ chainId: asChainId(chainId), now: () => 100n, policy });
  registry.register(attester, { pkCommitment: attesterCommitment(new Uint8Array(32).fill(1), 0), nextCommitment: attesterCommitment(master, 1), maxUses: 4n, rotationDeadline: 1_000n });
  const keys = createAttesterKeys({
    master, attester, chainId, searchGenerations: 4,
    readState: async () => { const s = registry.stateOf(attester)!; return { pkCommitment: s.pkCommitment, useCount: s.useCount, maxUses: s.maxUses }; },
    rotate: async () => assert.fail('must not rotate'), takeover: async () => assert.fail('must not take over'),
  });
  await assert.rejects(keys.current(), { code: 'SIGNER_STATE_UNSAFE' });
});

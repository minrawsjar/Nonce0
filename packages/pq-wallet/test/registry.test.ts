import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { asAddress, asChainId } from '@opaque/protocol-types/codecs.js';
import type { Hex } from '@opaque/protocol-types';
import { pqDigest } from '../src/digest.ts';
import { keyGen, pkCommitment, sign, encodeSignature, forsSchemeId } from '../src/fors.ts';
import { PQKeyRegistry, assertUsable, DISABLE_TIMELOCK, userActionPayload, rotationPayload,
  disablePayload, takeoverPayload, type RegistryPolicy } from '../src/registry.ts';

const account = asAddress(`0x${'aa'.repeat(20)}`);
const attacker = asAddress(`0x${'bb'.repeat(20)}`);
const chainId = asChainId(31337n);
// Small TEST-ONLY trees keep state-machine tests fast. Default parameters are tested separately.
const keys = [1, 2, 3].map(n => keyGen(new Uint8Array(32).fill(n), { k: 8, a: 4 }));
const [a, b, c] = keys.map(k => pkCommitment(k.publicKey));
const policy: RegistryPolicy = { deadline: 'reject-actions', allowLateRotation: true,
  pendingDisableOnRotation: 'preserve', repeatedDisable: 'preserve' };
function setup(maxUses = 8n) {
  let now = 100n;
  const registry = new PQKeyRegistry({ chainId, now: () => now, policy });
  registry.register(account, { pkCommitment: a!, nextCommitment: b!, maxUses, rotationDeadline: 1000n });
  const signature = (payload: Hex, key = 0, count = registry.stateOf(account)!.useCount): Hex => {
    const pair = keys[key]!;
    return encodeSignature(pair.publicKey, sign(pair.secretKey,
      pqDigest({ chainId, walletAddress: account, schemeId: forsSchemeId(pair.publicKey.params), useCount: count, payload })));
  };
  return { registry, signature, time: (value: bigint) => { now = value; } };
}

test('registration_isolated_and_cannot_overwrite', () => {
  const { registry } = setup(); const original = registry.stateOf(account);
  registry.register(attacker, { pkCommitment: c!, nextCommitment: a!, maxUses: 1n, rotationDeadline: 1000n });
  assert.deepEqual(registry.stateOf(account), original);
  assert.throws(() => registry.register(account, { pkCommitment: c!, nextCommitment: a!, maxUses: 1n, rotationDeadline: 1000n }));
  assert.equal(Object.isFrozen(registry.stateOf(account)), true);
  assert.deepEqual(Object.keys(original!).sort(), ['pkCommitment', 'nextCommitment', 'useCount', 'maxUses', 'rotationDeadline', 'disableAfter'].sort());
});
test('registration_rejects_zero_budget', () => assert.throws(() => setup(0n), { code: 'INVALID_INPUT' }));
test('rotation_requires_current_pq_key_no_fallback', () => {
  const { registry, signature } = setup(); const original = registry.stateOf(account);
  for (const sig of ['0x' as Hex, signature(rotationPayload(c!, 8n, 2000n), 1)]) {
    assert.throws(() => registry.rotate(account, c!, 8n, 2000n, sig));
    assert.deepEqual(registry.stateOf(account), original);
  }
  assert.equal('setOwner' in registry || 'setAdmin' in registry || 'upgradeTo' in registry || 'recover' in registry, false);
});
test('old_use_count_replay_rejected_and_failure_does_not_mutate', () => {
  const { registry, signature } = setup(); const sig = signature(userActionPayload('0x1234'));
  registry.consume(account, '0x1234', sig);
  assert.throws(() => registry.consume(account, '0x1234', sig), { code: 'PROOF_REJECTED' });
  assert.equal(registry.stateOf(account)!.useCount, 1n);
});
test('last_permitted_use_then_rejection_at_and_past_maxUses', () => {
  const { registry, signature } = setup(1n);
  registry.consume(account, '0x12', signature(userActionPayload('0x12')));
  assert.equal(registry.stateOf(account)!.useCount, 1n);
  assert.throws(() => registry.consume(account, '0x12', signature(userActionPayload('0x12'))), { code: 'KEY_EXHAUSTED' });
  assert.throws(() => assertUsable({ ...registry.stateOf(account)!, useCount: 2n }, 100n), { code: 'KEY_EXHAUSTED' });
});
test('user_action_signature_cannot_authorize_rotation_or_disable', () => {
  const { registry, signature } = setup();
  assert.throws(() => registry.rotate(account, c!, 8n, 2000n, signature(userActionPayload(rotationPayload(c!, 8n, 2000n)))));
  assert.throws(() => registry.initiateDisable(account, signature(userActionPayload(disablePayload()))));
});
test('rotation_promotes_next_key_and_rejects_retired_key', () => {
  const { registry, signature } = setup();
  registry.rotate(account, c!, 8n, 2000n, signature(rotationPayload(c!, 8n, 2000n)));
  assert.equal(registry.stateOf(account)!.pkCommitment, b);
  assert.equal(registry.stateOf(account)!.useCount, 0n);
  assert.throws(() => registry.consume(account, '0x12', signature(userActionPayload('0x12'), 0)), { code: 'PROOF_REJECTED' });
  registry.consume(account, '0x12', signature(userActionPayload('0x12'), 1));
});
test('disable_boundary_before_at_after_30_days', () => {
  const { registry, signature, time } = setup();
  registry.initiateDisable(account, signature(disablePayload()));
  const at = registry.stateOf(account)!.disableAfter;
  assert.equal(at, 100n + DISABLE_TIMELOCK);
  assertUsable(registry.stateOf(account)!, at - 1n);
  for (const now of [at, at + 1n]) {
    time(now);
    assert.throws(() => registry.consume(account, '0x12', signature(userActionPayload('0x12'))), { code: 'EXPIRED' });
  }
});
test('takeover_requires_precommitted_next_key_and_elapsed_timelock', () => {
  const { registry, signature, time } = setup();
  registry.initiateDisable(account, signature(disablePayload()));
  const payload = takeoverPayload(c!, 8n);
  assert.throws(() => registry.takeover(account, c!, 8n, signature(payload, 1, 0n)), { code: 'EXPIRED' });
  time(registry.stateOf(account)!.disableAfter);
  assert.throws(() => registry.takeover(account, c!, 8n, signature(payload, 0, 0n)), { code: 'PROOF_REJECTED' });
  registry.takeover(account, c!, 8n, signature(payload, 1, 0n));
  assert.equal(registry.stateOf(account)!.pkCommitment, b);
  assert.equal(registry.stateOf(account)!.useCount, 1n);
  assert.equal(registry.stateOf(account)!.disableAfter, 0n);
});
test('explicit_deadline_policy_rejects_operations_but_allows_lifecycle', () => {
  const { registry, signature, time } = setup(); time(1000n);
  assert.throws(() => registry.consume(account, '0x12', signature(userActionPayload('0x12'))), { code: 'EXPIRED' });
  registry.rotate(account, c!, 8n, 2000n, signature(rotationPayload(c!, 8n, 2000n)));
});
test('explicit_pending_disable_policy_is_preserved_across_rotation', () => {
  const { registry, signature } = setup(); registry.initiateDisable(account, signature(disablePayload()));
  const at = registry.stateOf(account)!.disableAfter;
  registry.rotate(account, c!, 8n, 2000n, signature(rotationPayload(c!, 8n, 2000n)));
  assert.equal(registry.stateOf(account)!.disableAfter, at);
});
test('existing_solidity_registry_vectors_match_typescript', () => {
  const f = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/registry-vectors.json', import.meta.url), 'utf8'));
  const registry = new PQKeyRegistry({ chainId, now: () => 100n, policy });
  registry.register(account, { pkCommitment: f.pkA, nextCommitment: f.pkB, maxUses: 4n, rotationDeadline: 1000000n });
  registry.consume(account, f.userPayload, f.sigConsume0);
  registry.consume(account, f.userPayload, f.sigConsume1);
  assert.equal(registry.stateOf(account)!.useCount, 2n);
  const rotation = new PQKeyRegistry({ chainId, now: () => 100n, policy });
  rotation.register(account, { pkCommitment: f.pkA, nextCommitment: f.pkB, maxUses: 4n, rotationDeadline: 1000000n });
  rotation.rotate(account, f.pkC, BigInt(f.nextMaxUses), BigInt(f.nextDeadline), f.sigRotate0);
  assert.equal(rotation.stateOf(account)!.pkCommitment, f.pkB);
});
test('exhausted_key_hands_over_to_precommitted_next', () => {
  const { registry, signature } = setup(1n);
  const payload = takeoverPayload(c!, 8n);
  // A signature left: the next key cannot barge in.
  assert.throws(() => registry.takeover(account, c!, 8n, signature(payload, 1, 0n)), { code: 'EXPIRED' });
  registry.consume(account, '0x12', signature(userActionPayload('0x12')));
  // Exhausted: rotation would spend a signature the key no longer has.
  assert.throws(() => registry.rotate(account, c!, 8n, 2000n, signature(rotationPayload(c!, 8n, 2000n))));
  assert.throws(() => registry.takeover(account, c!, 8n, signature(payload, 0, 0n)), { code: 'PROOF_REJECTED' });
  registry.takeover(account, c!, 8n, signature(payload, 1, 0n));
  assert.equal(registry.stateOf(account)!.pkCommitment, b);
  assert.equal(registry.stateOf(account)!.nextCommitment, c);
  assert.equal(registry.stateOf(account)!.useCount, 1n);
});

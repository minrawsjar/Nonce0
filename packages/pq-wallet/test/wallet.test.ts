import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PqWallet } from '@opaque/protocol-types';
import { createPqWallet } from '../src/wallet.ts';
import { MockWalletChain, mockWalletOptions } from '../src/mock.ts';
import { asAddress } from '@opaque/protocol-types/codecs.js';

function setup() {
  const chain = new MockWalletChain();
  const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 } };
  const wallet: PqWallet = createPqWallet(options);
  return { chain, options, wallet };
}
test('frozen_wallet_interface_create_register_getState', async () => {
  const { wallet } = setup();
  const created = await wallet.create(); assert.equal(created.active, false);
  assert.match(await wallet.register(), /^0x[0-9a-f]{64}$/);
  const state = await wallet.getState(); assert.equal(state.active, true);
  assert.equal(state.chainUseCount, 0n); assert.equal(state.localSigningReservations, 0n);
  assert.deepEqual(Object.keys(state).sort(), ['accountAddress', 'pkCommitment', 'keyEpoch', 'chainUseCount', 'localSigningReservations', 'maxUses', 'rotationDeadline', 'active'].sort());
  assert.equal(Object.isFrozen(state), true);
});
test('dropped_operations_and_refresh_never_lower_local_reservations', async () => {
  const { wallet, options } = setup(); await wallet.create(); await wallet.register();
  const first = await wallet.signUserOperation('0x1234');
  const refreshed = createPqWallet(options);
  assert.deepEqual(await refreshed.signUserOperation('0x1234'), first);
  await refreshed.signUserOperation('0x1235');
  const state = await refreshed.getState();
  assert.equal(state.chainUseCount, 0n); assert.equal(state.localSigningReservations, 2n);
});
test('confirmed_operation_advances_chain_count_and_replay_fails', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  const signed = await wallet.signUserOperation('0x1234'); await chain.acceptUserOperation(signed);
  assert.equal((await wallet.getState()).chainUseCount, 1n);
  await assert.rejects(chain.acceptUserOperation(signed), { code: 'PROOF_REJECTED' });
});
test('pending_rotation_does_not_activate_next_key_until_confirmation', async () => {
  const { wallet, chain, options } = setup(); await wallet.create(); await wallet.register();
  const original = await wallet.getState(); chain.deferTransactions = true;
  await wallet.rotate();
  assert.equal((await wallet.getState()).pkCommitment, original.pkCommitment);
  assert.equal((await wallet.getState()).localSigningReservations, 1n);
  await assert.rejects(wallet.signUserOperation('0x1234'), { code: 'SIGNER_STATE_UNSAFE' });
  chain.mine();
  const restored = createPqWallet(options); const rotated = await restored.getState();
  assert.notEqual(rotated.pkCommitment, original.pkCommitment);
  assert.equal(rotated.keyEpoch, original.keyEpoch + 1n);
  assert.equal(rotated.localSigningReservations, 0n);
});
test('failed_rotation_submission_keeps_capacity_and_retry_uses_cached_bytes', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  chain.failNextSubmission = true;
  await assert.rejects(wallet.rotate(), { code: 'SETTLEMENT_REVERTED' });
  assert.equal((await wallet.getState()).localSigningReservations, 1n);
  await wallet.rotate();
  assert.equal((await wallet.getState()).keyEpoch, 1n);
});
test('disable_preserves_timelock_and_then_rejects_signing', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  await wallet.disable(); assert.equal((await wallet.getState()).active, true);
  chain.now += 30n * 24n * 60n * 60n;
  assert.equal((await wallet.getState()).active, false);
  await assert.rejects(wallet.signUserOperation('0x1234'), { code: 'EXPIRED' });
});
test('unavailable_adapter_errors_are_sanitized', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  chain.observe = async () => { throw new Error('SECRET transport detail'); };
  await assert.rejects(wallet.getState(), error => {
    assert.equal(String(error).includes('SECRET'), false); return true;
  });
});
test('wrong_epoch_or_chain_observation_fails_closed', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  const observe = chain.observe.bind(chain);
  chain.observe = async account => ({ ...await observe(account), keyEpoch: 99n });
  await assert.rejects(wallet.getState(), { code: 'SIGNER_STATE_UNSAFE' });
});
test('public_wallet_and_signatures_do_not_serialize_seed_material', async () => {
  const { wallet } = setup(); await wallet.create(); await wallet.register();
  assert.equal(JSON.stringify(wallet), '{}');
  const signed = await wallet.signUserOperation('0x1234');
  assert.deepEqual(Object.keys(signed).sort(), ['digest', 'signature', 'keyEpoch', 'signingReservation'].sort());
});
test('reopening_with_changed_entrypoint_configuration_fails_closed', async () => {
  const { wallet, options } = setup(); await wallet.create(); await wallet.register();
  const changed = createPqWallet({ ...options, authority: { ...options.authority, entryPoint: asAddress(`0x${'ab'.repeat(20)}`) } });
  await assert.rejects(changed.getState(), { code: 'SIGNER_STATE_UNSAFE' });
});
test('malformed_chain_observation_is_a_safe_protocol_failure', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  chain.observe = async () => null as unknown as Awaited<ReturnType<typeof chain.observe>>;
  await assert.rejects(wallet.getState(), { code: 'SIGNER_STATE_UNSAFE' });
});
test('malformed_prepared_operation_is_rejected_before_reservation', async () => {
  const { wallet, chain } = setup(); await wallet.create(); await wallet.register();
  chain.prepareUserOperation = async () => null as unknown as Awaited<ReturnType<typeof chain.prepareUserOperation>>;
  await assert.rejects(wallet.signUserOperation('0x12'), { code: 'PROOF_REJECTED' });
  assert.equal((await wallet.getState()).localSigningReservations, 0n);
});

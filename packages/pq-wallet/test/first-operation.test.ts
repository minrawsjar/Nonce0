import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPqWallet } from '../src/wallet.ts';
import { MockWalletChain, mockWalletOptions } from '../src/mock.ts';
import { validatePreparedOperation } from '../src/authority.ts';
import { forsSchemeId } from '../src/fors.ts';

// An account can deploy itself: its first UserOperation carries initCode that
// creates it for these keys and registers them. The wallet signs that one
// operation unregistered, and nothing else.
async function unregistered() {
  const chain = new MockWalletChain();
  const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 } };
  const wallet = createPqWallet(options);
  const state = await wallet.create();
  const record = (await options.walletStore.readWallet(options.walletId))!;
  const own = { pkCommitment: record.active, nextCommitment: record.next, maxUses: options.maxUses, rotationDeadline: record.rotationDeadline };
  return { chain, options, wallet, state, own };
}

test('first_operation_deploys_registers_and_spends_use_zero', async () => {
  const { chain, wallet, own } = await unregistered();
  chain.firstOperation = own;
  const signed = await wallet.signUserOperation('0x1234');
  assert.equal((await wallet.getState()).active, false, 'nothing is registered until the operation lands');
  await chain.acceptUserOperation(signed);
  const after = await wallet.getState();
  assert.equal(after.active, true);
  assert.equal(after.chainUseCount, 1n, 'the first operation consumed the key at use 0');
  assert.equal(after.localSigningReservations, 1n);
  // And from there it is an ordinary registered wallet.
  await chain.acceptUserOperation(await wallet.signUserOperation('0x5678'));
  assert.equal((await wallet.getState()).chainUseCount, 2n);
});

test('first_operation_for_other_keys_is_refused_before_reserving', async () => {
  const { chain, wallet, own } = await unregistered();
  for (const change of [{ nextCommitment: own.pkCommitment }, { pkCommitment: own.nextCommitment }, { maxUses: own.maxUses + 1n }, { rotationDeadline: own.rotationDeadline + 1n }]) {
    chain.firstOperation = { ...own, ...change };
    await assert.rejects(wallet.signUserOperation('0x1234'), { code: 'PROOF_REJECTED' });
  }
  assert.equal((await wallet.getState()).localSigningReservations, 0n);
});

test('unregistered_without_deployment_still_refuses', async () => {
  const { wallet } = await unregistered();
  await assert.rejects(wallet.signUserOperation('0x1234'));
  assert.equal((await wallet.getState()).localSigningReservations, 0n);
});

test('deployment_is_bound_to_registration_state_both_ways', async () => {
  const { chain, options, wallet, state, own } = await unregistered();
  const scheme = forsSchemeId(options.params);
  chain.firstOperation = own;
  const observation = await chain.observe(state.accountAddress);
  const first = await chain.prepareUserOperation('0x1234', observation, scheme);
  const { deployment: _, ...withoutDeployment } = first;
  // Unregistered: a prepared operation must say what it deploys.
  validatePreparedOperation(options.authority, observation, '0x1234', scheme, first);
  assert.throws(() => validatePreparedOperation(options.authority, observation, '0x1234', scheme, withoutDeployment), { code: 'PROOF_REJECTED' });
  await wallet.register();
  const registered = await chain.observe(state.accountAddress);
  const later = await chain.prepareUserOperation('0x1234', registered, scheme);
  // Registered: one that claims to deploy is refused.
  assert.throws(() => validatePreparedOperation(options.authority, registered, '0x1234', scheme, { ...later, deployment: own }), { code: 'PROOF_REJECTED' });
});

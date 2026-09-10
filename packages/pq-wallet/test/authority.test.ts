import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asAddress, asBytes32, asChainId } from '@opaque/protocol-types/codecs.js';
import { createPqWallet } from '../src/wallet.ts';
import { MockWalletChain, mockWalletOptions } from '../src/mock.ts';
import { validatePreparedOperation, type PreparedUserOperation } from '../src/authority.ts';
import { forsSchemeId } from '../src/fors.ts';

test('mutated_chain_account_entrypoint_scheme_nonce_epoch_operation_expiry_and_digest_reject', async () => {
  const chain = new MockWalletChain(); const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 } };
  const wallet = createPqWallet(options); const state = await wallet.create(); await wallet.register();
  const observation = await chain.observe(state.accountAddress);
  const scheme = forsSchemeId(options.params);
  const prepared = await chain.prepareUserOperation('0x1234', observation, scheme);
  for (const change of [
    { chainId: asChainId(1n) }, { accountAddress: asAddress(`0x${'ab'.repeat(20)}`) },
    { entryPoint: asAddress(`0x${'ab'.repeat(20)}`) }, { schemeId: 'wrong' }, { useCount: 1n },
    { keyEpoch: 9n }, { encodedUserOperation: '0x1235' as const }, { validUntil: 100n },
    { digest: asBytes32(`0x${'00'.repeat(32)}`) }, { payload: '0x' as const },
  ]) {
    assert.throws(() => validatePreparedOperation(options.authority, observation, '0x1234', scheme, { ...prepared, ...change }), { code: 'PROOF_REJECTED' });
  }
});
test('wallet_requires_adapter_full_payload_verification_before_reserving', async () => {
  const chain = new MockWalletChain(); const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 } };
  const wallet = createPqWallet(options); await wallet.create(); await wallet.register();
  chain.verifyUserOperationBinding = async () => false;
  await assert.rejects(wallet.signUserOperation('0x1234'), { code: 'PROOF_REJECTED' });
  assert.equal((await wallet.getState()).localSigningReservations, 0n);
});
test('mock_payload_verification_checks_full_operation_hash_and_expiry', async () => {
  const chain = new MockWalletChain(); const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 } };
  const wallet = createPqWallet(options); const state = await wallet.create(); await wallet.register();
  const prepared = await chain.prepareUserOperation('0x1234', await chain.observe(state.accountAddress), forsSchemeId(options.params));
  assert.equal(await chain.verifyUserOperationBinding(prepared), true);
  for (const change of [{ userOpHash: asBytes32(`0x${'aa'.repeat(32)}`) }, { validUntil: prepared.validUntil + 1n },
    { keyEpoch: prepared.keyEpoch + 1n }]) {
    assert.equal(await chain.verifyUserOperationBinding({ ...prepared, ...change } as PreparedUserOperation), false);
  }
});
test('adapter_cannot_change_digest_after_validation_before_signing', async () => {
  const chain = new MockWalletChain(); const options = { ...mockWalletOptions(chain), params: { k: 8, a: 4 } };
  const wallet = createPqWallet(options); await wallet.create(); await wallet.register();
  chain.verifyUserOperationBinding = async prepared => {
    (prepared as { digest: PreparedUserOperation['digest'] }).digest = asBytes32(`0x${'ff'.repeat(32)}`);
    return true;
  };
  await assert.rejects(wallet.signUserOperation('0x12'));
  assert.equal((await wallet.getState()).localSigningReservations, 0n);
});

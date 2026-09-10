import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAndRegister, main } from '../scripts/create-register.ts';
import { createPqWallet } from '../src/wallet.ts';
import { mockWalletOptions } from '../src/mock.ts';

test('create_register_script_returns_safe_state_and_transaction_hash', async () => {
  const result = await createAndRegister(createPqWallet({ ...mockWalletOptions(), params: { k: 8, a: 4 } }));
  assert.equal(result.state.active, true); assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
});
test('create_register_script_refuses_to_label_mock_as_live', async () => {
  await assert.rejects(main(['--network', 'arc-testnet']), /LIVE account adapter/);
});

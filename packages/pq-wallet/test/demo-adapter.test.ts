import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDemo, type DemoEnvironment } from '../demo/adapter.ts';
import { MemorySignerStore } from '../src/signer-state.ts';
import { MemoryWalletStateStore } from '../src/wallet-state.ts';

function environment(): DemoEnvironment {
  const signers = new MemorySignerStore(); const wallets = new MemoryWalletStateStore();
  const values = new Map<string, string>(); let tail = Promise.resolve();
  return {
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
    lock<T>(run: () => Promise<T>): Promise<T> {
      const next = tail.then(run); tail = next.then(() => undefined, () => undefined); return next;
    },
    openStore: () => ({ read: signers.read.bind(signers), transact: signers.transact.bind(signers),
      readWallet: wallets.readWallet.bind(wallets), compareAndSwapWallet: wallets.compareAndSwapWallet.bind(wallets), close: async () => {} }),
  };
}
test('demo_restores_wallet_signing_and_network_history_across_actions', async () => {
  const env = environment();
  assert.equal((await runDemo('refresh', '', env)).wallet, undefined);
  const created = await runDemo('create', '', env); assert.equal(created.registered, false);
  await runDemo('register', '', env);
  const signed = await runDemo('sign', 'Approve a demo deposit', env); assert.ok(signed.pending);
  const refreshed = await runDemo('refresh', '', env);
  assert.equal(refreshed.wallet!.accountAddress, created.wallet!.accountAddress);
  assert.equal(refreshed.wallet!.localSigningReservations, 1n); assert.equal(refreshed.wallet!.chainUseCount, 0n);
  assert.deepEqual(refreshed.pending, signed.pending);
  const submitted = await runDemo('submit', '', env); assert.equal(submitted.wallet!.chainUseCount, 1n);
  const rotated = await runDemo('rotate', '', env); assert.equal(rotated.wallet!.keyEpoch, 1n);
  assert.equal((await runDemo('refresh', '', env)).wallet!.keyEpoch, 1n);
  await runDemo('disable', '', env);
  assert.equal((await runDemo('advance', '', env)).wallet!.active, false);
  const journal = env.storage.getItem('opaque-browser-demo-v1')!;
  for (const secretField of ['encryptedSeed', 'encryptionKey', 'secretKey', 'seed']) assert.equal(journal.includes(`"${secretField}"`), false);
});
test('demo_serializes_concurrent_signing_and_keeps_dropped_capacity', async () => {
  const env = environment(); await runDemo('create', '', env); await runDemo('register', '', env);
  await Promise.all([runDemo('sign', 'First action', env), runDemo('sign', 'Second action', env)]);
  assert.equal((await runDemo('refresh', '', env)).wallet!.localSigningReservations, 2n);
  assert.equal((await runDemo('submit', '', env)).wallet!.chainUseCount, 1n);
});
test('corrupt_demo_history_is_rejected_without_resetting_keys', async () => {
  const env = environment(); await runDemo('create', '', env); await runDemo('register', '', env);
  const original = env.storage.getItem('opaque-browser-demo-v1')!;
  env.storage.setItem('opaque-browser-demo-v1', '{"version":99,"events":[]}');
  await assert.rejects(runDemo('refresh', '', env), /Invalid demo history/);
  env.storage.setItem('opaque-browser-demo-v1', original);
  assert.equal((await runDemo('refresh', '', env)).registered, true);
});

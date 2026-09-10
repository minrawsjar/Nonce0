import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
import { initializeSigner, MemorySignerStore, signerSummary, type SignerStore, type SignerRecord } from '../src/signer-state.ts';
import { signDigest } from '../src/sign.ts';

const digest = (n: number) => asBytes32(`0x${n.toString(16).padStart(64, '0')}`);
const options = { keyEpoch: 0n, maxUses: 4n, lifecycleReserve: 1n, params: { k: 8, a: 4 } };

test('identical_retry_returns_cached_bytes_without_another_reservation', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  const first = await signDigest(store, id, digest(1), 'ordinary');
  assert.deepEqual(await signDigest(store, id, digest(1), 'ordinary'), first);
  assert.equal((await signerSummary(store, id)).localSigningReservations, 1n);
});
test('changed_retry_and_dropped_operation_chain_read_do_not_unburn_capacity', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  await signDigest(store, id, digest(1), 'ordinary'); // Deliberately never submitted.
  await signDigest(store, id, digest(2), 'ordinary');
  assert.equal((await signerSummary(store, id)).localSigningReservations, 2n);
  const chainUseCount = 0n;
  assert.notEqual((await signerSummary(store, id)).localSigningReservations, chainUseCount);
});
test('ordinary_actions_preserve_lifecycle_capacity_and_max_is_hard', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  for (const n of [1, 2, 3]) await signDigest(store, id, digest(n), 'ordinary');
  await assert.rejects(signDigest(store, id, digest(4), 'ordinary'), { code: 'KEY_EXHAUSTED' });
  await signDigest(store, id, digest(4), 'lifecycle');
  await assert.rejects(signDigest(store, id, digest(5), 'lifecycle'), { code: 'KEY_EXHAUSTED' });
  assert.equal((await signerSummary(store, id)).localSigningReservations, 4n);
});
test('concurrent_signers_reserve_distinct_capacity', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  const results = await Promise.all([1, 2, 3].map(n => signDigest(store, id, digest(n), 'ordinary')));
  assert.deepEqual(results.map(r => r.signingReservation).sort(), [1n, 2n, 3n]);
});
test('concurrent_identical_request_does_not_generate_again', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  const results = await Promise.allSettled([signDigest(store, id, digest(1), 'ordinary'), signDigest(store, id, digest(1), 'ordinary')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await signerSummary(store, id)).localSigningReservations, 1n);
});
test('crash_after_reservation_before_result_never_resigns', async () => {
  const base = new MemorySignerStore(); const id = await initializeSigner(base, options);
  let calls = 0;
  const broken: SignerStore = {
    read: key => base.read(key),
    async transact<T>(key: typeof id, update: (current: SignerRecord | undefined) => { record: SignerRecord; result: T }): Promise<T> {
      calls++;
      if (calls === 2) throw new Error('simulated persistence failure');
      return base.transact(key, update);
    },
  };
  await assert.rejects(signDigest(broken, id, digest(1), 'ordinary'), { code: 'SIGNER_STATE_UNSAFE' });
  assert.equal((await signerSummary(base, id)).localSigningReservations, 1n);
  await assert.rejects(signDigest(base, id, digest(1), 'ordinary'), { code: 'SIGNER_STATE_UNSAFE' });
});
test('crash_before_reservation_commits_returns_no_signature_and_burns_nothing', async () => {
  const base = new MemorySignerStore(); const id = await initializeSigner(base, options);
  const broken: SignerStore = { read: key => base.read(key), transact: async () => { throw new Error('transaction aborted'); } };
  await assert.rejects(signDigest(broken, id, digest(1), 'ordinary'));
  assert.equal((await signerSummary(base, id)).localSigningReservations, 0n);
});
test('crash_after_durable_result_before_return_is_cached', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  await signDigest(store, id, digest(1), 'ordinary'); // Caller loses this result.
  const retry = await signDigest(store, id, digest(1), 'ordinary');
  assert.equal(retry.signingReservation, 1n);
});
test('storage_contains_encrypted_seed_and_nonextractable_key', async () => {
  const store = new MemorySignerStore(); const id = await initializeSigner(store, options);
  const record = (await store.read(id))!;
  assert.equal('seed' in record || 'secretKey' in record, false);
  assert.equal(record.encryptionKey.extractable, false);
  assert.equal(record.encryptedSeed.length, 48);
  await assert.rejects(crypto.subtle.exportKey('raw', record.encryptionKey));
});
test('missing_state_and_attempted_history_rollback_fail_closed', async () => {
  const store = new MemorySignerStore();
  await assert.rejects(signDigest(store, digest(99), digest(1), 'ordinary'), { code: 'SIGNER_STATE_UNSAFE' });
  const id = await initializeSigner(store, options);
  await signDigest(store, id, digest(1), 'ordinary');
  await assert.rejects(store.transact(id, current => ({ record: { ...current!, revision: current!.revision + 1n, reservations: [] }, result: undefined })), { code: 'SIGNER_STATE_UNSAFE' });
});
test('corrupt_cached_signature_fails_as_unsafe_state_without_regeneration', async () => {
  const base = new MemorySignerStore(); const id = await initializeSigner(base, options);
  await signDigest(base, id, digest(1), 'ordinary');
  const corrupt: SignerStore = { read: key => base.read(key),
    transact: (key, update) => base.transact(key, current => update({ ...current!,
      reservations: current!.reservations.map(r => ({ ...r, signature: '0x' })) })) };
  await assert.rejects(signDigest(corrupt, id, digest(1), 'ordinary'), { code: 'SIGNER_STATE_UNSAFE' });
  assert.equal((await signerSummary(base, id)).localSigningReservations, 1n);
});

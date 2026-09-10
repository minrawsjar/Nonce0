import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
import { decodeSignature, verify } from '../src/fors.ts';
import { exportSigner, initializeSigner, MemorySignerStore, restoreSigner } from '../src/signer-state.ts';
import { signDigest } from '../src/sign.ts';

const digest = (n: number) => asBytes32(`0x${n.toString(16).padStart(64, '0')}`);
const params = { k: 32, a: 8 };

test('a restored key carries on from its signing log, never from index 1', async () => {
  const original = new MemorySignerStore();
  const id = await initializeSigner(original, { keyEpoch: 0n, maxUses: 8n, lifecycleReserve: 2n, params });
  await signDigest(original, id, digest(1), 'ordinary');

  const exported = await exportSigner(original, id);
  const restored = new MemorySignerStore();
  assert.equal(await restoreSigner(restored, exported), id);

  const next = await signDigest(restored, id, digest(2), 'ordinary');
  assert.equal(next.signingReservation, 2n, 'the index after the backup, not the first again');
  const record = (await restored.read(id))!;
  assert.ok(verify(record.publicKey, digest(2), decodeSignature(next.signature).signature));
  assert.equal(record.encryptionKey.extractable, false, 're-encrypted under a key that cannot leave the store');
});

test('restore never overwrites a key the store holds, nor takes a seed for another key', async () => {
  const store = new MemorySignerStore();
  const id = await initializeSigner(store, { keyEpoch: 0n, maxUses: 8n, lifecycleReserve: 2n, params });
  const exported = await exportSigner(store, id);
  await assert.rejects(restoreSigner(store, exported), { code: 'SIGNER_STATE_UNSAFE' });

  const other = new MemorySignerStore();
  const otherId = await initializeSigner(other, { keyEpoch: 0n, maxUses: 8n, lifecycleReserve: 2n, params });
  const swapped = { ...exported, seed: (await exportSigner(other, otherId)).seed };
  await assert.rejects(restoreSigner(new MemorySignerStore(), swapped), { code: 'SIGNER_STATE_UNSAFE' });
});

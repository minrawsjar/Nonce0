import { ProtocolFailure, type Bytes32 } from '@opaque/protocol-types';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
import { sign, verify, encodeSignature, decodeSignature, pkCommitment } from './fors.ts';
import { validateSignerRecord, unsafeState, type SignerRecord, type SignerStore, type SignedOutput } from './signer-state.ts';

/** Reserve, produce, persist, then return. Never retry production from an uncertain reservation. */
export async function signDigest(store: SignerStore, id: Bytes32, digest: Bytes32, kind: 'ordinary' | 'lifecycle'): Promise<SignedOutput> {
  asBytes32(id); asBytes32(digest);
  if (kind !== 'ordinary' && kind !== 'lifecycle') throw new ProtocolFailure('INVALID_INPUT', 'Unknown signing action');
  const reserved = await store.transact<{ record: SignerRecord; index: bigint; cached: SignedOutput['signature'] | undefined }>(id, current => {
    validateSignerRecord(current, id);
    const existing = current.reservations.find(r => r.digest === digest);
    if (existing) {
      if (existing.signature === undefined) throw unsafeState();
      try {
        const decoded = decodeSignature(existing.signature);
        if (pkCommitment(decoded.publicKey) !== id || !verify(current.publicKey, digest, decoded.signature)) throw unsafeState();
      } catch { throw unsafeState(); }
      return { record: { ...current, revision: current.revision + 1n }, result: { record: current, index: existing.index, cached: existing.signature } };
    }
    const limit = kind === 'ordinary' ? current.maxUses - current.lifecycleReserve : current.maxUses;
    if (BigInt(current.reservations.length) >= limit) throw new ProtocolFailure('KEY_EXHAUSTED', 'No signing capacity remains for this action');
    const index = BigInt(current.reservations.length + 1);
    return { record: { ...current, revision: current.revision + 1n,
      reservations: [...current.reservations, { digest, index }] }, result: { record: current, index, cached: undefined } };
  });
  const result = (signature: SignedOutput['signature']): SignedOutput => Object.freeze({
    digest, signature, keyEpoch: reserved.record.keyEpoch, signingReservation: reserved.index,
  });
  if (reserved.cached !== undefined) return result(reserved.cached);
  let seed: Uint8Array | undefined;
  try {
    const r = reserved.record;
    seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv,
      additionalData: new TextEncoder().encode(id) }, r.encryptionKey, r.encryptedSeed));
    const signature = sign({ params: r.publicKey.params, seed }, digest);
    if (!verify(r.publicKey, digest, signature)) throw unsafeState();
    const encoded = encodeSignature(r.publicKey, signature);
    await store.transact(id, current => {
      validateSignerRecord(current, id);
      const pending = current.reservations[Number(reserved.index - 1n)];
      if (!pending || pending.digest !== digest || pending.signature !== undefined) throw unsafeState();
      const next: SignerRecord = { ...current, revision: current.revision + 1n,
        reservations: current.reservations.map(item => item.index === reserved.index ? { ...item, signature: encoded } : item) };
      return { record: next, result: undefined };
    });
    return result(encoded);
  } catch { throw unsafeState(); }
  finally { seed?.fill(0); }
}

import { ProtocolFailure, type Bytes32, type Hex } from '@opaque/protocol-types';
import { asBytes32, assertHex } from '@opaque/protocol-types/codecs.js';
import { keyGen, pkCommitment, randomSeed, type ForsParams, type ForsPublicKey } from './fors.ts';
import { uint64 } from './registry.ts';

/**
 * WebCrypto's key type, taken from the platform's own `crypto.subtle` rather
 * than from lib.DOM.
 *
 * This package runs in a browser AND in Node, and the bare name `CryptoKey` is
 * a global only under lib.DOM. Naming it directly therefore forced every
 * consumer to load DOM types — which broke the Node backend's typecheck, and
 * "fixing" that by adding DOM to the backend's lib would have quietly allowed
 * `window` and `document` in server code. Deriving it from `generateKey` gets
 * the right type on both platforms and pulls in neither.
 *
 * `generateKey` returns a key or a key pair depending on the algorithm; AES-GCM
 * yields the single key, which is what the Extract selects.
 */
export type SubtleKey = Extract<Awaited<ReturnType<typeof crypto.subtle.generateKey>>, { type: string }>;

export interface SignedOutput {
  readonly digest: Bytes32;
  readonly signature: Hex;
  readonly keyEpoch: bigint;
  readonly signingReservation: bigint;
}
export interface Reservation {
  readonly digest: Bytes32;
  readonly index: bigint;
  readonly signature?: Hex;
}
/** Internal storage record. Never return this through the wallet public API. */
export interface SignerRecord {
  readonly version: 1;
  readonly revision: bigint;
  readonly id: Bytes32;
  readonly keyEpoch: bigint;
  readonly publicKey: ForsPublicKey;
  readonly encryptedSeed: Uint8Array<ArrayBuffer>;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly encryptionKey: SubtleKey;
  readonly maxUses: bigint;
  readonly lifecycleReserve: bigint;
  readonly reservations: readonly Reservation[];
}
export interface SignerStore {
  /** Callback must be synchronous; implementation atomically commits before resolving. */
  transact<T>(id: Bytes32, update: (current: SignerRecord | undefined) => {
    readonly record: SignerRecord; readonly result: T;
  }): Promise<T>;
  read(id: Bytes32): Promise<SignerRecord | undefined>;
}

export const unsafeState = (): ProtocolFailure => new ProtocolFailure('SIGNER_STATE_UNSAFE', 'Signer state cannot be established safely');

export function validateSignerRecord(record: SignerRecord | undefined, id: Bytes32): asserts record is SignerRecord {
  try {
    if (!record || record.version !== 1 || record.id !== asBytes32(id) || record.revision < 0n ||
        typeof record.revision !== 'bigint' || typeof record.keyEpoch !== 'bigint' || record.keyEpoch < 0n ||
        pkCommitment(record.publicKey) !== id || !Array.isArray(record.reservations) ||
        !(record.encryptedSeed instanceof Uint8Array) || record.encryptedSeed.length !== 48 ||
        !(record.iv instanceof Uint8Array) || record.iv.length !== 12 ||
        !record.encryptionKey || record.encryptionKey.extractable || record.encryptionKey.type !== 'secret' ||
        record.encryptionKey.algorithm.name !== 'AES-GCM') throw unsafeState();
    uint64(record.maxUses); uint64(record.lifecycleReserve);
    if (record.maxUses === 0n || record.lifecycleReserve === 0n || record.lifecycleReserve >= record.maxUses ||
        BigInt(record.reservations.length) > record.maxUses || record.revision < BigInt(record.reservations.length)) throw unsafeState();
    const seen = new Set<string>();
    for (let i = 0; i < record.reservations.length; i++) {
      const reservation = record.reservations[i];
      if (!reservation || reservation.index !== BigInt(i + 1) || seen.has(reservation.digest)) throw unsafeState();
      asBytes32(reservation.digest); seen.add(reservation.digest);
      if (reservation.signature !== undefined) assertHex(reservation.signature, 'signature');
    }
  } catch { throw unsafeState(); }
}

/** Checks append-only history even when using a storage adapter directly. */
export function validateTransition(before: SignerRecord | undefined, after: SignerRecord, id: Bytes32): void {
  validateSignerRecord(after, id);
  if (!before) {
    if (after.revision !== 0n || after.reservations.length !== 0) throw unsafeState();
    return;
  }
  validateSignerRecord(before, id);
  if (after.revision !== before.revision + 1n || after.keyEpoch !== before.keyEpoch ||
      after.maxUses !== before.maxUses || after.lifecycleReserve !== before.lifecycleReserve ||
      after.reservations.length < before.reservations.length || after.reservations.length > before.reservations.length + 1 ||
      !sameBytes(after.encryptedSeed, before.encryptedSeed) || !sameBytes(after.iv, before.iv)) throw unsafeState();
  for (let i = 0; i < before.reservations.length; i++) {
    const a = before.reservations[i]!; const b = after.reservations[i]!;
    if (a.digest !== b.digest || a.index !== b.index || (a.signature !== undefined && a.signature !== b.signature)) throw unsafeState();
  }
}
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export async function initializeSigner(store: SignerStore, input: {
  keyEpoch: bigint; maxUses: bigint; lifecycleReserve: bigint; params: ForsParams;
}): Promise<Bytes32> {
  const seed = new Uint8Array(randomSeed());
  try {
    const pair = keyGen(seed, input.params);
    const id = pkCommitment(pair.publicKey);
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedSeed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, encryptionKey, seed));
    pair.secretKey.seed.fill(0);
    const record: SignerRecord = { version: 1, revision: 0n, id, keyEpoch: input.keyEpoch,
      publicKey: pair.publicKey, encryptedSeed, iv, encryptionKey, maxUses: input.maxUses,
      lifecycleReserve: input.lifecycleReserve, reservations: [] };
    validateSignerRecord(record, id);
    await store.transact(id, current => {
      if (current) throw unsafeState();
      return { record, result: undefined };
    });
    return id;
  } finally { seed.fill(0); }
}

export async function signerSummary(store: SignerStore, id: Bytes32): Promise<{
  keyEpoch: bigint; maxUses: bigint; localSigningReservations: bigint;
}> {
  const record = await store.read(id); validateSignerRecord(record, id);
  return Object.freeze({ keyEpoch: record.keyEpoch, maxUses: record.maxUses, localSigningReservations: BigInt(record.reservations.length) });
}

/** Explicit test/mock adapter. Not durable and never the browser wallet default. */
export class MemorySignerStore implements SignerStore {
  #records = new Map<Bytes32, SignerRecord>();
  async read(id: Bytes32): Promise<SignerRecord | undefined> {
    const record = this.#records.get(id); return record && structuredClone(record);
  }
  async transact<T>(id: Bytes32, update: (current: SignerRecord | undefined) => { record: SignerRecord; result: T }): Promise<T> {
    const before = this.#records.get(id);
    const change = update(before && structuredClone(before));
    validateTransition(before, change.record, id);
    this.#records.set(id, structuredClone(change.record));
    return structuredClone(change.result);
  }
}

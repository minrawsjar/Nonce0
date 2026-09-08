// The bridge between the proof system and the §2 spend contract.
//
// This is what RingClient.buildSpend and RingClient.verifyLocally reduce to.
// Nothing above this file ever sees a note secret or a ring index.

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  ProtocolFailure,
  type Address,
  type Bytes32,
  type NoteCommitment,
  type Nullifier,
  type PoolScope,
  type PrivateSpend,
  type Ring8,
} from '@opaque/protocol-types';
import {
  asRing8,
  derivePaymentContext,
  fromHex,
  poolId,
  toHex,
} from '@opaque/protocol-types/codecs.js';

import {
  canonical,
  deriveCommitment,
  deriveNullifier,
  expectedOutput,
  narrow,
  nullifierImage,
  publicInputs,
  RING_SIZE,
  SECRET_BYTES,
} from './statement.ts';
import { prove, proofSize, REPS_128, verify } from './zkboo.ts';

export const SCHEME = 'zkboo-aes128-ring8' as const;
const SCHEME_DOMAIN = 'opaque/v1/zk/verifier';
const STATEMENT_DOMAIN = 'opaque/v1/zk/statement';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Identifies the exact verifier a spend was built for, repetition count
 * included. A proof at 40 repetitions is a different verifier from one at 219,
 * not a cheaper version of it, so the id has to separate them — otherwise a
 * pool pinned to 128-bit soundness would accept 2^-24 soundness silently.
 */
export const verifierId = (reps: number = REPS_128): Bytes32 =>
  toHex(keccak_256(canonical([utf8(SCHEME_DOMAIN), utf8(SCHEME), utf8(String(reps))]))) as Bytes32;

function statementHash(input: {
  readonly scope: PoolScope;
  readonly recipient: Address;
  readonly ring: Ring8;
  readonly nullifier: Nullifier;
  readonly verifierId: Bytes32;
}): Uint8Array {
  return keccak_256(
    canonical([
      utf8(STATEMENT_DOMAIN),
      fromHex(input.verifierId),
      fromHex(poolId(input.scope)),
      utf8(String(input.scope.chainId)),
      utf8(String(input.scope.denomination)),
      fromHex(input.recipient),
      fromHex(derivePaymentContext(input.scope, input.recipient)),
      ...input.ring.map((m) => fromHex(m as unknown as Bytes32)),
      fromHex(input.nullifier as unknown as Bytes32),
    ]),
  );
}

export const createNoteSecret = (
  random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
): Uint8Array => random(SECRET_BYTES);

/** Ring order is public and deterministic, so it can never encode the index. */
const sortRing = (members: readonly NoteCommitment[]): NoteCommitment[] =>
  [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export interface BuildRingSpendInput {
  readonly scope: PoolScope;
  readonly recipient: Address;
  readonly noteSecret: Uint8Array;
  /** Decoys from the Graph snapshot. Selection happens in the caller (T6). */
  readonly decoys: readonly NoteCommitment[];
  readonly reps?: number;
  readonly random?: (bytes: number) => Uint8Array;
}

/** Always an eight-member spend: this builder has no single-note path. */
export type RingSpend = Extract<PrivateSpend, { readonly mode: 'RING_8' }>;

export function buildRingSpend(input: BuildRingSpendInput): RingSpend {
  const reps = input.reps ?? REPS_128;
  const mine = deriveCommitment(input.noteSecret, input.scope);

  if (input.decoys.length !== RING_SIZE - 1) {
    throw new ProtocolFailure(
      'INSUFFICIENT_ANONYMITY',
      `a ring needs exactly ${RING_SIZE - 1} decoys, got ${input.decoys.length}`,
    );
  }
  if (input.decoys.includes(mine)) {
    // Silently deduplicating would ship a 7-member ring wearing an 8-member
    // label — the one failure mode the ring exists to prevent.
    throw new ProtocolFailure('INVALID_INPUT', 'a decoy duplicates the spender\'s own note');
  }

  const ring = asRing8(sortRing([mine, ...input.decoys]));
  const index = ring.indexOf(mine);
  const nullifier = deriveNullifier(input.noteSecret, input.scope);
  const id = verifierId(reps);

  const proof = prove({
    pub: publicInputs(input.scope, ring),
    secret: input.noteSecret,
    index,
    statementHash: statementHash({
      scope: input.scope,
      recipient: input.recipient,
      ring,
      nullifier,
      verifierId: id,
    }),
    reps,
    ...(input.random === undefined ? {} : { random: input.random }),
  });

  return {
    mode: 'RING_8',
    scope: input.scope,
    recipient: input.recipient,
    ring,
    nullifier,
    paymentContext: derivePaymentContext(input.scope, input.recipient),
    verifierId: id,
    proof: toHex(proof),
  };
}

/**
 * `expectVerifierId` is the pool's pinned verifier, from ProtocolCapabilities.
 * Omitting it checks only that the spend is internally consistent — which is
 * NOT enough on its own, because a self-consistent low-repetition proof is a
 * valid proof of a much weaker statement.
 */
export function verifyRingSpend(spend: PrivateSpend, expectVerifierId?: Bytes32): boolean {
  if (spend.mode !== 'RING_8') return false;
  if (expectVerifierId !== undefined && spend.verifierId !== expectVerifierId) return false;

  const proof = fromHex(spend.proof);
  if (proof.length < 3) return false;
  const reps = new DataView(proof.buffer, proof.byteOffset, proof.byteLength).getUint16(1, false);
  if (proof.length !== proofSize(new DataView(proof.buffer, proof.byteOffset, proof.byteLength).getUint32(3, false), reps)) {
    return false;
  }
  // The declared verifier must match the repetition count the proof actually
  // carries, or the id says 219 while the bytes say 40.
  if (spend.verifierId !== verifierId(reps)) return false;
  if (spend.paymentContext !== derivePaymentContext(spend.scope, spend.recipient)) return false;
  // Canonical ring order. The statement hash already binds whatever order the
  // prover used, so an unsorted ring is not forgeable — but it would give one
  // spend two encodings, and spendHash is what the CRE and the outbox key on.
  if (spend.ring.some((m, i) => i > 0 && !(spend.ring[i - 1]! < m))) return false;

  return verify(
    publicInputs(spend.scope, spend.ring),
    statementHash({
      scope: spend.scope,
      recipient: spend.recipient,
      ring: spend.ring,
      nullifier: spend.nullifier,
      verifierId: spend.verifierId,
    }),
    expectedOutput(narrow(spend.nullifier as unknown as Bytes32, 'nullifier')),
    proof,
  );
}

export { deriveCommitment, deriveNullifier, nullifierImage };

// The §6.2 statement, and the derivations that feed it.
//
//   "I know a secret S whose one-way image equals one of these 8 note
//    commitments, and this payment's nullifier is that same S's image under a
//    different, pool-bound block — without revealing which commitment."
//
// SPEC DEVIATION, stated up front because it is load-bearing. §6.4 and the §2
// contract write these as keccak preimages. They are not, here: proving a
// keccak preimage inside MPC-in-the-head costs ~38,400 AND gates per call
// against AES-128's ~5,760, and two calls are needed. The one-way function is
// AES-128 keyed by the note secret — the same structure Picnic uses, for the
// same reason. keccak is still what derives the PUBLIC block constants, so
// domain separation and pool binding are unchanged.
//
// The consequence to carry into review: a commitment and a nullifier are
// 128-bit values, right-padded into bytes32. That is the security level of
// AES-128 and of the 219-repetition soundness target, not an accident of
// encoding — but it IS narrower than the 256-bit field the contract's type
// suggests, and NoteVault must derive notes through this module rather than
// hashing its own.

import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  NOTE_DOMAIN,
  NULLIFIER_DOMAIN,
  ProtocolFailure,
  type Bytes32,
  type NoteCommitment,
  type Nullifier,
  type PoolScope,
  type Ring8,
} from '@opaque/protocol-types';
import { fromHex, poolId, toHex } from '@opaque/protocol-types/codecs.js';

import { aes128Encrypt, cipher, constBytes, keyExpansion, type Byte } from './aes.ts';
import { plainGates, type Bit, type Gates } from './bits.ts';

export const SECRET_BYTES = 16;
export const IMAGE_BYTES = 16;
export const RING_SIZE = 8;
/** 128 secret bits then 3 index bits. */
export const WITNESS_BITS = 131;
export const WITNESS_BYTES = 17;
/** (commitment XOR selected) then nullifier. */
export const OUTPUT_BITS = 256;
export const OUTPUT_BYTES = 32;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Length-prefixed concatenation, so no two field lists can collide. */
export function canonical(fields: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const f of fields) {
    view.setUint32(at, f.length, false);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

/** The public 128-bit block the note secret encrypts to form its commitment. */
export const noteBlock = (scope: PoolScope): Uint8Array =>
  keccak_256(
    canonical([utf8(NOTE_DOMAIN), fromHex(poolId(scope)), utf8(String(scope.denomination))]),
  ).slice(0, IMAGE_BYTES);

/**
 * Binds the secret and the pool, and NOTHING else. A nullifier that varied
 * with the recipient would let one note be spent once per recipient, without
 * limit — which is why the denomination is absent here and present above.
 */
export const nullifierBlock = (scope: PoolScope): Uint8Array =>
  keccak_256(canonical([utf8(NULLIFIER_DOMAIN), fromHex(poolId(scope))])).slice(0, IMAGE_BYTES);

/** A 128-bit image right-padded into bytes32, matching Solidity's bytes16 widening. */
export function widen(image: Uint8Array): Bytes32 {
  const out = new Uint8Array(32);
  out.set(image.subarray(0, IMAGE_BYTES));
  return toHex(out) as Bytes32;
}

export function narrow(value: Bytes32, label: string): Uint8Array {
  const bytes = fromHex(value);
  if (bytes.length !== 32) throw new ProtocolFailure('INVALID_INPUT', `${label} must be 32 bytes`);
  if (bytes.subarray(IMAGE_BYTES).some((b) => b !== 0)) {
    throw new ProtocolFailure(
      'INVALID_INPUT',
      `${label} carries data past 16 bytes; this verifier only accepts 128-bit images`,
    );
  }
  return bytes.subarray(0, IMAGE_BYTES);
}

export const commitmentImage = (secret: Uint8Array, scope: PoolScope): Uint8Array =>
  aes128Encrypt(secret, noteBlock(scope));

export const nullifierImage = (secret: Uint8Array, scope: PoolScope): Uint8Array =>
  aes128Encrypt(secret, nullifierBlock(scope));

/** The canonical note derivations. NoteVault (T1) must call these, not re-hash. */
export const deriveCommitment = (secret: Uint8Array, scope: PoolScope): NoteCommitment =>
  widen(commitmentImage(secret, scope)) as unknown as NoteCommitment;

export const deriveNullifier = (secret: Uint8Array, scope: PoolScope): Nullifier =>
  widen(nullifierImage(secret, scope)) as unknown as Nullifier;

// ── the circuit ───────────────────────────────────────────────────────────

export interface StatementPublic {
  /** 8 commitment images, 16 bytes each, in the spend's canonical ring order. */
  readonly ring: readonly Uint8Array[];
  readonly noteBlock: Uint8Array;
  readonly nullifierBlock: Uint8Array;
}

/**
 * An 8-way multiplexer over the ring, indexed by three secret bits.
 *
 * The first level chooses between PUBLIC constants, so `s & (a^b)` is an AND
 * with a constant — linear in the shares, and free. Only the second and third
 * levels spend real AND gates: 384 of them, against ~38,000 for the ciphers.
 */
function selectRing(g: Gates, idx: readonly Bit[], ring: readonly Uint8Array[]): Byte[] {
  let level: Byte[][] = [];
  for (let j = 0; j < 4; j++) {
    const a = ring[2 * j]!;
    const b = ring[2 * j + 1]!;
    level.push(
      Array.from({ length: IMAGE_BYTES }, (_, i) =>
        Array.from({ length: 8 }, (_, k) => {
          const ab = (a[i]! >> k) & 1;
          const bb = (b[i]! >> k) & 1;
          return g.xorConst(g.andConst(idx[0]!, ab ^ bb), ab);
        }),
      ),
    );
  }
  for (const bit of [idx[1]!, idx[2]!]) {
    const next: Byte[][] = [];
    for (let j = 0; j < level.length; j += 2) {
      const a = level[j]!;
      const b = level[j + 1]!;
      next.push(a.map((byte, i) => byte.map((x, k) => g.xor(x, g.and(bit, g.xor(x, b[i]![k]!))))));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Runs the statement. Both ciphers share ONE key expansion, so the secret's
 * 40 key-schedule S-boxes are paid once rather than twice.
 *
 * The output is (commitment XOR selected) ‖ nullifier. Checking that the first
 * half is zero proves equality with a ring member without revealing which one;
 * revealing the commitment itself would name the member outright.
 */
export function evaluate(g: Gates, pub: StatementPublic, w: readonly Bit[]): Bit[] {
  const key: Byte[] = Array.from({ length: SECRET_BYTES }, (_, i) => w.slice(i * 8, i * 8 + 8));
  const idx = [w[128]!, w[129]!, w[130]!];

  const schedule = keyExpansion(g, key);
  const commitment = cipher(g, schedule, constBytes(g, pub.noteBlock));
  const nullifier = cipher(g, schedule, constBytes(g, pub.nullifierBlock));
  const selected = selectRing(g, idx, pub.ring);

  const out: Bit[] = [];
  for (let i = 0; i < IMAGE_BYTES; i++) {
    for (let b = 0; b < 8; b++) out.push(g.xor(commitment[i]![b]!, selected[i]![b]!));
  }
  for (let i = 0; i < IMAGE_BYTES; i++) {
    for (let b = 0; b < 8; b++) out.push(nullifier[i]![b]!);
  }
  return out;
}

/** Same every run: the circuit's control flow never reads a wire value. */
export function countAnds(pub: StatementPublic): number {
  const g = plainGates();
  evaluate(g, pub, new Array<Bit>(WITNESS_BITS).fill(0));
  return g.andCount();
}

export function publicInputs(scope: PoolScope, ring: Ring8): StatementPublic {
  const images = ring.map((c, i) => narrow(c as unknown as Bytes32, `ring member ${i}`));
  if (new Set(images.map((b) => toHex(b))).size !== RING_SIZE) {
    throw new ProtocolFailure('INVALID_INPUT', 'ring members must be distinct');
  }
  return { ring: images, noteBlock: noteBlock(scope), nullifierBlock: nullifierBlock(scope) };
}

/** What the reconstructed output must equal: 16 zero bytes, then the nullifier. */
export function expectedOutput(nullifier: Uint8Array): Uint8Array {
  const out = new Uint8Array(OUTPUT_BYTES);
  out.set(nullifier.subarray(0, IMAGE_BYTES), IMAGE_BYTES);
  return out;
}

// ZKBoo — a (2,3)-decomposition sigma protocol, made non-interactive by
// Fiat-Shamir. Picnic's family, in its simplest published form.
//
// Each repetition secret-shares the witness three ways and runs the circuit
// under all three shares. The challenge opens two of the three views. A cheat
// has to sit in at least one party, so it survives one repetition with
// probability 2/3; 219 repetitions put that under 2^-128.
//
// Party e's AND outputs are RECOMPUTED by the verifier and checked against the
// commitment — that recomputation is the soundness check, not a formality.
// Party e+1's cannot be recomputed (it would need party e+2's wires), so the
// proof carries them, one bit per AND gate. That single bit, times the gate
// count, times the repetitions, is essentially the whole proof size.

import { keccak_256, shake256 } from '@noble/hashes/sha3.js';
import { ProtocolFailure } from '@opaque/protocol-types';

import { bitAt, proverGates, setBit, verifierGates, type Bit } from './bits.ts';
import {
  canonical,
  countAnds,
  evaluate,
  OUTPUT_BITS,
  OUTPUT_BYTES,
  SECRET_BYTES,
  WITNESS_BITS,
  WITNESS_BYTES,
  type StatementPublic,
} from './statement.ts';

export const PROOF_VERSION = 1;
/** (2/3)^219 < 2^-128. Lower values are for benchmarking, never for a spend. */
export const REPS_128 = 219;

const SEED_BYTES = 16;
const DIGEST_BYTES = 32;
const HEADER_BYTES = 7;

const TAPE_DOMAIN = 'opaque/v1/zk/tape';
const SHARE_DOMAIN = 'opaque/v1/zk/share';
const VIEW_DOMAIN = 'opaque/v1/zk/view';
const CHALLENGE_DOMAIN = 'opaque/v1/zk/challenge';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Zero every bit at or above `bits`, so one value has exactly one encoding. */
function maskTail(buf: Uint8Array, bits: number): Uint8Array {
  for (let i = bits; i < buf.length * 8; i++) buf[i >> 3] = buf[i >> 3]! & ~(1 << (i & 7));
  return buf;
}

const tailIsClear = (buf: Uint8Array, bits: number): boolean => {
  for (let i = bits; i < buf.length * 8; i++) if (bitAt(buf, i)) return false;
  return true;
};

const tape = (seed: Uint8Array, bytes: number): Uint8Array =>
  shake256(concat(utf8(TAPE_DOMAIN), seed), { dkLen: Math.max(bytes, 1) });

const shareFromSeed = (seed: Uint8Array): Uint8Array =>
  maskTail(shake256(concat(utf8(SHARE_DOMAIN), seed), { dkLen: WITNESS_BYTES }), WITNESS_BITS);

const commitView = (seed: Uint8Array, share: Uint8Array, view: Uint8Array): Uint8Array =>
  keccak_256(canonical([utf8(VIEW_DOMAIN), seed, share, view]));

/** Rejects 252..255 so the three residues stay equiprobable. */
function challengeTrits(digest: Uint8Array, reps: number): Uint8Array {
  const out = new Uint8Array(reps);
  let n = 0;
  for (let round = 0; n < reps; round++) {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, round, false);
    const block = shake256(concat(utf8(CHALLENGE_DOMAIN), digest, counter), { dkLen: 512 });
    for (const b of block) {
      if (b < 252 && n < reps) out[n++] = b % 3;
    }
  }
  return out;
}

const packOutput = (wires: readonly Bit[], party: number): Uint8Array => {
  const out = new Uint8Array(OUTPUT_BYTES);
  for (let i = 0; i < OUTPUT_BITS; i++) setBit(out, i, (wires[i]! >> party) & 1);
  return out;
};

/** The per-repetition record, in the order it is serialised. */
const repBytes = (tapeBytes: number): number =>
  SEED_BYTES * 2 + WITNESS_BYTES + DIGEST_BYTES * 3 + OUTPUT_BYTES * 3 + tapeBytes;

export const proofSize = (andGates: number, reps: number): number =>
  HEADER_BYTES + reps * repBytes(Math.ceil(andGates / 8));

export interface ProveInput {
  readonly pub: StatementPublic;
  readonly secret: Uint8Array;
  readonly index: number;
  /** Binds the proof to this exact payment. See spend.ts. */
  readonly statementHash: Uint8Array;
  readonly reps?: number;
  readonly random?: (bytes: number) => Uint8Array;
}

const defaultRandom = (bytes: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(bytes));

export function prove(input: ProveInput): Uint8Array {
  const reps = input.reps ?? REPS_128;
  if (!Number.isInteger(reps) || reps < 1 || reps > 65535) {
    throw new ProtocolFailure('INVALID_INPUT', 'reps must be an integer in 1..65535');
  }
  if (input.secret.length !== SECRET_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', `note secret must be ${SECRET_BYTES} bytes`);
  }
  if (!Number.isInteger(input.index) || input.index < 0 || input.index > 7) {
    throw new ProtocolFailure('INVALID_INPUT', 'ring index must be an integer in 0..7');
  }
  if (input.statementHash.length !== DIGEST_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'statementHash must be 32 bytes');
  }

  const random = input.random ?? defaultRandom;
  const andGates = countAnds(input.pub);
  const tapeBytes = Math.ceil(andGates / 8);

  const witness = new Uint8Array(WITNESS_BYTES);
  for (let i = 0; i < SECRET_BYTES; i++) {
    for (let b = 0; b < 8; b++) setBit(witness, i * 8 + b, (input.secret[i]! >> b) & 1);
  }
  for (let k = 0; k < 3; k++) setBit(witness, 128 + k, (input.index >> k) & 1);

  const seeds: Uint8Array[][] = [];
  const shares: Uint8Array[][] = [];
  const views: Uint8Array[][] = [];
  const commits: Uint8Array[][] = [];
  const outputs: Uint8Array[][] = [];

  for (let j = 0; j < reps; j++) {
    const seed = [random(SEED_BYTES), random(SEED_BYTES), random(SEED_BYTES)];
    const share0 = shareFromSeed(seed[0]!);
    const share1 = shareFromSeed(seed[1]!);
    const share2 = maskTail(
      Uint8Array.from(witness, (v, i) => v ^ share0[i]! ^ share1[i]!),
      WITNESS_BITS,
    );
    const share = [share0, share1, share2];
    const tapes = seed.map((s) => tape(s, tapeBytes));
    const view = [0, 1, 2].map(() => new Uint8Array(tapeBytes));

    const wires: Bit[] = Array.from(
      { length: WITNESS_BITS },
      (_, k) => bitAt(share0, k) | (bitAt(share1, k) << 1) | (bitAt(share2, k) << 2),
    );

    const out = evaluate(proverGates(tapes, view), input.pub, wires);

    seeds.push(seed);
    shares.push(share);
    views.push(view);
    commits.push([0, 1, 2].map((i) => commitView(seed[i]!, share[i]!, view[i]!)));
    outputs.push([0, 1, 2].map((i) => packOutput(out, i)));
  }

  const trits = challengeTrits(
    transcript(input.statementHash, reps, andGates, commits, outputs),
    reps,
  );

  const proof = new Uint8Array(proofSize(andGates, reps));
  const header = new DataView(proof.buffer);
  proof[0] = PROOF_VERSION;
  header.setUint16(1, reps, false);
  header.setUint32(3, andGates, false);

  let at = HEADER_BYTES;
  const put = (bytes: Uint8Array): void => {
    proof.set(bytes, at);
    at += bytes.length;
  };
  for (let j = 0; j < reps; j++) {
    const e = trits[j]!;
    const e1 = (e + 1) % 3;
    put(seeds[j]![e]!);
    put(seeds[j]![e1]!);
    put(shares[j]![2]!);
    for (let i = 0; i < 3; i++) put(commits[j]![i]!);
    for (let i = 0; i < 3; i++) put(outputs[j]![i]!);
    put(views[j]![e1]!);
  }
  return proof;
}

function transcript(
  statementHash: Uint8Array,
  reps: number,
  andGates: number,
  commits: readonly (readonly Uint8Array[])[],
  outputs: readonly (readonly Uint8Array[])[],
): Uint8Array {
  const counts = new Uint8Array(8);
  const view = new DataView(counts.buffer);
  view.setUint32(0, reps, false);
  view.setUint32(4, andGates, false);
  const flat: Uint8Array[] = [];
  for (let j = 0; j < reps; j++) {
    flat.push(...commits[j]!, ...outputs[j]!);
  }
  // Every field is fixed-width, so plain concatenation is already unambiguous;
  // the outer canonical() keeps the variable-length statementHash honest.
  return keccak_256(
    canonical([utf8(CHALLENGE_DOMAIN), statementHash, counts, concat(...flat)]),
  );
}

export function verify(
  pub: StatementPublic,
  statementHash: Uint8Array,
  expected: Uint8Array,
  proof: Uint8Array,
): boolean {
  if (proof.length < HEADER_BYTES || proof[0] !== PROOF_VERSION) return false;
  const header = new DataView(proof.buffer, proof.byteOffset, proof.byteLength);
  const reps = header.getUint16(1, false);
  const claimedAnds = header.getUint32(3, false);
  if (reps < 1) return false;

  // The verifier derives the gate count from the STATEMENT, never from the
  // proof. Trusting the header would let a prover nominate a smaller circuit.
  const andGates = countAnds(pub);
  if (claimedAnds !== andGates) return false;
  const tapeBytes = Math.ceil(andGates / 8);
  if (proof.length !== proofSize(andGates, reps)) return false;

  const commits: Uint8Array[][] = [];
  const outputs: Uint8Array[][] = [];
  const seedE: Uint8Array[] = [];
  const seedE1: Uint8Array[] = [];
  const share2: Uint8Array[] = [];
  const viewE1: Uint8Array[] = [];

  let at = HEADER_BYTES;
  const take = (n: number): Uint8Array => {
    const slice = proof.subarray(at, at + n);
    at += n;
    return slice;
  };
  for (let j = 0; j < reps; j++) {
    seedE.push(take(SEED_BYTES));
    seedE1.push(take(SEED_BYTES));
    share2.push(take(WITNESS_BYTES));
    commits.push([take(DIGEST_BYTES), take(DIGEST_BYTES), take(DIGEST_BYTES)]);
    outputs.push([take(OUTPUT_BYTES), take(OUTPUT_BYTES), take(OUTPUT_BYTES)]);
    viewE1.push(take(tapeBytes));
    // Non-canonical padding is rejected rather than ignored: unread bits still
    // enter the commitments, so leaving them free is a free challenge grind.
    if (!tailIsClear(share2[j]!, WITNESS_BITS)) return false;
    if (!tailIsClear(viewE1[j]!, andGates)) return false;
  }

  const trits = challengeTrits(
    transcript(statementHash, reps, andGates, commits, outputs),
    reps,
  );

  for (let j = 0; j < reps; j++) {
    const e = trits[j]!;
    const e1 = (e + 1) % 3;
    const shareE = e === 2 ? share2[j]! : shareFromSeed(seedE[j]!);
    const shareE1 = e1 === 2 ? share2[j]! : shareFromSeed(seedE1[j]!);
    const recomputed = new Uint8Array(tapeBytes);

    const wires: Bit[] = Array.from(
      { length: WITNESS_BITS },
      (_, k) => bitAt(shareE, k) | (bitAt(shareE1, k) << 1),
    );

    const out = evaluate(
      verifierGates({
        e,
        tapeE: tape(seedE[j]!, tapeBytes),
        tapeE1: tape(seedE1[j]!, tapeBytes),
        viewE1: viewE1[j]!,
        recomputed,
      }),
      pub,
      wires,
    );

    if (!equal(packOutput(out, 0), outputs[j]![e]!)) return false;
    if (!equal(packOutput(out, 1), outputs[j]![e1]!)) return false;
    if (!equal(commitView(seedE[j]!, shareE, recomputed), commits[j]![e]!)) return false;
    if (!equal(commitView(seedE1[j]!, shareE1, viewE1[j]!), commits[j]![e1]!)) return false;

    const reconstructed = Uint8Array.from(
      outputs[j]![0]!,
      (v, i) => v ^ outputs[j]![1]![i]! ^ outputs[j]![2]![i]!,
    );
    if (!equal(reconstructed, expected)) return false;
  }
  return true;
}

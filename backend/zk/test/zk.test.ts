import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address, Bytes32, NoteCommitment, PoolScope, Ring8 } from '@opaque/protocol-types';
import {
  asAddress,
  asChainId,
  derivePaymentContext,
  asRing8,
  fromHex,
  spendHash,
  toHex,
} from '@opaque/protocol-types/codecs.js';

import { aes128Encrypt, sbox } from '../aes.ts';
import { plainGates } from '../bits.ts';
import {
  countAnds,
  expectedOutput,
  narrow,
  nullifierImage,
  publicInputs,
} from '../statement.ts';
import {
  buildRingSpend,
  createNoteSecret,
  deriveCommitment,
  deriveNullifier,
  verifierId,
  verifyRingSpend,
} from '../spend.ts';
import { proofSize, prove, verify } from '../zkboo.ts';

const REPS = 8; // Soundness is 128-bit at 219; these tests exercise mechanism, not margin.

const scope: PoolScope = {
  chainId: asChainId(5042002n),
  pool: asAddress(`0x${'11'.repeat(20)}`),
  denomination: 1_000_000,
};
const alice = asAddress(`0x${'aa'.repeat(20)}`);
const bob = asAddress(`0x${'bb'.repeat(20)}`);

const secret = (n: number): Uint8Array => Uint8Array.from({ length: 16 }, (_, i) => n * 31 + i);
const secrets = Array.from({ length: 8 }, (_, i) => secret(i + 1));
const commitments = secrets.map((s) => deriveCommitment(s, scope));
const decoysFor = (i: number): NoteCommitment[] => commitments.filter((_, j) => j !== i);
const ring8 = asRing8([...commitments].sort());

const spendFor = (i: number, recipient: Address = alice, reps = REPS) =>
  buildRingSpend({ scope, recipient, noteSecret: secrets[i]!, decoys: decoysFor(i), reps });

// ── the circuit is the cipher ─────────────────────────────────────────────

test('the circuit reproduces the FIPS-197 AES-128 vector', () => {
  const ct = aes128Encrypt(
    Uint8Array.from({ length: 16 }, (_, i) => i),
    Uint8Array.from(Buffer.from('00112233445566778899aabbccddeeff', 'hex')),
  );
  assert.equal(Buffer.from(ct).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

test('the derived S-box matches an independent brute-force GF(2^8) inverse', () => {
  const mul = (a: number, b: number): number => {
    let r = 0;
    for (let i = 0; i < 8; i++) if ((b >> i) & 1) r ^= a << i;
    for (let i = 14; i >= 8; i--) if ((r >> i) & 1) r ^= 0x11b << (i - 8);
    return r & 0xff;
  };
  const inverse = (x: number): number => {
    if (x === 0) return 0;
    for (let y = 1; y < 256; y++) if (mul(x, y) === 1) return y;
    throw new Error('no inverse');
  };
  for (let x = 0; x < 256; x++) {
    const b = inverse(x);
    let want = 0x63;
    for (let i = 0; i < 8; i++) {
      const bit =
        ((b >> i) & 1) ^ ((b >> ((i + 4) % 8)) & 1) ^ ((b >> ((i + 5) % 8)) & 1) ^
        ((b >> ((i + 6) % 8)) & 1) ^ ((b >> ((i + 7) % 8)) & 1);
      want ^= bit << i;
    }
    const got = sbox(plainGates(), Array.from({ length: 8 }, (_, i) => (x >> i) & 1))
      .reduce((acc, bit, i) => acc | (bit << i), 0);
    assert.equal(got, want, `S-box(${x})`);
  }
});

// ── derivations ───────────────────────────────────────────────────────────

test('the nullifier binds the secret and the pool, and NOT the recipient', () => {
  // The double-spend rule the handoff PDF got wrong: a nullifier that varied
  // with the recipient would let one note be spent once per recipient.
  const toAlice = spendFor(0, alice);
  const toBob = spendFor(0, bob);
  assert.equal(toAlice.nullifier, toBob.nullifier);
  assert.notEqual(toAlice.paymentContext, toBob.paymentContext);
});

test('commitments separate pools and denominations', () => {
  const other: PoolScope = { ...scope, denomination: 5_000_000 };
  assert.notEqual(deriveCommitment(secrets[0]!, scope), deriveCommitment(secrets[0]!, other));
  const elsewhere: PoolScope = { ...scope, pool: asAddress(`0x${'22'.repeat(20)}`) };
  assert.notEqual(deriveNullifier(secrets[0]!, scope), deriveNullifier(secrets[0]!, elsewhere));
});

test('a 128-bit image is right-padded, and anything wider is refused', () => {
  assert.match(deriveCommitment(secrets[0]!, scope), /^0x[0-9a-f]{32}0{32}$/);
  assert.throws(
    () => narrow(`0x${'ab'.repeat(32)}` as Bytes32, 'commitment'),
    /only accepts 128-bit images/,
  );
});

// ── the proof ─────────────────────────────────────────────────────────────

test('a ring spend verifies, and its size matches the published formula', () => {
  const spend = spendFor(3);
  assert.equal(verifyRingSpend(spend), true);
  assert.equal(
    fromHex(spend.proof).length,
    proofSize(countAnds(publicInputs(scope, spend.ring)), REPS),
  );
});

test('every ring position proves, and the ring never reveals which', () => {
  const first = spendFor(0);
  const last = spendFor(7);
  assert.equal(verifyRingSpend(first), true);
  assert.equal(verifyRingSpend(last), true);
  // Same eight members, same canonical order, whichever one is spending.
  assert.deepEqual(first.ring, last.ring);
  assert.notEqual(first.nullifier, last.nullifier);
});

test('the proof carries no verbatim copy of the note secret', () => {
  const proof = Buffer.from(fromHex(spendFor(2).proof));
  assert.equal(proof.includes(Buffer.from(secrets[2]!)), false);
});

// ── rejection ─────────────────────────────────────────────────────────────

test('a tampered proof is rejected', () => {
  const spend = spendFor(1);
  const bytes = fromHex(spend.proof);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  assert.equal(verifyRingSpend({ ...spend, proof: toHex(bytes) }), false);
});

test('a proof cannot be redirected to another recipient', () => {
  const spend = spendFor(1, alice);
  const redirected = { ...spend, recipient: bob };
  // paymentContext is recomputed, so the swap fails before the proof is read.
  assert.equal(verifyRingSpend(redirected), false);
  assert.equal(
    verifyRingSpend({ ...redirected, paymentContext: derivePaymentContext(scope, bob) }),
    false,
  );
});

test('a proof cannot be replayed with a substituted nullifier', () => {
  const spend = spendFor(1);
  assert.equal(verifyRingSpend({ ...spend, nullifier: deriveNullifier(secrets[4]!, scope) }), false);
});

test('a proof cannot be moved to a different ring', () => {
  const spend = spendFor(1);
  const outsider = deriveCommitment(secret(99), scope);
  const swapped = [...spend.ring];
  swapped[swapped.indexOf(commitments[5]!)] = outsider;
  assert.equal(verifyRingSpend({ ...spend, ring: swapped.sort() as unknown as Ring8 }), false);
});

test('an unsorted ring is refused, so one spend cannot have two spendHashes', () => {
  const spend = spendFor(1);
  const shuffled = [...spend.ring];
  [shuffled[0], shuffled[1]] = [shuffled[1]!, shuffled[0]!];
  const reordered = { ...spend, ring: shuffled as unknown as Ring8 };
  assert.equal(verifyRingSpend(reordered), false);
  assert.notEqual(spendHash(reordered), spendHash(spend));
});

test('a weakened proof is refused by a pool pinned to full soundness', () => {
  const weak = spendFor(1, alice, 4);
  assert.equal(verifyRingSpend(weak), true, 'self-consistent at its own strength');
  assert.equal(verifyRingSpend(weak, verifierId()), false, 'but not the pinned verifier');
  assert.notEqual(weak.verifierId, verifierId());
});

test('a forged verifierId does not survive the repetition count in the bytes', () => {
  const weak = spendFor(1, alice, 4);
  assert.equal(verifyRingSpend({ ...weak, verifierId: verifierId() }), false);
});

test('non-canonical padding in the proof is rejected, not ignored', () => {
  const spend = spendFor(1);
  const bytes = fromHex(spend.proof);
  // Bits 131..135 of the first repetition's stored witness share are unread by
  // the circuit but still enter a commitment — free challenge grinding if left
  // unconstrained.
  bytes[7 + 16 + 16 + 16] = bytes[7 + 16 + 16 + 16]! | 0b1000;
  assert.equal(verifyRingSpend({ ...spend, proof: toHex(bytes) }), false);
});

test('a wrong witness cannot satisfy the ring', () => {
  // buildRingSpend always inserts the prover's OWN commitment, so a genuine
  // non-membership test has to go under it, to a ring the prover cannot edit.
  const pub = publicInputs(scope, ring8);
  const bound = new Uint8Array(32).fill(7);
  const outsider = secret(99);
  assert.equal(
    verify(
      pub, bound, expectedOutput(nullifierImage(outsider, scope)),
      prove({ pub, secret: outsider, index: 3, statementHash: bound, reps: REPS }),
    ),
    false,
    'a secret opening no ring member',
  );
  const mine = ring8.indexOf(commitments[0]!);
  assert.equal(
    verify(
      pub, bound, expectedOutput(nullifierImage(secrets[0]!, scope)),
      prove({ pub, secret: secrets[0]!, index: (mine + 1) % 8, statementHash: bound, reps: REPS }),
    ),
    false,
    'a real member claiming the wrong slot',
  );
});

test('ring construction refuses a short ring or a duplicated note', () => {
  assert.throws(
    () => buildRingSpend({ scope, recipient: alice, noteSecret: secrets[0]!, decoys: decoysFor(0).slice(0, 5), reps: REPS }),
    /needs exactly 7 decoys/,
  );
  assert.throws(
    () => buildRingSpend({ scope, recipient: alice, noteSecret: secrets[0]!, decoys: [commitments[0]!, ...decoysFor(0).slice(0, 6)], reps: REPS }),
    /duplicates the spender/,
  );
});

test('a fresh note secret is 16 bytes and does not repeat', () => {
  const a = createNoteSecret();
  const b = createNoteSecret();
  assert.equal(a.length, 16);
  assert.notEqual(toHex(a), toHex(b));
});

test('the expected output pins the nullifier and zero elsewhere', () => {
  const out = expectedOutput(nullifierImage(secrets[0]!, scope));
  assert.equal(out.length, 32);
  assert.ok(out.subarray(0, 16).every((b) => b === 0));
  assert.deepEqual(out.subarray(16), nullifierImage(secrets[0]!, scope));
});

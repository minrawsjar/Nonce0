import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure, type Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { openIntent } from '../sealed-intent.ts';
import { generateIntentKeypair, sealIntent } from '../seal-client.ts';

const KEY_ID = 'cre-intent-key-v1';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const failure = (code: string) => (error: unknown) =>
  error instanceof ProtocolFailure && error.code === code;

const keys = generateIntentKeypair();
const spend = JSON.stringify({ recipient: `0x${'aa'.repeat(20)}`, credential: 'kyc-attestation-7' });

// ── the round trip ────────────────────────────────────────────────────────

test('an intent sealed in the browser opens in the enclave', () => {
  const sealed = sealIntent(keys.publicKey, KEY_ID, utf8(spend));
  assert.equal(text(openIntent(keys.secretKey, KEY_ID, sealed)), spend);
});

test('sealing twice produces different bytes', () => {
  // A deterministic seal would let the mesh and the executor recognise a
  // repeated intent, which for a payment is most of the information in it.
  const a = sealIntent(keys.publicKey, KEY_ID, utf8(spend));
  const b = sealIntent(keys.publicKey, KEY_ID, utf8(spend));
  assert.notEqual(a, b);
  assert.equal(text(openIntent(keys.secretKey, KEY_ID, a)), text(openIntent(keys.secretKey, KEY_ID, b)));
});

test('the sealed intent contains no verbatim copy of the payload', () => {
  const secret = 'recipient-0xdeadbeef-and-a-credential';
  const sealed = Buffer.from(fromHex(sealIntent(keys.publicKey, KEY_ID, utf8(secret))));
  assert.equal(sealed.includes(Buffer.from(secret)), false);
});

test('an empty payload round-trips rather than being treated as absent', () => {
  const sealed = sealIntent(keys.publicKey, KEY_ID, new Uint8Array(0));
  assert.equal(openIntent(keys.secretKey, KEY_ID, sealed).length, 0);
});

// ── the enclave is the only reader ────────────────────────────────────────

test('another keypair cannot open it, however well-formed', () => {
  const sealed = sealIntent(keys.publicKey, KEY_ID, utf8(spend));
  const other = generateIntentKeypair();
  // Not "fails to parse": ML-KEM decapsulation is implicit-rejection, so the
  // wrong key yields a well-formed shared secret and the GCM tag is what
  // actually refuses. This is the test that the tag is really checked.
  assert.throws(() => openIntent(other.secretKey, KEY_ID, sealed), failure('INVALID_INPUT'));
});

test('a ciphertext for key version 1 cannot be replayed against version 2', () => {
  // Rotation has to be a barrier. Without the key id in the AAD, every intent
  // sealed to the old key stays replayable at the new key's workflow.
  const sealed = sealIntent(keys.publicKey, 'cre-intent-key-v1', utf8(spend));
  assert.throws(
    () => openIntent(keys.secretKey, 'cre-intent-key-v2', sealed),
    failure('INVALID_INPUT'),
  );
});

test('every byte of a sealed intent is authenticated', () => {
  const sealed = fromHex(sealIntent(keys.publicKey, KEY_ID, utf8('x'.repeat(64))));
  // KEM ciphertext, nonce, body and tag in turn.
  for (const at of [0, 1090, 1102, sealed.length - 1]) {
    const edited = Uint8Array.from(sealed);
    edited[at] = edited[at]! ^ 1;
    assert.throws(() => openIntent(keys.secretKey, KEY_ID, toHex(edited)), failure('INVALID_INPUT'), `byte ${at}`);
  }
});

// ── refusals at the boundary ──────────────────────────────────────────────

test('a key of the wrong length is refused before any crypto runs', () => {
  assert.throws(() => sealIntent('0xaabb' as Hex, KEY_ID, utf8('x')), failure('INVALID_INPUT'));
  assert.throws(() => openIntent('0xaabb' as Hex, KEY_ID, '0x00' as Hex), failure('INVALID_INPUT'));
  // A public key handed in where a secret key belongs, and the reverse.
  assert.throws(() => openIntent(keys.publicKey, KEY_ID, '0x00' as Hex), failure('INVALID_INPUT'));
  assert.throws(() => sealIntent(keys.secretKey, KEY_ID, utf8('x')), failure('INVALID_INPUT'));
});

test('an empty key id is refused, because it would bind nothing', () => {
  assert.throws(() => sealIntent(keys.publicKey, '', utf8('x')), failure('INVALID_INPUT'));
});

test('a truncated sealed intent is refused rather than read past its end', () => {
  const sealed = fromHex(sealIntent(keys.publicKey, KEY_ID, utf8('body')));
  assert.throws(() => openIntent(keys.secretKey, KEY_ID, toHex(sealed.subarray(0, 900))), failure('INVALID_INPUT'));
  assert.throws(() => openIntent(keys.secretKey, KEY_ID, '0x' as Hex), failure('INVALID_INPUT'));
});

test('an oversized sealed intent is refused before the enclave allocates it', () => {
  const huge = toHex(new Uint8Array(128 * 1024 + 1));
  assert.throws(() => openIntent(keys.secretKey, KEY_ID, huge), failure('INVALID_INPUT'));
});

// ── the constraint that shaped the file ───────────────────────────────────

test('opening needs no randomness, so it can run where the RNG is unspecified', () => {
  // CRE workflows run under Javy/QuickJS. If open() drew entropy, this whole
  // design would rest on a runtime whose RNG seeding nobody has specified.
  // Removing the global proves it never touches one.
  const sealed = sealIntent(keys.publicKey, KEY_ID, utf8(spend));
  const held = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    assert.equal(text(openIntent(keys.secretKey, KEY_ID, sealed)), spend);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: held, configurable: true });
  }
});

test('a keypair is reproducible from a seed, for offline key ceremonies', () => {
  const seed = new Uint8Array(64).fill(3);
  assert.deepEqual(generateIntentKeypair(seed), generateIntentKeypair(seed));
  assert.notEqual(generateIntentKeypair().publicKey, keys.publicKey);
});

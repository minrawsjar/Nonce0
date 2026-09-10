import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import test from 'node:test';

import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// The mesh's AEAD and key derivation moved from node:crypto to @noble so the
// SAME code builds onions in a browser. That is only safe if the two produce
// byte-identical output, because a relay and a client that disagree by one
// byte do not interoperate — and relays already built from the node:crypto
// version must keep accepting frames from browsers running the new one.
//
// So this pins @noble against node:crypto directly, for the exact parameter
// shapes transport.ts and return-path.ts use, across many random inputs. It
// guards the port AND any future upgrade of either library: RFC 5869 HKDF and
// AES-256-GCM are standards, and this is what proves both sides still are.

const ROUNDS = 256;
const utf8 = (s: string) => new TextEncoder().encode(s);
const nodeHkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array) =>
  new Uint8Array(hkdfSync('sha256', ikm, salt, info, 32));

function nodeSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return new Uint8Array(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]));
}

function nodeOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array {
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return new Uint8Array(Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]));
}

test('HKDF-SHA256 agrees byte for byte, for the hop-key shape', () => {
  // transport.ts: ikm = ML-KEM shared secret (32B), salt = utf8(hex hopLocalId)
  // — the UTF-8 of the 32-char hex STRING, not its 16 raw bytes. Easy to get
  // wrong in a port, and wrong here means no relay can open any layer.
  for (let i = 0; i < ROUNDS; i++) {
    const ikm = randomBytes(32);
    const salt = utf8(randomBytes(16).toString('hex'));
    const info = utf8('opaque/v1/mesh/hop-key');
    assert.deepEqual(hkdf(sha256, ikm, salt, info, 32), nodeHkdf(ikm, salt, info));
  }
});

test('HKDF-SHA256 agrees byte for byte, for the return-key shape', () => {
  // return-path.ts: salt = the 1088-byte ML-KEM ciphertext.
  for (let i = 0; i < ROUNDS; i++) {
    const ikm = randomBytes(32);
    const salt = randomBytes(1088);
    const info = utf8('opaque/v1/mesh/return-key');
    assert.deepEqual(hkdf(sha256, ikm, salt, info, 32), nodeHkdf(ikm, salt, info));
  }
});

test('AES-256-GCM seals identically, ciphertext and tag both', () => {
  for (let i = 0; i < ROUNDS; i++) {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    // AAD sized like a real frame header (69B) and like a KEM ciphertext.
    const aad = randomBytes(i % 2 === 0 ? 69 : 1088);
    const pt = randomBytes(1 + (i * 97) % 5000);
    assert.deepEqual(gcm(key, nonce, aad).encrypt(pt), nodeSeal(key, nonce, aad, pt));
  }
});

test('each side opens what the other sealed', () => {
  // The interop that matters during a rollout: a relay built from the old
  // image and a browser on the new code must read each other's frames.
  for (let i = 0; i < ROUNDS; i++) {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = randomBytes(69);
    const pt = randomBytes(1 + (i * 131) % 5000);
    assert.deepEqual(gcm(key, nonce, aad).decrypt(nodeSeal(key, nonce, aad, pt)), new Uint8Array(pt));
    assert.deepEqual(nodeOpen(key, nonce, aad, gcm(key, nonce, aad).encrypt(pt)), new Uint8Array(pt));
  }
});

test('a tampered header is rejected by both, so AAD is really bound', () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const aad = randomBytes(69);
  const sealed = gcm(key, nonce, aad).encrypt(utf8('payment'));
  const flipped = Uint8Array.from(aad);
  flipped[10] = flipped[10]! ^ 1;
  assert.throws(() => gcm(key, nonce, flipped).decrypt(sealed));
  assert.throws(() => nodeOpen(key, nonce, flipped, sealed));
});

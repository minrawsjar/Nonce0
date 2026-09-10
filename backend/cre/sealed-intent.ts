// The CRE recipient key, and the sealing that actually uses it.
//
// docs/cre-key-origin.md establishes WHY this exists: Chainlink documents no
// API for encrypting a fresh per-request payload to an enclave key, so we do
// not pretend one exists. Instead we choose our own keypair, hand the SECRET
// half to the Vault DON as a static secret, publish the PUBLIC half in the
// signed relay directory, and seal every intent ourselves. Chainlink holds a
// key; it does not define our cryptography.
//
// ── Why this file uses no node:crypto ────────────────────────────────────
//
// CRE workflows compile to WASM and run under Javy (QuickJS). That is NOT
// Node: `node:crypto`, `fetch` and `setTimeout` do not exist there, and the
// compiler rejects them. backend/mesh does use node:crypto, so none of the
// mesh's sealing can run inside the enclave — this is the pure-JS twin, built
// on @noble, and it is the reason the two are not one file.
//
// ── The asymmetry that makes it work ─────────────────────────────────────
//
//   sealIntent   NEEDS randomness (ML-KEM encapsulation + a fresh nonce).
//                It runs in the browser, which has crypto.getRandomValues.
//                It lives in seal-client.ts.
//   openIntent   needs NONE. ML-KEM decapsulation and AES-GCM decryption are
//                both deterministic, so the enclave never has to be trusted
//                for entropy — it only has to hold a secret. It lives HERE.
//
// That split is load-bearing, and it is a file boundary rather than a comment
// so that it is mechanical: the workflow's compile unit includes this file and
// not seal-client.ts, so it contains no reference to an RNG that Javy may not
// even provide. A design needing fresh entropy inside the enclave would rest
// on a QuickJS RNG whose seeding nobody has specified.

import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import { ProtocolFailure, type Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

const KEM_CIPHERTEXT_BYTES = 1088; // ML-KEM-768
export const KEM_PUBLIC_KEY_BYTES = 1184;
const KEM_SECRET_KEY_BYTES = 2400;
export const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_INFO = 'opaque/v1/cre/intent-key';

/**
 * Bounded: an unbounded sealed intent is a memory bomb aimed at the enclave.
 *
 * 1.25 MiB because a RING_8 spend carries a 1,101 KiB ZKBoo proof, which is
 * what the attester has to verify. It was 128 KiB, which no ring spend could
 * ever fit — the path from wallet to attester had never carried one. The proof
 * now travels as raw bytes (see encodeIntentPlaintext); as hex it was 2,202 KiB.
 * docs/proof-transport.md has the measurements.
 */
export const MAX_SEALED_INTENT_BYTES = 1280 * 1024;

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Salted with the KEM ciphertext, which is fresh per seal. The AAD binds the
 * ENCRYPTION KEY ID as well, so a ciphertext sealed to key version 1 cannot be
 * presented as one sealed to version 2 — rotation would otherwise leave every
 * old ciphertext replayable against the new key's workflow.
 */
export function intentKey(sharedSecret: Uint8Array, kemCiphertext: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, kemCiphertext, utf8(HKDF_INFO), 32);
}

export const aad = (keyId: string, kemCiphertext: Uint8Array): Uint8Array => {
  const id = utf8(keyId);
  const out = new Uint8Array(4 + id.length + kemCiphertext.length);
  new DataView(out.buffer).setUint32(0, id.length, false);
  out.set(id, 4);
  out.set(kemCiphertext, 4 + id.length);
  return out;
};

/**
 * ENCLAVE SIDE. Deterministic, and therefore safe under a runtime whose RNG
 * nobody has specified.
 *
 * `secretKey` is what `runtime.getSecret({ id })` returned. It is a Vault
 * secret's value, which the SDK types as a STRING, so it is carried as hex.
 */
export function openIntent(secretKey: Hex, keyId: string, sealed: Hex): Uint8Array {
  const decapsulationKey = fromHex(secretKey);
  if (decapsulationKey.length !== KEM_SECRET_KEY_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'CRE secret is not an ML-KEM-768 decapsulation key');
  }
  const bytes = fromHex(sealed);
  if (bytes.length > MAX_SEALED_INTENT_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'sealed intent exceeds the size the enclave accepts');
  }
  if (bytes.length < KEM_CIPHERTEXT_BYTES + NONCE_BYTES + GCM_TAG_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'sealed intent is too short to be one');
  }

  const cipherText = bytes.subarray(0, KEM_CIPHERTEXT_BYTES);
  const nonce = bytes.subarray(KEM_CIPHERTEXT_BYTES, KEM_CIPHERTEXT_BYTES + NONCE_BYTES);
  const body = bytes.subarray(KEM_CIPHERTEXT_BYTES + NONCE_BYTES);

  // ML-KEM decapsulation is IMPLICIT-REJECTION: a corrupt ciphertext yields a
  // wrong-but-well-formed shared secret rather than an error. The GCM tag
  // below is what actually rejects it, which is why this must never be
  // written as "if decapsulate throws".
  const sharedSecret = ml_kem768.decapsulate(cipherText, decapsulationKey);
  try {
    return gcm(intentKey(sharedSecret, cipherText), nonce, aad(keyId, cipherText)).decrypt(body);
  } catch {
    // One message for a wrong key, a wrong key id and a tampered body alike:
    // distinguishing them tells a submitter which part of their forgery to fix.
    throw new ProtocolFailure('INVALID_INPUT', 'sealed intent does not authenticate');
  }
}

// ── the plaintext inside the seal ─────────────────────────────────────────
//
// A container, not JSON, because JSON cannot hold bytes: the ZKBoo proof had
// to travel as hex, which doubled it to 2,202 KiB — twice what the enclave has
// to hold, and twice the mesh messages to carry it. The proof now sits after
// the JSON as raw bytes.
//
//   byte 0      0x01                  format version
//   bytes 1..4  u32 big-endian L      length of the JSON part
//   L bytes     utf8 JSON             { spend (minus proof), credential }
//   the rest    raw bytes             the proof
//
// JSON always begins with '{' (0x7B), so a legacy all-JSON plaintext is still
// read — the committed CRE simulate fixture uses it — and there is exactly one
// way to write a new one.

const PLAINTEXT_V1 = 0x01;
const JSON_OPEN = 0x7b;

const bigintAsDecimal = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString(10) : value;

/** What a wallet seals. The spend's proof leaves the JSON and follows it as bytes. */
export function encodeIntentPlaintext(spend: { readonly proof: Hex }, credential: string): Uint8Array {
  const { proof, ...rest } = spend as { proof: Hex } & Record<string, unknown>;
  const json = utf8(JSON.stringify({ spend: rest, credential }, bigintAsDecimal));
  const proofBytes = fromHex(proof);
  const out = new Uint8Array(5 + json.length + proofBytes.length);
  out[0] = PLAINTEXT_V1;
  new DataView(out.buffer).setUint32(1, json.length, false);
  out.set(json, 5);
  out.set(proofBytes, 5 + json.length);
  return out;
}

/**
 * What the enclave reads back. Returns the spend as a plain object with its
 * proof restored as hex — the caller decodes it with asPrivateSpend, which is
 * what revives the bigints and validates the rest.
 */
export function decodeIntentPlaintext(bytes: Uint8Array): { spend: Record<string, unknown>; credential: string } {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  if (bytes[0] === JSON_OPEN) {
    return JSON.parse(text(bytes)) as { spend: Record<string, unknown>; credential: string };
  }
  if (bytes[0] !== PLAINTEXT_V1 || bytes.length < 5) {
    throw new ProtocolFailure('INVALID_INPUT', 'sealed intent plaintext is in an unknown format');
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
  if (5 + length > bytes.length) {
    throw new ProtocolFailure('INVALID_INPUT', 'sealed intent plaintext declares a bad length');
  }
  const parsed = JSON.parse(text(bytes.subarray(5, 5 + length))) as {
    spend: Record<string, unknown>;
    credential: string;
  };
  return { spend: { ...parsed.spend, proof: toHex(bytes.subarray(5 + length)) }, credential: parsed.credential };
}

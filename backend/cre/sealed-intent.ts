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
import { fromHex } from '@opaque/protocol-types/codecs.js';

const KEM_CIPHERTEXT_BYTES = 1088; // ML-KEM-768
export const KEM_PUBLIC_KEY_BYTES = 1184;
const KEM_SECRET_KEY_BYTES = 2400;
export const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_INFO = 'opaque/v1/cre/intent-key';

/** Bounded: an unbounded sealed intent is a memory bomb aimed at the enclave. */
export const MAX_SEALED_INTENT_BYTES = 128 * 1024;

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

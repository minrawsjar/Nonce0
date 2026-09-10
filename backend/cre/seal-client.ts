// The client half of the CRE intent seal: everything that needs an RNG.
//
// Split out of sealed-intent.ts on purpose. A CRE workflow compiles to WASM
// and runs under Javy (QuickJS), whose RNG nobody has specified, so the
// enclave's compile unit must not so much as reference `crypto`. Keeping the
// two halves in separate files makes that mechanical rather than a promise:
// the workflow includes sealed-intent.ts and never this file.
//
// Everything here runs in the browser, or offline for a key ceremony.

import { gcm } from '@noble/ciphers/aes.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import {
  PROTOCOL_VERSION,
  ProtocolFailure,
  type Bytes32,
  type CredentialHandle,
  type EncryptedIntent,
  type Hex,
  type PaymentRequest,
  type PoolScope,
} from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import {
  KEM_PUBLIC_KEY_BYTES,
  MAX_SEALED_INTENT_BYTES,
  NONCE_BYTES,
  aad,
  encodeIntentPlaintext,
  intentKey,
} from './sealed-intent.ts';

export interface IntentKeypair {
  /** Published in the signed relay directory. Safe to hand to anyone. */
  readonly publicKey: Hex;
  /** Stored in the Vault DON. Never leaves an offline machine otherwise. */
  readonly secretKey: Hex;
}

/**
 * Run OFFLINE, once per key version. The secret half goes into the Vault DON
 * via `cre secrets create`; the public half goes into the directory.
 *
 * Needs an RNG, so this is a tooling function — never called in a workflow.
 */
export function generateIntentKeypair(seed?: Uint8Array): IntentKeypair {
  const { publicKey, secretKey } = seed === undefined ? ml_kem768.keygen() : ml_kem768.keygen(seed);
  return { publicKey: toHex(publicKey), secretKey: toHex(secretKey) };
}

/**
 * CLIENT SIDE. Seals a payload to the published CRE key.
 *
 * The payload is whatever the caller wants kept from the mesh and from the
 * executor — in Opaque, the complete spend plus the policy credential. Nothing
 * here inspects it: this is an envelope, and the binding to a specific spend
 * is `EncryptedIntent.spendHash`, which evaluate-intent.ts re-checks after
 * decryption.
 */
export function sealIntent(publicKey: Hex, keyId: string, payload: Uint8Array): Hex {
  const encapsulationKey = fromHex(publicKey);
  if (encapsulationKey.length !== KEM_PUBLIC_KEY_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'CRE key is not an ML-KEM-768 encapsulation key');
  }
  if (keyId.length === 0) {
    // Without an id the AAD binds nothing, and rotation stops being a barrier.
    throw new ProtocolFailure('INVALID_INPUT', 'an encryption key id is required');
  }
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(encapsulationKey);
  // Nonce from the KEM ciphertext's own randomness would be a reuse hazard, so
  // it is drawn fresh. gcm() takes it explicitly rather than generating one,
  // which keeps the wire layout fixed and readable.
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const body = gcm(intentKey(sharedSecret, cipherText), nonce, aad(keyId, cipherText)).encrypt(payload);
  const sealed = new Uint8Array(cipherText.length + NONCE_BYTES + body.length);
  sealed.set(cipherText, 0);
  sealed.set(nonce, cipherText.length);
  sealed.set(body, cipherText.length + NONCE_BYTES);

  if (sealed.length > MAX_SEALED_INTENT_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'sealed intent exceeds the size the enclave accepts');
  }
  return toHex(sealed);
}

// ── the adapter port ──────────────────────────────────────────────────────

export interface IntentSealerOptions {
  /**
   * The CRE ML-KEM-768 encapsulation key, read from the SIGNED relay
   * directory. Never from a Graph response or a config a server can rewrite:
   * an attacker who substitutes this key reads every payment.
   */
  readonly crePublicKey: Hex;
  /** Which key version. Bound into the AEAD's AAD, so rotation is a barrier. */
  readonly encryptionKeyId: string;
  /**
   * Resolves the policy credential the enclave will verify. Injected because
   * where a credential comes from is a deployment question — a local vault, a
   * prior issuance call — and this module must not care.
   */
  readonly resolveCredential: (handle: CredentialHandle) => Promise<string>;
}

/**
 * Builds the EncryptedIntent the executor accepts.
 *
 * Everything the mesh, the executor and the chain get to see is chosen here,
 * and it is deliberately thin: a scope, a hash, a deadline, a score floor and
 * an opaque blob. The recipient, the amount beyond the pool's fixed
 * denomination, and the policy credential are all INSIDE the ciphertext.
 *
 * `spendHash` is the binding that makes the rest safe. It is public, and
 * evaluate-intent.ts recomputes it over the decrypted spend, so a payload
 * swapped after submission is caught before any policy decision is made on it.
 */
export function createIntentSealer(
  options: IntentSealerOptions,
): (input: {
  readonly scope: PoolScope;
  readonly spendHash: Bytes32;
  readonly spend: unknown;
  readonly request: PaymentRequest;
}) => Promise<EncryptedIntent> {
  return async (input) => {
    const credential = await options.resolveCredential(input.request.credentialHandle);

    // The proof travels as raw bytes after the JSON, not as hex inside it —
    // for a ring spend that is the difference between 1.1 MiB and 2.2 MiB.
    // Bigints inside the JSON still cross as decimal strings.
    const payload = encodeIntentPlaintext(input.spend as { proof: Hex }, credential);

    return {
      version: PROTOCOL_VERSION,
      scope: input.scope,
      encryptedPayload: sealIntent(
        options.crePublicKey,
        options.encryptionKeyId,
        payload,
      ),
      encryptionKeyId: options.encryptionKeyId,
      spendHash: input.spendHash,
      minPrivacyScore: input.request.minPrivacyScore,
      deadline: input.request.deadline,
      idempotencyKey: input.request.idempotencyKey,
    };
  };
}

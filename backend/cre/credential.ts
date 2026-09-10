// Recipient policy, checked inside the enclave.
//
// The obvious design is an HTTP call: decrypt the spend, POST the recipient to
// a compliance service, act on the answer. It is also the design that gives
// the whole game away. That service then learns every recipient and the exact
// moment each payment is evaluated, which is most of what the mesh, the ring
// and the enclave were built to withhold — and CRE's own SDK makes it worse,
// because a capability call from a TEE handler is routed out through the DONs.
//
// So the recipient never leaves. The client obtains a CREDENTIAL from the
// policy authority ONCE, out of band, and seals it into the intent alongside
// the spend. The enclave verifies it locally: a MAC over (recipient, policy
// version, expiry) under a key held as a Vault DON secret.
//
// What this buys:
//   * The authority never sees a payment. It issued a credential at some
//     earlier time, for a recipient, with no idea which payment would use it
//     or when — so it cannot correlate issuance with settlement.
//   * No network call on the decrypted path at all, so there is nothing to
//     leak through timing, size, or a DON-routed request.
//
// What it costs, stated plainly:
//   * Revocation is only as fast as the credential's TTL. An authority that
//     needs to revoke within minutes must issue minute-long credentials, and
//     that is a real operational cost, not a footnote.
//   * The authority and the enclave share a symmetric key, so the authority
//     could mint a credential for any recipient. It is trusted for issuance
//     already; this adds no new trust, but it is not a signature and must not
//     be described as one.
//
// Pure JS: this runs under Javy (QuickJS), where node:crypto does not exist.

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { ProtocolFailure, type Address, type Hex, type UnixSeconds } from '@opaque/protocol-types';
import { encodeBigint, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

const CREDENTIAL_DOMAIN = 'opaque/v1/cre/recipient-credential';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Length-prefixed, so no two distinct field lists share a byte string. */
function canonical(fields: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const field of fields) {
    view.setUint32(at, field.length, false);
    out.set(field, at + 4);
    at += 4 + field.length;
  }
  return out;
}

/** Constant time. See release.ts for why this is hand-rolled and not node's. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface RecipientCredential {
  readonly recipient: Address;
  /** Bound in, so a credential cannot be carried across a policy change. */
  readonly policyVersion: string;
  readonly expiresAt: UnixSeconds;
  readonly tag: Hex;
}

const macInput = (credential: Omit<RecipientCredential, 'tag'>): Uint8Array =>
  canonical([
    utf8(CREDENTIAL_DOMAIN),
    utf8(credential.recipient),
    utf8(credential.policyVersion),
    utf8(encodeBigint(credential.expiresAt)),
  ]);

/**
 * ISSUER SIDE — the policy authority, offline or in its own service. Present
 * here so both ends agree on the bytes, and so the tests can issue one.
 */
export function issueCredential(
  input: Omit<RecipientCredential, 'tag'>,
  secret: Uint8Array,
): RecipientCredential {
  if (input.policyVersion.length === 0) {
    throw new ProtocolFailure('INVALID_INPUT', 'a credential needs a policy version');
  }
  return { ...input, tag: toHex(hmac(sha256, secret, macInput(input))) };
}

export type CredentialOutcome =
  | { readonly kind: 'APPROVED' }
  | { readonly kind: 'DENIED'; readonly reason: string };

/**
 * ENCLAVE SIDE. Returns an outcome rather than throwing: a credential that
 * does not verify is a policy DENIAL, which is a normal result the evaluator
 * records — not an exception that would abort the whole batch and strand every
 * other intent in it.
 *
 * The recipient is passed in from the DECRYPTED SPEND, not read from the
 * credential. A credential is only ever accepted for the recipient actually
 * being paid; otherwise one issued for an allowed address would authorise a
 * payment to any other.
 */
export function checkCredential(input: {
  readonly recipient: Address;
  readonly credential: RecipientCredential;
  readonly policyVersion: string;
  readonly now: UnixSeconds;
  readonly secret: Uint8Array;
}): CredentialOutcome {
  const { credential, recipient } = input;

  if (credential.recipient !== recipient) {
    return { kind: 'DENIED', reason: 'credential was issued for a different recipient' };
  }
  if (credential.policyVersion !== input.policyVersion) {
    return { kind: 'DENIED', reason: 'credential was issued under a different policy version' };
  }
  if (input.now >= credential.expiresAt) {
    // The revocation window. Short TTLs are the price of never calling out.
    return { kind: 'DENIED', reason: 'credential has expired' };
  }

  // Checked LAST, but checked on fields that were already compared — so a
  // forged tag cannot be probed field by field against a matching one.
  const expected = hmac(sha256, input.secret, macInput({
    recipient: credential.recipient,
    policyVersion: credential.policyVersion,
    expiresAt: credential.expiresAt,
  }));
  let actual: Uint8Array;
  try {
    actual = fromHex(credential.tag);
  } catch {
    return { kind: 'DENIED', reason: 'credential tag is malformed' };
  }
  if (!equalBytes(actual, expected)) {
    return { kind: 'DENIED', reason: 'credential does not authenticate' };
  }
  return { kind: 'APPROVED' };
}

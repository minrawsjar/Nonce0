// T7 — authenticated CRE-managed release (producer side).
//
// Replaces the original H(CRE_DOMAIN, spendHash, deadline, workflowSecret),
// which had an authorization producer and no verification consumer: nothing
// ever checked it, so it gated nothing.
//
// WHAT THIS IS: a service trust contract between the confidential release
// producer and the managed egress. Domain-separated HMAC-SHA-256 over the
// canonical ApprovedRelease fields, with a secret those two share and no
// relay holds.
//
// WHAT THIS IS NOT: an on-chain authorization proof. The pool is
// independently proof-gated and does not verify this tag, so anyone holding a
// valid spend can submit it directly and bypass policy entirely. That is
// disclosed, not hidden — deferred decision D1. Do not describe this as
// pool-wide compliance enforcement.

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  ProtocolFailure,
  type ApprovedRelease,
  type Bytes32,
  type Hex,
  type IntentId,
  type PrivateSpend,
  type UnixSeconds,
} from '@chaff/protocol-types';
import { encodeBigint, spendHash, toHex } from '@chaff/protocol-types/codecs.js';

const RELEASE_MAC_DOMAIN = 'projectx/v1/cre/approved-release';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

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

/**
 * The MAC covers every field except the tag. `intentId` is in there so a valid
 * release cannot be lifted onto a different intent, and `expiresAt` is in there
 * so the delivery window cannot be widened by an egress or a relay.
 */
function macInput(release: Omit<ApprovedRelease, 'authenticationTag'>): Uint8Array {
  const { spend } = release;
  return canonical([
    utf8(RELEASE_MAC_DOMAIN),
    utf8(release.intentId),
    utf8(release.spendHash),
    utf8(release.policyVersion),
    utf8(encodeBigint(release.issuedAt)),
    utf8(encodeBigint(release.expiresAt)),
    utf8(spend.mode),
    utf8(encodeBigint(spend.scope.chainId)),
    utf8(spend.scope.pool),
    utf8(String(spend.scope.denomination)),
  ]);
}

const tag = (release: Omit<ApprovedRelease, 'authenticationTag'>, secret: Uint8Array): Hex =>
  toHex(createHmac('sha256', secret).update(macInput(release)).digest());

/**
 * Called only after policy has APPROVED, inside the confidential handler.
 *
 * `ttlSeconds` is a delivery validity window and is deliberately separate from
 * the scheduling deadline: immediate mode sets `deadline = now`, and reusing
 * the deadline here would mint an authorization that is already expired.
 */
export function issueRelease(input: {
  readonly intentId: IntentId;
  readonly spend: PrivateSpend;
  readonly policyVersion: string;
  readonly issuedAt: UnixSeconds;
  readonly ttlSeconds: bigint;
  readonly secret: Uint8Array;
}): ApprovedRelease {
  if (input.ttlSeconds <= 0n) {
    throw new ProtocolFailure('INVALID_INPUT', 'a release TTL must be positive');
  }
  const unsigned = {
    intentId: input.intentId,
    spend: input.spend,
    spendHash: spendHash(input.spend),
    policyVersion: input.policyVersion,
    issuedAt: input.issuedAt,
    expiresAt: (input.issuedAt + input.ttlSeconds) as UnixSeconds,
  };
  return { ...unsigned, authenticationTag: tag(unsigned, input.secret) };
}

export interface ReleaseSeenSet {
  /** True if this intent already had a release delivered. Records it either way. */
  seen(intentId: IntentId): boolean;
}

export class MemoryReleaseSeenSet implements ReleaseSeenSet {
  #delivered = new Set<IntentId>();
  seen(intentId: IntentId): boolean {
    if (this.#delivered.has(intentId)) return true;
    this.#delivered.add(intentId);
    return false;
  }
}

/**
 * Egress side. Verifies before submitting, and never before.
 *
 * Order matters: the tag is checked first, so a forged release is rejected
 * without its contents ever being trusted enough to compare against anything.
 */
export function verifyRelease(input: {
  readonly release: ApprovedRelease;
  readonly secret: Uint8Array;
  readonly now: UnixSeconds;
  readonly expectedSpendHash?: Bytes32;
}): PrivateSpend {
  const { release, now } = input;
  const { authenticationTag, ...unsigned } = release;

  const expected = Buffer.from(tag(unsigned, input.secret).slice(2), 'hex');
  const actual = Buffer.from(authenticationTag.slice(2), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ProtocolFailure('POLICY_DENIED', 'release authentication failed');
  }

  // The tag covers spendHash, but not the spend body. Recomputing it here is
  // what stops an altered spend riding a valid tag from another release.
  if (spendHash(release.spend) !== release.spendHash) {
    throw new ProtocolFailure('POLICY_DENIED', 'release spend does not match its own hash');
  }
  if (input.expectedSpendHash !== undefined && release.spendHash !== input.expectedSpendHash) {
    throw new ProtocolFailure('POLICY_DENIED', 'release is for a different spend');
  }
  if (now >= release.expiresAt) {
    throw new ProtocolFailure('EXPIRED', 'release delivery window has closed');
  }
  if (release.issuedAt > now) {
    throw new ProtocolFailure('POLICY_DENIED', 'release is issued in the future');
  }
  return release.spend;
}

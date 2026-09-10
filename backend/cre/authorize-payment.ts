import { sha256 } from '@noble/hashes/sha2.js';

import {
  ProtocolFailure,
  type Address,
  type Bytes32,
  type IntentId,
  type Nullifier,
  type PrivateSpend,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { spendHash, toHex } from '@opaque/protocol-types/codecs.js';

/** Exact wire shape consumed by ICREPolicyGate.Authorization. */
export interface CreAuthorization {
  readonly id: Bytes32;
  readonly spendHash: Bytes32;
  readonly nullifier: Nullifier;
  readonly pool: Address;
  readonly recipient: Address;
  readonly feeCollector: Address;
  readonly grossAmount: bigint;
  readonly feeAmount: bigint;
  readonly feeBps: number;
  readonly expiresAt: UnixSeconds;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

function authorizationId(intentId: IntentId, spend: PrivateSpend, expiresAt: UnixSeconds): Bytes32 {
  // The publisher cannot choose a fresh id for an identical retry. This binds
  // the public settlement fields, including recipient and nullifier, to one
  // deterministic one-shot gate entry.
  return toHex(sha256(utf8([
    'opaque/v1/cre-authorization', intentId, spendHash(spend), spend.nullifier,
    spend.scope.pool, String(spend.scope.chainId), String(spend.scope.denomination),
    spend.recipient, expiresAt.toString(10),
  ].join('|')))) as Bytes32;
}

export async function authorizePayment(input: {
  readonly intentId: IntentId;
  readonly spends: readonly PrivateSpend[];
  readonly feeBps: number;
  readonly feeCollector: Address;
  readonly expiresAt: UnixSeconds;
  readonly now: UnixSeconds;
  readonly verifyRingSpend: (spend: PrivateSpend, index: number) => Promise<boolean>;
  readonly publish: (authorization: CreAuthorization) => Promise<void>;
}): Promise<readonly CreAuthorization[]> {
  if (input.spends.length === 0) throw new ProtocolFailure('INVALID_INPUT', 'a payment needs at least one note');
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000) {
    throw new ProtocolFailure('INVALID_INPUT', 'fee BPS is out of range');
  }
  if (input.expiresAt <= input.now) throw new ProtocolFailure('EXPIRED', 'authorization is already expired');

  const recipient = input.spends[0]!.recipient;
  const nullifiers = new Set<string>();
  // Verify everything before publishing anything. A partial payment is a
  // payment integrity failure, not a useful partial success.
  for (let index = 0; index < input.spends.length; index++) {
    const spend = input.spends[index]!;
    if (spend.mode !== 'RING_8' || spend.recipient !== recipient) {
      throw new ProtocolFailure('INVALID_INPUT', 'all authorization chunks must be ring spends for one recipient');
    }
    if (nullifiers.has(spend.nullifier)) throw new ProtocolFailure('INVALID_INPUT', 'payment repeats a nullifier');
    nullifiers.add(spend.nullifier);
    if (!(await input.verifyRingSpend(spend, index))) {
      throw new ProtocolFailure('PROOF_REJECTED', 'CRE rejected a ring proof');
    }
  }

  const authorizations = input.spends.map((spend) => {
    const grossAmount = BigInt(spend.scope.denomination);
    const feeAmount = (grossAmount * BigInt(input.feeBps) + 9_999n) / 10_000n;
    if (feeAmount >= grossAmount) throw new ProtocolFailure('INVALID_INPUT', 'fee leaves no recipient amount');
    return {
      id: authorizationId(input.intentId, spend, input.expiresAt),
      spendHash: spendHash(spend), nullifier: spend.nullifier, pool: spend.scope.pool,
      recipient: spend.recipient, feeCollector: input.feeCollector, grossAmount, feeAmount,
      feeBps: input.feeBps, expiresAt: input.expiresAt,
    } satisfies CreAuthorization;
  });
  for (const authorization of authorizations) await input.publish(authorization);
  return authorizations;
}

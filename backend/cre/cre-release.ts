// The CRE decision, written once for its two runners: the confidential
// workflow (opaque-cre/confidential-intent) and the local stand-in
// (simulator.ts). Pure JS, no Node and no RNG, because it compiles into the
// enclave.
//
// Every 30 s the workflow reads the executor's pending envelopes, decides each
// here, and posts the decisions back in one request:
//
//   WAIT      not yet eligible: before its deadline, and the privacy score is
//             below what the payer asked for (or unknown).
//   RELEASE   eligible, the envelope opens, it is for this spend, and the
//             recipient's credential verifies. Carries the recipient and the
//             bulk key K, under a tag the executor checks.
//   DENY      the envelope or the credential fails.
//
// Timing is decided on the payer's own terms, sealed in the envelope — never
// on the executor's copy beside it, which would let the executor restate a
// deadline and have a recipient released early. So every envelope is opened;
// the enclave is the boundary, and a WAIT reveals nothing outside it.

import type { Address, Hex, PoolScope, UnixSeconds } from '@opaque/protocol-types';
import { poolId } from '@opaque/protocol-types/codecs.js';

import { readinessScores } from '../../graph/src/privacy-score.ts';
import { checkCredential, type RecipientCredential } from './credential.ts';
import { openEnvelope, releaseTag, type Envelope } from './sealed-intent.ts';

/** One intent as the executor serves it: an id, its spend's hash, and the sealed envelope. Nothing else is trusted. */
export interface PendingIntent {
  readonly intentId: string;
  readonly spendHash: string;
  readonly envelope: Hex;
}

export interface PendingBatch {
  readonly intents: readonly PendingIntent[];
}

export type Decision =
  | { readonly intentId: string; readonly verdict: 'RELEASE'; readonly recipient: string; readonly k: Hex; readonly tag: Hex }
  | { readonly intentId: string; readonly verdict: 'DENY'; readonly reason: string; readonly tag: Hex };

export interface DecisionBatch {
  readonly decisions: readonly Decision[];
}

/** The subgraph's id for a pool's ring: `${poolId(scope)}-${denomination}` (graph/src/mapping.ts). */
export const ringPoolKey = (scope: Envelope['scope']): string =>
  `${poolId({ chainId: BigInt(scope.chainId), pool: scope.pool, denomination: scope.denomination } as unknown as PoolScope)}-${scope.denomination}`;

/**
 * What the workflow asks the subgraph each tick. Every pool at once, so the
 * question is the same whichever pools have payments waiting.
 */
export const GRAPH_QUERY =
  '{ _meta { hasIndexingErrors block { timestamp } } ringPools(first: 1000) { id poolSize } relayNodes(first: 100) { id reliabilityScore batchOccupancy lastSeenAt } }';

// As the exit reads the same data (mesh/graph-health.ts, graph/src/client.ts).
const INDEX_MAX_AGE = 300n;
const HEALTH_MAX_AGE = 900n;
const RELIABILITY_FLOOR = 5_000;
const MAX_OCCUPANCY = 4;

/**
 * Each pool's privacy score from a GRAPH_QUERY response, by the exit's own
 * formula. Relays are the pinned directory's (`relayOperators`: id → operator):
 * the Graph cannot add one, nor remove one by omitting it, and stale or absent
 * health counts as the uniform prior. An unhealthy or stale index gives no
 * scores at all, so payments wait for their deadlines rather than go on it.
 */
export function scoresFromGraph(body: unknown, relayOperators: Readonly<Record<string, string>>, now: UnixSeconds): Map<string, number> {
  const scores = new Map<string, number>();
  const data = (body as { data?: Record<string, any> } | null)?.data;
  const at = Number(data?.['_meta']?.block?.timestamp);
  if (data?.['_meta']?.hasIndexingErrors !== false || !Number.isSafeInteger(at) || now - BigInt(at) > INDEX_MAX_AGE) return scores;

  const reported = new Map<string, Record<string, unknown>>(
    (Array.isArray(data['relayNodes']) ? data['relayNodes'] : []).map((n: Record<string, unknown>) => [String(n['id']), n]),
  );
  const clamp = (v: unknown, low: number, high: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.trunc(n))) : low;
  };
  const nodes = Object.entries(relayOperators).map(([id, operatorId]) => {
    const node = reported.get(id);
    const fresh = node !== undefined && /^\d+$/.test(String(node['lastSeenAt'])) && now - BigInt(String(node['lastSeenAt'])) <= HEALTH_MAX_AGE;
    return {
      operatorId,
      reliabilityScore: fresh ? clamp(node!['reliabilityScore'], RELIABILITY_FLOOR, 10_000) : RELIABILITY_FLOOR,
      batchOccupancy: fresh ? clamp(node!['batchOccupancy'], 1, MAX_OCCUPANCY) : 1,
    };
  });
  for (const pool of Array.isArray(data['ringPools']) ? data['ringPools'] : []) {
    const size = Number(pool?.poolSize);
    if (typeof pool?.id !== 'string' || !Number.isSafeInteger(size) || size < 0) continue;
    scores.set(pool.id, readinessScores(size, nodes).privacyScore);
  }
  return scores;
}

export interface DecideInput {
  readonly intent: PendingIntent;
  readonly now: UnixSeconds;
  /** A pool's privacy score (0..10000) by ringPoolKey, or undefined when it could not be read fresh. */
  readonly scoreOf: (ringPool: string) => number | undefined;
  /** The ML-KEM decapsulation key (sealed-intent.ts decapsulationKey). */
  readonly secretKey: Hex;
  readonly encryptionKeyId: string;
  /** Shared with the executor: verifies credentials and tags decisions. */
  readonly credentialSecret: Uint8Array;
  readonly policyVersion: string;
}

export function decide(input: DecideInput): Decision | { readonly intentId: string; readonly verdict: 'WAIT' } {
  const { intent } = input;
  const deny = (reason: string): Decision => ({
    intentId: intent.intentId, verdict: 'DENY', reason,
    tag: releaseTag(input.credentialSecret, { intentId: intent.intentId, spendHash: intent.spendHash, verdict: 'DENY' }),
  });

  // THE LINE. Below here a recipient exists in plaintext, in the enclave.
  let opened: Envelope;
  try {
    opened = openEnvelope(input.secretKey, input.encryptionKeyId, intent.envelope);
  } catch {
    return deny('the envelope does not open under this key');
  }
  if (opened.spendHash.toLowerCase() !== intent.spendHash.toLowerCase()) {
    return deny('the envelope is for a different spend');
  }

  // Timing, on the payer's sealed terms. At the deadline a payment goes
  // regardless of the score, so a Graph outage never strands one; a payer who
  // asked for no wait (0) goes at once.
  const score = input.scoreOf(ringPoolKey(opened.scope));
  const eligible = input.now >= BigInt(opened.deadline) || opened.minPrivacyScore === 0
    || (score !== undefined && score >= opened.minPrivacyScore);
  if (!eligible) return { intentId: intent.intentId, verdict: 'WAIT' };

  let credential: RecipientCredential;
  try {
    const raw = JSON.parse(opened.credential) as Record<string, unknown>;
    credential = {
      recipient: raw['recipient'] as Address,
      policyVersion: String(raw['policyVersion'] ?? ''),
      expiresAt: BigInt(String(raw['expiresAt'] ?? '0')) as UnixSeconds,
      tag: raw['tag'] as Hex,
    };
  } catch {
    return deny('credential is not readable');
  }
  // The recipient comes from the envelope the payer sealed, and the executor
  // refuses the release unless the decrypted spend pays exactly that address.
  const policy = checkCredential({
    recipient: opened.recipient as Address, credential, policyVersion: input.policyVersion,
    now: input.now, secret: input.credentialSecret,
  });
  if (policy.kind !== 'APPROVED') return deny(policy.reason);

  return {
    intentId: intent.intentId, verdict: 'RELEASE', recipient: opened.recipient, k: opened.k,
    tag: releaseTag(input.credentialSecret, {
      intentId: intent.intentId, spendHash: intent.spendHash, verdict: 'RELEASE', recipient: opened.recipient, k: opened.k,
    }),
  };
}

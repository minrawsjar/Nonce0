// Ring decoy selection (§8.1). Owner: Aditya, T6.
//
// The ORDER of the steps is the whole point. §8.1 is explicit that applying
// enrolledAt diversity *before* the Sybil heuristics is what made the original
// algorithm actively favour a freshly-deposited flood:
//
//   a. exclude anything above a reuse-frequency threshold
//   b. deprioritise members whose fundingCluster is an unusually large share
//      of the pool (the airdrop-farm detection heuristic)
//   c. prefer members with hasOtherActivity === true
//   d. weight toward enrolledAt diversity ONLY among what survives b and c
//   e. sample 7
//
// Two properties this file must never lose:
//
//   * Selection is LOCAL. The real note is excluded here, from a snapshot the
//     caller already holds. Nothing ever asks a remote service to exclude or
//     locate it — that request alone would identify the spender.
//   * fundingCluster and hasOtherActivity are NULLABLE, and null means
//     UNKNOWN. Treating null as zero or as false turns an absent measurement
//     into a fabricated signal, in both directions.

import {
  ProtocolFailure,
  type NoteCommitment,
  type PoolScope,
  type RingCandidate,
  type RingSnapshot,
} from '@opaque/protocol-types';
import { asNoteCommitment, asPoolScope } from '@opaque/protocol-types/codecs.js';
import { RING_SIZE } from '@opaque/zk';

export interface SelectionPolicy {
  /** Step a. A member used more often than this is excluded outright. */
  readonly maxTimesUsedInRing: number;
  /** Step b. A known cluster holding more than this share is deprioritised. */
  readonly clusterShareLimit: number;
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = Object.freeze({
  maxTimesUsedInRing: 16,
  clusterShareLimit: 0.2,
});

export interface SelectDecoysInput {
  readonly snapshot: RingSnapshot;
  readonly scope: PoolScope;
  /** The spender's own commitment. Excluded locally, never remotely. */
  readonly exclude: NoteCommitment;
  readonly count?: number;
  readonly policy?: SelectionPolicy;
  readonly randomInt?: (maxExclusive: number) => number;
}

/** Unbiased, and not Math.random: a predictable decoy set is a guessable one. */
export function cryptoRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % maxExclusive;
  }
}

/** A 128-bit image widened to bytes32, as backend/zk/statement.ts widen() makes it. */
const RING_IMAGE = /^0x[0-9a-f]{32}0{32}$/;

/** true → 2, unknown → 1, false → 0. Unknown is never demoted to false. */
const activityRank = (candidate: RingCandidate): number =>
  candidate.hasOtherActivity === null ? 1 : candidate.hasOtherActivity ? 2 : 0;

/**
 * Spreads a pick across the enrolment history instead of taking the newest n.
 * The list is cut into `need` contiguous age buckets and one member is drawn
 * uniformly from each, so a batch of same-block deposits can occupy at most
 * its share of the buckets rather than the whole ring.
 */
function ageDiverseSample(
  members: readonly RingCandidate[],
  need: number,
  randomInt: (maxExclusive: number) => number,
): NoteCommitment[] {
  if (members.length <= need) return members.map((m) => m.commitment);
  const byAge = [...members].sort((a, b) =>
    a.enrolledAtBlock < b.enrolledAtBlock ? -1 : a.enrolledAtBlock > b.enrolledAtBlock ? 1 : 0,
  );
  const out: NoteCommitment[] = [];
  for (let i = 0; i < need; i++) {
    const from = Math.floor((i * byAge.length) / need);
    const to = Math.floor(((i + 1) * byAge.length) / need);
    out.push(byAge[from + randomInt(to - from)]!.commitment);
  }
  return out;
}

/**
 * Throws INSUFFICIENT_ANONYMITY rather than padding a short candidate set. A
 * ring of five members presented as eight is worse than a refusal: the user
 * would believe in anonymity they do not have.
 */
export function selectDecoys(input: SelectDecoysInput): readonly NoteCommitment[] {
  const need = input.count ?? RING_SIZE - 1;
  const policy = input.policy ?? DEFAULT_SELECTION_POLICY;
  const randomInt = input.randomInt ?? cryptoRandomInt;

  const snapshotScope = asPoolScope(input.snapshot.scope);
  const scope = asPoolScope(input.scope);
  if (
    snapshotScope.chainId !== scope.chainId ||
    snapshotScope.pool !== scope.pool ||
    snapshotScope.denomination !== scope.denomination
  ) {
    throw new ProtocolFailure('INVALID_INPUT', 'ring snapshot describes a different pool');
  }

  // Trust boundary: the snapshot came off a wire from the Graph. Brands are
  // erased, so every commitment is checked and duplicates are collapsed — a
  // repeated member would inflate the apparent pool without adding anonymity.
  const seen = new Set<string>();
  const pool: RingCandidate[] = [];
  for (const raw of input.snapshot.candidates) {
    const commitment = asNoteCommitment(raw.commitment);
    if (!Number.isInteger(raw.timesUsedInRing) || raw.timesUsedInRing < 0) {
      throw new ProtocolFailure('INVALID_INPUT', 'timesUsedInRing must be a non-negative integer');
    }
    // The ring proves membership over 128-bit images. The pool takes any
    // bytes32, so a commitment with data past 16 bytes is a real deposit that
    // can never sit in a ring. Anyone can make one for the price of a note,
    // so it is skipped here rather than failing every spend that draws it.
    if (!RING_IMAGE.test(commitment)) continue;
    if (seen.has(commitment)) continue;
    seen.add(commitment);
    pool.push({ ...raw, commitment });
  }

  // (a) Reuse threshold, and the local exclusion of our own note.
  const eligible = pool.filter(
    (c) => c.commitment !== input.exclude && c.timesUsedInRing <= policy.maxTimesUsedInRing,
  );

  // (b) Cluster share, measured over what survived (a). A null cluster is
  // UNKNOWN: it joins no cluster's count and is never penalised as if it did.
  const clusterSize = new Map<string, number>();
  for (const c of eligible) {
    if (c.fundingCluster !== null) {
      clusterSize.set(c.fundingCluster, (clusterSize.get(c.fundingCluster) ?? 0) + 1);
    }
  }
  const shareLimit = policy.clusterShareLimit * eligible.length;
  const oversized = (c: RingCandidate): boolean =>
    c.fundingCluster !== null && (clusterSize.get(c.fundingCluster) ?? 0) > shareLimit;

  // (b) then (c): cluster is the primary key, organic activity the secondary.
  // Deprioritise, not exclude — §8.1 says deprioritise, so a pool with no
  // clean members still yields a ring, from the penalised tier and no other.
  const tiers = new Map<number, RingCandidate[]>();
  for (const c of eligible) {
    const rank = (oversized(c) ? 0 : 3) + activityRank(c);
    const tier = tiers.get(rank);
    if (tier === undefined) tiers.set(rank, [c]);
    else tier.push(c);
  }

  // (d) and (e): fill from the best tier down, age-diverse within each tier.
  const chosen: NoteCommitment[] = [];
  for (const rank of [...tiers.keys()].sort((a, b) => b - a)) {
    if (chosen.length >= need) break;
    chosen.push(...ageDiverseSample(tiers.get(rank)!, need - chosen.length, randomInt));
  }

  if (chosen.length < need) {
    throw new ProtocolFailure(
      'INSUFFICIENT_ANONYMITY',
      `the pool offers ${chosen.length} usable decoys, ${need} are required`,
      true,
    );
  }
  return chosen;
}

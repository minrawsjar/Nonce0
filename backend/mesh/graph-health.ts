// The §8.2 health feed, adapted into the mesh's `health` hook.
//
// The Graph observes which relays are busy and which are reliable; the mesh
// draws three hops from six. This is the join, and almost all of it is about
// what the Graph is NOT allowed to do.
//
// ── The attack this is shaped around ─────────────────────────────────────
//
// The Graph is reached over the network. A hostile or compromised one wants
// every payment routed through relays it runs, because three hops it owns is
// no hops at all. It has three ways to try:
//
//   1. Add its own relays to the pool.       Impossible here: this returns a
//      health record for a directory entry and can never produce an entry.
//      Relay identity and keys come from the signed directory, verified
//      against a pinned root before any relay is contacted.
//
//   2. Remove honest relays from the pool.   Blocked: reliability is clamped
//      UP to the policy floor, so a Graph answer can never push a relay below
//      the threshold that would exclude it. Only the directory's own validity
//      window removes a relay.
//
//   3. Starve honest relays of weight.       Bounded: §8.2 weights on
//      occupancy / (1 + recentSelectionCount), and both are clamped, so the
//      ratio between the most and least favoured relay is capped. The Graph
//      can express a preference. It cannot dictate a route.
//
// The cost of (2) is real and chosen deliberately: a genuinely dead relay
// stays eligible and some payments fail against it and retry. That is the
// right trade. A Graph that can exclude relays can force a path; a Graph that
// cannot merely wastes an attempt.

import type { RelaySnapshot, PrivacyScore, UnixSeconds } from '@opaque/protocol-types';

import type { RelayHealth } from './bootstrap.ts';
import type { RelayDirectory } from './contracts.ts';

/**
 * Must match the reliability floor of the policy this feeds — MarkovPathPolicy
 * uses 5000. Clamping to a floor the policy does not share would let an
 * observation slip under it and exclude a relay after all.
 */
export const DEFAULT_RELIABILITY_FLOOR = 5_000;

/**
 * The most one relay's weight may exceed another's on the Graph's say-so.
 * Four is enough to steer load away from a busy relay and far too little to
 * corner a three-hop path.
 */
export const MAX_OCCUPANCY = 4;

/** Above this, an observation is treated as absent rather than as truth. */
export const DEFAULT_MAX_AGE_SECONDS = 300n;

export interface GraphHealthOptions {
  /** Reads the §8.2 observations. Never a source of relay identity or keys. */
  readonly fetchSnapshot: () => Promise<RelaySnapshot>;
  readonly now?: () => UnixSeconds;
  readonly maxAgeSeconds?: bigint;
  readonly reliabilityFloor?: number;
}

export interface GraphHealth {
  /** Pass to createMeshBootstrap as `health`. Synchronous, served from cache. */
  readonly health: (entry: RelayDirectory['entries'][number]) => RelayHealth;
  /** Pulls a fresh snapshot. A failure leaves the previous one in place. */
  refresh(): Promise<boolean>;
  /** What the adapter currently believes, for tests and diagnostics. */
  observedAt(): UnixSeconds | undefined;
}

const clamp = (value: number, low: number, high: number): number =>
  !Number.isFinite(value) ? low : Math.min(high, Math.max(low, value));

export function createGraphHealth(options: GraphHealthOptions): GraphHealth {
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const floor = options.reliabilityFloor ?? DEFAULT_RELIABILITY_FLOOR;

  // The uniform prior, and what every relay falls back to. Identical to
  // bootstrap's own default, so an absent Graph and a silent one behave the
  // same way — neither is a reason to treat any relay as special.
  const prior: RelayHealth = {
    reliabilityScore: floor as PrivacyScore,
    batchOccupancy: 1,
    recentSelectionCount: 0,
  };

  let observations = new Map<string, RelayHealth>();
  let at: UnixSeconds | undefined;

  return {
    observedAt: () => at,

    async refresh(): Promise<boolean> {
      let snapshot: RelaySnapshot;
      try {
        snapshot = await options.fetchSnapshot();
      } catch {
        // A Graph that is down must not empty the pool. The previous
        // observations stand until they age out into the prior.
        return false;
      }
      const next = new Map<string, RelayHealth>();
      for (const node of snapshot.nodes) {
        // ONLY the three health numbers are read. id is a lookup key, and
        // endpoint, kemPublicKey, keyEpoch and operatorId are ignored outright
        // — taking any of them here is how the Graph would become a source of
        // relay identity, which is the thing the pinned directory exists to be.
        next.set(node.id as string, {
          reliabilityScore: clamp(node.reliabilityScore, floor, 10_000) as PrivacyScore,
          batchOccupancy: clamp(node.batchOccupancy, 1, MAX_OCCUPANCY),
          recentSelectionCount: clamp(Math.trunc(node.recentSelectionCount), 0, MAX_OCCUPANCY),
        });
      }
      observations = next;
      at = snapshot.observedAt;
      return true;
    },

    health(entry): RelayHealth {
      // Stale is treated as absent. A Graph frozen at one moment would
      // otherwise pin selection to that moment forever, which is a standing
      // circuit arrived at slowly.
      if (at === undefined || now() - at > maxAge) return prior;
      // A relay the Graph does not mention keeps the prior rather than losing
      // its weight. Omission must not be a way to remove a relay.
      return observations.get(entry.id as string) ?? prior;
    },
  };
}

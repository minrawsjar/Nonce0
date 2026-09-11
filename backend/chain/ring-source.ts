// The exit's ring: MEMBERSHIP from the pool's own Deposited events, and the
// §8.1 weights — use counts, funding buckets — from the subgraph.
//
// Membership never comes from the Graph. A ring has to be real deposits (a
// decoy the pool has never seen makes spend() revert with UnknownCommitment),
// and an index that could add members could hand a wallet seven decoys it
// owns, or leave honest ones out. So the Graph only annotates members the
// chain already named; one it names that the chain does not is dropped.
//
// Without a (fresh) Graph the annotations are unknown, never zero:
// timesUsedInRing 0, fundingCluster and hasOtherActivity null.
//
// Arc serves getLogs windows of 20,000 blocks and refuses 50,000, so the scan
// pages in 10,000-block windows and only ever re-reads what is new.

import type { PublicClient } from 'viem';
import { parseAbiItem } from 'viem';

import {
  ProtocolFailure,
  type GraphSelectionClient,
  type NoteCommitment,
  type PoolScope,
  type RelaySnapshot,
  type RingCandidate,
  type RingSnapshot,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { evaluatePublicReadiness } from '../../graph/src/privacy-score.ts';

const DEPOSITED = parseAbiItem('event Deposited(bytes32 indexed commitment, uint256 index)');
const WINDOW = 10_000n;

export interface ChainRingSourceOptions {
  readonly publicClient: PublicClient;
  readonly scope: PoolScope;
  readonly deployedAtBlock: bigint;
  /** Relay health for privacy conditions. Keys never come from here. */
  readonly relaySnapshot: () => RelaySnapshot | Promise<RelaySnapshot>;
  /** The subgraph's view of the same pool. Weights only; see the header. */
  readonly indexed?: (scope: PoolScope) => Promise<RingSnapshot>;
  readonly now?: () => UnixSeconds;
}

export function createChainRingSource(options: ChainRingSourceOptions): GraphSelectionClient {
  const { publicClient, scope } = options;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const candidates: RingCandidate[] = [];
  let scannedThrough = options.deployedAtBlock - 1n;
  let scannedAt: UnixSeconds | undefined;
  let scanning: Promise<bigint> | undefined;

  const sameScope = (s: PoolScope): boolean =>
    s.pool.toLowerCase() === scope.pool.toLowerCase() && BigInt(s.chainId) === BigInt(scope.chainId)
    && s.denomination === scope.denomination;

  async function refresh(): Promise<bigint> {
    const head = await publicClient.getBlockNumber();
    for (let from = scannedThrough + 1n; from <= head; from += WINDOW) {
      const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n;
      const logs = await publicClient.getLogs({ address: scope.pool, event: DEPOSITED, fromBlock: from, toBlock: to });
      for (const log of logs) {
        candidates.push({
          commitment: log.args.commitment!.toLowerCase() as NoteCommitment,
          enrolledAtBlock: log.blockNumber!,
          timesUsedInRing: 0,
          fundingCluster: null,
          hasOtherActivity: null,
        });
      }
      scannedThrough = to;
    }
    return head;
  }

  // One scan at a time: two at once read the same blocks and added their
  // deposits twice. And a scan the RPC refuses (Arc rate-limits a burst of
  // reads) leaves the last good one standing, dated when it ran: membership
  // only grows, so it is still a true ring, missing at most the newest
  // deposits. A wallet waited out its whole poll for a refused one.
  const scan = (): Promise<bigint> => (scanning ??= refresh().then(
    (head) => { scannedAt = now(); return head; },
    (error: unknown) => { if (scannedAt === undefined) throw error; return scannedThrough; },
  ).finally(() => { scanning = undefined; }));

  async function getRingSnapshot(requested: PoolScope): Promise<RingSnapshot> {
    // One pool per source. Answering for another would hand a wallet decoys
    // from the wrong pool — deposits this pool has never seen.
    if (!sameScope(requested)) {
      throw new ProtocolFailure('INVALID_INPUT', 'this ring source serves a different pool');
    }
    const [head, indexed] = await Promise.all([
      scan(),
      // Down or stale is not fatal: the ring is still the chain's.
      options.indexed?.(requested).catch(() => undefined),
    ]);
    const weights = new Map(indexed?.candidates.map((c) => [c.commitment.toLowerCase(), c]));
    return {
      scope,
      candidates: candidates.map((c) => {
        const w = weights.get(c.commitment);
        return w === undefined ? c : { ...c, timesUsedInRing: w.timesUsedInRing, fundingCluster: w.fundingCluster, hasOtherActivity: w.hasOtherActivity };
      }),
      indexedThroughBlock: head,
      observedAt: scannedAt!,
      policyVersion: indexed === undefined ? 'chain-deposited-v1' : 'chain-deposited+graph-v1',
    };
  }

  return {
    getRingSnapshot,
    getRelaySnapshot: async () => options.relaySnapshot(),
    async getPrivacyConditions(requested) {
      return evaluatePublicReadiness(await getRingSnapshot(requested), await options.relaySnapshot());
    },
  };
}

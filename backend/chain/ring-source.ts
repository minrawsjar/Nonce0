// A ring source read straight from the pool's Deposited events.
//
// The subgraph is not deployed, and a ring has to be REAL deposits: a decoy
// the pool has never seen makes spend() revert with UnknownCommitment. The
// pool's own events are exactly what the subgraph would index, so this reads
// the same facts from the same source, just without the index in between.
//
// What it cannot know, and says so rather than guessing:
//   - timesUsedInRing is 0 for every member. A Spent event names a nullifier
//     and never a ring member — deliberately, since an event that tied the two
//     together would undo the ring from the indexing side. Reuse is not
//     observable on chain; that is the privacy property, not a gap.
//   - fundingCluster and hasOtherActivity are null: unknown, never zero.
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
  readonly now?: () => UnixSeconds;
}

export function createChainRingSource(options: ChainRingSourceOptions): GraphSelectionClient {
  const { publicClient, scope } = options;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const candidates: RingCandidate[] = [];
  let scannedThrough = options.deployedAtBlock - 1n;

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

  async function getRingSnapshot(requested: PoolScope): Promise<RingSnapshot> {
    // One pool per source. Answering for another would hand a wallet decoys
    // from the wrong pool — deposits this pool has never seen.
    if (!sameScope(requested)) {
      throw new ProtocolFailure('INVALID_INPUT', 'this ring source serves a different pool');
    }
    const head = await refresh();
    return {
      scope,
      candidates: [...candidates],
      indexedThroughBlock: head,
      observedAt: now(),
      policyVersion: 'chain-deposited-v1',
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

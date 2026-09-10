// §8.2 on chain: the relays this box runs, announced to RelayDirectory and
// reported every few minutes, so the subgraph has health to index.
//
// Health and liveness only. The keys a wallet encrypts to come from the signed
// directory; the kemKeyCommitment announced here is what lets a reader of the
// Graph check that it agrees with that directory (graph/src/client.ts).

import { createWalletClient, http, keccak256, parseAbi, stringToHex, type Account, type PublicClient } from 'viem';

import type { Address } from '@opaque/protocol-types';

import type { DirectoryEntry } from '../mesh/contracts.ts';
import type { Relay } from '../mesh/server.ts';
import { ARC_TESTNET } from './pool.ts';

const ABI = parseAbi([
  'function nodes(bytes32) view returns (address operator, string endpoint, bytes32 kemKeyCommitment, uint64 epoch, uint16 reliabilityBps, uint16 batchOccupancy, uint32 recentSelections, uint64 updatedAt)',
  'function announce(bytes32 nodeId, string endpoint, bytes32 kemKeyCommitment, uint64 epoch)',
  'function report((bytes32 nodeId, uint16 reliabilityBps, uint16 batchOccupancy, uint32 recentSelections)[] reports)',
]);

/** "R1" → 0x5231 00…: the directory's relay id, UTF-8, right-padded to 32 bytes. */
export const nodeId = (id: string): `0x${string}` => stringToHex(id, { size: 32 });

type Counters = Pick<Relay, 'relayId' | 'accepted' | 'released' | 'batches' | 'undelivered'>;

/** Each call returns every relay's health over the window since the previous call. */
export function healthWindow(relays: readonly Counters[]) {
  const read = (r: Counters) => ({ accepted: r.accepted, released: r.released, batches: r.batches, undelivered: r.undelivered });
  let last = relays.map(read);
  return () => {
    const now = relays.map(read);
    const reports = relays.map((r, i) => {
      const a = now[i]!;
      const b = last[i]!;
      const released = a.released - b.released;
      const failed = a.undelivered - b.undelivered;
      const batches = a.batches - b.batches;
      return {
        nodeId: nodeId(r.relayId),
        // The share of what it had to hand on that it did. Nothing to hand on
        // is nothing failed.
        reliabilityBps: released === 0 ? 10_000 : Math.max(0, Math.round((10_000 * (released - failed)) / released)),
        // Messages per batch that moved anything: how much company a message had.
        batchOccupancy: batches === 0 ? 0 : Math.min(65_535, Math.round(released / batches)),
        recentSelections: Math.min(2 ** 32 - 1, a.accepted - b.accepted),
      };
    });
    last = now;
    return reports;
  };
}

export function relayDirectoryReporter(options: {
  readonly publicClient: PublicClient;
  /** The relays' operator. One account for all six says, truthfully, one operator. */
  readonly operator: Account;
  readonly directory: Address;
  readonly entries: readonly DirectoryEntry[];
  readonly relays: readonly Counters[];
}) {
  const { publicClient, directory } = options;
  const wallet = createWalletClient({ account: options.operator, chain: ARC_TESTNET, transport: http() });
  const send = async (functionName: 'announce' | 'report', args: readonly unknown[]): Promise<void> => {
    const hash = await wallet.writeContract({ address: directory, abi: ABI, functionName, args } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`relay ${functionName} reverted in ${hash}`);
  };
  const window = healthWindow(options.relays);

  return {
    /**
     * Once per boot. The epoch is the key's, and RelayDirectory only moves it
     * forward, so a restart within a generation (same keys, same epoch) finds
     * its relays already announced and sends nothing.
     */
    async announce(): Promise<number> {
      let sent = 0;
      for (const e of options.entries) {
        const id = nodeId(e.id);
        const commitment = keccak256(e.kemPublicKey);
        const [, endpoint, onChain, epoch] = await publicClient.readContract({ address: directory, abi: ABI, functionName: 'nodes', args: [id] });
        if (epoch === e.keyEpoch && endpoint === e.endpoint && onChain.toLowerCase() === commitment.toLowerCase()) continue;
        // Same epoch, different endpoint or key: RelayDirectory refuses it too.
        if (epoch >= e.keyEpoch) throw new Error(`${e.id} is already announced under epoch ${epoch}, not before this directory's ${e.keyEpoch}`);
        await send('announce', [id, e.endpoint, commitment, e.keyEpoch]);
        sent++;
      }
      return sent;
    },
    /** One transaction for all of this box's relays. */
    report: (): Promise<void> => send('report', [window()]),
  };
}

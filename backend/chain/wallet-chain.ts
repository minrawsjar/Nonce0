// The chain touches a browser wallet makes, built on the one viem this repo
// bundles. The frontend imports this rather than viem, so there is a single
// copy of it in the page.
//
// ── What the note vault's reads reveal, and to whom ──────────────────────
//
// The page uses createMeshChainObserver, and neither read goes to an RPC
// from the browser:
//
//   observeCommitment(mine)  Answered from the pool-wide RING_SNAPSHOT, the
//                            question every wallet already asks. Nobody
//                            learns which commitment is yours.
//   isNullifierSpent(mine)   WALLET_RPC over the mesh. The exit learns a
//                            nullifier was asked about, never by whom; asked
//                            directly, the RPC would learn which SPEND is
//                            yours, the one link the ring exists to hide.
//
// createChainObserver reads the RPC directly. It is for Node scripts, which
// have no mesh and nobody to hide from.

import type { EIP1193Provider, PublicClient, WalletClient } from 'viem';
import { createWalletClient, custom, parseAbi, parseAbiItem } from 'viem';

import type {
  NoteCommitment,
  Nullifier,
  PoolScope,
  PrivatePoolContract,
  ProtocolCapabilities,
  RingSnapshot,
  TxHash,
} from '@opaque/protocol-types';

import { ARC_TESTNET, createPoolClient } from './pool.ts';
import { readOne, type WalletRpcSend } from './wallet-rpc.ts';

/** The funding wallet as the PQ account's payer: it pays, and signs nothing for the account. */
export const browserPayer = (provider: EIP1193Provider | undefined) => async (): Promise<WalletClient> => {
  if (provider === undefined) throw new Error('no wallet: install MetaMask (or any EIP-1193 wallet) to pay for this');
  return createWalletClient({ chain: ARC_TESTNET, transport: custom(provider) });
};

const POOL = parseAbi([
  'function isCommitmentKnown(bytes32) view returns (bool)',
  'function isNullifierSpent(bytes32) view returns (bool)',
]);
const DEPOSITED = parseAbiItem('event Deposited(bytes32 indexed commitment, uint256 index)');
/** Arc refuses getLogs windows past 20,000 blocks. */
const WINDOW = 19_999n;

export interface WalletChainObserver {
  observeCommitment(scope: PoolScope, commitment: NoteCommitment): Promise<{ readonly blockNumber: bigint } | null>;
  isNullifierSpent(scope: PoolScope, nullifier: Nullifier): Promise<boolean>;
}

/** The note vault's evidence. A note is AVAILABLE only on this, never on a tx hash. */
export function createChainObserver(publicClient: PublicClient, deployedAtBlock: bigint): WalletChainObserver {
  return {
    async observeCommitment(scope, commitment) {
      const known = await publicClient.readContract({ address: scope.pool, abi: POOL, functionName: 'isCommitmentKnown', args: [commitment as `0x${string}`] });
      if (!known) return null;
      // Newest window first: a note being reconciled was usually just deposited.
      const head = await publicClient.getBlockNumber();
      for (let to = head; to >= deployedAtBlock; to -= WINDOW + 1n) {
        const from = to - WINDOW < deployedAtBlock ? deployedAtBlock : to - WINDOW;
        const [log] = await publicClient.getLogs({ address: scope.pool, event: DEPOSITED, args: { commitment: commitment as `0x${string}` }, fromBlock: from, toBlock: to });
        if (log?.blockNumber != null) return { blockNumber: log.blockNumber };
      }
      return null;
    },
    isNullifierSpent: (scope, nullifier) =>
      publicClient.readContract({ address: scope.pool, abi: POOL, functionName: 'isNullifierSpent', args: [nullifier as `0x${string}`] }),
  };
}

/** The note vault's evidence, with no read that names a note going to an RPC. See the header. */
export function createMeshChainObserver(options: {
  readonly walletRpc: WalletRpcSend;
  readonly ringSnapshot: (scope: PoolScope) => Promise<RingSnapshot>;
}): WalletChainObserver {
  // One snapshot answers every note reconciled together (a multi-note deposit
  // checks all of them at once). Kept 2 s after it arrives, so a retry 3 s
  // later asks again and can see a deposit this one did not.
  let last: { key: string; settledAt?: number; snapshot: Promise<RingSnapshot> } | undefined;
  const snapshotFor = (scope: PoolScope): Promise<RingSnapshot> => {
    const key = `${scope.chainId}:${scope.pool.toLowerCase()}`;
    if (last === undefined || last.key !== key || (last.settledAt !== undefined && Date.now() - last.settledAt > 2_000)) {
      const entry: NonNullable<typeof last> = { key, snapshot: options.ringSnapshot(scope) };
      entry.snapshot.then(() => { entry.settledAt = Date.now(); }, () => { entry.settledAt = 0; });
      last = entry;
    }
    return last.snapshot;
  };
  return {
    async observeCommitment(scope, commitment) {
      const member = (await snapshotFor(scope)).candidates.find((c) => c.commitment.toLowerCase() === commitment.toLowerCase());
      return member === undefined ? null : { blockNumber: member.enrolledAtBlock };
    },
    isNullifierSpent: async (scope, nullifier) =>
      (await readOne(options.walletRpc, scope.pool, 'isNullifierSpent', [nullifier])).value as boolean,
  };
}

/** Several notes at once: every commitment in one deposit, all one denomination. */
export type DepositMany = (input: { readonly scope: PoolScope; readonly commitments: readonly NoteCommitment[] }) => Promise<readonly TxHash[]>;

/**
 * The pool port for a browser: the user's own wallet pays for a deposit.
 * Deposit APPROVES FIRST — the frozen PrivatePoolContract has no approve, and
 * a deposit without allowance reverts in transferFrom. Exactly what the
 * deposits need, never MaxUint256.
 */
export function createBrowserPool(
  provider: EIP1193Provider | undefined,
  offChain: Pick<ProtocolCapabilities, 'pqWallet' | 'graph' | 'confidentialExecution' | 'policyScope'>,
): PrivatePoolContract & { readonly publicClient: PublicClient; readonly depositMany: DepositMany } {
  const client = createPoolClient({ ...(provider === undefined ? {} : { provider }), offChain });
  // One approval for all of them, then one transaction per note: an EOA
  // cannot batch, and the pool takes one commitment per deposit.
  const depositMany: DepositMany = async ({ scope, commitments }) => {
    if (provider === undefined) {
      throw new Error('no wallet: install MetaMask (or any EIP-1193 wallet) on Arc testnet to deposit');
    }
    await client.approveDeposit(scope.pool, BigInt(commitments.length));
    const hashes: TxHash[] = [];
    for (const commitment of commitments) hashes.push(await client.deposit({ scope, commitment }));
    return hashes;
  };
  return {
    publicClient: client.publicClient as PublicClient,
    capabilities: (pool) => client.capabilities(pool),
    depositMany,
    deposit: async ({ scope, commitment }) => (await depositMany({ scope, commitments: [commitment] }))[0]!,
    spend: (spend) => client.spend(spend),
    isNullifierSpent: (scope, value) => client.isNullifierSpent(scope, value),
  };
}

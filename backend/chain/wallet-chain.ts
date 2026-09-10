// The two chain touches a browser wallet makes, built on the one viem this
// repo bundles. The frontend imports this rather than viem, so there is a
// single copy of it in the page.
//
// ── What these reveal, stated so nobody has to work it out ──────────────
//
//   observeCommitment(mine)  Tells the RPC which commitment you care about.
//                            Harmless: you deposited it from your own wallet,
//                            and a deposit is attributable by design (§4).
//   isNullifierSpent(mine)   Tells the RPC which SPEND is yours — the one
//                            link the ring exists to hide. A direct read here
//                            is a known leak in this build, kept visible
//                            rather than buried: it should cross the mesh.

import type { EIP1193Provider, PublicClient } from 'viem';
import { parseAbi, parseAbiItem } from 'viem';

import type {
  NoteCommitment,
  Nullifier,
  PoolScope,
  PrivatePoolContract,
  ProtocolCapabilities,
} from '@opaque/protocol-types';

import { createPoolClient } from './pool.ts';

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

/**
 * The pool port for a browser: the user's own wallet pays for a deposit.
 * Deposit APPROVES FIRST — the frozen PrivatePoolContract has no approve, and
 * a deposit without allowance reverts in transferFrom. Exactly one
 * denomination per deposit, never MaxUint256.
 */
export function createBrowserPool(
  provider: EIP1193Provider | undefined,
  offChain: Pick<ProtocolCapabilities, 'pqWallet' | 'graph' | 'confidentialExecution' | 'policyScope'>,
): PrivatePoolContract & { readonly publicClient: PublicClient } {
  const client = createPoolClient({ ...(provider === undefined ? {} : { provider }), offChain });
  return {
    publicClient: client.publicClient as PublicClient,
    capabilities: (pool) => client.capabilities(pool),
    async deposit(input) {
      if (provider === undefined) {
        throw new Error('no wallet: install MetaMask (or any EIP-1193 wallet) on Arc testnet to deposit');
      }
      await client.approveDeposit(input.scope.pool);
      return client.deposit(input);
    },
    spend: (spend) => client.spend(spend),
    isNullifierSpent: (scope, value) => client.isNullifierSpent(scope, value),
  };
}

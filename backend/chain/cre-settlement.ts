import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';

import type { Address, TxHash } from '@opaque/protocol-types';
import type { CreAuthorization } from '../cre/authorize-payment.ts';
import { ARC_TESTNET } from './pool.ts';

export const CRE_POLICY_GATE_ABI = parseAbi([
  'function publish((bytes32 id, bytes32 spendHash, bytes32 nullifier, address pool, address recipient, address feeCollector, uint256 grossAmount, uint256 feeAmount, uint16 feeBps, uint64 expiresAt) authorization)',
]);
export const CRE_BATCH_SETTLEMENT_ABI = parseAbi([
  'function settleAll(address[] pools, bytes32[] authorizationIds)',
]);

/** Kept pure so the EVM boundary has one independently testable mapping. */
export const authorizationArgs = (authorization: CreAuthorization) => [authorization] as const;
export const batchSettlementArgs = (authorizations: readonly CreAuthorization[]) => [
  authorizations.map((authorization) => authorization.pool),
  authorizations.map((authorization) => authorization.id),
] as const;

export interface CreSettlementClient {
  publish(authorization: CreAuthorization): Promise<void>;
  settle(authorizations: readonly CreAuthorization[]): Promise<TxHash>;
  readonly publicClient: PublicClient;
}

export function createCreSettlementClient(input: {
  readonly account: Account;
  readonly gate: Address;
  readonly batchSettlement: Address;
  readonly rpcUrl?: string;
  readonly chain?: Chain;
}): CreSettlementClient {
  const chain = input.chain ?? ARC_TESTNET;
  const transport = http(input.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ chain, account: input.account, transport }) as WalletClient;

  async function write(address: Address, abi: typeof CRE_POLICY_GATE_ABI | typeof CRE_BATCH_SETTLEMENT_ABI, functionName: string, args: readonly unknown[]): Promise<TxHash> {
    const { request } = await publicClient.simulateContract({
      address: getAddress(address), abi, functionName, args, account: input.account,
    } as never);
    const hash = await walletClient.writeContract(request as never) as TxHash;
    await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    return hash;
  }

  return {
    publicClient,
    async publish(authorization) {
      await write(input.gate, CRE_POLICY_GATE_ABI, 'publish', authorizationArgs(authorization));
    },
    settle(authorizations) {
      if (authorizations.length === 0) throw new Error('cannot settle an empty authorization batch');
      return write(input.batchSettlement, CRE_BATCH_SETTLEMENT_ABI, 'settleAll', batchSettlementArgs(authorizations));
    },
  };
}

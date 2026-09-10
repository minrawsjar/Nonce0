// The attester's key manager (cre/attester-keys.ts), wired to the deployed
// PQKeyRegistry. Rotation and takeover are authenticated by FORS signatures
// alone, so any account may submit them; the egress pays, as it pays for
// settlements.

import { createWalletClient, http, parseAbi, type Account, type PublicClient } from 'viem';

import type { Address } from '@opaque/protocol-types';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';

import { createAttesterKeys, type AttesterKeys } from '../cre/attester-keys.ts';
import { ARC_TESTNET } from './pool.ts';

const REGISTRY_ABI = parseAbi([
  'function stateOf(address) view returns ((bytes32,bytes32,uint64,uint64,uint64,uint64))',
  'function rotate(address,bytes32,uint64,uint64,bytes)',
  'function takeover(address,bytes32,uint64,bytes)',
]);

export function registryAttesterKeys(options: {
  readonly publicClient: PublicClient;
  /** Pays for rotation and takeover. Holds no authority over the key. */
  readonly payer: Account;
  readonly registry: Address;
  readonly attester: Address;
  readonly master: Uint8Array;
  readonly chainId: bigint;
}): AttesterKeys {
  const { publicClient, registry, attester } = options;
  const wallet = createWalletClient({ account: options.payer, chain: ARC_TESTNET, transport: http() });

  async function send(functionName: 'rotate' | 'takeover', args: readonly unknown[]): Promise<void> {
    const hash = await wallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName, args } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`attester ${functionName} reverted in ${hash}`);
  }

  return createAttesterKeys({
    master: options.master,
    attester,
    chainId: options.chainId,
    async readState() {
      const s = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'stateOf', args: [attester] });
      return { pkCommitment: asBytes32(s[0].toLowerCase()), useCount: s[2], maxUses: s[3] };
    },
    rotate: (next, maxUses, deadline, signature) => send('rotate', [attester, next, maxUses, deadline, signature]),
    takeover: (next, maxUses, signature) => send('takeover', [attester, next, maxUses, signature]),
  });
}

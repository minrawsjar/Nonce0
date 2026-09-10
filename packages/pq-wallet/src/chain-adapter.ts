import type { Address, Bytes32, Hex, TxHash } from '@opaque/protocol-types';
import type { ChainObservation, PreparedUserOperation } from './authority.ts';
import type { SignedOutput } from './signer-state.ts';

/** Infrastructure port. The LIVE implementation is blocked on approved ABI/epoch/payload configuration. */
export interface WalletChainAdapter {
  readonly mode: 'MOCK' | 'LIVE';
  deriveAccount(active: Bytes32, next: Bytes32): Promise<Address>;
  observe(account: Address): Promise<ChainObservation>;
  register(account: Address, active: Bytes32, next: Bytes32, maxUses: bigint, deadline: bigint): Promise<TxHash>;
  prepareUserOperation(encoded: Hex, observation: ChainObservation, schemeId: string): Promise<PreparedUserOperation>;
  /** Recompute/decode the reviewed full payload, including userOpHash/epoch/expiry. */
  verifyUserOperationBinding(prepared: PreparedUserOperation): Promise<boolean>;
  rotate(account: Address, next: Bytes32, maxUses: bigint, deadline: bigint, signed: SignedOutput): Promise<TxHash>;
  disable(account: Address, signed: SignedOutput): Promise<TxHash>;
}

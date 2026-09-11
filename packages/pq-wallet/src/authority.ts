import { ProtocolFailure, type Address, type Bytes32, type ChainId, type Hex } from '@opaque/protocol-types';
import { asAddress, asBytes32, asChainId, assertHex, toHex } from '@opaque/protocol-types/codecs.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { canonical, pqDigest, utf8 } from './digest.ts';
import type { PQKeyState } from './registry.ts';

export interface AuthorityConfig {
  readonly chainId: ChainId;
  readonly entryPoint: Address;
  readonly entryPointVersion: string;
  readonly accountImplementation: Address;
  readonly factory: Address;
  readonly registry: Address;
  readonly validator: Address;
  readonly bundlerUrl: string;
  readonly paymaster: { readonly mode: 'none' } | { readonly mode: 'configured'; readonly address: Address };
}
export interface ChainObservation {
  readonly accountAddress: Address;
  readonly chainId: ChainId;
  readonly blockNumber: bigint;
  readonly now: bigint;
  readonly keyEpoch: bigint;
  readonly state: PQKeyState | undefined;
}
/** What a first operation's initCode deploys: the account for exactly these keys, registered to them. */
export interface AccountDeployment {
  readonly pkCommitment: Bytes32;
  readonly nextCommitment: Bytes32;
  readonly maxUses: bigint;
  readonly rotationDeadline: bigint;
}
export interface PreparedUserOperation {
  readonly encodedUserOperation: Hex;
  readonly accountAddress: Address;
  readonly chainId: ChainId;
  readonly entryPoint: Address;
  readonly keyEpoch: bigint;
  readonly useCount: bigint;
  readonly schemeId: string;
  readonly userOpHash: Bytes32;
  readonly validUntil: bigint;
  /** Complete reviewed structured payload, already including the registry action domain. */
  readonly payload: Hex;
  /** Produced by the canonical on-chain digest helper/approved adapter. */
  readonly digest: Bytes32;
  /**
   * Present exactly when the account is not yet registered: the operation is
   * its first, and its initCode deploys it. The adapter binds this to the
   * encoded initCode; the wallet binds it to its own keys.
   */
  readonly deployment?: AccountDeployment;
}
export function validateAuthorityConfig(config: AuthorityConfig): void {
  if (!config || typeof config !== 'object' || !config.paymaster) {
    throw new ProtocolFailure('INVALID_INPUT', 'Complete authority configuration required');
  }
  asChainId(config.chainId);
  for (const address of [config.entryPoint, config.accountImplementation, config.factory, config.registry, config.validator]) asAddress(address);
  if (!config.entryPointVersion || !config.bundlerUrl) throw new ProtocolFailure('INVALID_INPUT', 'Pinned EntryPoint and bundler configuration required');
  if (config.paymaster.mode === 'configured') asAddress(config.paymaster.address);
  else if (config.paymaster.mode !== 'none') throw new ProtocolFailure('INVALID_INPUT', 'Explicit paymaster mode required');
}

/** Local persistence binding only, not a new on-chain digest or shared protocol field. */
export function authorityConfigId(config: AuthorityConfig): Bytes32 {
  validateAuthorityConfig(config);
  return asBytes32(toHex(keccak_256(canonical([
    'opaque/local/wallet-configuration', config.chainId.toString(), config.entryPoint, config.entryPointVersion,
    config.accountImplementation, config.factory, config.registry, config.validator,
    config.paymaster.mode, config.paymaster.mode === 'configured' ? config.paymaster.address : '',
  ].map(utf8)))));
}

/** Checks the adapter result against the caller and chain facts; it does not invent a wire format. */
export function validatePreparedOperation(config: AuthorityConfig, observation: ChainObservation,
  encoded: Hex, schemeId: string, prepared: PreparedUserOperation): void {
  if (!prepared || typeof prepared !== 'object') throw new ProtocolFailure('PROOF_REJECTED', 'Malformed prepared operation');
  assertHex(encoded, 'encodedUserOperation'); asBytes32(prepared.userOpHash); asBytes32(prepared.digest);
  // An unregistered account's first operation registers its key as it runs,
  // at use count 0, and must say what it deploys; any later one must not.
  const useCount = observation.state?.useCount ?? 0n;
  if ((observation.state === undefined) !== (prepared.deployment !== undefined) || prepared.encodedUserOperation !== encoded ||
      prepared.accountAddress !== observation.accountAddress || prepared.chainId !== config.chainId ||
      observation.chainId !== config.chainId || prepared.entryPoint !== config.entryPoint ||
      prepared.keyEpoch !== observation.keyEpoch || prepared.useCount !== useCount ||
      prepared.schemeId !== schemeId || typeof prepared.validUntil !== 'bigint' || prepared.validUntil <= observation.now) {
    throw new ProtocolFailure('PROOF_REJECTED', 'Operation authority binding rejected');
  }
  const digest = pqDigest({ chainId: config.chainId, walletAddress: observation.accountAddress,
    schemeId, useCount, payload: prepared.payload });
  if (prepared.digest !== digest) throw new ProtocolFailure('PROOF_REJECTED', 'Canonical digest mismatch');
}

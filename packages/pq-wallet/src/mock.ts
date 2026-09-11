import { keccak_256 } from '@noble/hashes/sha3.js';
import { ProtocolFailure, type Address, type Bytes32, type Hex, type PqWallet, type TxHash } from '@opaque/protocol-types';
import { asAddress, asBytes32, asChainId, fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { canonical, pqDigest, utf8 } from './digest.ts';
import { PQKeyRegistry, userActionPayload, type RegistryPolicy } from './registry.ts';
import { MemorySignerStore, type SignedOutput } from './signer-state.ts';
import { MemoryWalletStateStore } from './wallet-state.ts';
import { createPqWallet, type WalletOptions } from './wallet.ts';
import type { AccountDeployment, AuthorityConfig, ChainObservation, PreparedUserOperation } from './authority.ts';
import type { WalletChainAdapter } from './chain-adapter.ts';

const address = (n: number): Address => asAddress(`0x${n.toString(16).padStart(40, '0')}`);
/** Synthetic addresses and an intentionally unreachable endpoint. Never deploy with this configuration. */
export const MOCK_AUTHORITY: AuthorityConfig = Object.freeze({ chainId: asChainId(31337n), entryPoint: address(1),
  entryPointVersion: 'MOCK-not-erc4337', accountImplementation: address(2), factory: address(3), registry: address(4),
  validator: address(5), bundlerUrl: 'https://mock.invalid', paymaster: Object.freeze({ mode: 'none' as const }) });
export const MOCK_POLICY: RegistryPolicy = Object.freeze({ deadline: 'reject-actions', allowLateRotation: true,
  pendingDisableOnRotation: 'preserve', repeatedDisable: 'preserve' });

/** Mock-only epoch/payload conventions. These are not an approved LIVE wire format. */
function mockPayload(prepared: Pick<PreparedUserOperation, 'entryPoint' | 'userOpHash' | 'keyEpoch' | 'validUntil'>): Hex {
  return toHex(canonical([utf8('opaque/mock/user-operation'), fromHex(prepared.entryPoint), fromHex(prepared.userOpHash),
    utf8(prepared.keyEpoch.toString()), utf8(prepared.validUntil.toString())]));
}

const sameDeployment = (a: AccountDeployment, b: AccountDeployment | undefined): boolean => b !== undefined &&
  a.pkCommitment === b.pkCommitment && a.nextCommitment === b.nextCommitment && a.maxUses === b.maxUses && a.rotationDeadline === b.rotationDeadline;

export class MockWalletChain implements WalletChainAdapter {
  readonly mode = 'MOCK' as const;
  readonly config = MOCK_AUTHORITY;
  now = 100n;
  deferTransactions = false;
  failNextSubmission = false;
  /** Mock-only: what an unregistered account's first operation deploys. LIVE decodes it from initCode. */
  firstOperation: AccountDeployment | undefined;
  #block = 1n;
  #tx = 0n;
  #epochs = new Map<Address, bigint>();
  #operations = new Map<Bytes32, { account: Address; payload: Hex; deployment?: AccountDeployment }>();
  #pending: Array<() => void> = [];
  #registry = new PQKeyRegistry({ chainId: MOCK_AUTHORITY.chainId, now: () => this.now, policy: MOCK_POLICY });

  async deriveAccount(active: Bytes32, next: Bytes32): Promise<Address> {
    return asAddress(`0x${toHex(keccak_256(canonical([fromHex(active), fromHex(next)]))).slice(-40)}`);
  }
  async observe(account: Address): Promise<ChainObservation> {
    return { accountAddress: account, chainId: this.config.chainId, keyEpoch: this.#epochs.get(account) ?? 0n,
      now: this.now, blockNumber: this.#block, state: this.#registry.stateOf(account) };
  }
  async register(account: Address, active: Bytes32, next: Bytes32, maxUses: bigint, deadline: bigint): Promise<TxHash> {
    return this.#submit(() => {
      this.#registry.register(account, { pkCommitment: active, nextCommitment: next, maxUses, rotationDeadline: deadline });
      this.#epochs.set(account, 0n);
    });
  }
  async prepareUserOperation(encoded: Hex, observation: ChainObservation, schemeId: string): Promise<PreparedUserOperation> {
    const deployment = observation.state ? undefined : this.firstOperation;
    if (!observation.state && !deployment) throw new ProtocolFailure('INVALID_INPUT', 'Mock account is not registered');
    const userOpHash = asBytes32(toHex(keccak_256(fromHex(encoded))));
    const fields = { encodedUserOperation: encoded, accountAddress: observation.accountAddress,
      chainId: this.config.chainId, entryPoint: this.config.entryPoint, keyEpoch: observation.keyEpoch,
      useCount: observation.state?.useCount ?? 0n, schemeId, userOpHash, validUntil: this.now + 300n };
    const rawPayload = mockPayload(fields);
    const payload = userActionPayload(rawPayload);
    const digest = pqDigest({ chainId: fields.chainId, walletAddress: fields.accountAddress, schemeId, useCount: fields.useCount, payload });
    this.#operations.set(digest, { account: observation.accountAddress, payload: rawPayload, ...(deployment ? { deployment } : {}) });
    return { ...fields, payload, digest, ...(deployment ? { deployment } : {}) };
  }
  async verifyUserOperationBinding(prepared: PreparedUserOperation): Promise<boolean> {
    return prepared.userOpHash === toHex(keccak_256(fromHex(prepared.encodedUserOperation))) &&
      prepared.payload === userActionPayload(mockPayload(prepared)) &&
      (prepared.deployment === undefined || sameDeployment(prepared.deployment, this.firstOperation));
  }
  async rotate(account: Address, next: Bytes32, maxUses: bigint, deadline: bigint, signed: SignedOutput): Promise<TxHash> {
    return this.#submit(() => {
      this.#registry.rotate(account, next, maxUses, deadline, signed.signature);
      this.#epochs.set(account, this.#epochs.get(account)! + 1n);
    });
  }
  async disable(account: Address, signed: SignedOutput): Promise<TxHash> {
    return this.#submit(() => this.#registry.initiateDisable(account, signed.signature));
  }
  async acceptUserOperation(signed: SignedOutput): Promise<TxHash> {
    const operation = this.#operations.get(signed.digest);
    if (!operation) throw new ProtocolFailure('INVALID_INPUT', 'Unknown mock operation');
    const d = operation.deployment;
    return this.#submit(() => {
      // As on chain: initCode deploys and registers first, then validation consumes.
      if (d && !this.#registry.stateOf(operation.account)) {
        this.#registry.register(operation.account, { pkCommitment: d.pkCommitment, nextCommitment: d.nextCommitment, maxUses: d.maxUses, rotationDeadline: d.rotationDeadline });
        this.#epochs.set(operation.account, 0n);
      }
      this.#registry.consume(operation.account, operation.payload, signed.signature);
    });
  }
  mine(): void {
    const pending = this.#pending.shift(); if (pending) { pending(); this.#block++; }
  }
  #submit(apply: () => void): TxHash {
    if (this.failNextSubmission) { this.failNextSubmission = false; throw new Error('mock submission failed'); }
    if (this.deferTransactions) this.#pending.push(apply);
    else { apply(); this.#block++; }
    return `0x${(++this.#tx).toString(16).padStart(64, '0')}` as TxHash;
  }
}

export function mockWalletOptions(chain = new MockWalletChain()): WalletOptions {
  return { walletId: 'MOCK-wallet', signerStore: new MemorySignerStore(), walletStore: new MemoryWalletStateStore(),
    chain, authority: MOCK_AUTHORITY, params: { k: 32, a: 8 }, maxUses: 8n, lifecycleReserve: 2n,
    initialKeyEpoch: 0n, initialRotationDeadline: 1000n, registryPolicy: MOCK_POLICY,
    nextKeyEpoch: epoch => epoch + 1n, nextRotationDeadline: now => now + 1000n };
}

/** Conforming six-method mock with real PQ signatures and an explicitly simulated chain. */
export function createMockPqWallet(): PqWallet { return createPqWallet(mockWalletOptions()); }

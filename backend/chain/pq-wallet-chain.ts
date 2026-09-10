// The PQ wallet on the real chain: the LIVE WalletChainAdapter over the
// deployed PQKeyRegistry and PQAccountFactory, and the account's own deposits
// as v0.7 UserOperations through a public bundler.
//
// Authority is the FORS key and nothing else. The funding wallet (MetaMask)
// only PAYS, for three transactions that need no authority: deploying the
// account — CREATE2 commits to its keys, so whoever deploys it gets the same
// account — and submitting a rotation or disable the FORS key already signed.
// It never signs for the account.
//
// keyEpoch: PQKeyRegistry has no epoch. The SDK checks that the chain's key is
// at the epoch its store holds that key under; here that epoch is looked up in
// the store, so the check reduces to "the registered key is one this wallet
// holds", which the SDK also checks directly.
//
// Direct, not over the mesh (§7.5): registry reads for this account and the
// bundler submission. Both name the account, which deposits in the open by
// design (§4); neither names a note or a spend.

import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { createBundlerClient, entryPoint07Abi, toPackedUserOperation, toSmartAccount } from 'viem/account-abstraction';

import { ProtocolFailure, type Address, type Bytes32, type Hex, type PqWallet, type PrivatePoolContract, type TxHash } from '@opaque/protocol-types';
import { asAddress, asBytes32, asChainId } from '@opaque/protocol-types/codecs.js';
import { createPqWallet, encodeSignature, FORS_C_DEFAULT, keyGen, pqDigest, sign } from '@opaque/pq-wallet';

import { deployment, entryPoint, requireContract } from '../../deployments/index.ts';
// Not in pq-wallet's pinned public API; imported from source, as
// cre/attester-keys.ts does.
import type { AuthorityConfig, ChainObservation, PreparedUserOperation } from '../../packages/pq-wallet/src/authority.ts';
import type { WalletChainAdapter } from '../../packages/pq-wallet/src/chain-adapter.ts';
import { userActionPayload, type RegistryPolicy } from '../../packages/pq-wallet/src/registry.ts';
import type { SignerStore } from '../../packages/pq-wallet/src/signer-state.ts';
import type { WalletStateStore } from '../../packages/pq-wallet/src/wallet-state.ts';

import { accountSalt, predictAccount, userOperationPayload } from './pq-account.ts';
import { ERC20_ABI } from './pool.ts';

/** The deployed account stack, as the SDK pins it. Changing any field is a different wallet. */
export const ARC_AUTHORITY: AuthorityConfig = Object.freeze({
  chainId: asChainId(BigInt(deployment.network.chainId)),
  entryPoint: asAddress(entryPoint()),
  entryPointVersion: '0.7',
  accountImplementation: asAddress(requireContract('pqAccountImplementation')),
  factory: asAddress(requireContract('pqAccountFactory')),
  registry: asAddress(requireContract('pqKeyRegistry')),
  validator: asAddress(requireContract('pqAccountValidator')),
  bundlerUrl: deployment.erc4337.bundlerUrl,
  paymaster: Object.freeze({ mode: 'none' as const }),
});

/** What PQKeyRegistry.sol does: the deadline is stored, not enforced; a rotation keeps a pending disable; a second disable restarts the clock. */
export const CONTRACT_POLICY: RegistryPolicy = Object.freeze({
  deadline: 'observe-only', allowLateRotation: true, pendingDisableOnRotation: 'preserve', repeatedDisable: 'restart',
});

const REGISTRY = parseAbi([
  'function stateOf(address) view returns ((bytes32 pkCommitment, bytes32 nextCommitment, uint64 useCount, uint64 maxUses, uint64 rotationDeadline, uint64 disableAfter))',
  'function rotate(address, bytes32, uint64, uint64, bytes)',
  'function initiateDisable(address, bytes)',
]);
const FACTORY = parseAbi(['function createAccount(bytes32, bytes32, uint64, uint64) returns (address)']);
const ACCOUNT = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)']);
const POOL = parseAbi(['function deposit(bytes32)', 'function denomination() view returns (uint256)', 'function token() view returns (address)']);

/** A PackedUserOperation without its signature: what the wallet is asked to sign. */
const PACKED = parseAbiParameters('(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData)');

/** EntryPoint v0.7's getUserOpHash, over the operation exactly as encoded for signing. */
export function userOpHashOf(encoded: Hex, entryPoint: Address, chainId: bigint): Bytes32 {
  const [op] = decodeAbiParameters(PACKED, encoded);
  const inner = keccak256(encodeAbiParameters(
    parseAbiParameters('address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32'),
    [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)],
  ));
  return keccak256(encodeAbiParameters(parseAbiParameters('bytes32, address, uint256'), [inner, entryPoint, chainId])) as Bytes32;
}

export interface LiveWalletChainOptions {
  readonly publicClient: PublicClient;
  readonly authority: AuthorityConfig;
  /** Pays for deploy, rotate and disable. Never signs for the account. */
  readonly payer: () => Promise<WalletClient>;
  readonly maxUses: bigint;
  /** The initial deadline. Part of the account's salt, so fixed at create(). */
  readonly rotationDeadline: bigint;
  readonly initialKeyEpoch: bigint;
  /** The epoch the local store holds a key under; undefined if it holds no such key. */
  readonly epochOf: (pkCommitment: Bytes32) => Promise<bigint | undefined>;
}

export function createLiveWalletChain(options: LiveWalletChainOptions): WalletChainAdapter {
  const { publicClient, authority } = options;
  const chainId = BigInt(authority.chainId);
  // Arc's public RPC is load-balanced, and a lagging node answers with an
  // older block. The SDK treats a block that goes backwards as an unsafe
  // state, so an older answer is asked again rather than handed on.
  let highest = 0n;

  async function pay(address: Address, abi: typeof FACTORY | typeof REGISTRY, functionName: string, args: readonly unknown[]): Promise<TxHash> {
    const wallet = await options.payer();
    const account = wallet.account ?? (await wallet.getAddresses())[0];
    if (account === undefined) throw new ProtocolFailure('INVALID_INPUT', 'connect a funding wallet to pay for this transaction');
    // Simulated first, so a revert surfaces decoded instead of as a spent transaction.
    const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account } as never);
    const hash = await wallet.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new ProtocolFailure('SETTLEMENT_REVERTED', `${functionName} reverted in ${hash}`);
    return hash as TxHash;
  }

  return {
    mode: 'LIVE',

    async deriveAccount(active, next) {
      return predictAccount(authority.factory, authority.accountImplementation, accountSalt(active, next, options.maxUses, options.rotationDeadline));
    },

    async observe(account): Promise<ChainObservation> {
      for (let attempt = 0; ; attempt++) {
        try {
          const block = await publicClient.getBlock();
          if (block.number < highest) throw new Error('a lagging node answered');
          const s = await publicClient.readContract({ address: authority.registry, abi: REGISTRY, functionName: 'stateOf', args: [account], blockNumber: block.number });
          highest = block.number;
          const state = BigInt(s.pkCommitment) === 0n ? undefined : {
            pkCommitment: asBytes32(s.pkCommitment.toLowerCase()), nextCommitment: asBytes32(s.nextCommitment.toLowerCase()),
            useCount: s.useCount, maxUses: s.maxUses, rotationDeadline: s.rotationDeadline, disableAfter: s.disableAfter,
          };
          // -1 is refused by the SDK: a registered key this wallet does not hold.
          const keyEpoch = state === undefined ? options.initialKeyEpoch : (await options.epochOf(state.pkCommitment)) ?? -1n;
          return { accountAddress: account, chainId: authority.chainId, blockNumber: block.number, now: block.timestamp, keyEpoch, state };
        } catch (error) {
          if (attempt >= 4) throw new ProtocolFailure('STALE_OBSERVATION', `could not read the account from the chain: ${(error as Error).message}`, true);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    },

    async register(account, active, next, maxUses, deadline) {
      // The address commits to all four. Refuse to deploy anything else.
      if (predictAccount(authority.factory, authority.accountImplementation, accountSalt(active, next, maxUses, deadline)) !== account) {
        throw new ProtocolFailure('INVALID_INPUT', 'the account address does not commit to these keys');
      }
      return pay(authority.factory, FACTORY, 'createAccount', [active, next, maxUses, deadline]);
    },

    async prepareUserOperation(encoded, observation, schemeId): Promise<PreparedUserOperation> {
      if (observation.state === undefined) throw new ProtocolFailure('INVALID_INPUT', 'the account is not registered');
      const userOpHash = userOpHashOf(encoded, authority.entryPoint, chainId);
      const payload = userActionPayload(userOperationPayload(userOpHash));
      const useCount = observation.state.useCount;
      return {
        encodedUserOperation: encoded, accountAddress: observation.accountAddress, chainId: authority.chainId,
        entryPoint: authority.entryPoint, keyEpoch: observation.keyEpoch, useCount, schemeId, userOpHash,
        // PQValidator returns no validUntil: an operation is bounded by its
        // nonce and the key's useCount, not a clock. This is the SDK's local
        // signing window and nothing on chain.
        validUntil: observation.now + 300n,
        payload,
        digest: pqDigest({ chainId: authority.chainId, walletAddress: observation.accountAddress, schemeId, useCount, payload }),
      };
    },

    async verifyUserOperationBinding(prepared) {
      const [op] = decodeAbiParameters(PACKED, prepared.encodedUserOperation);
      return op.sender.toLowerCase() === prepared.accountAddress
        && prepared.userOpHash === userOpHashOf(prepared.encodedUserOperation, authority.entryPoint, chainId)
        && prepared.payload === userActionPayload(userOperationPayload(prepared.userOpHash));
    },

    rotate: (account, next, maxUses, deadline, signed) =>
      pay(authority.registry, REGISTRY, 'rotate', [account, next, maxUses, deadline, signed.signature]),
    disable: (account, signed) => pay(authority.registry, REGISTRY, 'initiateDisable', [account, signed.signature]),
  };
}

const YEAR = 365n * 86_400n;
/** Per key. FORS+C is few-time; two of these are held back for rotate and disable. */
export const ACCOUNT_MAX_USES = 32n;

/** A PQ wallet whose account lives on Arc. In a browser both stores are one IndexedDbSignerStore. */
export function createLivePqWallet(options: {
  readonly signerStore: SignerStore;
  readonly walletStore: WalletStateStore;
  readonly publicClient: PublicClient;
  readonly payer: () => Promise<WalletClient>;
  readonly walletId?: string;
}): PqWallet {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const chain = createLiveWalletChain({
    publicClient: options.publicClient, authority: ARC_AUTHORITY, payer: options.payer,
    maxUses: ACCOUNT_MAX_USES, rotationDeadline: now + YEAR, initialKeyEpoch: 0n,
    epochOf: async (pk) => (await options.signerStore.read(pk))?.keyEpoch,
  });
  return createPqWallet({
    walletId: options.walletId ?? 'opaque-account', signerStore: options.signerStore, walletStore: options.walletStore, chain,
    authority: ARC_AUTHORITY, params: FORS_C_DEFAULT, maxUses: ACCOUNT_MAX_USES, lifecycleReserve: 2n,
    initialKeyEpoch: 0n, initialRotationDeadline: now + YEAR, registryPolicy: CONTRACT_POLICY,
    nextKeyEpoch: (epoch) => epoch + 1n, nextRotationDeadline: (t) => t + YEAR,
  });
}

/**
 * The account's deposits, as UserOperations the PQ key signs. Everything but
 * deposit is the base pool's: spends are authorised by the ring proof and
 * submitted by the release egress, never by this account.
 */
export function createAccountPool(options: {
  readonly base: PrivatePoolContract;
  readonly publicClient: PublicClient;
  readonly wallet: PqWallet;
  readonly account: Address;
  readonly authority: AuthorityConfig;
}): PrivatePoolContract {
  const { publicClient, wallet, authority } = options;
  const bundler = createBundlerClient({
    client: publicClient,
    transport: http(authority.bundlerUrl),
    userOperation: {
      // A bundler refuses an operation priced under its own quote.
      async estimateFeesPerGas({ bundlerClient }) {
        const quote = await bundlerClient.request({ method: 'pimlico_getUserOperationGasPrice' as never }) as { standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
        return { maxFeePerGas: BigInt(quote.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(quote.standard.maxPriorityFeePerGas) };
      },
    },
  });

  // A well-formed signature under a throwaway key. Validation runs the whole
  // FORS check on it and fails only at the last comparison — returning
  // SIG_VALIDATION_FAILED, not reverting — so the estimate is the real cost.
  let stub: Hex | undefined;
  const stubSignature = (): Hex => {
    if (stub === undefined) {
      const key = keyGen();
      stub = encodeSignature(key.publicKey, sign(key.secretKey, `0x${'00'.repeat(32)}` as Bytes32));
    }
    return stub;
  };

  const smartAccount = toSmartAccount({
    client: publicClient,
    entryPoint: { abi: entryPoint07Abi, address: authority.entryPoint, version: '0.7' },
    getAddress: async () => options.account,
    encodeCalls: async (calls) => encodeFunctionData({
      abi: ACCOUNT, functionName: 'executeBatch',
      args: [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data ?? '0x' }))],
    }),
    // Deployed by register(), from the funding wallet: never by an operation.
    getFactoryArgs: async () => ({ factory: undefined, factoryData: undefined }),
    getStubSignature: async () => stubSignature(),
    signMessage: async () => { throw new ProtocolFailure('INVALID_INPUT', 'the PQ account signs UserOperations only'); },
    signTypedData: async () => { throw new ProtocolFailure('INVALID_INPUT', 'the PQ account signs UserOperations only'); },
    async signUserOperation(op) {
      const packed = toPackedUserOperation({ ...op, sender: options.account, signature: '0x' });
      const encoded = encodeAbiParameters(PACKED, [packed]) as Hex;
      return (await wallet.signUserOperation(encoded)).signature;
    },
  });

  return {
    ...options.base,
    async deposit({ scope, commitment }) {
      const [token, denomination] = await Promise.all([
        publicClient.readContract({ address: scope.pool, abi: POOL, functionName: 'token' }),
        publicClient.readContract({ address: scope.pool, abi: POOL, functionName: 'denomination' }),
      ]);
      const held = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [options.account] });
      if (held < denomination) {
        throw new ProtocolFailure('INVALID_INPUT', `the account holds ${Number(held) / 1e6} USDC; send it at least ${Number(denomination) / 1e6} plus a little for gas`);
      }
      const calls = [
        // Exactly one denomination, as the funding-wallet path approves.
        { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [scope.pool, denomination] }) },
        { to: scope.pool, data: encodeFunctionData({ abi: POOL, functionName: 'deposit', args: [commitment] }) },
      ];
      const account = await smartAccount;
      const gas = await bundler.estimateUserOperationGas({ account, calls });
      const hash = await bundler.sendUserOperation({
        account, calls, ...gas,
        // The stub stops before the real signature's useCount write and event.
        verificationGasLimit: gas.verificationGasLimit + 60_000n,
      });
      const { success, receipt } = await bundler.waitForUserOperationReceipt({ hash, timeout: 180_000 });
      if (!success) throw new ProtocolFailure('SETTLEMENT_REVERTED', `the deposit operation reverted in ${receipt.transactionHash}`);
      return receipt.transactionHash as TxHash;
    },
  };
}

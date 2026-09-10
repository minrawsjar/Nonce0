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
// Over the mesh (§7.5), through WALLET_RPC (chain/wallet-rpc.ts): every read
// that names the account, and every UserOperation. The RPC and the bundler
// see the exit, not this wallet. What still goes direct is what the funding
// wallet pays for (deploy, rotate, disable): its own transactions, which name
// it on chain whatever route they take.

import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { formatUserOperationRequest, toPackedUserOperation } from 'viem/account-abstraction';

import { ProtocolFailure, type Address, type Bytes32, type Hex, type NoteCommitment, type PoolScope, type PqWallet, type TxHash } from '@opaque/protocol-types';
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
import { bundlerCall, readOne, readState, STATE_ABI, type WalletRpcSend } from './wallet-rpc.ts';

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
  /** The account's reads: WALLET_RPC over the mesh in a browser. */
  readonly walletRpc: WalletRpcSend;
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
          const read = await readOne(options.walletRpc, authority.registry, 'stateOf', [account]);
          const block = { number: read.blockNumber, timestamp: read.timestamp };
          if (block.number < highest) throw new Error('a lagging node answered');
          const s = read.value as { pkCommitment: Hex; nextCommitment: Hex; useCount: bigint; maxUses: bigint; rotationDeadline: bigint; disableAfter: bigint };
          highest = block.number;
          const state = BigInt(s.pkCommitment) === 0n ? undefined : {
            pkCommitment: asBytes32(s.pkCommitment.toLowerCase()), nextCommitment: asBytes32(s.nextCommitment.toLowerCase()),
            useCount: s.useCount, maxUses: s.maxUses, rotationDeadline: s.rotationDeadline, disableAfter: s.disableAfter,
          };
          // -1 is refused by the SDK: a registered key this wallet does not hold.
          const keyEpoch = state === undefined ? options.initialKeyEpoch : (await options.epochOf(state.pkCommitment)) ?? -1n;
          return { accountAddress: account, chainId: authority.chainId, blockNumber: block.number, now: block.timestamp, keyEpoch, state };
        } catch (error) {
          if (attempt >= 2) throw new ProtocolFailure('STALE_OBSERVATION', `could not read the account from the chain: ${(error as Error).message}`, true);
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
  readonly walletRpc: WalletRpcSend;
  readonly walletId?: string;
}): PqWallet {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const chain = createLiveWalletChain({
    publicClient: options.publicClient, authority: ARC_AUTHORITY, payer: options.payer, walletRpc: options.walletRpc,
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

type Call = { readonly to: Address; readonly value?: bigint; readonly data?: Hex };
type Op = {
  sender: Address; nonce: bigint; callData: Hex; callGasLimit: bigint; verificationGasLimit: bigint;
  preVerificationGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; signature: Hex;
};
const WEI_PER_USDC6 = 10n ** 12n;

/**
 * What the account does by itself: deposit into a pool and withdraw, each a
 * UserOperation its PQ key signs. Built here rather than by viem's smart
 * account, which reads the account's code and nonce straight from the RPC;
 * every read and bundler call below goes through `walletRpc`.
 *
 * Spends are not here: they are authorised by the ring proof and submitted by
 * the release egress, never by this account.
 */
export function createPqAccountOps(options: {
  readonly wallet: PqWallet;
  readonly account: Address;
  readonly authority: AuthorityConfig;
  readonly walletRpc: WalletRpcSend;
}) {
  const { wallet, account, authority, walletRpc: send } = options;
  const bundle = (method: string, params: readonly unknown[]) => bundlerCall(send, method, params);

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

  const encodeCalls = (calls: readonly Call[]): Hex => encodeFunctionData({
    abi: ACCOUNT, functionName: 'executeBatch',
    args: [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data ?? '0x' }))],
  }) as Hex;

  /** EntryPoint v0.7's _getRequiredPrefund, with no paymaster. */
  const prefundOf = (op: Op): bigint => (op.verificationGasLimit + op.callGasLimit + op.preVerificationGas) * op.maxFeePerGas;

  /** What the account can spend: its USDC, and gas it has prepaid to the EntryPoint (18 decimals). */
  async function funds(): Promise<{ readonly usdc6: bigint; readonly prepaidGas: bigint }> {
    const { results } = await readState(send, [
      { to: deployment.tokens.usdc.address as Address, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'balanceOf', args: [account] }) as Hex },
      { to: authority.entryPoint, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'balanceOf', args: [account] }) as Hex },
    ]);
    return { usdc6: BigInt(results[0]!), prepaidGas: BigInt(results[1]!) };
  }

  async function prepare(calls: readonly Call[]): Promise<Op> {
    const [nonce, quote] = await Promise.all([
      readOne(send, authority.entryPoint, 'getNonce', [account, 0n]),
      // A bundler refuses an operation priced under its own quote.
      bundle('pimlico_getUserOperationGasPrice', []) as Promise<{ standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>,
    ]);
    const base: Op = {
      sender: account, nonce: nonce.value as bigint, callData: encodeCalls(calls),
      maxFeePerGas: BigInt(quote.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(quote.standard.maxPriorityFeePerGas),
      callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, signature: stubSignature(),
    };
    const gas = await bundle('eth_estimateUserOperationGas', [formatUserOperationRequest(base as never), authority.entryPoint]) as Record<string, Hex>;
    return {
      ...base,
      callGasLimit: BigInt(gas['callGasLimit']!),
      // The stub stops before the real signature's useCount write and event.
      verificationGasLimit: BigInt(gas['verificationGasLimit']!) + 60_000n,
      preVerificationGas: BigInt(gas['preVerificationGas']!),
    };
  }

  async function submit(op: Op): Promise<TxHash> {
    const packed = toPackedUserOperation({ ...op, signature: '0x' } as never);
    const signed = await wallet.signUserOperation(encodeAbiParameters(PACKED, [packed as never]) as Hex);
    const hash = await bundle('eth_sendUserOperation', [formatUserOperationRequest({ ...op, signature: signed.signature } as never), authority.entryPoint]);
    for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
      const found = await bundle('eth_getUserOperationReceipt', [hash]) as { success: boolean; receipt: { transactionHash: TxHash } } | null;
      if (found !== null) {
        if (!found.success) throw new ProtocolFailure('SETTLEMENT_REVERTED', `the account's operation reverted in ${found.receipt.transactionHash}`);
        return found.receipt.transactionHash;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new ProtocolFailure('MESH_UNAVAILABLE', `operation ${String(hash)} was sent but no receipt arrived; it may still land`, true);
  }

  const shortfall = (need18: bigint, have: { usdc6: bigint; prepaidGas: bigint }) =>
    new ProtocolFailure('INVALID_INPUT',
      `the account holds ${(Number(have.usdc6) / 1e6).toFixed(2)} USDC and needs about ${(Number(need18) / 1e18).toFixed(2)}; send it USDC first`);

  return {
    funds,

    /** A pool deposit: exactly one denomination approved, then deposited. */
    async deposit({ scope, commitment }: { scope: PoolScope; commitment: NoteCommitment }): Promise<TxHash> {
      const denomination = BigInt(scope.denomination);
      const have = await funds();
      if (have.usdc6 < denomination) throw shortfall(denomination * WEI_PER_USDC6, have);
      const op = await prepare([
        { to: deployment.tokens.usdc.address as Address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [scope.pool, denomination] }) as Hex },
        { to: scope.pool, data: encodeFunctionData({ abi: POOL, functionName: 'deposit', args: [commitment] }) as Hex },
      ]);
      // Gas the EntryPoint already holds for the account is spent first.
      const need = denomination * WEI_PER_USDC6 + (prefundOf(op) > have.prepaidGas ? prefundOf(op) - have.prepaidGas : 0n);
      if (have.usdc6 * WEI_PER_USDC6 < need) throw shortfall(need, have);
      return submit(op);
    },

    /**
     * Everything the account holds, to `to`, less this operation's gas. What
     * the EntryPoint refunds afterwards lands in the account's deposit there,
     * a few cents that pay for its next operation.
     */
    async withdraw(to: Address): Promise<TxHash> {
      const op = await prepare([{ to, value: 1n }]);
      const have = await funds();
      const fromBalance = prefundOf(op) > have.prepaidGas ? prefundOf(op) - have.prepaidGas : 0n;
      const value = have.usdc6 * WEI_PER_USDC6 - fromBalance;
      if (value <= 0n) throw new ProtocolFailure('INVALID_INPUT', 'the account holds too little to pay for its own withdrawal');
      return submit({ ...op, callData: encodeCalls([{ to, value }]) });
    },
  };
}

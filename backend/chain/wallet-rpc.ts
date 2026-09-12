// WALLET_RPC (§7.5): a wallet's own chain reads, and its account's
// UserOperations, answered at the mesh exit. The RPC and the bundler then see
// the exit and never the wallet.
//
// Not a general proxy. Each operation takes one JSON request and does one
// narrow thing:
//
//   STATE                   view calls, each to an allowlisted contract AND
//                           selector, all at one block
//   ESTIMATE                eth_estimateUserOperationGas, pimlico_getUserOperationGasPrice
//   SUBMIT_USER_OPERATION   eth_sendUserOperation
//   USER_OPERATION_RECEIPT  eth_getUserOperationReceipt
//   ROTATE                  PQKeyRegistry.rotate, signed by the account's
//                           current key and PAID FOR BY THIS EXIT
//
// Bundler calls must name the pinned v0.7 EntryPoint and come from a PQ
// account clone, or deploy one: an initCode is accepted only as the pinned
// factory's createAccount, which can create nothing but a PQ account. So the
// exit is not a free bundler for anything else.
//
// An answer carries its own error ({ error }) instead of failing the query.
// A query that fails at the exit leaves nothing at the drop, and the wallet
// would wait out its deadline to learn nothing.
//
// ROTATE is the one operation the exit pays for. An account cannot pay for its
// own rotation: a UserOperation spends a signature during validation, so a
// rotation carried inside one would be signed against the wrong useCount and
// revert. PQKeyRegistry.rotate takes the account as an argument and checks no
// msg.sender, so anyone may submit it, and the exit's egress key is already
// the thing that pays for settlement and the attester's own rotations.

import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector, walletActions, type Account, type PublicClient } from 'viem';
import { formatUserOperationRequest, toPackedUserOperation } from 'viem/account-abstraction';

import { ProtocolFailure, type Address, type Bytes32, type Hex, type TxHash, type WalletRpcOperation } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, entryPoint, requireContract } from '../../deployments/index.ts';

/** The one thing the page hands the mesh: an operation and its JSON, as hex. */
export type WalletRpcSend = (operation: WalletRpcOperation, encodedRequest: Hex) => Promise<Hex>;

export const WALLET_RPC_OPERATIONS: readonly WalletRpcOperation[] = ['STATE', 'ESTIMATE', 'SUBMIT_USER_OPERATION', 'USER_OPERATION_RECEIPT', 'ROTATE'];

const BUNDLER_METHODS: Readonly<Record<string, readonly string[]>> = {
  ESTIMATE: ['eth_estimateUserOperationGas', 'pimlico_getUserOperationGasPrice'],
  SUBMIT_USER_OPERATION: ['eth_sendUserOperation'],
  USER_OPERATION_RECEIPT: ['eth_getUserOperationReceipt'],
};

export const STATE_ABI = parseAbi([
  'function stateOf(address) view returns ((bytes32 pkCommitment, bytes32 nextCommitment, uint64 useCount, uint64 maxUses, uint64 rotationDeadline, uint64 disableAfter))',
  'function isNullifierSpent(bytes32) view returns (bool)',
  'function isCommitmentKnown(bytes32) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function getNonce(address, uint192) view returns (uint256)',
  'function capabilities() view returns ((uint8 proofMode, uint8 ringSize, bytes32 verifierId, uint256 denomination, bool requiresCommitReveal))',
]);

/** Which view calls STATE will make: target -> selectors. Everything else is refused. */
export function walletRpcAllowlist(): ReadonlyMap<string, ReadonlySet<string>> {
  const sel = (signature: string) => toFunctionSelector(signature);
  const allow = new Map<string, Set<string>>();
  const add = (target: string, ...signatures: string[]) =>
    allow.set(target.toLowerCase(), new Set([...(allow.get(target.toLowerCase()) ?? []), ...signatures.map(sel)]));
  add(requireContract('pqKeyRegistry'), 'stateOf(address)');
  for (const pool of deployment.pools) add(pool.address, 'isNullifierSpent(bytes32)', 'isCommitmentKnown(bytes32)', 'capabilities()');
  add(deployment.tokens.usdc.address, 'balanceOf(address)');
  add(entryPoint(), 'balanceOf(address)', 'getNonce(address,uint192)');
  return allow;
}

/**
 * A UserOperation request, ABI-encoded rather than JSON. Its FORS signature is
 * 9 KB; as hex in JSON in hex on the mesh it came to 82 KB, past the largest
 * size class, and as ABI it is about half that.
 */
const USER_OPERATION_REQUEST = parseAbiParameters('string method, address entryPoint, (address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) op');

const REGISTRY_ROTATE = parseAbi(['function rotate(address, bytes32, uint64, uint64, bytes)']);
/** At most one relayed rotation per account per minute, so a loop cannot drain the egress. */
const ROTATE_COOLDOWN_MS = 60_000;

const MAX_CALLS = 8;
const CREATE_ACCOUNT = toFunctionSelector('createAccount(bytes32,bytes32,uint64,uint64)');
const MAX_REQUEST_BYTES = 60_000;
const utf8 = (s: string) => new TextEncoder().encode(s);
const json = (value: unknown): Hex => toHex(utf8(JSON.stringify(value))) as Hex;

/** The exit's side. Returns hex JSON: { result } or { error: { message } }. */
export function createWalletRpcAnswerer(options: {
  readonly publicClient: PublicClient;
  readonly bundlerUrl: string;
  readonly entryPoint: Address;
  readonly accountImplementation: Address;
  /** PQAccountFactory: the one initCode relayed is its createAccount. Unset, none is. */
  readonly factory?: Address;
  /** Pays for ROTATE. Unset, ROTATE is refused: nothing else here spends gas. */
  readonly payer?: Account;
  readonly allowlist?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly fetch?: typeof globalThis.fetch;
}): WalletRpcSend {
  const { publicClient } = options;
  const allowlist = options.allowlist ?? walletRpcAllowlist();
  const doFetch = options.fetch ?? globalThis.fetch;
  // EIP-1167 runtime code of a PQAccount clone: the only senders relayed.
  const cloneCode = `0x363d3d373d3d3d363d73${options.accountImplementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  const pqAccounts = new Set<string>();

  const signer = options.payer === undefined ? undefined : publicClient.extend(walletActions);
  const rotatedAt = new Map<string, number>();

  const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };
  /** Only a deployed PQAccount clone. Cached: a clone's code never changes. */
  async function assertPqAccount(address: string): Promise<void> {
    if (pqAccounts.has(address)) return;
    const code = await publicClient.getCode({ address: address as Address });
    if (code?.toLowerCase() !== cloneCode) refuse('only PQ accounts are relayed');
    pqAccounts.add(address);
  }
  /** A first operation's factory call: only the pinned factory, only createAccount. */
  const deploys = (factory: unknown, factoryData: unknown): boolean => {
    if (factory === undefined || factory === null) return false;
    if (options.factory === undefined || String(factory).toLowerCase() !== options.factory.toLowerCase()
      || String(factoryData).slice(0, 10).toLowerCase() !== CREATE_ACCOUNT) refuse('the only initCode relayed is the PQ account factory\'s createAccount');
    return true;
  };

  async function state(request: { calls?: unknown }): Promise<unknown> {
    const calls = request.calls;
    if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_CALLS) refuse(`STATE takes 1 to ${MAX_CALLS} calls`);
    for (const c of calls as { to?: unknown; data?: unknown }[]) {
      if (typeof c.to !== 'string' || typeof c.data !== 'string' || !/^0x[0-9a-fA-F]{8,136}$/.test(c.data)) refuse('a STATE call is { to, data }');
      const selectors = allowlist.get((c.to as string).toLowerCase());
      if (selectors === undefined || !selectors.has((c.data as string).slice(0, 10).toLowerCase())) refuse(`STATE does not read ${String(c.to)} ${String(c.data).slice(0, 10)}`);
    }
    // One block for every call, so a registry state and a balance agree.
    // Arc's public RPC is load-balanced: a node behind that block is asked again.
    for (let attempt = 0; ; attempt++) {
      try {
        const block = await publicClient.getBlock();
        const results = await Promise.all((calls as { to: Address; data: Hex }[]).map(async (c) =>
          (await publicClient.call({ to: c.to, data: c.data, blockNumber: block.number })).data ?? '0x'));
        return { blockNumber: block.number.toString(), timestamp: block.timestamp.toString(), results };
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async function bundler(operation: string, request: { method?: unknown; params?: unknown }): Promise<unknown> {
    const { method, params } = request;
    if (typeof method !== 'string' || !BUNDLER_METHODS[operation]?.includes(method)) refuse(`${operation} does not relay ${String(method)}`);
    if (!Array.isArray(params)) refuse('params must be an array');
    const p = params as unknown[];
    if (method === 'eth_estimateUserOperationGas' || method === 'eth_sendUserOperation') {
      if (String(p[1]).toLowerCase() !== options.entryPoint.toLowerCase()) refuse('only the pinned v0.7 EntryPoint is relayed');
      const op = (p[0] ?? {}) as { sender?: unknown; factory?: unknown; factoryData?: unknown };
      const sender = String(op.sender ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(sender)) refuse('a UserOperation needs a sender');
      // A deploying operation's sender has no code yet; the EntryPoint refuses
      // it unless the factory created exactly that address.
      if (!deploys(op.factory, op.factoryData)) await assertPqAccount(sender);
    } else if (method === 'eth_getUserOperationReceipt') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(p[0]))) refuse('a receipt needs a UserOperation hash');
    }
    const response = await doFetch(options.bundlerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.json() as { result?: unknown; error?: { message?: string; code?: number } };
    if (body.error !== undefined) throw new ProtocolFailure('SETTLEMENT_REVERTED', `bundler: ${body.error.message ?? 'refused'}`);
    if (method === 'eth_getUserOperationReceipt' && body.result) {
      // What the wallet uses, and no more: a full receipt's logs would outgrow the answer.
      const r = body.result as { success: boolean; actualGasUsed: Hex; receipt: { transactionHash: Hex; blockNumber: Hex } };
      return { success: r.success, actualGasUsed: r.actualGasUsed, receipt: { transactionHash: r.receipt.transactionHash, blockNumber: r.receipt.blockNumber } };
    }
    return body.result ?? null;
  }

  /**
   * A rotation the account's own key already signed, submitted with the exit's
   * gas. What makes that safe is on chain, not here: the registry verifies the
   * FORS signature against the key it holds for this account, at that key's
   * exact useCount, so this exit can neither forge a rotation nor replay one,
   * and a wrong one costs nothing because it is simulated first.
   *
   * What is left to guard is the gas bill, and both guards below are about
   * only that.
   */
  async function rotate(request: Record<string, unknown>): Promise<unknown> {
    // Thrown, not refused: `refuse` returns never but does not narrow here.
    if (signer === undefined) throw new ProtocolFailure('INVALID_INPUT', 'this exit does not relay rotations');
    const account = String(request['account'] ?? '').toLowerCase();
    const next = String(request['next'] ?? '').toLowerCase();
    const signature = String(request['signature'] ?? '');
    if (!/^0x[0-9a-f]{40}$/.test(account)) refuse('a rotation names its account');
    if (!/^0x[0-9a-f]{64}$/.test(next)) refuse('a rotation names the next key commitment');
    if (!/^0x[0-9a-f]+$/i.test(signature)) refuse('a rotation carries a signature');
    const maxUses = BigInt(String(request['maxUses']));
    const deadline = BigInt(String(request['deadline']));
    await assertPqAccount(account);
    if (Date.now() - (rotatedAt.get(account) ?? 0) < ROTATE_COOLDOWN_MS) refuse('a rotation for this account was relayed a moment ago');
    // rotate() resets useCount to 0, so a key that has signed nothing is either
    // brand new or just rotated. Refusing those means every relayed rotation
    // costs whoever asks one real operation of their own first, which is what
    // stops this being free gas in a loop.
    const registry = requireContract('pqKeyRegistry') as Address;
    const read = await publicClient.call({ to: registry, data: encodeFunctionData({ abi: STATE_ABI, functionName: 'stateOf', args: [account as Address] }) as Hex });
    const state = decodeFunctionResult({ abi: STATE_ABI, functionName: 'stateOf', data: read.data ?? '0x' }) as unknown as { pkCommitment: Hex; useCount: bigint };
    if (BigInt(state.pkCommitment) === 0n) refuse('that account has no registered key');
    if (state.useCount === 0n) refuse('that key has signed nothing, so it does not need rotating');
    // Simulated first: a signature for the wrong useCount reverts here, for free.
    const { request: tx } = await publicClient.simulateContract({
      address: registry, abi: REGISTRY_ROTATE, functionName: 'rotate',
      args: [account as Address, next as Bytes32, maxUses, deadline, signature as Hex], account: options.payer,
    } as never);
    const hash = await signer.writeContract(tx as never) as TxHash;
    rotatedAt.set(account, Date.now());
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new ProtocolFailure('SETTLEMENT_REVERTED', `rotate reverted in ${hash}`);
    return { txHash: hash };
  }

  /** An ABI UserOperation request, as the bundler's JSON-RPC params. */
  function unpack(encoded: Hex): { method: string; params: unknown[] } {
    const [method, entry, op] = decodeAbiParameters(USER_OPERATION_REQUEST, encoded);
    // Accounts pay their own gas: a paymaster is not something this route carries.
    // An initCode is split back into factory and factoryData, and checked with them.
    if (op.paymasterAndData !== '0x') refuse('no paymaster on this route');
    const high = (word: Hex) => BigInt(`0x${word.slice(2, 34)}`);
    const low = (word: Hex) => BigInt(`0x${word.slice(34)}`);
    const deploy = op.initCode === '0x' ? {} : { factory: op.initCode.slice(0, 42) as Address, factoryData: `0x${op.initCode.slice(42)}` as Hex };
    return {
      method,
      params: [formatUserOperationRequest({
        sender: op.sender, nonce: op.nonce, callData: op.callData, signature: op.signature, ...deploy,
        verificationGasLimit: high(op.accountGasLimits), callGasLimit: low(op.accountGasLimits),
        preVerificationGas: op.preVerificationGas,
        maxPriorityFeePerGas: high(op.gasFees), maxFeePerGas: low(op.gasFees),
      } as never), entry],
    };
  }

  return async (operation, encodedRequest) => {
    try {
      if (!WALLET_RPC_OPERATIONS.includes(operation)) refuse(`unknown operation ${operation}`);
      const bytes = fromHex(encodedRequest);
      if (bytes.length > MAX_REQUEST_BYTES) refuse('request too large');
      // JSON starts with '{'; anything else is an ABI UserOperation request.
      const request: Record<string, unknown> = bytes[0] === 0x7b ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : unpack(encodedRequest);
      const result = operation === 'STATE' ? await state(request)
        : operation === 'ROTATE' ? await rotate(request)
          : await bundler(operation, request);
      return json({ result });
    } catch (error) {
      // Public messages only: nothing here carries a secret.
      const e = error as { publicMessage?: string; message?: string; code?: string; retryable?: boolean };
      return json({ error: { code: e.code ?? 'MESH_UNAVAILABLE', message: e.publicMessage ?? e.message ?? 'failed', retryable: e.retryable ?? true } });
    }
  };
}

// ── the wallet's side ─────────────────────────────────────────────────────

async function call(send: WalletRpcSend, operation: WalletRpcOperation, request: unknown): Promise<unknown> {
  return answerOf(await send(operation, json(request)));
}

function answerOf(hex: Hex): unknown {
  const answer = JSON.parse(new TextDecoder().decode(fromHex(hex))) as {
    result?: unknown; error?: { code: string; message: string; retryable: boolean };
  };
  if (answer.error !== undefined) throw new ProtocolFailure(answer.error.code as never, answer.error.message, answer.error.retryable);
  return answer.result;
}

/** eth_estimateUserOperationGas or eth_sendUserOperation, with the operation ABI-encoded. */
export async function userOperationCall(
  send: WalletRpcSend,
  method: 'eth_estimateUserOperationGas' | 'eth_sendUserOperation',
  op: Parameters<typeof toPackedUserOperation>[0],
  entryPoint: Address,
): Promise<unknown> {
  const packed = toPackedUserOperation(op);
  const operation: WalletRpcOperation = method === 'eth_sendUserOperation' ? 'SUBMIT_USER_OPERATION' : 'ESTIMATE';
  return answerOf(await send(operation, encodeAbiParameters(USER_OPERATION_REQUEST, [method, entryPoint, packed as never]) as Hex));
}

/**
 * A signed rotation, submitted and paid for at the exit. The account cannot pay
 * for this itself: a UserOperation spends a signature while it validates, so a
 * rotation inside one would be signed for the wrong useCount.
 */
export async function relayRotation(
  send: WalletRpcSend, account: Address, next: Bytes32, maxUses: bigint, deadline: bigint, signature: Hex,
): Promise<TxHash> {
  const { txHash } = await call(send, 'ROTATE', {
    account, next, maxUses: maxUses.toString(10), deadline: deadline.toString(10), signature,
  }) as { txHash: TxHash };
  return txHash;
}

export interface StateRead { readonly blockNumber: bigint; readonly timestamp: bigint; readonly results: readonly Hex[] }

/** View calls at one block, through `send`. */
export async function readState(send: WalletRpcSend, calls: readonly { to: Address; data: Hex }[]): Promise<StateRead> {
  const r = await call(send, 'STATE', { calls }) as { blockNumber: string; timestamp: string; results: Hex[] };
  return { blockNumber: BigInt(r.blockNumber), timestamp: BigInt(r.timestamp), results: r.results };
}

/** One allowlisted view, decoded. */
export async function readOne<const F extends (typeof STATE_ABI)[number]['name']>(
  send: WalletRpcSend, to: Address, functionName: F, args: readonly unknown[],
) {
  const { results, blockNumber, timestamp } = await readState(send, [{ to, data: encodeFunctionData({ abi: STATE_ABI, functionName, args } as never) }]);
  return { value: decodeFunctionResult({ abi: STATE_ABI, functionName, data: results[0]! } as never) as never, blockNumber, timestamp };
}

/** One bundler JSON-RPC call, through `send`. */
export const bundlerCall = (send: WalletRpcSend, method: string, params: readonly unknown[]): Promise<unknown> => {
  const operation: WalletRpcOperation | undefined = ({
    eth_estimateUserOperationGas: 'ESTIMATE',
    pimlico_getUserOperationGasPrice: 'ESTIMATE',
    eth_sendUserOperation: 'SUBMIT_USER_OPERATION',
    eth_getUserOperationReceipt: 'USER_OPERATION_RECEIPT',
  } as const)[method];
  if (operation === undefined) throw new ProtocolFailure('INVALID_INPUT', `the account's bundler route does not carry ${method}`);
  return call(send, operation, { method, params });
};

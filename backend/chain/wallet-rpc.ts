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
//
// Bundler calls must name the pinned v0.7 EntryPoint and come from a PQ
// account clone, so the exit is not a free bundler for anything else.
//
// An answer carries its own error ({ error }) instead of failing the query.
// A query that fails at the exit leaves nothing at the drop, and the wallet
// would wait out its deadline to learn nothing.

import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector, type PublicClient } from 'viem';
import { formatUserOperationRequest, toPackedUserOperation } from 'viem/account-abstraction';

import { ProtocolFailure, type Address, type Hex, type WalletRpcOperation } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, entryPoint, requireContract } from '../../deployments/index.ts';

/** The one thing the page hands the mesh: an operation and its JSON, as hex. */
export type WalletRpcSend = (operation: WalletRpcOperation, encodedRequest: Hex) => Promise<Hex>;

export const WALLET_RPC_OPERATIONS: readonly WalletRpcOperation[] = ['STATE', 'ESTIMATE', 'SUBMIT_USER_OPERATION', 'USER_OPERATION_RECEIPT'];

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
]);

/** Which view calls STATE will make: target -> selectors. Everything else is refused. */
export function walletRpcAllowlist(): ReadonlyMap<string, ReadonlySet<string>> {
  const sel = (signature: string) => toFunctionSelector(signature);
  const allow = new Map<string, Set<string>>();
  const add = (target: string, ...signatures: string[]) =>
    allow.set(target.toLowerCase(), new Set([...(allow.get(target.toLowerCase()) ?? []), ...signatures.map(sel)]));
  add(requireContract('pqKeyRegistry'), 'stateOf(address)');
  for (const pool of deployment.pools) add(pool.address, 'isNullifierSpent(bytes32)', 'isCommitmentKnown(bytes32)');
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

const MAX_CALLS = 8;
const MAX_REQUEST_BYTES = 60_000;
const utf8 = (s: string) => new TextEncoder().encode(s);
const json = (value: unknown): Hex => toHex(utf8(JSON.stringify(value))) as Hex;

/** The exit's side. Returns hex JSON: { result } or { error: { message } }. */
export function createWalletRpcAnswerer(options: {
  readonly publicClient: PublicClient;
  readonly bundlerUrl: string;
  readonly entryPoint: Address;
  readonly accountImplementation: Address;
  readonly allowlist?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly fetch?: typeof globalThis.fetch;
}): WalletRpcSend {
  const { publicClient } = options;
  const allowlist = options.allowlist ?? walletRpcAllowlist();
  const doFetch = options.fetch ?? globalThis.fetch;
  // EIP-1167 runtime code of a PQAccount clone: the only senders relayed.
  const cloneCode = `0x363d3d373d3d3d363d73${options.accountImplementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  const pqAccounts = new Set<string>();

  const refuse = (message: string): never => { throw new ProtocolFailure('INVALID_INPUT', message); };

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
      const sender = String((p[0] as { sender?: unknown } | undefined)?.sender ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(sender)) refuse('a UserOperation needs a sender');
      if (!pqAccounts.has(sender)) {
        const code = await publicClient.getCode({ address: sender as Address });
        if (code?.toLowerCase() !== cloneCode) refuse('only PQ accounts are relayed');
        pqAccounts.add(sender);
      }
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

  /** An ABI UserOperation request, as the bundler's JSON-RPC params. */
  function unpack(encoded: Hex): { method: string; params: unknown[] } {
    const [method, entry, op] = decodeAbiParameters(USER_OPERATION_REQUEST, encoded);
    // Accounts are deployed by the funding wallet and pay their own gas: an
    // operation with initCode or a paymaster is not one this route carries.
    if (op.initCode !== '0x' || op.paymasterAndData !== '0x') refuse('no initCode or paymaster on this route');
    const high = (word: Hex) => BigInt(`0x${word.slice(2, 34)}`);
    const low = (word: Hex) => BigInt(`0x${word.slice(34)}`);
    return {
      method,
      params: [formatUserOperationRequest({
        sender: op.sender, nonce: op.nonce, callData: op.callData, signature: op.signature,
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
      const result = operation === 'STATE' ? await state(request) : await bundler(operation, request);
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

export interface StateRead { readonly blockNumber: bigint; readonly timestamp: bigint; readonly results: readonly Hex[] }

/** View calls at one block, through `send`. */
export async function readState(send: WalletRpcSend, calls: readonly { to: Address; data: Hex }[]): Promise<StateRead> {
  const r = await call(send, 'STATE', { calls }) as { blockNumber: string; timestamp: string; results: Hex[] };
  return { blockNumber: BigInt(r.blockNumber), timestamp: BigInt(r.timestamp), results: r.results };
}

/** One allowlisted view, decoded. */
export async function readOne<const F extends 'stateOf' | 'isNullifierSpent' | 'isCommitmentKnown' | 'balanceOf' | 'getNonce'>(
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

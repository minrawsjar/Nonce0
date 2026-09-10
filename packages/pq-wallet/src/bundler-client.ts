import { toHex, concat, type Hex } from 'viem';
import { asBytes32, asAddress } from '@opaque/protocol-types/codecs.js';
import { operationHash, type PackedOperation } from './user-operation.ts';

const rpcAddress = (value: unknown) => asAddress(typeof value === 'string' ? value.toLowerCase() : value);
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export class RpcError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    // Do not expose upstream URLs, credentials or full operation bytes in the UI.
    const safe = message.replace(/https?:\/\/\S+/gi, '[RPC endpoint]')
      .replace(/(api[-_]?key|authorization|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .replace(/0x[0-9a-f]{80,}/gi, '[operation data]')
      .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 600);
    super(`${method} failed (${code}): ${safe}`);
    this.name = 'RpcError'; this.code = code;
  }
}
export function httpRpc(url: string, fetcher: typeof fetch = fetch): Rpc {
  let id = 0;
  const endpoint = new URL(url, typeof location === 'undefined' ? undefined : location.href);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname))) throw new Error('RPC needs HTTPS or loopback');
  return async (method, params) => {
    const requestId = ++id;
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`${method}: RPC service unavailable (HTTP ${response.status})`);
    const raw = await response.text(); if (raw.length > 2_000_000) throw new Error('RPC response too large');
    const reply = JSON.parse(raw);
    if (!reply || reply.jsonrpc !== '2.0' || reply.id !== requestId) throw new Error(`${method}: Invalid RPC response`);
    if (reply.error) {
      if (!Number.isInteger(reply.error.code) || typeof reply.error.message !== 'string') throw new Error(`${method}: Invalid RPC error`);
      throw new RpcError(method, reply.error.code, reply.error.message);
    }
    if (!('result' in reply)) throw new Error(`${method}: Missing RPC result`);
    return reply.result;
  };
}
export function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid RPC quantity');
  const n = BigInt(value); if (n >= 1n << 256n) throw new Error('RPC quantity overflow'); return n;
}
export function rpcOperation(op: PackedOperation): Record<string, unknown> {
  const result: Record<string, unknown> = { sender: op.sender, nonce: toHex(op.nonce), callData: op.callData,
    verificationGasLimit: toHex(BigInt(`0x${op.accountGasLimits.slice(2, 34)}`)),
    callGasLimit: toHex(BigInt(`0x${op.accountGasLimits.slice(34)}`)), preVerificationGas: toHex(op.preVerificationGas),
    maxPriorityFeePerGas: toHex(BigInt(`0x${op.gasFees.slice(2, 34)}`)), maxFeePerGas: toHex(BigInt(`0x${op.gasFees.slice(34)}`)), signature: op.signature };
  if (op.initCode !== '0x') { result.factory = op.initCode.slice(0, 42); result.factoryData = `0x${op.initCode.slice(42)}`; }
  if (op.paymasterAndData !== '0x') {
    result.paymaster = op.paymasterAndData.slice(0, 42);
    result.paymasterVerificationGasLimit = toHex(BigInt(`0x${op.paymasterAndData.slice(42, 74)}`));
    result.paymasterPostOpGasLimit = toHex(BigInt(`0x${op.paymasterAndData.slice(74, 106)}`));
    result.paymasterData = `0x${op.paymasterAndData.slice(106)}`;
  }
  return result;
}
export interface OperationReceipt { userOpHash: Hex; transactionHash: Hex; success: boolean; blockNumber: bigint }
export class BundlerClient {
  readonly rpc: Rpc; readonly entryPoint: Hex; readonly chainId: bigint;
  constructor(rpc: Rpc, entryPoint: Hex, chainId: bigint) { this.rpc = rpc; this.entryPoint = entryPoint; this.chainId = chainId; }
  async check(): Promise<void> {
    const supported = await this.rpc('eth_supportedEntryPoints', []);
    if (!Array.isArray(supported) || !supported.some(a => typeof a === 'string' && a.toLowerCase() === this.entryPoint.toLowerCase())) throw new Error('Bundler does not support the pinned EntryPoint');
    if (quantity(await this.rpc('eth_chainId', [])) !== this.chainId) throw new Error('Wrong bundler network');
  }
  async estimate(op: PackedOperation): Promise<{ verification: bigint; call: bigint; pre: bigint }> {
    const value = await this.rpc('eth_estimateUserOperationGas', [rpcOperation(op), this.entryPoint]) as Record<string, unknown>;
    if (!value || typeof value !== 'object') throw new Error('Invalid estimate');
    return { verification: quantity(value.verificationGasLimit), call: quantity(value.callGasLimit), pre: quantity(value.preVerificationGas) };
  }
  async submit(op: PackedOperation): Promise<Hex> {
    const expected = operationHash(op, this.entryPoint, this.chainId);
    const result = asBytes32(await this.rpc('eth_sendUserOperation', [rpcOperation(op), this.entryPoint]));
    if (result.toLowerCase() !== expected.toLowerCase()) throw new Error('Bundler returned a different operation hash');
    return result;
  }
  async receipt(hash: Hex, sender: Hex, nonce: bigint): Promise<OperationReceipt | undefined> {
    const r = await this.rpc('eth_getUserOperationReceipt', [hash]) as Record<string, unknown> | null;
    if (r === null) return undefined;
    if (!r || asBytes32(r.userOpHash).toLowerCase() !== hash.toLowerCase() || rpcAddress(r.sender).toLowerCase() !== sender.toLowerCase() ||
        rpcAddress(r.entryPoint).toLowerCase() !== this.entryPoint.toLowerCase() || quantity(r.nonce) !== nonce || typeof r.success !== 'boolean') throw new Error('Unrelated operation receipt');
    const receipt = r.receipt as Record<string, unknown>;
    if (!receipt || quantity(receipt.status) !== 1n) throw new Error('Bundle reverted');
    return { userOpHash: hash, transactionHash: asBytes32(receipt.transactionHash), success: r.success, blockNumber: quantity(receipt.blockNumber) };
  }
}
export interface Sponsorship { paymasterAndData: Hex; verificationGasLimit: bigint; callGasLimit: bigint; preVerificationGas: bigint }
/** Explicit provider adapter for the v0.7 split-field pm_sponsorUserOperation dialect. */
export async function sponsorOperation(rpc: Rpc, op: PackedOperation, entryPoint: Hex, expectedPaymaster: Hex): Promise<Sponsorship> {
  const r = await rpc('pm_sponsorUserOperation', [rpcOperation(op), entryPoint]) as Record<string, unknown>;
  if (!r || rpcAddress(r.paymaster).toLowerCase() !== expectedPaymaster.toLowerCase() || typeof r.paymasterData !== 'string' || !/^0x(?:[a-f0-9]{2})*$/i.test(r.paymasterData)) throw new Error('Unexpected sponsorship');
  return { paymasterAndData: concat([rpcAddress(r.paymaster), toHex(quantity(r.paymasterVerificationGasLimit), { size: 16 }),
    toHex(quantity(r.paymasterPostOpGasLimit), { size: 16 }), r.paymasterData as Hex]),
    verificationGasLimit: quantity(r.verificationGasLimit), callGasLimit: quantity(r.callGasLimit), preVerificationGas: quantity(r.preVerificationGas) };
}

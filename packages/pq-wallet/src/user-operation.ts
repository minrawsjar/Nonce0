import { encodeAbiParameters, decodeAbiParameters, keccak256, toHex, concat, toBytes, type Hex as VHex } from 'viem';
import { asBytes32, asChainId, asAddress } from '@opaque/protocol-types/codecs.js';
import type { Bytes32, Hex } from '@opaque/protocol-types';
import { pqDigest } from './digest.ts';

export const ENTRYPOINT_VERSION = '0.7' as const;
export const ACCOUNT_SCHEME = 'FORS+C/keccak256/k=32,a=8';
export const PACKED_OPERATION = [{ type: 'tuple', components: [
  { name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }, { name: 'signature', type: 'bytes' },
] }] as const;
export interface PackedOperation {
  sender: VHex; nonce: bigint; initCode: VHex; callData: VHex; accountGasLimits: VHex;
  preVerificationGas: bigint; gasFees: VHex; paymasterAndData: VHex; signature: VHex;
}
const HASH_FIELDS = [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' },
  { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }] as const;
export function operationHash(op: PackedOperation, entryPoint: VHex, chainId: bigint): Bytes32 {
  validateOperation(op); asAddress(entryPoint); asChainId(chainId);
  const inner = keccak256(encodeAbiParameters(HASH_FIELDS, [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData),
    op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)]));
  return asBytes32(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [inner, entryPoint, chainId])));
}
export function validateOperation(op: PackedOperation): void {
  asAddress(op.sender);
  if (op.nonce < 0n || op.nonce >= 1n << 64n) throw new Error('Only nonce lane zero is supported');
  // ABI encoding validates widths and types. Dynamic values must be whole bytes.
  for (const value of [op.initCode, op.callData, op.paymasterAndData, op.signature]) {
    if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(value)) throw new Error('Malformed operation bytes');
  }
  encodeAbiParameters(PACKED_OPERATION, [op]);
  if (op.initCode !== '0x' && op.initCode.length < 42) throw new Error('Missing factory address');
  if (op.paymasterAndData !== '0x' && op.paymasterAndData.length < 106) throw new Error('Incomplete paymaster fields');
}
export function encodeOperation(op: PackedOperation): Hex { validateOperation(op); return encodeAbiParameters(PACKED_OPERATION, [op]) as Hex; }
export function decodeOperation(encoded: Hex): PackedOperation {
  const [decoded] = decodeAbiParameters(PACKED_OPERATION, encoded);
  const op = { ...decoded, sender: asAddress(decoded.sender.toLowerCase()) };
  if (encodeOperation(op).toLowerCase() !== encoded.toLowerCase()) throw new Error('Noncanonical operation');
  return op;
}
export interface OperationContext { entryPoint: VHex; chainId: bigint; epoch: bigint; useCount: bigint; validAfter: bigint; validUntil: bigint }
export function operationPayload(hash: Bytes32, c: OperationContext): Hex {
  if (c.validAfter < 0n || c.validUntil <= 0n || c.validUntil >= 1n << 48n || c.validAfter > c.validUntil) throw new Error('Invalid validity window');
  return encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' },
    { type: 'uint48' }, { type: 'uint48' }], ['opaque/v1/pq-wallet/erc4337-v07', c.entryPoint, hash, c.epoch, Number(c.validAfter), Number(c.validUntil)]) as Hex;
}
export function accountDigest(op: PackedOperation, c: OperationContext): Bytes32 {
  return pqDigest({ chainId: asChainId(c.chainId), walletAddress: asAddress(op.sender), schemeId: ACCOUNT_SCHEME,
    useCount: c.useCount, payload: operationPayload(operationHash(op, c.entryPoint, c.chainId), c) });
}
export function signatureEnvelope(c: Pick<OperationContext, 'epoch' | 'validAfter' | 'validUntil'>, signature: Hex): Hex {
  if (toBytes(signature).length !== 9251) throw new Error('Expected the pinned FORS signature profile');
  return concat([toHex(c.epoch, { size: 32 }), toHex(c.validAfter, { size: 6 }), toHex(c.validUntil, { size: 6 }), signature]) as Hex;
}
export const EXECUTE_SELECTOR = keccak256(toBytes('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)')).slice(0, 10) as VHex;
export type ActionKind = 0 | 1 | 2 | 3 | 4;
export function actionCallData(kind: ActionKind, data: VHex = '0x'): Hex {
  return concat([EXECUTE_SELECTOR, encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [kind, data])]) as Hex;
}
export function decodeAction(callData: VHex): { kind: ActionKind; data: VHex } {
  if (callData.slice(0, 10) !== EXECUTE_SELECTOR) throw new Error('Unrecognized account call');
  const [kind, data] = decodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], `0x${callData.slice(10)}`);
  if (kind > 4 || actionCallData(kind as ActionKind, data).toLowerCase() !== callData.toLowerCase()) throw new Error('Noncanonical action');
  return { kind: kind as ActionKind, data };
}
export function batchAction(calls: readonly { target: VHex; value: bigint; data: VHex }[]): Hex {
  if (calls.length < 1 || calls.length > 8) throw new Error('Expected one to eight calls');
  return actionCallData(1, encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], [calls]));
}
export function lifecycleAction(kind: 2 | 4, next: Bytes32, deadline: bigint): Hex {
  return actionCallData(kind, encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [next, deadline]));
}
export function packedGas(high: bigint, low: bigint): VHex { return concat([toHex(high, { size: 16 }), toHex(low, { size: 16 })]); }

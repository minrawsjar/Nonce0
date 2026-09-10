import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getUserOperationHash } from 'viem/account-abstraction';
import { asAddress } from '@opaque/protocol-types/codecs.js';
import { accountDigest, actionCallData, encodeOperation, decodeOperation, operationHash, packedGas, signatureEnvelope, type PackedOperation } from '../src/user-operation.ts';
import { rpcOperation, BundlerClient } from '../src/bundler-client.ts';
const address = asAddress(`0x${'11'.repeat(20)}`), entryPoint = asAddress(`0x${'22'.repeat(20)}`);
const op: PackedOperation = { sender: address, nonce: 0n, initCode: '0x', callData: actionCallData(0), accountGasLimits: packedGas(300000n, 100000n),
  preVerificationGas: 180000n, gasFees: packedGas(1n, 2n), paymasterAndData: '0x', signature: '0x' };
const context = { entryPoint, chainId: 31337n, epoch: 0n, useCount: 0n, validAfter: 100n, validUntil: 200n };
test('account hash matches independent viem v0.7 implementation', () => {
  assert.equal(operationHash(op, entryPoint, 31337n), getUserOperationHash({ chainId: 31337, entryPointAddress: entryPoint, entryPointVersion: '0.7',
    userOperation: { sender: address, nonce: 0n, callData: op.callData, callGasLimit: 100000n, verificationGasLimit: 300000n, preVerificationGas: 180000n,
      maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, signature: '0x' } }));
  assert.deepEqual(decodeOperation(encodeOperation(op)), op);
});
test('full operation and authority mutations change the signed digest', () => {
  const digest = accountDigest(op, context);
  for (const change of [{ nonce: 1n }, { initCode: `0x${'33'.repeat(20)}` as const }, { callData: actionCallData(3) },
    { accountGasLimits: packedGas(300001n, 100000n) }, { gasFees: packedGas(1n, 3n) }, { preVerificationGas: 180001n },
    { paymasterAndData: `0x${'44'.repeat(52)}` as const }]) assert.notEqual(accountDigest({ ...op, ...change }, context), digest);
  for (const change of [{ entryPoint: address }, { chainId: 1n }, { epoch: 1n }, { useCount: 1n }, { validAfter: 101n }, { validUntil: 201n }]) {
    assert.notEqual(accountDigest(op, { ...context, ...change }), digest);
  }
  assert.equal(operationHash({ ...op, signature: '0x1234' }, entryPoint, 31337n), operationHash(op, entryPoint, 31337n));
});
test('envelope and RPC encoding preserve profile and packed fields', () => {
  const envelope = signatureEnvelope(context, `0x${'01'.repeat(9251)}` as import('@opaque/protocol-types').Hex);
  assert.equal((envelope.length - 2) / 2, 9295);
  assert.throws(() => signatureEnvelope(context, '0x' as import('@opaque/protocol-types').Hex));
  assert.equal(rpcOperation(op).verificationGasLimit, '0x493e0');
});
test('bundler must return the expected hash and distinguish operation failure', async () => {
  const hash = operationHash(op, entryPoint, 31337n);
  const bad = new BundlerClient(async () => `0x${'99'.repeat(32)}`, entryPoint, 31337n);
  await assert.rejects(bad.submit(op));
  const bundler = new BundlerClient(async () => ({ userOpHash: hash, sender: address, entryPoint, nonce: '0x0', success: false,
    receipt: { status: '0x1', transactionHash: `0x${'55'.repeat(32)}`, blockNumber: '0x1' } }), entryPoint, 31337n);
  assert.equal((await bundler.receipt(hash, address, 0n))?.success, false);
  await assert.rejects(bundler.receipt(hash, address, 1n));
});

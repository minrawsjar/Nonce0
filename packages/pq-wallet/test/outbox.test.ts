import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asAddress, asBytes32 } from '@opaque/protocol-types/codecs.js';
import { MemoryAccountStore, validateAccountRecord, type AccountRecord } from '../src/operation-outbox.ts';
import { accountDigest, actionCallData, packedGas, operationHash, type PackedOperation } from '../src/user-operation.ts';
const b = (n: number) => asBytes32(`0x${n.toString(16).padStart(64, '0')}`);
const account = asAddress(`0x${'11'.repeat(20)}`);
const base = (): AccountRecord => ({ version: 1, revision: 0n, configId: b(1), account, active: b(2), next: b(3), initialActive: b(2), initialNext: b(3),
  salt: b(4), initialDeadline: 1000n, epoch: 0n, lastBlock: 1n, chainCount: 0n, registered: false, history: [] });
test('outbox compare-and-swap rejects stale writes and chain regression', async () => {
  const store = new MemoryAccountStore(); const record = base(); await store.write(undefined, record);
  await store.write(0n, { ...record, revision: 1n, lastBlock: 2n, chainCount: 1n });
  await assert.rejects(store.write(0n, { ...record, revision: 1n }));
  await assert.rejects(store.write(1n, { ...record, revision: 2n }));
  assert.equal((await store.read())?.chainCount, 1n);
});
test('outbox rejects altered operation bytes and unrelated receipt', () => {
  const operation: PackedOperation = { sender: account, nonce: 0n, initCode: '0x', callData: actionCallData(0), accountGasLimits: packedGas(400000n, 100000n),
    gasFees: packedGas(1n, 2n), preVerificationGas: 200000n, paymasterAndData: '0x', signature: '0x' };
  const context = { entryPoint: account, chainId: 31337n, epoch: 0n, useCount: 0n, validAfter: 0n, validUntil: 1000n };
  const r = base(); r.pending = { phase: 'prepared', operation, context, digest: accountDigest(operation, context), hash: operationHash(operation, account, 31337n), signer: r.active };
  validateAccountRecord(r);
  r.pending.operation.gasFees = packedGas(1n, 3n); assert.throws(() => validateAccountRecord(r));
});

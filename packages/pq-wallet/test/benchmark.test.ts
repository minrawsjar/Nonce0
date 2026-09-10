import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectVerificationReceipt } from '../scripts/benchmark.ts';

const hash = `0x${'aa'.repeat(32)}`; const verifier = `0x${'bb'.repeat(20)}`;
const receipt = { transactionHash: hash, status: '0x1', gasUsed: '0x10000', blockNumber: '0x2', blockHash: `0x${'cc'.repeat(32)}` };
const tx = { hash, to: verifier, input: '0x1234', blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
function rpc(overrides: Record<string, unknown> = {}) {
  return async (method: string) => ({ eth_chainId: '0x7a69', eth_getTransactionReceipt: receipt,
    eth_getTransactionByHash: tx, ...overrides })[method as 'eth_chainId'];
}
test('benchmark_records_matching_receipt_gas_without_calling_it_isolated_verification', async () => {
  const result = await collectVerificationReceipt({ rpc: rpc(), chainId: 31337n, txHash: hash, verifier, calldata: '0x1234' });
  assert.equal(result.gasUsed, '65536'); assert.equal(result.source, 'SUCCESSFUL_TRANSACTION_RECEIPT');
});
test('benchmark_rejects_wrong_chain_reverted_receipt_or_unrelated_transaction', async () => {
  for (const overrides of [{ eth_chainId: '0x1' }, { eth_getTransactionReceipt: { ...receipt, status: '0x0' } },
    { eth_getTransactionByHash: { ...tx, input: '0x9999' } }, { eth_getTransactionReceipt: null }]) {
    await assert.rejects(collectVerificationReceipt({ rpc: rpc(overrides), chainId: 31337n, txHash: hash, verifier, calldata: '0x1234' }));
  }
});

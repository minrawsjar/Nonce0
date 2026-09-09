import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure, type Address, type Nullifier, type PoolScope } from '@opaque/protocol-types';

import { ARC_TESTNET, POOL_ABI, createPoolClient } from '../pool.ts';

// The pool actually deployed by script/Deploy.s.sol. These read the LIVE
// chain on purpose: a mock that agrees with itself proves nothing about
// whether the ABI matches the deployed bytecode, which is the one thing that
// really goes wrong between a contract and its client.
const POOL = '0x4cfa5843453E782924Bfa7cE6a9E3dAd713Da995' as Address;
const VERIFIER = '0x8ad3c8f52F17B0F62a4dA3c3A1905a04E114B015' as Address;
const USDC = '0x3600000000000000000000000000000000000000';

const scope: PoolScope = {
  chainId: 5_042_002n as PoolScope['chainId'],
  pool: POOL,
  denomination: 1_000_000 as PoolScope['denomination'],
};

const offChain = {
  pqWallet: 'MOCK',
  graph: 'FIXTURE',
  confidentialExecution: 'SIMULATED',
  policyScope: 'CRE_WORKFLOW_ONLY',
} as const;

const reader = () => createPoolClient({ offChain });

test('capabilities are READ from the deployed pool, not assumed', async () => {
  const caps = await reader().capabilities(POOL);
  // This deployment is SINGLE_NOTE_PQ. If that silently became RING_8, a UI
  // would start promising anonymity the pool does not provide.
  assert.equal(caps.proofMode, 'SINGLE_NOTE_PQ');
  assert.equal(caps.ringSize, 1);
  assert.match(caps.verifierId, /^0x[0-9a-f]{64}$/);
});

test('the off-chain fields come from configuration, never from a default', async () => {
  const caps = await reader().capabilities(POOL);
  // confidentialExecution must read SIMULATED until attestations are actually
  // verified. A default is how it would quietly come to say otherwise.
  assert.equal(caps.confidentialExecution, 'SIMULATED');
  assert.equal(caps.pqWallet, 'MOCK');
  assert.equal(caps.graph, 'FIXTURE');
});

test('the ABI matches the deployed bytecode for every read', async () => {
  const { publicClient } = reader();
  const read = (functionName: 'denomination' | 'token' | 'poolId') =>
    publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName });
  assert.equal(await read('denomination'), 1_000_000n);
  assert.equal(String(await read('token')).toLowerCase(), USDC);
  assert.match(String(await read('poolId')), /^0x[0-9a-f]{64}$/);
});

test('an unspent nullifier reads false against the live pool', async () => {
  assert.equal(await reader().isNullifierSpent(scope, `0x${'ab'.repeat(32)}` as Nullifier), false);
});

test('the verifier the pool points at really has bytecode', async () => {
  const code = await reader().publicClient.getCode({ address: VERIFIER });
  assert.ok((code?.length ?? 0) > 2, 'verifier has no bytecode');
});

test('a client with no signer refuses to write rather than pretending', async () => {
  // A caller that believes it deposited and did not is worse than one that
  // cannot deposit at all.
  await assert.rejects(
    reader().deposit({ scope, commitment: `0x${'11'.repeat(32)}` as never }),
    (error: unknown) => error instanceof ProtocolFailure && error.code === 'INVALID_INPUT',
  );
});

test('the chain definition matches what the RPC reports', async () => {
  assert.equal(ARC_TESTNET.id, 5_042_002);
  assert.equal(await reader().publicClient.getChainId(), ARC_TESTNET.id);
  // Native USDC is 18 decimals and pays gas; the pool's ERC-20 interface is 6.
  assert.equal(ARC_TESTNET.nativeCurrency.decimals, 18);
});

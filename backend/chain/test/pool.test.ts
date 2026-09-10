import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure, type Address, type Nullifier, type PoolScope } from '@opaque/protocol-types';

import { deployment, poolFor, requireContract } from '../../../deployments/index.ts';
import { ARC_TESTNET, POOL_ABI, createPoolClient } from '../pool.ts';

// The pool actually deployed by script/Deploy.s.sol. These read the LIVE
// chain on purpose: a mock that agrees with itself proves nothing about
// whether the ABI matches the deployed bytecode, which is the one thing that
// really goes wrong between a contract and its client.
// From deployments/arc-testnet.json, never a second copy: a test that pinned
// its own address would keep passing against a pool nobody uses any more.
const POOL = poolFor(1_000_000, 'SINGLE_NOTE_PQ').address as Address;
const VERIFIER = requireContract('singleNotePqVerifier') as Address;
const USDC = deployment.tokens.usdc.address;

const scope: PoolScope = {
  chainId: BigInt(deployment.network.chainId) as PoolScope['chainId'],
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

// ── the signer path ───────────────────────────────────────────────────────

test('a local account is passed to viem WHOLE, not narrowed to an address', async () => {
  // The bug this pins: narrowing a local Account to its address made viem
  // choose eth_sendTransaction, which means "the node holds this key". Public
  // RPCs do not, so every write failed with "method does not exist" while
  // every read passed. Reads are all the rest of this file exercises, which is
  // exactly why it survived to a live settlement attempt.
  const { privateKeyToAccount } = await import('viem/accounts');
  // A published, worthless key: Foundry's own anvil account 0.
  const account = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const client = createPoolClient({ account, offChain });

  // simulateContract must receive the Account object. If it is ever narrowed
  // again, viem reports the wrong send path and this fails on the message.
  await assert.rejects(
    client.deposit({ scope, commitment: `0x${'11'.repeat(32)}` as never }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.equal(
        message.includes('eth_sendTransaction'),
        false,
        'signer was narrowed to an address: viem picked the node-holds-the-key path',
      );
      // It still fails, because that account has no USDC and no approval —
      // which is a revert from the chain, not a transport mistake.
      return true;
    },
  );
});

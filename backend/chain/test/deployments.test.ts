import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicClient, http, parseAbi } from 'viem';

import { deployment } from '../../../deployments/index.ts';

// LIVE. deployments/arc-testnet.json is now the one place every address lives,
// which makes it the one place a wrong address would break everything at once.
// So the file itself is checked against the chain, not against itself: an
// address that is written down but has no code behind it — a typo, a redeploy
// nobody recorded, a contract on the wrong network — fails here rather than in
// the first transaction a user sends.

const client = createPublicClient({ transport: http(deployment.network.rpcUrl) });
const hasCode = async (address: `0x${string}`) => ((await client.getCode({ address })) ?? '0x').length > 2;

test('the rpc really is the chain the config claims', async () => {
  assert.equal(await client.getChainId(), deployment.network.chainId);
});

for (const [name, contract] of Object.entries(deployment.contracts)) {
  // Only what is claimed deployed. null is an honest "not yet" and needs no check.
  if (contract === null) continue;
  test(`contracts.${name} has code at ${contract.address}`, async () => {
    assert.ok(await hasCode(contract.address), `${name}: no code — wrong address or wrong network`);
  });
}

for (const pool of deployment.pools) {
  test(`the ${pool.denomination} pool matches what the config says about it`, async () => {
    assert.ok(await hasCode(pool.address), 'no code at the pool address');
    const abi = parseAbi([
      'function denomination() view returns (uint256)',
      'function verifier() view returns (address)',
      'function token() view returns (address)',
      'function capabilities() view returns ((uint8 proofMode, uint8 ringSize, bytes32 verifierId, uint256 denomination, bool requiresCommitReveal))',
    ]);
    const read = (functionName: 'denomination' | 'verifier' | 'token') =>
      client.readContract({ address: pool.address, abi, functionName });

    // The mode is what decides whether a note can ever be spent here, so the
    // config's claim is checked against what the pool itself reports.
    const caps = await client.readContract({ address: pool.address, abi, functionName: 'capabilities' });
    const MODES = ['RING_8', 'SINGLE_NOTE_PQ', 'ATTESTED_OFFCHAIN'] as const;
    assert.equal(MODES[caps.proofMode], pool.proofMode, `the pool reports ${MODES[caps.proofMode]}`);
    assert.equal(caps.ringSize, pool.proofMode === 'RING_8' ? 8 : 1, 'ring size follows the mode');

    assert.equal(await read('denomination'), BigInt(pool.denomination), 'denomination');
    assert.equal(String(await read('token')).toLowerCase(), deployment.tokens.usdc.address, 'token');
    // The pool's verifier must be the one the config names — a pool pointed at
    // a different verifier is a different trust model under the same address.
    const verifier = deployment.contracts[pool.verifier];
    assert.notEqual(verifier, null, `pool names ${pool.verifier}, which the config says is not deployed`);
    assert.equal(String(await read('verifier')).toLowerCase(), verifier!.address, 'verifier');
  });
}

test('usdc is the 6-decimal interface, not the 18-decimal native one', async () => {
  const decimals = await client.readContract({
    address: deployment.tokens.usdc.address,
    abi: parseAbi(['function decimals() view returns (uint8)']),
    functionName: 'decimals',
  });
  assert.equal(decimals, deployment.tokens.usdc.decimals);
  assert.equal(deployment.tokens.usdc.decimals, 6);
  assert.equal(deployment.network.nativeCurrency.decimals, 18);
});

for (const [version, address] of Object.entries(deployment.erc4337.entryPoints)) {
  test(`ERC-4337 EntryPoint ${version} is deployed`, async () => {
    assert.ok(await hasCode(address), `EntryPoint ${version}: no code at ${address}`);
  });
}

test('the ring verifier trusts the attester the config names, and that attester is registered', async () => {
  const verifier = deployment.contracts.attestedRingVerifier;
  if (verifier === null) return; // not deployed: nothing to check
  const attester = await client.readContract({
    address: verifier.address,
    abi: parseAbi(['function attester() view returns (address)']),
    functionName: 'attester',
  });
  assert.equal(String(attester).toLowerCase(), deployment.accounts.attester, 'config and chain disagree on who attests');

  // An attester with no registered key would make every spend revert with
  // NotRegistered — a pool that accepts deposits and can never pay out.
  const [pkCommitment, , useCount, maxUses] = await client.readContract({
    address: deployment.contracts.pqKeyRegistry!.address,
    abi: parseAbi(['function stateOf(address) view returns ((bytes32,bytes32,uint64,uint64,uint64,uint64))']),
    functionName: 'stateOf',
    args: [deployment.accounts.attester],
  }) as unknown as readonly [string, string, bigint, bigint];
  assert.notEqual(pkCommitment, `0x${'0'.repeat(64)}`, 'the attester has no registered FORS key');
  assert.ok(useCount < maxUses, `the attester's few-time budget is spent (${useCount}/${maxUses}) — rotate it`);
});

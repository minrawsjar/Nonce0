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
    ]);
    const read = (functionName: 'denomination' | 'verifier' | 'token') =>
      client.readContract({ address: pool.address, abi, functionName });

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

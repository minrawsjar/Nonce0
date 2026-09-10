import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeFunctionData } from 'viem';

import type { Address, Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { encodeSignature, keyGen, sign } from '@opaque/pq-wallet';

import { createWalletRpcAnswerer, readOne, STATE_ABI, userOperationCall, walletRpcAllowlist } from '../../chain/wallet-rpc.ts';
import { deployment, entryPoint, requireContract } from '../../../deployments/index.ts';

const implementation = `0x${'ab'.repeat(20)}` as Address;
const pqAccount = `0x${'11'.repeat(20)}`;
const stranger = `0x${'22'.repeat(20)}`;
const cloneCode = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;

function world() {
  const reads: string[] = [];
  const relayed: string[] = [];
  const publicClient = {
    getBlock: async () => ({ number: 7n, timestamp: 1_000n }),
    call: async ({ to, data }: { to: string; data: string }) => { reads.push(`${to}:${data.slice(0, 10)}`); return { data: `0x${'00'.repeat(31)}01` }; },
    getCode: async ({ address }: { address: string }) => (address === pqAccount ? cloneCode : '0x'),
  };
  const send = createWalletRpcAnswerer({
    publicClient: publicClient as never, bundlerUrl: 'https://bundler.invalid', entryPoint: entryPoint() as Address,
    accountImplementation: implementation,
    fetch: (async (_url: string, init: { body: string }) => {
      relayed.push(JSON.parse(init.body).method);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xbeef' }));
    }) as never,
  });
  const ask = async (operation: string, request: unknown) =>
    JSON.parse(new TextDecoder().decode(fromHex(await send(operation as never, toHex(new TextEncoder().encode(JSON.stringify(request))) as Hex))));
  return { send, ask, reads, relayed };
}

test('STATE reads allowlisted views, at one block, and nothing else', async () => {
  const { send, ask, reads } = world();
  const pool = deployment.pools[0]!.address as Address;
  const spent = await readOne(send, pool, 'isNullifierSpent', [`0x${'33'.repeat(32)}`]);
  assert.equal(spent.value, true);
  assert.equal(spent.blockNumber, 7n);

  // The registry's stateOf is allowed; its rotate is not, nor any contract off the list.
  const rotate = `0x${'aa'.repeat(4)}${'00'.repeat(32)}`;
  assert.match((await ask('STATE', { calls: [{ to: requireContract('pqKeyRegistry'), data: rotate }] })).error.message, /does not read/);
  const balance = encodeFunctionData({ abi: STATE_ABI, functionName: 'balanceOf', args: [pqAccount as Address] });
  assert.match((await ask('STATE', { calls: [{ to: stranger, data: balance }] })).error.message, /does not read/);
  assert.equal(reads.length, 1, 'refused calls never reached the chain');
  assert.ok(walletRpcAllowlist().get(deployment.tokens.usdc.address.toLowerCase())?.size === 1);
});

test('bundler calls are relayed for PQ accounts on the pinned EntryPoint only', async () => {
  const { ask, relayed } = world();
  const op = (sender: string) => ({ sender, nonce: '0x0', callData: '0x' });

  assert.equal((await ask('SUBMIT_USER_OPERATION', { method: 'eth_sendUserOperation', params: [op(pqAccount), entryPoint()] })).result, '0xbeef');
  assert.match((await ask('SUBMIT_USER_OPERATION', { method: 'eth_sendUserOperation', params: [op(stranger), entryPoint()] })).error.message, /only PQ accounts/);
  assert.match((await ask('ESTIMATE', { method: 'eth_estimateUserOperationGas', params: [op(pqAccount), `0x${'44'.repeat(20)}`] })).error.message, /pinned v0.7/);
  assert.match((await ask('ESTIMATE', { method: 'eth_sendRawTransaction', params: ['0x00'] })).error.message, /does not relay/);
  assert.match((await ask('WALLET_RPC_ANYTHING', {})).error.message, /unknown operation/);
  assert.deepEqual(relayed, ['eth_sendUserOperation'], 'only the one legitimate call left the exit');
});

test('a signed UserOperation fits the largest mesh size class', async () => {
  let captured = '' as Hex;
  const send = async (_operation: unknown, encoded: Hex) => {
    captured = encoded;
    return toHex(new TextEncoder().encode(JSON.stringify({ result: '0x01' }))) as Hex;
  };
  const key = keyGen();
  const signature = encodeSignature(key.publicKey, sign(key.secretKey, `0x${'00'.repeat(32)}` as never));
  await userOperationCall(send as never, 'eth_sendUserOperation', {
    sender: pqAccount as Address, nonce: 2n ** 70n, callData: `0x${'ab'.repeat(600)}`,
    callGasLimit: 10n ** 6n, verificationGasLimit: 2n * 10n ** 6n, preVerificationGas: 10n ** 6n,
    maxFeePerGas: 10n ** 11n, maxPriorityFeePerGas: 10n ** 10n, signature,
  } as never, entryPoint() as Address);
  // As the mesh carries it: the query as JSON, as hex, inside the onion's payload.
  const body = toHex(new TextEncoder().encode(JSON.stringify({ kind: 'WALLET_RPC', operation: 'SUBMIT_USER_OPERATION', encodedRequest: captured })));
  assert.ok(body.length + 2_048 < 65_536, `a ${body.length}-byte query leaves too little room`);
});

test('an ABI UserOperation reaches the bundler as the same operation', async () => {
  let forwarded: { method: string; params: [Record<string, string>, string] } | undefined;
  const publicClient = { getCode: async () => cloneCode };
  const send = createWalletRpcAnswerer({
    publicClient: publicClient as never, bundlerUrl: 'https://bundler.invalid', entryPoint: entryPoint() as Address, accountImplementation: implementation,
    fetch: (async (_url: string, init: { body: string }) => { forwarded = JSON.parse(init.body); return new Response(JSON.stringify({ result: '0xfeed' })); }) as never,
  });
  const signature = `0x${'cd'.repeat(9_251)}` as Hex;
  const hash = await userOperationCall(send, 'eth_sendUserOperation', {
    sender: pqAccount as Address, nonce: 5n, callData: '0x1234', callGasLimit: 11n, verificationGasLimit: 22n,
    preVerificationGas: 33n, maxFeePerGas: 44n, maxPriorityFeePerGas: 55n, signature,
  } as never, entryPoint() as Address);
  assert.equal(hash, '0xfeed');
  const [op, entry] = forwarded!.params;
  assert.equal(forwarded!.method, 'eth_sendUserOperation');
  assert.equal(entry.toLowerCase(), entryPoint().toLowerCase());
  assert.deepEqual([op['sender']!.toLowerCase(), op['nonce'], op['callGasLimit'], op['verificationGasLimit'], op['preVerificationGas'], op['maxFeePerGas'], op['maxPriorityFeePerGas'], op['signature']],
    [pqAccount, '0x5', '0xb', '0x16', '0x21', '0x2c', '0x37', signature]);
});

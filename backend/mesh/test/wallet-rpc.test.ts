import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector } from 'viem';
import { toPackedUserOperation } from 'viem/account-abstraction';

import type { Address, Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { encodeSignature, keyGen, sign } from '@opaque/pq-wallet';

import { createWalletRpcAnswerer, readOne, STATE_ABI, userOperationCall, walletRpcAllowlist } from '../../chain/wallet-rpc.ts';
import { ARC_AUTHORITY, createLiveWalletChain } from '../../chain/pq-wallet-chain.ts';
import { accountSalt, predictAccount } from '../../chain/pq-account.ts';

const PACKED_OP = parseAbiParameters('(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData)');
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
  // The page's one pool-wide read, so it needs no RPC of its own.
  assert.ok(walletRpcAllowlist().get(pool.toLowerCase())?.has(toFunctionSelector('capabilities()')));
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

test('a first operation that deploys a PQ account is relayed; no other initCode is', async () => {
  const factory = `0x${'fa'.repeat(20)}` as Address;
  const relayed: Record<string, unknown>[] = [];
  const send = createWalletRpcAnswerer({
    publicClient: { getCode: async () => undefined } as never, bundlerUrl: 'https://bundler.invalid', entryPoint: entryPoint() as Address,
    accountImplementation: implementation, factory,
    fetch: (async (_url: string, init: { body: string }) => { relayed.push(JSON.parse(init.body).params[0]); return new Response(JSON.stringify({ result: '0xfeed' })); }) as never,
  });
  const createAccount = encodeFunctionData({ abi: parseAbi(['function createAccount(bytes32, bytes32, uint64, uint64) returns (address)']), functionName: 'createAccount', args: [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, 32n, 1n] });
  const op = { sender: stranger, nonce: 0n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' };
  const call = (extra: object) => userOperationCall(send, 'eth_sendUserOperation', { ...op, ...extra } as never, entryPoint() as Address);

  // As the page sends it, ABI-encoded: the initCode arrives as factory + factoryData again.
  assert.equal(await call({ factory, factoryData: createAccount }), '0xfeed');
  assert.equal(String(relayed[0]!['factory']).toLowerCase(), factory);
  assert.equal(relayed[0]!['factoryData'], createAccount);
  // Another factory, or another call on the right one, never reaches the bundler.
  await assert.rejects(call({ factory: stranger, factoryData: createAccount }), /createAccount/);
  await assert.rejects(call({ factory, factoryData: '0xdeadbeef' }), /createAccount/);
  // Without an initCode, a sender with no code is still not a PQ account.
  await assert.rejects(call({}), /only PQ accounts/);
  assert.equal(relayed.length, 1);
});

test('the adapter signs an unregistered account only for the operation that deploys that address', async () => {
  const chain = createLiveWalletChain({
    publicClient: {} as never, authority: ARC_AUTHORITY, payer: async () => { throw new Error('no payer here'); }, walletRpc: (async () => '0x') as never,
    maxUses: 32n, rotationDeadline: 2_000_000_000n, initialKeyEpoch: 0n, epochOf: async () => 0n,
  });
  const keys = [`0x${'0a'.repeat(32)}`, `0x${'0b'.repeat(32)}`] as const;
  const account = predictAccount(ARC_AUTHORITY.factory, ARC_AUTHORITY.accountImplementation, accountSalt(keys[0] as never, keys[1] as never, 32n, 2_000_000_000n));
  const factoryCall = (a: string, b: string) => encodeFunctionData({ abi: parseAbi(['function createAccount(bytes32, bytes32, uint64, uint64) returns (address)']), functionName: 'createAccount', args: [a as Hex, b as Hex, 32n, 2_000_000_000n] });
  const encode = (extra: object) => encodeAbiParameters(PACKED_OP, [toPackedUserOperation({
    sender: account, nonce: 0n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x', ...extra,
  } as never) as never]) as Hex;
  const observation = { accountAddress: account, chainId: ARC_AUTHORITY.chainId, blockNumber: 1n, now: 100n, keyEpoch: 0n, state: undefined };

  const prepared = await chain.prepareUserOperation(encode({ factory: ARC_AUTHORITY.factory, factoryData: factoryCall(keys[0], keys[1]) }), observation, 'fors');
  assert.equal(prepared.useCount, 0n);
  assert.deepEqual([prepared.deployment?.pkCommitment, prepared.deployment?.nextCommitment], [...keys]);
  assert.equal(await chain.verifyUserOperationBinding(prepared), true);
  assert.equal(await chain.verifyUserOperationBinding({ ...prepared, deployment: { ...prepared.deployment!, nextCommitment: keys[0] as never } }), false);

  // Keys that CREATE2 would put at another address, or no initCode at all.
  await assert.rejects(chain.prepareUserOperation(encode({ factory: ARC_AUTHORITY.factory, factoryData: factoryCall(keys[1], keys[0]) }), observation, 'fors'), /different account/);
  await assert.rejects(chain.prepareUserOperation(encode({}), observation, 'fors'), /first operation must deploy/);
});

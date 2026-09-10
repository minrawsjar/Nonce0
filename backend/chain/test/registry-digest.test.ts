import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicClient, http, parseAbi } from 'viem';

import { FORS_C_DEFAULT, forsSchemeId, pqDigest } from '@opaque/pq-wallet';

import { deployment, requireContract } from '../../../deployments/index.ts';
import { asAddress, asChainId } from '@opaque/protocol-types/codecs.js';

import {
  disablePayload,
  rotationPayload,
  takeoverPayload,
  userActionPayload,
} from '../../../packages/pq-wallet/src/registry.ts';

// LIVE. The wallet SDK signs a §5.3 digest it computes in TypeScript, and the
// deployed registry recomputes that digest in Solidity before it will accept
// the signature. If the two ever disagree by one byte, every registration,
// rotation and disable fails on chain with BadSignature — and nothing offline
// would have caught it, because both sides are internally consistent.
//
// So this asks the DEPLOYED bytecode, not a local build and not a fixture.
// `digest` is a view function: these are eth_calls, no gas, no state.
const REGISTRY = requireContract('pqKeyRegistry');
const CHAIN_ID = BigInt(deployment.network.chainId);

const ABI = parseAbi([
  'function digest(address account,string schemeId,uint64 useCount,bytes payload) view returns (bytes32)',
]);

const client = createPublicClient({ transport: http(deployment.network.rpcUrl) });
const schemeId = forsSchemeId(FORS_C_DEFAULT);
const ACCOUNT = '0x00000000000000000000000000000000000000a1';

const onChain = (useCount: bigint, payload: string): Promise<string> =>
  client.readContract({
    address: REGISTRY,
    abi: ABI,
    functionName: 'digest',
    args: [ACCOUNT as `0x${string}`, schemeId, useCount, payload as `0x${string}`],
  }) as Promise<string>;

const local = (useCount: bigint, payload: string): string =>
  pqDigest({
    chainId: asChainId(CHAIN_ID),
    walletAddress: asAddress(ACCOUNT),
    schemeId,
    useCount,
    payload: payload as `0x${string}`,
  });

// Every payload the wallet can present to the registry, each under its own
// domain. A domain that matched on one path and not another would let one
// action's signature be replayed as a different action.
const paths: readonly (readonly [string, bigint, string])[] = [
  ['a user action', 0n, userActionPayload('0x1234')],
  // A different useCount MUST give a different digest: it is what stops a
  // spent signature verifying a second time.
  ['a user action at a later index', 7n, userActionPayload('0x1234')],
  ['a rotation', 3n, rotationPayload(`0x${'ab'.repeat(32)}` as never, 8n, 1_900_000_000n)],
  ['a disable', 1n, disablePayload()],
  ['a takeover', 0n, takeoverPayload(`0x${'cd'.repeat(32)}` as never, 4n)],
];

for (const [name, useCount, payload] of paths) {
  test(`the deployed registry and the wallet SDK agree on the digest for ${name}`, async () => {
    assert.equal((await onChain(useCount, payload)).toLowerCase(), local(useCount, payload).toLowerCase());
  });
}

test('the index is bound, so one signature never covers two actions', async () => {
  const payload = userActionPayload('0x1234');
  assert.notEqual(await onChain(0n, payload), await onChain(1n, payload));
});

test('the domains are separated, so a rotation is never a plain action', async () => {
  const rotation = rotationPayload(`0x${'ab'.repeat(32)}` as never, 8n, 1_900_000_000n);
  // The same bytes offered as an ordinary action must digest differently, or a
  // user could be induced to sign a transfer that is really a key rotation.
  assert.notEqual(await onChain(0n, rotation), await onChain(0n, userActionPayload(rotation)));
});

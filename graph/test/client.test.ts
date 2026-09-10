import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure, type Address } from '@opaque/protocol-types';
import { asChainId, toHex } from '@opaque/protocol-types/codecs.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { GraphHttpClient } from '../src/client.ts';

test('Graph client requests only the public pool denomination bucket', async () => {
  let body = '';
  const client = new GraphHttpClient({
    endpoint: 'https://example.invalid/graphql',
    now: () => 1_000n,
    fetch: async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ data: { _meta: { hasIndexingErrors: false, block: { number: '12', timestamp: 990 } }, ringMembers: [] } }), { status: 200 });
    },
  });
  await client.getRingSnapshot(
    { chainId: asChainId(5_042_002n), pool: `0x${'11'.repeat(20)}` as Address, denomination: 20_000_000 },
  );
  assert.match(body, /20000000/);
  assert.doesNotMatch(body, /realCommitment|exclude/);
});

test('a funding bucket reaches selection as a share, and a lagging index is refused', async () => {
  const member = (id: string, bucket: number | null) => ({ id: `0x${id.repeat(64)}`, enrolledAt: '1', timesUsedInRing: 2, fundingConcentrationBucket: bucket, hasOtherActivity: null });
  const at = (timestamp: number) => new GraphHttpClient({
    endpoint: 'https://example.invalid/graphql', now: () => 1_000n,
    fetch: async () => new Response(JSON.stringify({ data: {
      _meta: { hasIndexingErrors: false, block: { number: 12, timestamp } }, // as graph-node sends it
      ringMembers: [member('a', null), member('b', 1), member('c', 2), member('d', 3)],
    } }), { status: 200 }),
  });
  const scope = { chainId: asChainId(5_042_002n), pool: `0x${'11'.repeat(20)}` as Address, denomination: 1_000_000 as never };
  const snapshot = await at(990).getRingSnapshot(scope);
  assert.deepEqual(snapshot.candidates.map((c) => c.fundingCluster), [null, null, 'concentrated', 'concentrated']);
  assert.equal(snapshot.candidates[0]?.timesUsedInRing, 2);
  await assert.rejects(at(1).getRingSnapshot(scope), (error: unknown) => error instanceof ProtocolFailure && error.code === 'STALE_OBSERVATION');
});

test('Graph relay health cannot replace a pinned KEM key', async () => {
  const key = `0x${'22'.repeat(32)}` as const;
  const client = new GraphHttpClient({
    endpoint: 'https://example.invalid/graphql',
    pinnedRelays: [{ id: 'relay-1' as never, endpoint: 'https://relay.example', kemPublicKey: key, keyEpoch: 1n, operatorId: 'operator-1' }],
    now: () => 1_000n,
    fetch: async () => new Response(JSON.stringify({ data: {
      _meta: { hasIndexingErrors: false, block: { number: '12' } },
      relayDirectory: { version: '1', observedAt: '999' },
      relayNodes: [{ id: 'relay-1', endpoint: 'https://relay.example', kemKeyCommitment: toHex(keccak_256(new Uint8Array(32).fill(0x22))), keyEpoch: '1', operatorId: 'operator-1', reliabilityScore: '9000', batchOccupancy: '3', recentSelectionCount: 0, lastSeenAt: '999' }],
    } }), { status: 200 }),
  });
  const snapshot = await client.getRelaySnapshot();
  assert.equal(snapshot.nodes[0]?.kemPublicKey, key);
});

test('Graph rejects a relay that is not in the pinned directory', async () => {
  const client = new GraphHttpClient({
    endpoint: 'https://example.invalid/graphql', now: () => 1_000n,
    fetch: async () => new Response(JSON.stringify({ data: {
      _meta: { hasIndexingErrors: false, block: { number: '12' } },
      relayDirectory: { version: '1', observedAt: '999' },
      relayNodes: [{ id: 'attacker', endpoint: 'https://attacker.example', kemKeyCommitment: `0x${'00'.repeat(32)}`, keyEpoch: '1', operatorId: 'attacker', reliabilityScore: '9000', batchOccupancy: '3', recentSelectionCount: 0, lastSeenAt: '999' }],
    } }), { status: 200 }),
  });
  await assert.rejects(client.getRelaySnapshot(), (error: unknown) => error instanceof ProtocolFailure && error.code === 'UNTRUSTED_DIRECTORY');
});

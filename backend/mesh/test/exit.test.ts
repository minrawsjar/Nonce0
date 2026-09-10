import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type {
  EncryptedIntent,
  GraphSelectionClient,
  IdempotencyKey,
  PoolScope,
  PrivacyScore,
  RelayPath,
  UnixSeconds,
} from '@opaque/protocol-types';
import { asAddress, asChainId } from '@opaque/protocol-types/codecs.js';

import { createExecutorServer } from '../../cre/executor-server.ts';
import { createMeshTransport } from '../client.ts';
import { buildLocalMesh, serveLocalMesh } from '../local-mesh.ts';
import type { MeshMessageKind } from '../transport.ts';

// The whole wallet read/write path, for real: six relays over HTTP, a mesh
// client building genuine onions, and the executor at the exit. Before this,
// nothing answered a query at the far end, and the executor refused the
// envelope hop 3 actually sends — so each piece passed its own tests while
// the path between them had never carried a single message.

const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const scope: PoolScope = {
  chainId: asChainId(5042002n),
  pool: asAddress('0x4cfa5843453e782924bfa7ce6a9e3dad713da995'),
  denomination: 1_000_000,
};

/** The Graph, standing in until the subgraph is deployed. Returns real bigints. */
const fixtureGraph: GraphSelectionClient = {
  getRingSnapshot: async (s) => ({
    scope: s,
    candidates: [{
      commitment: `0x${'ab'.repeat(16)}${'00'.repeat(16)}` as never,
      enrolledAtBlock: 61_285_376n,
      timesUsedInRing: 2,
      fundingCluster: null,
      hasOtherActivity: null,
    }],
    indexedThroughBlock: 61_290_000n,
    observedAt: nowS(),
    policyVersion: 'fixture-v1',
  }),
  getRelaySnapshot: async () => ({ nodes: [], directoryVersion: 'fixture', observedAt: nowS() }),
  getPrivacyConditions: async (s) => ({
    scope: s, privacyScore: 7_000 as PrivacyScore, ringFreshnessScore: 6_000 as PrivacyScore,
    meshHealthScore: 8_000 as PrivacyScore, observedAt: nowS(), formulaVersion: 'fixture', source: 'FIXTURE',
  }),
};

test('a query, a payment, and a status read all cross six real relays to the exit and back', async () => {
  const exit = createExecutorServer({ graph: fixtureGraph });
  const exitServer = await exit.listen(0);
  const port = (exitServer.address() as AddressInfo).port;

  const mesh = buildLocalMesh(19_401);
  const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
    ['PAYMENT', `http://127.0.0.1:${port}/v1/mesh/payment`],
    ['QUERY', `http://127.0.0.1:${port}/v1/mesh/query`],
  ]));

  try {
    const path = mesh.signed.directory.entries.slice(0, 3).map((e) => ({
      id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch,
      operatorId: e.operatorId, reliabilityScore: 5_000 as PrivacyScore, batchOccupancy: 1,
      recentSelectionCount: 0, lastSeenAt: nowS(),
    })) as unknown as RelayPath;
    const mesh$ = createMeshTransport({ pollIntervalMs: 100, pollTimeoutMs: 20_000 });

    // ── 1. a read ────────────────────────────────────────────────────────
    const ring = await mesh$.query({ kind: 'RING_SNAPSHOT', scope }, path);
    assert.equal(ring.kind, 'RING_SNAPSHOT');
    if (ring.kind !== 'RING_SNAPSHOT') return;
    // The bug this closes: these arrived as strings typed as bigints, and the
    // first arithmetic on one threw. They must be real bigints now.
    assert.equal(typeof ring.value.observedAt, 'bigint', 'observedAt revived');
    assert.equal(typeof ring.value.indexedThroughBlock, 'bigint');
    assert.equal(typeof ring.value.candidates[0]!.enrolledAtBlock, 'bigint');
    assert.equal(typeof ring.value.scope.chainId, 'bigint');
    assert.ok(nowS() - ring.value.observedAt < 60n, 'and arithmetic on them works');
    assert.equal(ring.value.candidates[0]!.fundingCluster, null, 'null stays null, never zero');

    // ── 2. a write ───────────────────────────────────────────────────────
    const intent = {
      version: '1-review',
      scope,
      encryptedPayload: `0x${'cd'.repeat(64)}`,
      encryptionKeyId: 'opaque-intent-key-v1',
      spendHash: `0x${'ef'.repeat(32)}`,
      minPrivacyScore: 5_000,
      deadline: (nowS() + 3_600n) as UnixSeconds,
      idempotencyKey: 'exit-e2e-1' as IdempotencyKey,
    } as unknown as EncryptedIntent;
    const ref = await mesh$.submitIntent(intent, path);
    assert.match(ref.statusHandle, /^[0-9a-f]{64}$/, 'the executor minted a real handle');
    assert.notEqual(ref.statusHandle, ref.intentId);

    // ── 3. a read of that write, still through the mesh ──────────────────
    const status = await mesh$.query({ kind: 'INTENT_STATUS', handle: ref.statusHandle }, path);
    assert.equal(status.kind, 'INTENT_STATUS');
    if (status.kind !== 'INTENT_STATUS') return;
    assert.equal(status.value.state, 'WAITING_FOR_PRIVACY', 'queued, waiting for cover');
    assert.equal(typeof status.value.updatedAt, 'bigint');
  } finally {
    await Promise.all(relays.map((r) => r.close()));
    await exit.close();
  }
});

test('the exit refuses a query kind it does not answer, rather than proxying it', async () => {
  const exit = createExecutorServer({ graph: fixtureGraph });
  const server = await exit.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const body = `0x${Buffer.from(JSON.stringify({ kind: 'WALLET_RPC', operation: 'eth_sendRawTransaction', encodedRequest: '0x00' })).toString('hex')}`;
    const r = await fetch(`http://127.0.0.1:${port}/v1/mesh/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'QUERY', body }),
    });
    assert.equal(r.status, 400, 'not a general RPC proxy');
  } finally {
    await exit.close();
  }
});

test('an exit with no graph says so instead of dropping every read', async () => {
  const exit = createExecutorServer();
  const server = await exit.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const body = `0x${Buffer.from(JSON.stringify({ kind: 'RELAY_SNAPSHOT' })).toString('hex')}`;
    const r = await fetch(`http://127.0.0.1:${port}/v1/mesh/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'QUERY', body }),
    });
    assert.equal(r.status, 503);
  } finally {
    await exit.close();
  }
});

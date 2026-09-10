import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { ProtocolFailure, type MeshQuery, type PrivacyScore, type RelayNode, type RelayPath, type UnixSeconds } from '@opaque/protocol-types';

import { fromHex } from '@opaque/protocol-types/codecs.js';

import { createMeshTransport } from '../client.ts';
import { encodeAnswer } from '../queries.ts';
import { buildLocalMesh, serveLocalMesh } from '../local-mesh.ts';
import type { MeshMessageKind } from '../transport.ts';

const score = (n: number) => n as unknown as PrivacyScore;

/** A RelayNode carries everything the client needs; no directory lookup. */
const nodeFor = (entry: { id: any; endpoint: string; kemPublicKey: any; keyEpoch: bigint; operatorId: string }): RelayNode => ({
  ...entry,
  reliabilityScore: score(10_000),
  batchOccupancy: 0,
  recentSelectionCount: 0,
  lastSeenAt: 0n as UnixSeconds,
});

/**
 * A real mesh with a real egress behind it, so the assertions below are about
 * a round trip and not about a mock agreeing with itself.
 */
async function liveMesh(basePort: number, answer: (request: MeshQuery) => unknown) {
  const seen: MeshQuery[] = [];
  const egress = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { body } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { body: any };
      // Deliberately LOOSE: this stub hands back malformed answers on purpose
      // so the client's handling of them is what gets tested. It only decodes
      // the request to record what reached it. The production exit, in
      // queries.ts, is strict about both directions.
      const request = JSON.parse(new TextDecoder().decode(fromHex(body))) as MeshQuery;
      seen.push(request);
      res.writeHead(200);
      // encodeAnswer, not JSON.stringify: a real answer carries bigints.
      res.end(Buffer.from(encodeAnswer(answer(request) as any)));
    });
  });
  await new Promise<void>((r) => egress.listen(0, r));
  const url = `http://127.0.0.1:${(egress.address() as AddressInfo).port}/`;

  const mesh = buildLocalMesh(basePort);
  const relays = await serveLocalMesh(
    mesh,
    new Map<MeshMessageKind, string>([['QUERY', url], ['PAYMENT', url]]),
  );
  const path = mesh.signed.directory.entries.map(nodeFor) as unknown as RelayPath;
  return {
    path,
    seen,
    close: async () => {
      await Promise.all(relays.map((r) => r.close()));
      await new Promise<void>((r) => egress.close(() => r()));
    },
  };
}

test('a query goes out through three relays and the answer comes back', async () => {
  const scope = { chainId: 5042002n, pool: '0x' + '11'.repeat(20), denomination: 1_000_000 };
  // A COMPLETE answer. This used to be {privacyScore, formulaVersion} alone —
  // not a PrivacyConditions at all — and the client, which cast rather than
  // decoded, accepted it. Anything the wallet then read off it was undefined.
  const conditions = {
    kind: 'PRIVACY_CONDITIONS',
    value: {
      scope, privacyScore: 8_500, ringFreshnessScore: 7_000, meshHealthScore: 9_000,
      observedAt: 1_760_000_000n, formulaVersion: 'v1', source: 'FIXTURE',
    },
  };
  const mesh = await liveMesh(19101, () => conditions);
  try {
    const transport = createMeshTransport({ pollIntervalMs: 50 });
    const result = await transport.query({ kind: 'PRIVACY_CONDITIONS', scope } as any, mesh.path);

    // Equal to the NATIVE form — bigints and all — after a trip across the
    // wire as decimal strings. Revival is part of what this now proves.
    assert.deepEqual(result, conditions);
    assert.equal(typeof (result as any).value.observedAt, 'bigint');
    // The egress saw the query. It did NOT see a browser: the request reached
    // it from hop 3, which is the entire point of the exercise.
    assert.equal(mesh.seen.length, 1);
    assert.equal(mesh.seen[0]!.kind, 'PRIVACY_CONDITIONS');

    // A PoolScope carries a bigint chainId and JSON.stringify throws on one
    // outright, so this silently broke every scoped query until it was tested.
    // Decimal strings are encodeBigint's format, which asChainId already
    // accepts on the far side.
    assert.equal((mesh.seen[0] as any).scope.chainId, '5042002');
    assert.equal(typeof (mesh.seen[0] as any).scope.chainId, 'string');
  } finally {
    await mesh.close();
  }
});

test('two queries share no drop and no key, so a relay cannot join them', async () => {
  const mesh = await liveMesh(19111, (request) => ({
    kind: request.kind,
    value: { nodes: [], directoryVersion: 'v1', observedAt: 1_760_000_000n },
  }));
  try {
    const transport = createMeshTransport({ pollIntervalMs: 50 });
    const query = { kind: 'RELAY_SNAPSHOT' } as MeshQuery;
    await transport.query(query, mesh.path);
    await transport.query(query, mesh.path);
    assert.equal(mesh.seen.length, 2);
    // Same question, twice, and nothing on the wire ties the two together —
    // a fresh one-time key and a fresh drop id per call.
  } finally {
    await mesh.close();
  }
});

test('an answer of the wrong kind is refused rather than read as the right one', async () => {
  // A relay that returns a RELAY_SNAPSHOT where PRIVACY_CONDITIONS was asked
  // for must not be read as whatever the caller hoped for.
  const mesh = await liveMesh(19121, () => ({ kind: 'RELAY_SNAPSHOT', value: {} }));
  try {
    const transport = createMeshTransport({ pollIntervalMs: 50 });
    await assert.rejects(
      transport.query({ kind: 'PRIVACY_CONDITIONS', scope: {} } as any, mesh.path),
      (error: unknown) => error instanceof ProtocolFailure && error.code === 'INVALID_INPUT',
    );
  } finally {
    await mesh.close();
  }
});

test('an unreadable answer fails loudly instead of becoming undefined', async () => {
  const mesh = await liveMesh(19131, () => 'not json at all');
  try {
    const transport = createMeshTransport({ pollIntervalMs: 50 });
    await assert.rejects(transport.query({ kind: 'RELAY_SNAPSHOT' }, mesh.path));
  } finally {
    await mesh.close();
  }
});

test('a submitted intent returns the ref the executor issued', async () => {
  const mesh = await liveMesh(19141, () => ({
    intentId: 'intent-1',
    statusHandle: 'handle-1',
  }));
  try {
    const transport = createMeshTransport({ pollIntervalMs: 50 });
    // A realistic intent: submitIntent reads encryptedPayload's size to
    // decide between one message and a chunked upload.
    const ref = await transport.submitIntent({ spendHash: '0xaa', encryptedPayload: '0x00' } as any, mesh.path);
    assert.deepEqual(ref, { intentId: 'intent-1', statusHandle: 'handle-1' });
  } finally {
    await mesh.close();
  }
});

test('an executor answer with no usable ref is refused, not returned half-built', async () => {
  const mesh = await liveMesh(19151, () => ({ ok: true }));
  try {
    const transport = createMeshTransport({ pollIntervalMs: 50 });
    await assert.rejects(
      transport.submitIntent({ encryptedPayload: '0x00' } as any, mesh.path),
      (error: unknown) => error instanceof ProtocolFailure && error.code === 'MESH_UNAVAILABLE',
    );
  } finally {
    await mesh.close();
  }
});

test('the drop is collected only from the relay the directory named', () => {
  const transport = createMeshTransport();
  const path = [
    nodeFor({ id: 'R1', endpoint: 'https://r1.invalid/v1/relay', kemPublicKey: '0x00', keyEpoch: 1n, operatorId: 'a' }),
    nodeFor({ id: 'R2', endpoint: 'https://r2.invalid/v1/relay', kemPublicKey: '0x00', keyEpoch: 1n, operatorId: 'b' }),
    // An endpoint that is not a /v1/relay URL: there is no second field to
    // point a collection somewhere else, and a malformed one is refused.
    nodeFor({ id: 'R3', endpoint: 'https://evil.invalid/collect', kemPublicKey: '0x00', keyEpoch: 1n, operatorId: 'c' }),
  ] as unknown as RelayPath;
  assert.rejects(transport.query({ kind: 'RELAY_SNAPSHOT' }, path));
});

test('a timeout is retryable, not a silent empty answer', async () => {
  // An egress that never answers: the drop stays empty and the client must
  // say so rather than resolving with nothing.
  const mesh = await liveMesh(19161, () => {
    throw new Error('egress is down');
  });
  try {
    const transport = createMeshTransport({ pollIntervalMs: 20, pollTimeoutMs: 400 });
    await assert.rejects(
      transport.query({ kind: 'RELAY_SNAPSHOT' }, mesh.path),
      (error: unknown) =>
        error instanceof ProtocolFailure && error.code === 'MESH_UNAVAILABLE' && error.retryable,
    );
  } finally {
    await mesh.close();
  }
});

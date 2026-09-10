import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type {
  ApprovedRelease,
  CredentialHandle,
  GraphSelectionClient,
  IdempotencyKey,
  NoteId,
  PoolScope,
  PrivacyScore,
  RelayPath,
  TxHash,
  UnixSeconds,
} from '@opaque/protocol-types';
import { asAddress, asChainId, fromHex, spendHash } from '@opaque/protocol-types/codecs.js';
import { utf8 } from '@opaque/pq-wallet';

import { issueCredential } from '../../cre/credential.ts';
import { createExecutorServer } from '../../cre/executor-server.ts';
import { createIntentSealer, generateIntentKeypair } from '../../cre/seal-client.ts';
import { createCreSimulator } from '../../cre/simulator.ts';
import { buildRingSpend, deriveCommitment } from '../../zk/spend.ts';
import { CHUNK_DATA_BYTES } from '../chunks.ts';
import { createMeshTransport } from '../client.ts';
import { buildLocalMesh, serveLocalMesh } from '../local-mesh.ts';
import type { MeshMessageKind } from '../transport.ts';

// THE WHOLE RING PATH, for real. Nothing here is a stub except the chain:
//
//   a 219-rep ZKBoo proof (1,101 KiB)
//   → sealed to the CRE's ML-KEM key (~1.1 MiB)
//   → chunked into ~35 onions, each on a FRESH path through six real relays
//   → reassembled at the exit and checked against the committed hash
//   → opened, credential-checked, verified at full strength, FORS-attested
//   → released, and reconciled to SETTLED
//   → and that status read back THROUGH THE MESH
//
// Before chunking, step three was impossible: the mesh carries 64 KiB.

const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const scope: PoolScope = {
  chainId: asChainId(5042002n),
  pool: asAddress('0x8b54cc1b008eafa270740d847e45954f10dbf150'),
  denomination: 1_000_000,
};
const RECIPIENT = asAddress('0x000000000000000000000000000000000000b0b0');
const credentialMac = utf8('ring-over-mesh-mac');
const intentKeys = generateIntentKeypair(new Uint8Array(64).fill(9));
const KEY_ID = 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';

const noGraph: GraphSelectionClient = {
  getRingSnapshot: async () => { throw new Error('unused'); },
  getRelaySnapshot: async () => ({ nodes: [], directoryVersion: 'unused', observedAt: nowS() }),
  getPrivacyConditions: async () => { throw new Error('unused'); },
};

test('a real ring payment crosses the mesh in chunks and settles', { timeout: 180_000 }, async () => {
  // ── the spend ──────────────────────────────────────────────────────────
  const secrets = Array.from({ length: 8 }, (_, i) => new Uint8Array(16).fill(i + 41));
  const commitments = secrets.map((s) => deriveCommitment(s, scope));
  const spend = buildRingSpend({
    scope, recipient: RECIPIENT, noteSecret: secrets[5]!,
    decoys: commitments.filter((_, i) => i !== 5),
  });

  const credential = issueCredential({ recipient: RECIPIENT, policyVersion: POLICY, expiresAt: (nowS() + 3600n) as UnixSeconds }, credentialMac);
  const seal = createIntentSealer({
    crePublicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID,
    resolveCredential: async () => JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
  });
  const deadline = (nowS() + 120n) as UnixSeconds;
  const intent = await seal({
    scope, spendHash: spendHash(spend), spend,
    request: {
      noteId: 'n' as NoteId, recipient: RECIPIENT, minPrivacyScore: 5_000 as PrivacyScore, deadline,
      credentialHandle: 'c' as CredentialHandle, idempotencyKey: 'ring-over-mesh' as IdempotencyKey,
    },
  });
  const sealedBytes = fromHex(intent.encryptedPayload).length;
  assert.ok(sealedBytes > 1_000_000, `a ring intent is ~1.1 MiB (${sealedBytes} bytes)`);
  const expectedChunks = Math.ceil(sealedBytes / CHUNK_DATA_BYTES);

  // ── the exit and six relays ────────────────────────────────────────────
  const exit = createExecutorServer({ graph: noGraph });
  const port = ((await exit.listen(0)).address() as AddressInfo).port;
  const mesh = buildLocalMesh(19_501);
  const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
    ['PAYMENT', `http://127.0.0.1:${port}/v1/mesh/payment`],
    ['QUERY', `http://127.0.0.1:${port}/v1/mesh/query`],
  ]));

  try {
    const nodes = mesh.signed.directory.entries.map((e) => ({
      id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch,
      operatorId: e.operatorId, reliabilityScore: 5_000 as PrivacyScore, batchOccupancy: 1,
      recentSelectionCount: 0, lastSeenAt: nowS(),
    }));
    // A FRESH path per message, drawn from all six — and counted, to prove
    // no single entry relay carried the whole upload.
    const entries = new Map<string, number>();
    const pathFor = async (): Promise<RelayPath> => {
      const shuffled = [...nodes].sort(() => Math.random() - 0.5).slice(0, 3);
      entries.set(shuffled[0]!.id as string, (entries.get(shuffled[0]!.id as string) ?? 0) + 1);
      return shuffled as unknown as RelayPath;
    };
    const transport = createMeshTransport({ pollIntervalMs: 100, pollTimeoutMs: 60_000, pathFor });

    // ── across the mesh, in chunks ───────────────────────────────────────
    const ref = await transport.submitIntent(intent, await pathFor());
    assert.match(ref.statusHandle, /^[0-9a-f]{64}$/, 'the exit reassembled it and the executor issued a handle');

    // Byte-exact reassembly: the executor holds precisely what was sealed.
    const stored = exit.executor.store.get(ref.intentId)!;
    assert.equal(stored.intent.encryptedPayload, intent.encryptedPayload, 'reassembled byte for byte');
    assert.ok(entries.size > 1, `the upload used ${entries.size} different entry relays, not one`);
    const busiest = Math.max(...entries.values());
    assert.ok(busiest < expectedChunks, `no entry saw every chunk (busiest saw ${busiest} of ${expectedChunks})`);

    // ── settle ───────────────────────────────────────────────────────────
    const delivered: ApprovedRelease[] = [];
    const simulator = createCreSimulator({
      executor: exit.executor, intentSecretKey: intentKeys.secretKey, encryptionKeyId: KEY_ID,
      credentialMac, policyVersion: POLICY, releaseTtlSeconds: 900n,
      now: () => deadline, // the deadline branch fires
      attester: {
        identity: {
          chainId: 5042002n, registry: asAddress('0x7fc11e0f5d224439b2d710bb1c141913f454ef17'),
          attester: asAddress('0x8d47981ac51628fa19bf8b32afdda09f2d72d257'), pool: scope.pool, denomination: 1_000_000,
        },
        forsSeed: new Uint8Array(32).fill(5), useCount: async () => 0n,
      },
      deliver: async (release) => { delivered.push(release); return `0x${'cd'.repeat(32)}` as TxHash; },
      evidence: async (txHash, release) => ({ txHash, spendHash: spendHash(release.spend), succeeded: true }),
      nullifierSpent: async () => true,
    });
    assert.equal(await simulator.tick(), 1);
    assert.equal(delivered.length, 1);
    assert.ok(fromHex(delivered[0]!.spend.proof).length < 40_000, 'the on-chain proof is the attestation, not 1.1 MiB');

    // ── and read it back through the mesh ────────────────────────────────
    const status = await transport.query({ kind: 'INTENT_STATUS', handle: ref.statusHandle }, await pathFor());
    assert.equal(status.kind, 'INTENT_STATUS');
    if (status.kind === 'INTENT_STATUS') {
      assert.equal(status.value.state, 'SETTLED');
      assert.equal(status.value.txHash, `0x${'cd'.repeat(32)}`);
    }
  } finally {
    await Promise.all(relays.map((r) => r.close()));
    await exit.close();
  }
});

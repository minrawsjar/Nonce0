import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type PathSelectionPolicy,
  type PrivacyScore,
  type RelayNode,
  type RelayPath,
  type RelaySnapshot,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { createMeshBootstrap } from '../bootstrap.ts';
import { MIN_POOL_RELAYS } from '../contracts.ts';
import { deterministicDirectory, deterministicSigner, signDirectory, signerCommitment } from '../directory.ts';
import { createGraphHealth, DEFAULT_RELIABILITY_FLOOR, MAX_OCCUPANCY } from '../graph-health.ts';

const signer = deterministicSigner('graph-health-root');
const { directory } = deterministicDirectory('graph-health');
const signed = signDirectory(directory, signer);
const root = { signerCommitment: signerCommitment(signer.publicKey), minVersion: 0n };
const NOW = (directory.issuedAt + 3600n) as UnixSeconds;

const node = (id: string, over: Partial<RelayNode> = {}): RelayNode =>
  ({
    id, endpoint: 'https://ignored.invalid/v1/relay', kemPublicKey: `0x${'99'.repeat(1184)}`,
    keyEpoch: 999n, operatorId: 'graph-says-so', reliabilityScore: 9_000 as PrivacyScore,
    batchOccupancy: 2, recentSelectionCount: 0, lastSeenAt: NOW, ...over,
  }) as RelayNode;

const snapshotOf = (nodes: readonly RelayNode[], observedAt: UnixSeconds = NOW): RelaySnapshot =>
  ({ nodes, directoryVersion: 'graph-v1', observedAt });

const entryFor = (id: string) => directory.entries.find((e) => e.id === (id as never))!;

const healthFor = async (nodes: readonly RelayNode[], observedAt: UnixSeconds = NOW) => {
  const feed = createGraphHealth({ fetchSnapshot: async () => snapshotOf(nodes, observedAt), now: () => NOW });
  await feed.refresh();
  return feed;
};

// ── what the Graph may never do ───────────────────────────────────────────

test('the Graph cannot introduce a relay, whatever it returns', async () => {
  // It reports a relay that is not in the signed directory at all, with a key
  // it controls. The mesh must never carry a message to it.
  const feed = await healthFor([node('R1'), node('EVIL-RELAY', { batchOccupancy: 4 })]);
  const boot = createMeshBootstrap({ root, signed, pathPolicy: firstThree, now: () => NOW, health: feed.health });

  const ids = boot.snapshot().nodes.map((n) => n.id as string);
  assert.equal(ids.length, MIN_POOL_RELAYS, 'the pool is the directory, not the Graph');
  assert.equal(ids.includes('EVIL-RELAY'), false, 'a relay the directory never signed');
});

test('the Graph cannot supply a key, an endpoint or an operator', async () => {
  const feed = await healthFor([node('R1')]);
  const boot = createMeshBootstrap({ root, signed, pathPolicy: firstThree, now: () => NOW, health: feed.health });
  const r1 = boot.snapshot().nodes.find((n) => (n.id as string) === 'R1')!;
  const signedEntry = entryFor('R1');

  // The Graph claimed key epoch 999 and a key of its own. Both ignored.
  assert.equal(r1.kemPublicKey, signedEntry.kemPublicKey, 'keys come from the pinned directory');
  assert.equal(r1.keyEpoch, signedEntry.keyEpoch);
  assert.equal(r1.endpoint, signedEntry.endpoint);
  assert.equal(r1.operatorId, signedEntry.operatorId, 'operator drives the no-collusion rule');
});

test('the Graph cannot exclude a relay by calling it unreliable', async () => {
  // Zero reliability is the Graph trying to push R1 under the policy floor,
  // which would drop it from every row of the §8.2 chain.
  const feed = await healthFor([node('R1', { reliabilityScore: 0 as PrivacyScore })]);
  assert.equal(feed.health(entryFor('R1')).reliabilityScore, DEFAULT_RELIABILITY_FLOOR, 'clamped up to the floor');
});

test('the Graph cannot exclude a relay by omitting it', async () => {
  const feed = await healthFor([node('R1', { batchOccupancy: 4 })]);
  // R2..R6 are simply absent from the answer. They keep the prior, not zero.
  assert.equal(feed.health(entryFor('R2')).batchOccupancy, 1, 'omission is not removal');
  assert.notEqual(feed.health(entryFor('R2')).batchOccupancy, 0, 'zero weight would drop it from selection');
});

test('the Graph cannot corner a path by inflating one relay', async () => {
  const feed = await healthFor([
    node('R1', { batchOccupancy: 1_000_000 }),
    node('R2', { batchOccupancy: 0 }),
  ]);
  const best = feed.health(entryFor('R1'));
  const worst = feed.health(entryFor('R2'));
  assert.equal(best.batchOccupancy, MAX_OCCUPANCY, 'preference is capped');
  assert.equal(worst.batchOccupancy, 1, 'and nobody can be starved to zero');
  // §8.2 weights on occupancy / (1 + recent), so this ratio bounds how much
  // more likely the Graph can make its favourite.
  const ratio = best.batchOccupancy / (1 + best.recentSelectionCount) /
    (worst.batchOccupancy / (1 + worst.recentSelectionCount));
  assert.ok(ratio <= MAX_OCCUPANCY, `ratio ${ratio} must stay bounded`);
});

// ── what it may do, and when it is ignored ────────────────────────────────

test('a fresh observation does re-weight a relay', async () => {
  const feed = await healthFor([node('R1', { batchOccupancy: 3, recentSelectionCount: 2 })]);
  const h = feed.health(entryFor('R1'));
  assert.equal(h.batchOccupancy, 3);
  assert.equal(h.recentSelectionCount, 2);
  assert.equal(h.reliabilityScore, 9_000);
});

test('a stale observation is treated as absent, not as truth', async () => {
  // A Graph frozen at one moment would otherwise pin selection to that moment
  // forever, which is a standing circuit arrived at slowly.
  const stale = (NOW - 1_000n) as UnixSeconds;
  const feed = await healthFor([node('R1', { batchOccupancy: 4 })], stale);
  assert.equal(feed.health(entryFor('R1')).batchOccupancy, 1, 'back to the uniform prior');
});

test('a Graph that is down leaves the pool intact', async () => {
  const feed = createGraphHealth({
    fetchSnapshot: async () => {
      throw new ProtocolFailure('GRAPH_UNAVAILABLE', 'down', true);
    },
    now: () => NOW,
  });
  assert.equal(await feed.refresh(), false, 'reports the failure rather than throwing');

  const boot = createMeshBootstrap({ root, signed, pathPolicy: firstThree, now: () => NOW, health: feed.health });
  assert.equal(boot.snapshot().nodes.length, MIN_POOL_RELAYS, 'still a full pool');
  // And a weight-based policy can still draw from it.
  for (const n of boot.snapshot().nodes) assert.ok(n.batchOccupancy > 0);
});

const firstThree: PathSelectionPolicy = {
  selectPath: (snapshot: RelaySnapshot) => ({
    nodes: snapshot.nodes.slice(0, 3) as unknown as RelayPath,
    probabilities: [1, 1, 1],
  }),
};

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type PathSelectionPolicy,
  type PrivacyScore,
  type RelayPath,
  type RelaySnapshot,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { createMeshBootstrap } from '../bootstrap.ts';
import { MIN_POOL_RELAYS } from '../contracts.ts';
import { deterministicDirectory, deterministicSigner, signDirectory, signerCommitment } from '../directory.ts';

const signer = deterministicSigner('bootstrap-root');
const { directory } = deterministicDirectory('bootstrap');
const signed = signDirectory(directory, signer);
const root = { signerCommitment: signerCommitment(signer.publicKey), minVersion: 0n };
const NOW = (directory.issuedAt + 3600n) as UnixSeconds;

const failure = (code: string) => (error: unknown) =>
  error instanceof ProtocolFailure && error.code === code;

/** Takes the first three, in order. Enough to observe what bootstrap hands it. */
const firstThree: PathSelectionPolicy = {
  selectPath: (snapshot: RelaySnapshot) => ({
    nodes: snapshot.nodes.slice(0, 3) as unknown as RelayPath,
    probabilities: [1, 1, 1],
  }),
};

const boot = (policy: PathSelectionPolicy = firstThree, now = () => NOW) =>
  createMeshBootstrap({ root, signed, pathPolicy: policy, now });

// ── verify before anything else ───────────────────────────────────────────

test('the directory is verified against the pinned root before a mesh exists', () => {
  const wrongSigner = deterministicSigner('somebody-else');
  assert.throws(
    () =>
      createMeshBootstrap({
        root: { signerCommitment: signerCommitment(wrongSigner.publicKey), minVersion: 0n },
        signed,
        pathPolicy: firstThree,
        now: () => NOW,
      }),
    failure('UNTRUSTED_DIRECTORY'),
  );
});

test('bootstrap walks the hash chain, so this version cannot be replayed', () => {
  const mesh = boot();
  assert.equal(mesh.nextRoot.minVersion, directory.version);
  assert.equal(mesh.nextRoot.signerCommitment, directory.nextSignerCommitment);
  assert.throws(
    () => createMeshBootstrap({ root: mesh.nextRoot, signed, pathPolicy: firstThree, now: () => NOW }),
    failure('UNTRUSTED_DIRECTORY'),
  );
});

// ── the snapshot handed to the policy ─────────────────────────────────────

test('the snapshot carries the verified keys, and the directory version', () => {
  const snapshot = boot().snapshot();
  assert.equal(snapshot.nodes.length, MIN_POOL_RELAYS, 'the policy sees the whole live pool');
  assert.equal(snapshot.directoryVersion, '1');
  for (const node of snapshot.nodes) {
    const entry = directory.entries.find((e) => e.id === node.id)!;
    assert.equal(node.kemPublicKey, entry.kemPublicKey);
    assert.equal(node.operatorId, entry.operatorId);
  }
});

// One relay rotates out early while the DIRECTORY is still perfectly valid.
// Using a time past the directory's own expiry would prove nothing here: that
// is refused at verification, before a policy is ever consulted.
const shortLived = {
  ...directory,
  entries: [
    { ...directory.entries[0]!, validUntil: (directory.issuedAt + 3600n) as UnixSeconds },
    ...directory.entries.slice(1),
  ],
};
const afterRotation = (directory.issuedAt + 7200n) as UnixSeconds;
const bootShortLived = (now = () => afterRotation) =>
  createMeshBootstrap({
    root,
    signed: signDirectory(shortLived, signer),
    pathPolicy: firstThree,
    now,
  });

test('an entry that has rotated out never reaches the policy', () => {
  // Live at the start, gone later, with the same directory throughout.
  const beforeRotation = (directory.issuedAt + 1800n) as UnixSeconds;
  assert.equal(bootShortLived(() => beforeRotation).snapshot().nodes.length, MIN_POOL_RELAYS);
  assert.equal(bootShortLived().snapshot().nodes.length, MIN_POOL_RELAYS - 1);
});

test('a pool below the floor refuses, even though five relays could still make three hops', async () => {
  // The distinction this pins: refusing is NOT about being unable to build a
  // path. Five live relays build one fine. It is about refusing to draw from a
  // pool the deployment never promised — silently narrowing the set a payment
  // could have come from, while still returning a path that looks healthy, is
  // the failure mode. One operator restarting stops payments; that is the cost
  // of the floor and it is deliberate, not an oversight.
  assert.equal(bootShortLived().snapshot().nodes.length, 5, 'five is enough for a path');
  await assert.rejects(bootShortLived().pathFor(), failure('INSUFFICIENT_RELAYS'));
});

test('a thin pool is refused before the policy is ever consulted', async () => {
  // Ordering, not just outcome. A policy asked to choose from five relays has
  // already been handed a narrowed set, and a policy that logs or scores what
  // it sees would record a selection the mesh then refuses to make.
  let asked = 0;
  const counting: PathSelectionPolicy = {
    selectPath: (snapshot) => {
      asked += 1;
      return firstThree.selectPath(snapshot);
    },
  };
  await assert.rejects(
    createMeshBootstrap({
      root,
      signed: signDirectory(shortLived, signer),
      pathPolicy: counting,
      now: () => afterRotation,
    }).pathFor(),
    failure('INSUFFICIENT_RELAYS'),
  );
  assert.equal(asked, 0, 'the policy must not see a pool the mesh will not draw from');
});

// ── what the snapshot has to be USABLE for ────────────────────────────────

test('every node arrives with capacity a weight-based policy can actually draw on', async () => {
  // §8.2 weights on batchOccupancy / (1 + recentSelectionCount) and drops
  // anything at weight zero. This mirrors that filter without importing across
  // the package boundary.
  //
  // Regression: toNode used to report batchOccupancy 0 for every relay as a
  // deliberately-flat non-measurement. Flat is right; zero is not — it means
  // "no capacity", so the real policy discarded all six live relays and failed
  // with `have 0 operators`. The mesh and the policy were each correct alone
  // and could not build a single path together.
  const weighted: PathSelectionPolicy = {
    selectPath: (snapshot) => {
      const usable = snapshot.nodes.filter((n) => n.batchOccupancy / (1 + n.recentSelectionCount) > 0);
      assert.equal(usable.length, MIN_POOL_RELAYS, 'a weight-based policy must see the whole pool');
      return { nodes: usable.slice(0, 3) as unknown as RelayPath, probabilities: [1, 1, 1] };
    },
  };
  const path = await boot(weighted).pathFor();
  assert.equal(path.length, 3);
});

test('a health feed can re-weight a relay but never introduce one', async () => {
  // The feed is reached over the network. If it could add an entry it could
  // put its own relay on every path, encrypted to its own key — which is the
  // exact substitution the pinned directory exists to prevent.
  const seen: string[] = [];
  const boots = createMeshBootstrap({
    root,
    signed,
    pathPolicy: firstThree,
    now: () => NOW,
    health: (entry) => {
      seen.push(entry.id as string);
      return { reliabilityScore: 9_000 as PrivacyScore, batchOccupancy: 4, recentSelectionCount: 1 };
    },
  });
  const nodes = boots.snapshot().nodes;
  assert.equal(nodes.length, MIN_POOL_RELAYS, 'the feed cannot change the size of the pool');
  assert.equal(seen.length, MIN_POOL_RELAYS, 'and it is asked about every live relay');
  assert.equal(nodes[0]!.batchOccupancy, 4);
  assert.equal(nodes[0]!.recentSelectionCount, 1);
  // The keys still come from the verified directory, never from the feed.
  for (const node of nodes) {
    assert.equal(node.kemPublicKey, directory.entries.find((e) => e.id === node.id)!.kemPublicKey);
  }
});

// ── paths ─────────────────────────────────────────────────────────────────

test('a path is three distinct relays under three distinct operators', async () => {
  const path = await boot().pathFor();
  assert.equal(path.length, 3);
  assert.equal(new Set(path.map((n) => n.id)).size, 3);
  assert.equal(new Set(path.map((n) => n.operatorId)).size, 3);
});

test('a policy that repeats an operator is refused, not trusted', async () => {
  // Three hops run by one company are one hop wearing three hats, and the
  // policy is exactly the place a bug like that would go unnoticed.
  const oneOperator: PathSelectionPolicy = {
    selectPath: (snapshot) => ({
      nodes: snapshot.nodes.map((n) => ({ ...n, operatorId: 'one-company' })) as unknown as RelayPath,
      probabilities: [1, 1, 1],
    }),
  };
  await assert.rejects(boot(oneOperator).pathFor(), failure('INSUFFICIENT_RELAYS'));
});

test('a policy that repeats a relay is refused', async () => {
  const repeats: PathSelectionPolicy = {
    selectPath: (snapshot) => ({
      nodes: [snapshot.nodes[0]!, snapshot.nodes[0]!, snapshot.nodes[1]!] as unknown as RelayPath,
      probabilities: [1, 1, 1],
    }),
  };
  await assert.rejects(boot(repeats).pathFor(), failure('INSUFFICIENT_RELAYS'));
});

test('a fresh path is drawn per call, never cached', async () => {
  let calls = 0;
  const counting: PathSelectionPolicy = {
    selectPath: (snapshot) => {
      calls++;
      return { nodes: snapshot.nodes.slice(0, 3) as unknown as RelayPath, probabilities: [1, 1, 1] };
    },
  };
  const mesh = boot(counting);
  await mesh.pathFor();
  await mesh.pathFor();
  // A cached path is a standing circuit one relay can watch for a whole session.
  assert.equal(calls, 2);
});

test('bootstrap yields a transport the application can actually hold', () => {
  const { transport } = boot();
  for (const method of ['query', 'submitIntent', 'subscribe'] as const) {
    assert.equal(typeof transport[method], 'function', `transport.${method}`);
  }
});

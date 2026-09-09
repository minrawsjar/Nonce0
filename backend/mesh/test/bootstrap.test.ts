import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type PathSelectionPolicy,
  type RelayPath,
  type RelaySnapshot,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { createMeshBootstrap } from '../bootstrap.ts';
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
  assert.equal(snapshot.nodes.length, 3);
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
  assert.equal(bootShortLived(() => beforeRotation).snapshot().nodes.length, 3);
  assert.equal(bootShortLived().snapshot().nodes.length, 2);
});

test('a directory that cannot supply three live relays refuses rather than short-pathing', async () => {
  // Two hops that still look like a success is the failure mode worth
  // preventing: the caller would believe it had three.
  await assert.rejects(bootShortLived().pathFor(), failure('INSUFFICIENT_RELAYS'));
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

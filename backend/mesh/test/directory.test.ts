// §7 directory verification: the bootstrap trust anchor.
//
// What is actually being tested here is the set of ways a client can be handed
// a directory it should not believe — a rollback to a retired key, a version
// chained from the wrong predecessor, a padded entry that can never route, a
// path whose three "independent" hops share an operator — plus the one case
// that has to keep working: a client that has only ever pinned version N
// authenticating version N+1 with no network and no authority.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProtocolFailure, type Hex, type RelayId, type UnixSeconds } from '@opaque/protocol-types';

import {
  accept,
  canonicalBytes,
  deterministicDirectory,
  deterministicSigner,
  directoryModule,
  signDirectory,
  signerCommitment,
  toPath,
  verify,
  type ForsKeypair,
} from '../directory.ts';
import type { DirectoryEntry, DirectoryTrustRoot, RelayDirectory, SignedDirectory } from '../contracts.ts';
import { MemoryReplayCache, buildOnion, peelLayer, type FinalPayload } from '../transport.ts';

// FORS keyGen is ~24.5k keccaks. The seeds are fixed, so the keys are too —
// deriving each one once keeps the suite honest and fast.
const signers = new Map<string, ForsKeypair>();
function signer(label: string): ForsKeypair {
  const cached = signers.get(label);
  if (cached !== undefined) return cached;
  const fresh = deterministicSigner(label);
  signers.set(label, fresh);
  return fresh;
}

const SEED = 'directory-test';
const { directory: V1, relays } = deterministicDirectory(SEED);
const NOW = (V1.issuedAt + 60n) as UnixSeconds;

/** The key the fixture directory pins as its successor. */
const SUCCESSOR = signer(`${SEED}/next`);
const V1_SIGNER = signer('v1');
const ROOT: DirectoryTrustRoot = { signerCommitment: signerCommitment(V1_SIGNER.publicKey), minVersion: 0n };

const sign = (directory: RelayDirectory, keypair: ForsKeypair = V1_SIGNER): SignedDirectory =>
  signDirectory(directory, keypair);

const withEntry = (directory: RelayDirectory, index: number, patch: Partial<DirectoryEntry>): RelayDirectory => ({
  ...directory,
  entries: directory.entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ProtocolFailure).code ?? 'THREW';
  }
  return 'NO_THROW';
};

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ProtocolFailure).publicMessage ?? String(error);
  }
  return '';
};

const ids = (): readonly [RelayId, RelayId, RelayId] => [relays[0]!.id, relays[1]!.id, relays[2]!.id];

// ── canonical encoding ────────────────────────────────────────────────────

test('one directory has exactly one encoding, whatever order the entries arrive in', () => {
  const shuffled: RelayDirectory = { ...V1, entries: [...V1.entries].reverse() };
  assert.deepEqual(canonicalBytes(shuffled), canonicalBytes(V1));

  // ...and it is not order-blind: a changed field is a changed encoding.
  const moved = withEntry(V1, 1, { endpoint: 'https://elsewhere.invalid/v1/relay' });
  assert.notDeepEqual(canonicalBytes(moved), canonicalBytes(V1));
});

test('a field cannot be slid across a boundary into its neighbour', () => {
  // The classic separator attack: with `id + ":" + operatorId`, ("R1","OPA")
  // and ("R1O","PA") hash the same and an attacker picks the split that suits
  // them. Length prefixes are what make these two different directories.
  const left = withEntry(V1, 0, { id: 'R1' as RelayId, operatorId: 'OPA' });
  const right = withEntry(V1, 0, { id: 'R1O' as RelayId, operatorId: 'PA' });
  assert.notDeepEqual(canonicalBytes(left), canonicalBytes(right));
});

test('the encoding covers the version, the window and the successor commitment', () => {
  const base = canonicalBytes(V1);
  assert.notDeepEqual(canonicalBytes({ ...V1, version: 2n }), base);
  assert.notDeepEqual(canonicalBytes({ ...V1, expiresAt: (V1.expiresAt + 1n) as UnixSeconds }), base);
  assert.notDeepEqual(
    canonicalBytes({ ...V1, nextSignerCommitment: signerCommitment(signer('other').publicKey) }),
    base,
  );
});

// ── verification ──────────────────────────────────────────────────────────

test('a freshly signed directory verifies against its pinned root', () => {
  assert.deepEqual(verify(sign(V1), ROOT, NOW), V1);
  // ...and through the module object, which is the shape the contract names.
  assert.deepEqual(directoryModule.verify(sign(V1), ROOT, NOW), V1);
});

test('editing a signed directory invalidates it', () => {
  const signed = sign(V1);
  const swapped: SignedDirectory = {
    directory: withEntry(V1, 0, { endpoint: 'https://attacker.invalid/v1/relay' }),
    signature: signed.signature,
  };
  assert.equal(code(() => verify(swapped, ROOT, NOW)), 'UNTRUSTED_DIRECTORY');

  // Substituting the KEM key is the attack the whole file exists to stop.
  const keySwap: SignedDirectory = {
    directory: withEntry(V1, 1, { kemPublicKey: V1.entries[2]!.kemPublicKey }),
    signature: signed.signature,
  };
  assert.equal(code(() => verify(keySwap, ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('a tampered signature is refused, whichever part of it is touched', () => {
  const signed = sign(V1);
  const flip = (at: number): Hex => {
    const chars = [...signed.signature];
    chars[at] = chars[at] === '0' ? '1' : '0';
    return chars.join('') as Hex;
  };

  // Byte 3 is inside the embedded public key; a late offset is inside a
  // revealed leaf or an authentication path.
  assert.equal(code(() => verify({ ...signed, signature: flip(10) }, ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
  assert.equal(code(() => verify({ ...signed, signature: flip(2_000) }, ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
  // Truncation must not read as a short-but-valid signature.
  assert.equal(
    code(() => verify({ ...signed, signature: signed.signature.slice(0, 500) as Hex }, ROOT, NOW)),
    'UNTRUSTED_DIRECTORY',
  );
});

test('a directory signed by a real key that is not the pinned one is refused', () => {
  // The signature verifies perfectly. It is simply not the signer this client
  // pinned, which is the only thing the client actually trusts.
  const impostor = signer('impostor');
  const signed = sign(V1, impostor);
  assert.equal(verify(signed, { ...ROOT, signerCommitment: signerCommitment(impostor.publicKey) }, NOW), V1);
  assert.equal(code(() => verify(signed, ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('a correctly signed older version is a rollback attack, not a stale cache', () => {
  const pinned: DirectoryTrustRoot = { ...ROOT, minVersion: 5n };
  const at = (version: bigint) => code(() => verify(sign({ ...V1, version }), pinned, NOW));

  assert.equal(at(4n), 'UNTRUSTED_DIRECTORY', 'older');
  assert.equal(at(5n), 'UNTRUSTED_DIRECTORY', 'equal — replaying the pinned version is still a replay');
  assert.equal(at(6n), 'NO_THROW');
});

test('a directory outside its own window is refused at both ends', () => {
  const signed = sign(V1);
  assert.equal(code(() => verify(signed, ROOT, (V1.issuedAt - 1n) as UnixSeconds)), 'UNTRUSTED_DIRECTORY');
  assert.equal(code(() => verify(signed, ROOT, V1.issuedAt)), 'NO_THROW');
  assert.equal(code(() => verify(signed, ROOT, (V1.expiresAt - 1n) as UnixSeconds)), 'NO_THROW');
  assert.equal(code(() => verify(signed, ROOT, V1.expiresAt)), 'UNTRUSTED_DIRECTORY', 'expiry is exclusive');
});

test('an entry with an insane validity window is refused', () => {
  const inverted = withEntry(V1, 1, { validFrom: V1.entries[1]!.validUntil, validUntil: V1.entries[1]!.validFrom });
  assert.equal(code(() => verify(sign(inverted), ROOT, NOW)), 'UNTRUSTED_DIRECTORY', 'ends before it starts');

  const empty = withEntry(V1, 1, { validUntil: V1.entries[1]!.validFrom });
  assert.equal(code(() => verify(sign(empty), ROOT, NOW)), 'UNTRUSTED_DIRECTORY', 'zero-width window');
});

test('an entry that can never be selected is refused rather than padding the mesh', () => {
  // Dead before the directory was issued, and alive only after it expires.
  // Either inflates the apparent size of the mesh — which is exactly the
  // number an operator would point at to argue the anonymity set is large.
  const dead = withEntry(V1, 0, {
    validFrom: (V1.issuedAt - 200n) as UnixSeconds,
    validUntil: (V1.issuedAt - 100n) as UnixSeconds,
  });
  assert.equal(code(() => verify(sign(dead), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');

  const notYet = withEntry(V1, 0, {
    validFrom: (V1.expiresAt + 100n) as UnixSeconds,
    validUntil: (V1.expiresAt + 200n) as UnixSeconds,
  });
  assert.equal(code(() => verify(sign(notYet), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('a duplicated relay id is refused: which key is that relay holding?', () => {
  const duplicated: RelayDirectory = {
    ...V1,
    entries: [...V1.entries, { ...V1.entries[0]!, keyEpoch: 8n }],
  };
  assert.equal(code(() => verify(sign(duplicated), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('a directory that cannot supply three hops is refused', () => {
  const twoRelays: RelayDirectory = { ...V1, entries: [V1.entries[0]!, V1.entries[1]!] };
  assert.equal(code(() => verify(sign(twoRelays), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
  assert.equal(code(() => verify(sign({ ...V1, entries: [] }), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('a malformed relay key or id is refused before it reaches the transport', () => {
  const shortKey = withEntry(V1, 2, { kemPublicKey: '0xdeadbeef' as Hex });
  assert.equal(code(() => verify(sign(shortKey), ROOT, NOW)), 'UNTRUSTED_DIRECTORY', 'not an ML-KEM-768 key');

  // transport.ts frames the hop id into 32 bytes; a longer one would throw
  // inside onion construction, far from the directory that caused it.
  const longId = withEntry(V1, 2, { id: 'R'.repeat(33) as RelayId });
  assert.equal(code(() => verify(sign(longId), ROOT, NOW)), 'UNTRUSTED_DIRECTORY', 'unframeable relay id');

  const noOperator = withEntry(V1, 0, { operatorId: '' });
  assert.equal(code(() => verify(sign(noOperator), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');

  const badEndpoint = withEntry(V1, 0, { endpoint: 'javascript:alert(1)' });
  assert.equal(code(() => verify(sign(badEndpoint), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('a directory that chains the next version to its own signer is refused', () => {
  // FORS+C is FEW-time: two signatures under one key reveal twice the leaves.
  // Committing to yourself as your own successor is how that happens by
  // accident, so it is refused mechanically rather than left to discipline.
  const selfChained = { ...V1, nextSignerCommitment: ROOT.signerCommitment };
  assert.equal(code(() => verify(sign(selfChained), ROOT, NOW)), 'UNTRUSTED_DIRECTORY');
});

test('no rejection message carries key material', () => {
  // The logging rule is absolute and includes error paths. A message that
  // echoed the key it rejected would put relay key material into any log that
  // renders a publicMessage.
  const failures = [
    message(() => verify(sign(V1, signer('impostor')), ROOT, NOW)),
    message(() => verify(sign({ ...V1, version: 0n }), ROOT, NOW)),
    message(() => verify(sign(withEntry(V1, 0, { kemPublicKey: '0xdeadbeef' as Hex })), ROOT, NOW)),
    message(() => verify(sign(V1), ROOT, V1.expiresAt)),
  ];

  for (const text of failures) {
    assert.ok(text.length > 0 && text.length < 200, `a rejection message must stay short: ${text}`);
    assert.ok(!/[0-9a-f]{40,}/i.test(text), `a rejection message must not carry a key or signature: ${text}`);
    for (const relay of relays) {
      assert.ok(!text.includes(relay.secretKey), 'a rejection message must never carry a secret key');
    }
  }
});

// ── the hash chain ────────────────────────────────────────────────────────

test('accept advances the pinned root along the hash chain', () => {
  const { directory, nextRoot } = accept(sign(V1), ROOT, NOW);
  assert.equal(directory, V1);
  assert.equal(nextRoot.signerCommitment, V1.nextSignerCommitment);
  assert.equal(nextRoot.minVersion, V1.version);
});

test('a client that pinned only version 1 authenticates version 2 offline', () => {
  const { nextRoot } = accept(sign(V1), ROOT, NOW);

  // Signed by the successor the previous version committed to — no network,
  // no authority, nothing but the hash the client already holds.
  const v2: RelayDirectory = {
    ...V1,
    version: 2n,
    nextSignerCommitment: signerCommitment(signer('v3').publicKey),
  };
  const accepted = accept(sign(v2, SUCCESSOR), nextRoot, NOW);
  assert.equal(accepted.directory.version, 2n);
  assert.equal(accepted.nextRoot.minVersion, 2n);
  assert.equal(accepted.nextRoot.signerCommitment, v2.nextSignerCommitment);
});

test('a directory signed by the right kind of key but the wrong predecessor is refused', () => {
  const { nextRoot } = accept(sign(V1), ROOT, NOW);

  // `rogue` is a perfectly good FORS key that legitimately signs some other
  // chain — the previous version simply never committed to it. Without the
  // chain check, anyone holding any signing key could publish version 2.
  const rogue = signer('rogue-but-real');
  const v2: RelayDirectory = {
    ...V1,
    version: 2n,
    nextSignerCommitment: signerCommitment(signer('v3').publicKey),
  };
  assert.equal(code(() => accept(sign(v2, rogue), nextRoot, NOW)), 'UNTRUSTED_DIRECTORY');
  // The original signer is equally wrong now: the chain moved past it.
  assert.equal(code(() => accept(sign(v2, V1_SIGNER), nextRoot, NOW)), 'UNTRUSTED_DIRECTORY');
  assert.equal(code(() => accept(sign(v2, SUCCESSOR), nextRoot, NOW)), 'NO_THROW');
});

test('replaying the version that was just accepted is refused', () => {
  const { nextRoot } = accept(sign(V1), ROOT, NOW);
  // Wrong signer AND a stale version; either alone must be enough.
  assert.equal(code(() => accept(sign(V1), nextRoot, NOW)), 'UNTRUSTED_DIRECTORY');
  assert.equal(code(() => accept(sign(V1, SUCCESSOR), nextRoot, NOW)), 'UNTRUSTED_DIRECTORY');
});

// ── path construction ─────────────────────────────────────────────────────

test('toPath returns the hops in the order requested', () => {
  const forwards = toPath(V1, ids(), NOW);
  assert.deepEqual(
    forwards.map((hop) => hop.id),
    [relays[0]!.id, relays[1]!.id, relays[2]!.id],
  );

  const backwards = directoryModule.toPath(V1, [relays[2]!.id, relays[1]!.id, relays[0]!.id], NOW);
  assert.deepEqual(
    backwards.map((hop) => hop.id),
    [relays[2]!.id, relays[1]!.id, relays[0]!.id],
  );

  assert.equal(forwards[0].kemPublicKey, V1.entries[0]!.kemPublicKey);
  assert.equal(forwards[0].keyEpoch, V1.entries[0]!.keyEpoch);
});

test('an unknown relay is refused rather than quietly substituted', () => {
  // Silently swapping in a live relay would hand path selection to whoever
  // wrote the directory, which is the choice the client is making itself.
  assert.equal(
    code(() => toPath(V1, [relays[0]!.id, 'GHOST' as RelayId, relays[2]!.id], NOW)),
    'INSUFFICIENT_RELAYS',
  );
});

test('an entry outside its validity window cannot be used', () => {
  const expired = withEntry(V1, 1, { validUntil: NOW });
  assert.equal(code(() => toPath(expired, ids(), NOW)), 'INSUFFICIENT_RELAYS', 'validUntil is exclusive');

  const notYet = withEntry(V1, 1, { validFrom: (NOW + 1n) as UnixSeconds });
  assert.equal(code(() => toPath(notYet, ids(), NOW)), 'INSUFFICIENT_RELAYS');

  const live = withEntry(V1, 1, { validFrom: NOW, validUntil: (NOW + 1n) as UnixSeconds });
  assert.equal(code(() => toPath(live, ids(), NOW)), 'NO_THROW', 'validFrom is inclusive');
});

test('a path that repeats a relay is refused', () => {
  assert.equal(
    code(() => toPath(V1, [relays[0]!.id, relays[1]!.id, relays[0]!.id], NOW)),
    'INSUFFICIENT_RELAYS',
  );
});

test('a path that repeats an OPERATOR is refused, even with three distinct relays', () => {
  // Three relays, one company: three hops that collude for free, and the
  // reason the whole construction exists is gone while the path still looks
  // perfectly well formed.
  const oneOperator = withEntry(V1, 2, { operatorId: V1.entries[0]!.operatorId });
  assert.equal(code(() => toPath(oneOperator, ids(), NOW)), 'INSUFFICIENT_RELAYS');
  assert.equal(code(() => toPath(V1, ids(), NOW)), 'NO_THROW', 'the same ids are fine under three operators');
});

test('a relay listed under two key epochs is refused rather than guessed at', () => {
  // Guessing wrong is not a local failure: the message travels the whole path
  // and is rejected at the hop, which tells that operator a client is stale.
  const ambiguous: RelayDirectory = {
    ...V1,
    entries: [...V1.entries, { ...V1.entries[1]!, keyEpoch: 8n }],
  };
  assert.equal(code(() => toPath(ambiguous, ids(), NOW)), 'INSUFFICIENT_RELAYS');
});

test('an unframeable key epoch is refused at path construction, not inside the onion', () => {
  const overflowed = withEntry(V1, 0, { keyEpoch: 1n << 64n });
  assert.equal(code(() => toPath(overflowed, ids(), NOW)), 'INSUFFICIENT_RELAYS');
  assert.equal(code(() => toPath(withEntry(V1, 0, { keyEpoch: 0n }), ids(), NOW)), 'INSUFFICIENT_RELAYS');
});

// ── end to end ────────────────────────────────────────────────────────────

test('a path built from the directory actually carries a payment three hops', () => {
  // The point of the fixture: the directory hands out public keys, the relays
  // hold the matching secrets, and the two agree. A directory that verified
  // but produced unusable hops would pass every test above.
  const path = toPath(V1, ids(), NOW);
  const payload: FinalPayload = { kind: 'PAYMENT', body: '0xdeadbeef' };
  let envelope = buildOnion({ path, payload, expiresAt: NOW + 300n });

  const seenIds: string[] = [];
  for (const relay of relays) {
    seenIds.push(envelope.hopLocalId);
    const result = peelLayer({
      envelope,
      hopId: relay.id,
      secretKey: relay.secretKey,
      keyEpoch: relay.keyEpoch,
      now: NOW,
      replayCache: new MemoryReplayCache(),
    });
    if (result.kind === 'FINAL') {
      assert.deepEqual(result.payload, payload);
      assert.equal(new Set(seenIds).size, 3, 'the three hops must share no identifier');
      return;
    }
    envelope = result.envelope;
  }
  assert.fail('the payment never reached the final hop');
});

// ── the fixture ───────────────────────────────────────────────────────────

test('deterministicDirectory is reproducible, and different seeds are different meshes', () => {
  assert.deepEqual(deterministicDirectory(SEED).directory, V1, 'a failure must reproduce, not be a coin flip');

  const other = deterministicDirectory('a-different-mesh');
  assert.notEqual(other.directory.entries[0]!.kemPublicKey, V1.entries[0]!.kemPublicKey);
  assert.notEqual(other.relays[0]!.secretKey, relays[0]!.secretKey);

  // And it is a directory the real verifier accepts, so tests built on it are
  // testing the code rather than a shape the code happens to tolerate.
  const root: DirectoryTrustRoot = { signerCommitment: signerCommitment(signer('v1').publicKey), minVersion: 0n };
  assert.equal(code(() => verify(sign(other.directory), root, other.directory.issuedAt)), 'NO_THROW');
});

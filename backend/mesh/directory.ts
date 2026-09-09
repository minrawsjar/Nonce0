// §7 — the relay directory: the mesh's bootstrap trust anchor.
//
// Everything else in §7 is downstream of this file. A client that can be fed a
// fake directory gets a mesh whose ML-KEM keys the attacker holds, and onion
// encryption, hop-local ids, padding classes and batching all become
// decoration over a wiretap. So the directory is authenticated against a root
// PINNED IN THE APPLICATION, never against a server that answers questions.
//
// Three decisions that carry the weight:
//
//   1. Hash-based signatures only. FORS+C over Keccak256 (§5.1), so no
//      elliptic curve enters the trust path. Verifying is ~290 keccaks; the
//      signature is ~9 KB, which is the price of not shipping a curve.
//   2. A hash chain, not an online authority. Every directory commits to the
//      key permitted to sign the NEXT version. A client that has only ever
//      pinned version N can authenticate version N+1 offline, and an attacker
//      who later steals the version-N key still cannot rewrite version N+1.
//   3. Rollback is an attack, not a stale cache. A correctly signed older
//      directory is exactly how you put a retired (or seized) relay key back
//      in front of a client, so `version > minVersion` is strict.
//
// Logging: relay ids, operator ids and versions here are public directory
// data and may be logged. Nothing in this file ever logs, and no error message
// carries key material — a `publicMessage` is rendered to users.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import { ProtocolFailure, type Bytes32, type Hex, type RelayId, type UnixSeconds } from '@opaque/protocol-types';
import { asBytes32, assertRelayPath, encodeBigint, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

// pq-wallet is not yet a declared dependency of @opaque/backend, so these are
// relative imports into the sibling package rather than '@opaque/pq-wallet'.
// See deliberateGaps: the package link is a packaging change, not a code one.
import { canonical, utf8 } from '../../packages/pq-wallet/src/digest.ts';
import {
  decodeSignature,
  encodeSignature,
  forsSchemeId,
  keyGen,
  pkCommitment,
  sign,
  verify as forsVerify,
  type ForsPublicKey,
  type ForsSecretKey,
} from '../../packages/pq-wallet/src/fors.ts';

import { MESH_VERSION, safeEqualHex } from './transport.ts';
import type {
  DirectoryEntry,
  DirectoryModule,
  DirectoryTrustRoot,
  RelayDirectory,
  SignedDirectory,
} from './contracts.ts';
import type { PathHop } from './transport.ts';

/** Pinned. Changing it invalidates every existing signature, which is the point. */
export const DIRECTORY_DOMAIN = 'opaque/v1/mesh/directory' as const;
const DIRECTORY_SIGNING_DOMAIN = 'opaque/v1/mesh/directory-sig' as const;

/** ML-KEM-768 encapsulation key. A wrong-length key is a broken or hostile entry. */
const KEM_PUBLIC_KEY_BYTES = 1184;
/** transport.ts frames the hop id into 32 bytes; a longer id cannot be carried. */
const MAX_RELAY_ID_BYTES = 32;
/** keyEpoch, validFrom, validUntil and expiresAt all become u64 on the wire. */
const MAX_U64 = 1n << 64n;
/** Three hops is the protocol. A directory that cannot supply three is not usable. */
const MIN_ENTRIES = 3;

// Function declarations, not arrow consts: TypeScript only treats a call as
// never-returning (and narrows after it) when the callee is declared this way.
function untrusted(message: string): never {
  throw new ProtocolFailure('UNTRUSTED_DIRECTORY', message);
}

function insufficient(message: string): never {
  throw new ProtocolFailure('INSUFFICIENT_RELAYS', message);
}

/**
 * Runs a codec that throws INVALID_INPUT and restates the failure as a trust
 * failure. A malformed field in a directory is not a caller mistake — it is a
 * directory that must not be believed.
 */
function checked<T>(label: string, read: () => T): T {
  try {
    return read();
  } catch {
    return untrusted(`${label} is malformed`);
  }
}

const inU64 = (value: bigint): boolean => value >= 0n && value < MAX_U64;

// ── canonical encoding ────────────────────────────────────────────────────

/**
 * Length-prefixed, never `field + separator + field`: a separator that can
 * occur inside a field is not a separator, and with `"a:b" + "c"` and
 * `"a" + "b:c"` hashing alike an attacker picks whichever split suits them.
 * `canonical` (from pq-wallet/digest.ts) writes a 4-byte big-endian length
 * before every field, so no two distinct field lists share a byte string.
 *
 * Entries are encoded individually and then sorted BY THEIR ENCODED BYTES, so
 * one directory has exactly one encoding no matter what order the entries
 * arrived in — sorting on the id alone would leave two encodings for a
 * directory that lists an id twice.
 */
function encodeEntry(entry: DirectoryEntry): Uint8Array {
  return canonical([
    utf8(entry.id),
    utf8(entry.operatorId),
    utf8(entry.endpoint),
    fromHex(entry.kemPublicKey),
    utf8(encodeBigint(entry.keyEpoch)),
    utf8(encodeBigint(entry.validFrom)),
    utf8(encodeBigint(entry.validUntil)),
  ]);
}

export function canonicalBytes(directory: RelayDirectory): Uint8Array {
  const entries = directory.entries.map(encodeEntry).sort(Buffer.compare);
  return canonical([
    utf8(DIRECTORY_DOMAIN),
    // Binds the mesh wire version, so a v1 directory can never be replayed as
    // the directory of a future mesh that reads these fields differently.
    utf8(MESH_VERSION),
    utf8(encodeBigint(directory.version)),
    utf8(encodeBigint(directory.issuedAt)),
    utf8(encodeBigint(directory.expiresAt)),
    fromHex(directory.nextSignerCommitment),
    // Explicit count: without it, two directories could differ only in
    // trailing entries that the length prefixes already separate — cheap
    // belt-and-braces, and it makes the entry list self-describing.
    utf8(String(directory.entries.length)),
    ...entries,
  ]);
}

/**
 * What FORS actually signs. The scheme id (which carries k and a) is bound in,
 * so a signature can never be reinterpreted under weaker parameters — the same
 * reasoning as §5.3's digest. `pkCommitment` binds (k, a) too, so the pinned
 * root pins the parameter set as well as the key.
 */
function directoryDigest(directory: RelayDirectory, params: ForsPublicKey['params']): Bytes32 {
  return toHex(
    keccak_256(
      canonical([utf8(DIRECTORY_SIGNING_DOMAIN), utf8(forsSchemeId(params)), canonicalBytes(directory)]),
    ),
  ) as Bytes32;
}

// ── structural validation ─────────────────────────────────────────────────

/**
 * Shape checks that must pass before the bytes are worth hashing. Each one is
 * a way a signed-but-nonsensical directory would otherwise fail later, in a
 * place with less context: an over-long relay id throws inside frame
 * construction, a short KEM key throws inside encapsulation, and an entry that
 * expired before the directory was issued simply never routes.
 */
function assertSaneDirectory(directory: RelayDirectory): void {
  if (typeof directory !== 'object' || directory === null) untrusted('directory must be an object');
  if (directory.version <= 0n || !inU64(directory.version)) untrusted('directory version is out of range');
  if (!inU64(directory.issuedAt) || !inU64(directory.expiresAt)) untrusted('directory timestamps are out of range');
  if (directory.issuedAt >= directory.expiresAt) untrusted('directory expires at or before it was issued');

  checked('nextSignerCommitment', () => fromHex(asBytes32(directory.nextSignerCommitment)));

  if (!Array.isArray(directory.entries)) untrusted('directory entries must be a list');
  if (directory.entries.length < MIN_ENTRIES) {
    untrusted(`a directory must list at least ${MIN_ENTRIES} relays, got ${directory.entries.length}`);
  }

  const ids = new Set<string>();
  for (const entry of directory.entries) {
    if (typeof entry !== 'object' || entry === null) untrusted('a directory entry must be an object');

    const idBytes = utf8(entry.id ?? '');
    if (idBytes.length === 0) untrusted('a relay id must not be empty');
    if (idBytes.length > MAX_RELAY_ID_BYTES) {
      untrusted(`relay id must be at most ${MAX_RELAY_ID_BYTES} bytes on the wire`);
    }
    // Two entries under one id leave no unambiguous answer to "which key is
    // this relay's key right now", and toPath refuses to guess.
    if (ids.has(entry.id)) untrusted(`directory lists relay ${entry.id} more than once`);
    ids.add(entry.id);

    if (typeof entry.operatorId !== 'string' || entry.operatorId.length === 0) {
      untrusted(`relay ${entry.id} has no operator`);
    }
    if (typeof entry.endpoint !== 'string' || !/^https?:\/\/./.test(entry.endpoint)) {
      untrusted(`relay ${entry.id} has no usable endpoint`);
    }

    const kem = checked(`relay ${entry.id} kemPublicKey`, () => fromHex(entry.kemPublicKey));
    if (kem.length !== KEM_PUBLIC_KEY_BYTES) {
      untrusted(`relay ${entry.id} key must be ${KEM_PUBLIC_KEY_BYTES} bytes of ML-KEM-768`);
    }

    if (entry.keyEpoch <= 0n || !inU64(entry.keyEpoch)) untrusted(`relay ${entry.id} has an out-of-range key epoch`);
    if (!inU64(entry.validFrom) || !inU64(entry.validUntil)) {
      untrusted(`relay ${entry.id} has out-of-range validity timestamps`);
    }
    if (entry.validFrom >= entry.validUntil) untrusted(`relay ${entry.id} expires at or before it becomes valid`);
    // An entry already dead when the directory was issued, or not alive until
    // after the directory is, is a padding entry: it inflates the apparent
    // size of the mesh without ever being selectable.
    if (entry.validUntil <= directory.issuedAt) untrusted(`relay ${entry.id} was already expired when issued`);
    if (entry.validFrom >= directory.expiresAt) untrusted(`relay ${entry.id} is never valid while this directory is`);
  }
}

// ── verification ──────────────────────────────────────────────────────────

export function verify(signed: SignedDirectory, root: DirectoryTrustRoot, now: UnixSeconds): RelayDirectory {
  if (typeof signed !== 'object' || signed === null) untrusted('signed directory must be an object');
  const directory = signed.directory;
  assertSaneDirectory(directory);

  const { publicKey, signature } = checked('signature', () => decodeSignature(signed.signature));

  // The pinned root first: it is the only thing here the client actually
  // trusts, and everything below is meaningless if the signer is not it.
  const commitment = checked('signer commitment', () => pkCommitment(publicKey));
  if (!safeEqualHex(commitment, root.signerCommitment)) {
    untrusted('directory was signed by a key that is not the pinned signer');
  }

  if (!forsVerify(publicKey, directoryDigest(directory, publicKey.params), signature)) {
    untrusted('directory signature does not verify');
  }

  // ROLLBACK. A correctly signed version <= the pinned minimum is how a
  // retired or seized relay key gets put back in front of a client, so this is
  // an attack to refuse and not a cache to freshen.
  if (directory.version <= root.minVersion) {
    untrusted(`directory version ${directory.version} is not newer than the pinned ${root.minVersion}`);
  }

  if (now < directory.issuedAt) untrusted('directory is not yet issued');
  if (now >= directory.expiresAt) untrusted('directory has expired');

  // FORS+C is FEW-time: every extra signature under one key reveals more
  // leaves and raises the forgery probability. Chaining a version to its own
  // signer means that key signs twice, so the successor must be a fresh key.
  if (safeEqualHex(directory.nextSignerCommitment, root.signerCommitment)) {
    untrusted('directory chains the next version to its own signer, reusing a few-time key');
  }

  return directory;
}

/**
 * Verify, then walk the hash chain forward. `nextRoot` is what the client
 * pins from here: the successor key this version committed to, and this
 * version's number as the new rollback floor — so replaying the directory that
 * was just accepted is itself refused next time.
 */
export function accept(
  signed: SignedDirectory,
  root: DirectoryTrustRoot,
  now: UnixSeconds,
): { readonly directory: RelayDirectory; readonly nextRoot: DirectoryTrustRoot } {
  const directory = verify(signed, root, now);
  return {
    directory,
    nextRoot: {
      signerCommitment: directory.nextSignerCommitment,
      minVersion: directory.version,
    },
  };
}

// ── path construction ─────────────────────────────────────────────────────

/**
 * The three hops the caller asked for, in the order they asked for them,
 * or nothing.
 *
 * "Or nothing" matters: quietly substituting a live relay for a dead one would
 * hand path selection to whoever wrote the directory, and quietly dropping a
 * hop would build a two-hop path that still looks like a success.
 *
 * A repeated relay is refused, and so is a repeated OPERATOR — two hops run by
 * one company are two hops that collude for free, which is the entire premise
 * of three hops gone. `assertRelayPath` enforces both.
 */
export function toPath(
  directory: RelayDirectory,
  ids: readonly [RelayId, RelayId, RelayId],
  now: UnixSeconds,
): readonly [PathHop, PathHop, PathHop] {
  if (!Array.isArray(directory.entries)) insufficient('directory has no entries');

  const chosen = ids.map((id): DirectoryEntry => {
    const matches = directory.entries.filter((entry) => entry.id === id);
    const entry = matches[0];
    if (entry === undefined) insufficient(`relay ${id} is not in this directory`);
    // Two entries for one id is an unresolvable key epoch: picking either
    // means guessing which key the relay is actually holding, and a wrong
    // guess is rejected at the hop with UNTRUSTED_DIRECTORY after the message
    // has already travelled.
    if (matches.length > 1) insufficient(`directory lists relay ${id} under more than one key epoch`);

    if (entry.keyEpoch <= 0n || !inU64(entry.keyEpoch)) {
      insufficient(`relay ${id} has a key epoch that cannot be carried on the wire`);
    }
    if (now < entry.validFrom || now >= entry.validUntil) {
      insufficient(`relay ${id} is outside its validity window`);
    }
    return entry;
  });

  // Copied, not passed by reference: assertRelayPath is an assertion signature
  // and narrowing `chosen` to RelayPath here would be a lie about its type.
  assertRelayPath([...chosen]);

  const hops = chosen.map((entry) => ({
    id: entry.id,
    kemPublicKey: entry.kemPublicKey,
    keyEpoch: entry.keyEpoch,
  }));
  return hops as unknown as readonly [PathHop, PathHop, PathHop];
}

export const directoryModule: DirectoryModule = { canonicalBytes, verify, accept, toPath };

// ── signing: TESTS AND OFFLINE TOOLING ONLY ───────────────────────────────

export interface ForsKeypair {
  readonly secretKey: ForsSecretKey;
  readonly publicKey: ForsPublicKey;
}

/**
 * TEST AND TOOLING HELPER. Production directories are signed on an offline
 * machine that holds the FORS seed; this function exists so tests and that
 * tooling agree on the bytes, and it is deliberately the only writer.
 *
 * FORS+C is few-time: sign ONE directory version per keypair. The successor
 * key is committed in `nextSignerCommitment`, and `verify` refuses a directory
 * that chains back to its own signer precisely to keep that rule mechanical.
 */
export function signDirectory(directory: RelayDirectory, keypair: ForsKeypair): SignedDirectory {
  const digest = directoryDigest(directory, keypair.publicKey.params);
  return {
    directory,
    signature: encodeSignature(keypair.publicKey, sign(keypair.secretKey, digest)),
  };
}

/** The commitment to pin for a signer. Thin, but it keeps FORS out of callers. */
export const signerCommitment = (publicKey: ForsPublicKey): Bytes32 => pkCommitment(publicKey);

/** Derives a FORS keypair from a label. TEST AND TOOLING ONLY — see below. */
export const deterministicSigner = (label: string): ForsKeypair =>
  keyGen(keccak_256(canonical([utf8(`${DIRECTORY_DOMAIN}/signer`), utf8(label)])));

// ══════════════════════════════════════════════════════════════════════════
//
//   ####  TEST FIXTURE ONLY — THESE ARE NOT RELAY KEYS  ####
//
//   Every ML-KEM secret key `deterministicDirectory` produces is a pure
//   function of the seed string. Anyone holding this file and that seed can
//   derive the secret key of every relay in the directory and decrypt every
//   onion layer addressed to it. A relay whose secret key is derivable is not
//   a relay — it is a wiretap with a hostname, and a mesh of them provides
//   exactly zero anonymity while looking, at every layer, like it works.
//
//   NEVER point a deployment, a staging environment, or anything reachable
//   from a real wallet at a directory built here. A real relay generates its
//   keypair with `generateRelayKeypair()` from system randomness, on its own
//   machine, and the secret never leaves it.
//
//   It exists so tests are deterministic: the same seed gives the same bytes,
//   so a failure reproduces instead of being a coin flip.
//
// ══════════════════════════════════════════════════════════════════════════

export interface DeterministicRelay {
  readonly id: RelayId;
  readonly operatorId: string;
  /** DERIVABLE FROM THE SEED. Test fixtures only. */
  readonly secretKey: Hex;
  readonly keyEpoch: bigint;
}

/**
 * A sane three-relay directory, valid for a week from `issuedAt`, whose relay
 * secret keys are returned so a test can actually peel what it builds.
 *
 * Variants are made by spreading the result — `{ ...directory, version: 9n }`
 * — and re-signing, rather than by an options bag nobody would read.
 */
export function deterministicDirectory(
  seed: string,
  issuedAt: UnixSeconds = 1_760_000_000n as UnixSeconds,
): {
  readonly directory: RelayDirectory;
  readonly relays: readonly [DeterministicRelay, DeterministicRelay, DeterministicRelay];
} {
  const keyEpoch = 7n;
  const relays: DeterministicRelay[] = [];
  const entries: DirectoryEntry[] = [];

  for (let i = 1; i <= 3; i++) {
    // ml_kem768 wants 64 bytes of seed; two domain-separated keccaks supply it.
    const material = new Uint8Array(64);
    material.set(keccak_256(canonical([utf8(`${DIRECTORY_DOMAIN}/relay/a`), utf8(seed), utf8(String(i))])), 0);
    material.set(keccak_256(canonical([utf8(`${DIRECTORY_DOMAIN}/relay/b`), utf8(seed), utf8(String(i))])), 32);
    const { publicKey, secretKey } = ml_kem768.keygen(material);

    const id = `R${i}` as RelayId;
    const operatorId = `operator-${i}`;
    relays.push({ id, operatorId, secretKey: toHex(secretKey), keyEpoch });
    entries.push({
      id,
      operatorId,
      endpoint: `https://r${i}.relay.invalid/v1/relay`,
      kemPublicKey: toHex(publicKey),
      keyEpoch,
      validFrom: issuedAt,
      validUntil: (issuedAt + 2_592_000n) as UnixSeconds, // 30 days
    });
  }

  return {
    directory: {
      version: 1n,
      issuedAt,
      expiresAt: (issuedAt + 604_800n) as UnixSeconds, // 7 days
      entries,
      nextSignerCommitment: signerCommitment(deterministicSigner(`${seed}/next`).publicKey),
    },
    relays: relays as unknown as readonly [DeterministicRelay, DeterministicRelay, DeterministicRelay],
  };
}

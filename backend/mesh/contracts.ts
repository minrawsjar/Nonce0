// Shared contract for the mesh SERVICE layer (§7), around the transport core.
//
// transport.ts is the cryptography: it seals and peels one layer. Everything
// here is what turns that into three relays anyone can run — the directory that
// says who they are, the queue that decides when a message moves, and the
// return path that gets an answer back to someone with no inbound address.
//
// These types are frozen the same way packages/protocol-types is: modules
// implement them and never reach past them into each other.

import type { Bytes32, Hex, RelayId, UnixSeconds } from '@opaque/protocol-types';

import type { MeshEnvelope, PathHop } from './transport.ts';

// ── the directory (§7, bootstrap) ─────────────────────────────────────────

/**
 * Hops in one onion. Three is the protocol: entry knows the sender, exit knows
 * the destination, and the middle exists so no single relay knows both.
 */
export const PATH_HOPS = 3;

/**
 * Live relays the mesh must be able to draw those three FROM.
 *
 * These are two different numbers and the difference is the whole point. Run
 * exactly three and "select the best three" selects all of them — the graph
 * feed is computing a ranking that changes nothing, every payment walks the
 * same route, and a standing circuit is precisely what three hops exist to
 * avoid. Six gives twenty possible paths, and the path a message takes stops
 * being a property of the deployment and starts being a per-payment draw.
 *
 * Six is a floor on the POOL, never on the path length: a message still makes
 * three hops. Raising this costs operators, not latency.
 */
export const MIN_POOL_RELAYS = 6;

export interface DirectoryEntry {
  readonly id: RelayId;
  /** Who runs it. A path must never use one operator twice. */
  readonly operatorId: string;
  readonly endpoint: string;
  readonly kemPublicKey: Hex;
  readonly keyEpoch: bigint;
  readonly validFrom: UnixSeconds;
  readonly validUntil: UnixSeconds;
}

export interface RelayDirectory {
  readonly version: bigint;
  readonly issuedAt: UnixSeconds;
  readonly expiresAt: UnixSeconds;
  readonly entries: readonly DirectoryEntry[];
  /**
   * Hash-chained: the commitment to the key permitted to sign the NEXT
   * version. This is what makes an update authenticable against a pinned root
   * without an online authority, and without any elliptic curve.
   */
  readonly nextSignerCommitment: Bytes32;
}

export interface SignedDirectory {
  readonly directory: RelayDirectory;
  /** FORS+C over canonicalDirectoryBytes. Hash-based; no ECDSA anywhere. */
  readonly signature: Hex;
}

/**
 * Pinned in application configuration and shipped with the client. An
 * untrusted Graph response can never replace this — which is also why the mesh
 * has to bootstrap BEFORE the first Graph query rather than after it.
 */
export interface DirectoryTrustRoot {
  readonly signerCommitment: Bytes32;
  /** Monotonic. A directory at or below this version is a rollback attempt. */
  readonly minVersion: bigint;
}

export interface DirectoryModule {
  canonicalBytes(directory: RelayDirectory): Uint8Array;
  /**
   * Verifies signature, signer commitment, version monotonicity and validity
   * window. Throws UNTRUSTED_DIRECTORY rather than returning a flag: a caller
   * that forgets to check a boolean gets a working mesh with no trust.
   */
  verify(signed: SignedDirectory, root: DirectoryTrustRoot, now: UnixSeconds): RelayDirectory;
  /** Verifies, then advances the pinned root along the hash chain. */
  accept(
    signed: SignedDirectory,
    root: DirectoryTrustRoot,
    now: UnixSeconds,
  ): { readonly directory: RelayDirectory; readonly nextRoot: DirectoryTrustRoot };
  /** Live entries only, checked against `now`, in the order requested. */
  toPath(
    directory: RelayDirectory,
    ids: readonly [RelayId, RelayId, RelayId],
    now: UnixSeconds,
  ): readonly [PathHop, PathHop, PathHop];
}

// ── batching and delay (§7.1) ─────────────────────────────────────────────

export interface QueuedMessage {
  /**
   * LOCAL to this relay and to this queue. Never on the wire, never equal to
   * hopLocalId, never logged next to one. Two relays comparing queue ids must
   * learn nothing.
   */
  readonly queueId: string;
  readonly envelope: MeshEnvelope;
  /** null when this relay is the final hop. */
  readonly next: RelayId | null;
  readonly acceptedAt: bigint;
  readonly releaseAt: bigint;
}

export interface SchedulerOptions {
  /** Fixed, not adaptive: an adaptive window leaks the load it adapts to. */
  readonly batchWindowMs: number;
  readonly maxExtraDelayMs: number;
  /** Bounded. A queue that grows without limit is a memory oracle. */
  readonly maxQueue: number;
  readonly random: () => number;
}

export interface BatchScheduler {
  /**
   * False when the queue is full. The caller must REJECT the message with a
   * retryable error — silently dropping it looks identical to delivering it.
   */
  offer(envelope: MeshEnvelope, next: RelayId | null, now: bigint): boolean;
  /** Everything due at `now`, in randomised order. Removes what it returns. */
  drain(now: bigint): readonly QueuedMessage[];
  readonly size: number;
}

// ── the return path (§7.5) ────────────────────────────────────────────────
//
// A wallet has no inbound address, so a reply cannot simply be sent back. The
// client seals a one-time ML-KEM public key and a drop location into the
// innermost payload, which only the final hop can read. The final hop
// encapsulates to that key and deposits the sealed answer at the drop. The
// client collects it later, through a fresh path.
//
// The drop id is the private capability: unguessable, single-use, and
// unlinkable to the intent it answers.

export interface ResponseChannel {
  /** The one-time ML-KEM public key, carried as FinalPayload.responseKey. */
  readonly responseKey: Hex;
  /** Drop relay and drop id, carried as FinalPayload.returnRoute. */
  readonly returnRoute: Hex;
  readonly dropId: string;
  /** Opens a sealed reply. Held by the client only. */
  open(sealed: Hex): Uint8Array;
}

export interface ReturnRouteTarget {
  readonly dropRelay: RelayId;
  readonly dropId: string;
}

export interface ReturnPathModule {
  /** Client side. `random` is injected so tests are deterministic. */
  createChannel(
    dropRelay: RelayId,
    random?: (n: number) => Uint8Array,
  ): ResponseChannel;
  /** Final hop side: where to deposit, read out of the innermost payload. */
  decodeRoute(returnRoute: Hex): ReturnRouteTarget;
  /** Final hop side: seal an answer to the client's one-time key. */
  seal(responseKey: Hex, body: Uint8Array): Hex;
}

// ── drops (the private-capability fetch) ──────────────────────────────────

export interface DropStore {
  /** Write-once. A second deposit under one id is rejected, never overwritten. */
  put(dropId: string, sealed: Hex, expiresAt: bigint): void;
  /** Single-use: collecting removes it. */
  take(dropId: string, now: bigint): Hex | undefined;
  sweep(now: bigint): void;
  readonly size: number;
}

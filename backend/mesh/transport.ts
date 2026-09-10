// T10 — the relay privacy boundary.
//
// A three-hop onion. Each layer is sealed to exactly one relay's ML-KEM-768
// public key, and a relay that opens its layer learns only the next hop's
// address and an opaque blob. No relay sees the payload, and no relay except
// the last learns whether it is carrying a payment or a query.
//
// Four properties this file is responsible for, each of which is a way the
// design fails if it is skipped:
//
//   1. No end-to-end identifier. Every layer carries its OWN hop-local id.
//      A single id threaded through all three hops would let three operators
//      (or three log files) join their observations and reconstruct the path,
//      which is the exact linkage three hops exist to prevent.
//   2. The message kind lives in the INNERMOST layer only. Putting
//      PAYMENT/QUERY in the outer header — as the first draft did — lets any
//      relay or on-path observer filter payments out with one field read, and
//      the claim that query traffic covers payment traffic evaporates.
//   3. Padding to declared size classes. Bounded delay alone is not a
//      traffic-analysis defence; if a payment is 40 KB and a status query is
//      400 bytes, size alone separates them.
//   4. Header fields are authenticated as AAD. A relay that can rewrite the
//      expiry or the intended hop without invalidating the tag can redirect
//      or resurrect a message.
//
// No X25519 and no ECDH anywhere in this path — V1 forbids an elliptic curve
// in application relay encryption.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import { ProtocolFailure, type Hex, type RelayId } from '@opaque/protocol-types';
import { encodeBigint, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

export const MESH_VERSION = '1-review' as const;

const KEM_CIPHERTEXT_BYTES = 1088; // ML-KEM-768
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_INFO = 'opaque/v1/mesh/hop-key';

/**
 * The INNERMOST plaintext is padded up to one of these. Because every layer is
 * a fixed-size binary frame, the size at each depth is then a constant:
 *
 *   hop 3 receives  class + 1*OVERHEAD
 *   hop 2 receives  class + 2*OVERHEAD
 *   hop 1 receives  class + 3*OVERHEAD
 *
 * So a PAYMENT and a QUERY at the same class are byte-identical at every hop —
 * which is the property the cover-traffic argument actually needs. Using a
 * smaller class for queries would re-separate them, so the default is the
 * largest and choosing otherwise is a deliberate trade.
 *
 * DISCLOSED LIMITATION: sizes differ BETWEEN depths, so an observer watching a
 * relay can tell a first hop from a third. Removing that needs a constant-size
 * construction (Sphinx-style header shifting with hop-side re-padding), which
 * V1 does not attempt. A packet cannot simply nest inside itself at constant
 * size; pretending otherwise is how this gets quietly gotten wrong.
 */
export const SIZE_CLASSES = Object.freeze([4_096, 16_384, 65_536] as const);
export type SizeClass = (typeof SIZE_CLASSES)[number];
export const DEFAULT_SIZE_CLASS: SizeClass = 65_536;

// Binary frame. An earlier draft nested JSON carrying hex-encoded inner
// layers: hex doubles, JSON adds more, and three hops turned a 64 KiB payload
// into 500 KiB. Fixed-width binary keeps every layer's cost to OVERHEAD.
const HOP_ID_BYTES = 32;   // utf8, zero-padded
const HOP_LOCAL_ID_BYTES = 16;
const FRAME_HEADER_BYTES = 1 + HOP_LOCAL_ID_BYTES + HOP_ID_BYTES + 8 + 8 + 4;
export const LAYER_OVERHEAD = FRAME_HEADER_BYTES + KEM_CIPHERTEXT_BYTES + NONCE_BYTES + GCM_TAG_BYTES;

// ── wire types ────────────────────────────────────────────────────────────

/** What a relay receives. Everything meaningful is inside `ciphertext`. */
export interface MeshEnvelope {
  readonly version: typeof MESH_VERSION;
  /** Unique to THIS hop. Never equal to the id at any other hop. */
  readonly hopLocalId: string;
  readonly hopId: RelayId;
  /** Decimal string: the relay key generation this layer was sealed to. */
  readonly keyEpoch: string;
  readonly expiresAt: string;
  readonly kemCiphertext: Hex;
  readonly nonce: Hex;
  readonly ciphertext: Hex;
}

export type MeshMessageKind = 'PAYMENT' | 'QUERY';

/** The innermost plaintext — visible only to the final hop. */
export interface FinalPayload {
  readonly kind: MeshMessageKind;
  /** Opaque to the mesh: an approved release, or an allowlisted query. */
  readonly body: Hex;
  /** QUERY only. One-time key plus encrypted return route. */
  readonly responseKey?: Hex;
  readonly returnRoute?: Hex;
}

export interface RelayKeypair {
  readonly publicKey: Hex;
  readonly secretKey: Hex;
  readonly keyEpoch: bigint;
}

export interface PathHop {
  readonly id: RelayId;
  readonly kemPublicKey: Hex;
  readonly keyEpoch: bigint;
}

export type PeelResult =
  | { readonly kind: 'FORWARD'; readonly next: RelayId; readonly envelope: MeshEnvelope }
  | { readonly kind: 'FINAL'; readonly payload: FinalPayload };

// ── keys ──────────────────────────────────────────────────────────────────

export function generateRelayKeypair(keyEpoch = 1n): RelayKeypair {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { publicKey: toHex(publicKey), secretKey: toHex(secretKey), keyEpoch };
}

// ── framing ───────────────────────────────────────────────────────────────

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function frameHeaderBytes(h: {
  hopLocalId: string;
  hopId: RelayId;
  keyEpoch: string;
  expiresAt: string;
  ciphertextLength: number;
}): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(out.buffer);
  out[0] = 1; // frame version
  out.set(fromHex(`0x${h.hopLocalId}` as Hex), 1);

  const hopId = utf8(h.hopId);
  if (hopId.length > HOP_ID_BYTES) throw new ProtocolFailure('INVALID_INPUT', 'relay id is too long');
  out.set(hopId, 1 + HOP_LOCAL_ID_BYTES);

  view.setBigUint64(1 + HOP_LOCAL_ID_BYTES + HOP_ID_BYTES, BigInt(h.keyEpoch), false);
  view.setBigUint64(1 + HOP_LOCAL_ID_BYTES + HOP_ID_BYTES + 8, BigInt(h.expiresAt), false);
  view.setUint32(FRAME_HEADER_BYTES - 4, h.ciphertextLength, false);
  return out;
}

/** The header IS the associated data — every routing field is authenticated. */
const headerAad = (h: Parameters<typeof frameHeaderBytes>[0]): Uint8Array => frameHeaderBytes(h);

export function encodeFrame(envelope: MeshEnvelope): Uint8Array {
  const ct = fromHex(envelope.ciphertext);
  const header = frameHeaderBytes({ ...envelope, ciphertextLength: ct.length });
  const out = new Uint8Array(header.length + KEM_CIPHERTEXT_BYTES + NONCE_BYTES + ct.length);
  out.set(header, 0);
  out.set(fromHex(envelope.kemCiphertext), header.length);
  out.set(fromHex(envelope.nonce), header.length + KEM_CIPHERTEXT_BYTES);
  out.set(ct, header.length + KEM_CIPHERTEXT_BYTES + NONCE_BYTES);
  return out;
}

export function decodeFrame(bytes: Uint8Array): MeshEnvelope {
  if (bytes.length < LAYER_OVERHEAD) throw new ProtocolFailure('INVALID_INPUT', 'frame is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 1) throw new ProtocolFailure('UNSUPPORTED_VERSION', 'unknown mesh frame version');

  const hopLocalId = Buffer.from(bytes.slice(1, 1 + HOP_LOCAL_ID_BYTES)).toString('hex');
  const hopIdRaw = bytes.slice(1 + HOP_LOCAL_ID_BYTES, 1 + HOP_LOCAL_ID_BYTES + HOP_ID_BYTES);
  const hopId = Buffer.from(hopIdRaw).toString('utf8').replace(/\0+$/, '') as RelayId;

  const keyEpoch = view.getBigUint64(1 + HOP_LOCAL_ID_BYTES + HOP_ID_BYTES, false);
  const expiresAt = view.getBigUint64(1 + HOP_LOCAL_ID_BYTES + HOP_ID_BYTES + 8, false);
  const ctLength = view.getUint32(FRAME_HEADER_BYTES - 4, false);

  const kemAt = FRAME_HEADER_BYTES;
  const nonceAt = kemAt + KEM_CIPHERTEXT_BYTES;
  const ctAt = nonceAt + NONCE_BYTES;
  if (ctAt + ctLength > bytes.length) throw new ProtocolFailure('INVALID_INPUT', 'frame declares a bad ciphertext length');

  return {
    version: MESH_VERSION,
    hopLocalId,
    hopId,
    keyEpoch: encodeBigint(keyEpoch),
    expiresAt: encodeBigint(expiresAt),
    kemCiphertext: toHex(bytes.slice(kemAt, nonceAt)),
    nonce: toHex(bytes.slice(nonceAt, ctAt)),
    ciphertext: toHex(bytes.slice(ctAt, ctAt + ctLength)),
  };
}

function hopKey(sharedSecret: Uint8Array, hopLocalId: string): Buffer {
  // The hop-local id is the salt, so two layers that happened to share a
  // shared secret still derive different AEAD keys.
  return Buffer.from(hkdfSync('sha256', sharedSecret, utf8(hopLocalId), utf8(HKDF_INFO), 32));
}

function seal(hop: PathHop, plaintext: Uint8Array, expiresAt: bigint): MeshEnvelope {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(fromHex(hop.kemPublicKey));

  // Independent per hop — property 1. Tied to nothing else in the message.
  const hopLocalId = randomBytes(HOP_LOCAL_ID_BYTES).toString('hex');
  const nonce = randomBytes(NONCE_BYTES);

  const header = {
    hopLocalId,
    hopId: hop.id,
    keyEpoch: encodeBigint(hop.keyEpoch),
    expiresAt: encodeBigint(expiresAt),
    ciphertextLength: plaintext.length + GCM_TAG_BYTES,
  };

  const cipher = createCipheriv('aes-256-gcm', hopKey(sharedSecret, hopLocalId), nonce);
  cipher.setAAD(headerAad(header));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  return {
    version: MESH_VERSION,
    hopLocalId,
    hopId: hop.id,
    keyEpoch: header.keyEpoch,
    expiresAt: header.expiresAt,
    kemCiphertext: toHex(cipherText),
    nonce: toHex(nonce),
    ciphertext: toHex(body),
  };
}

function open(envelope: MeshEnvelope, secretKey: Hex): Uint8Array {
  const kem = fromHex(envelope.kemCiphertext);
  if (kem.length !== KEM_CIPHERTEXT_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', `KEM ciphertext must be ${KEM_CIPHERTEXT_BYTES}B`);
  }
  const nonce = fromHex(envelope.nonce);
  if (nonce.length !== NONCE_BYTES) throw new ProtocolFailure('INVALID_INPUT', 'nonce must be 12B');

  const sealed = fromHex(envelope.ciphertext);
  if (sealed.length <= GCM_TAG_BYTES) throw new ProtocolFailure('INVALID_INPUT', 'ciphertext is truncated');

  // ML-KEM decapsulation is designed never to fail loudly: a bad ciphertext
  // yields a wrong-but-well-formed shared secret. The AEAD tag is what
  // actually rejects it, one line below.
  const sharedSecret = ml_kem768.decapsulate(kem, fromHex(secretKey));

  const decipher = createDecipheriv('aes-256-gcm', hopKey(sharedSecret, envelope.hopLocalId), nonce);
  decipher.setAAD(headerAad({ ...envelope, ciphertextLength: sealed.length }));
  decipher.setAuthTag(sealed.slice(sealed.length - GCM_TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.slice(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
  } catch {
    throw new ProtocolFailure('INVALID_INPUT', 'envelope failed authentication');
  }
}

// ── the onion ─────────────────────────────────────────────────────────────

/**
 * Sealed innermost-first: the layer only the last hop can open is built first,
 * then wrapped for hop 2, then hop 1. The client needs every hop's public key,
 * which is why the pinned directory (§5) must be trusted before any of this.
 */
export function buildOnion(input: {
  readonly path: readonly [PathHop, PathHop, PathHop];
  readonly payload: FinalPayload;
  readonly expiresAt: bigint;
  readonly sizeClass?: SizeClass;
}): MeshEnvelope {
  const sizeClass = input.sizeClass ?? DEFAULT_SIZE_CLASS;
  const [first, second, third] = input.path;

  if (new Set([first.id, second.id, third.id]).size !== 3) {
    throw new ProtocolFailure('INSUFFICIENT_RELAYS', 'a path must not repeat a relay');
  }

  const body = utf8(JSON.stringify(input.payload));
  if (body.length + 4 > sizeClass) {
    throw new ProtocolFailure('INVALID_INPUT', `payload of ${body.length}B exceeds size class ${sizeClass}`);
  }

  // Pad ONLY the innermost plaintext. Every outer layer is then a fixed
  // function of it, so PAYMENT and QUERY match byte-for-byte at each depth.
  const padded = new Uint8Array(sizeClass);
  new DataView(padded.buffer).setUint32(0, body.length, false);
  padded.set(body, 4);

  // `kind` is in here, and only here. Hops 1 and 2 never see it.
  let layer = seal(third, padded, input.expiresAt);
  for (const hop of [second, first]) {
    layer = seal(hop, encodeFrame(layer), input.expiresAt);
  }
  return layer;
}

export interface ReplayCache {
  /** True if this id was already seen. Records it either way. */
  seen(hopLocalId: string, expiresAt: bigint): boolean;
}

/**
 * Bounded, expiry-aware, and persistable — the PDF requires the lifetime to
 * survive a restart, so `entries`/`restore` exist to be written to disk.
 */
export class MemoryReplayCache implements ReplayCache {
  #seen = new Map<string, bigint>();
  readonly #max: number;

  constructor(max = 100_000, restore: ReadonlyArray<readonly [string, bigint]> = []) {
    this.#max = max;
    for (const [id, expiry] of restore) this.#seen.set(id, expiry);
  }

  seen(hopLocalId: string, expiresAt: bigint): boolean {
    if (this.#seen.has(hopLocalId)) return true;
    if (this.#seen.size >= this.#max) {
      // Evict only what can no longer be replayed. Dropping live entries to
      // make room would silently reopen the replay window under load.
      const now = BigInt(Math.floor(Date.now() / 1000));
      for (const [id, expiry] of this.#seen) if (expiry <= now) this.#seen.delete(id);
      if (this.#seen.size >= this.#max) {
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'replay cache is full of live entries', true);
      }
    }
    this.#seen.set(hopLocalId, expiresAt);
    return false;
  }

  entries(): ReadonlyArray<readonly [string, bigint]> {
    return [...this.#seen];
  }
}

/**
 * One hop's whole job. Validate, then either forward the inner envelope or —
 * if this is the last hop — hand the payload to the allowlisted egress.
 *
 * Validation happens BEFORE queueing so a malformed or replayed message never
 * occupies a batch slot.
 */
export function peelLayer(input: {
  readonly envelope: MeshEnvelope;
  readonly hopId: RelayId;
  readonly secretKey: Hex;
  readonly keyEpoch: bigint;
  readonly now: bigint;
  readonly replayCache: ReplayCache;
}): PeelResult {
  const { envelope, hopId, now, replayCache } = input;

  if (envelope.version !== MESH_VERSION) {
    throw new ProtocolFailure('UNSUPPORTED_VERSION', `mesh version ${String(envelope.version)} is not accepted`);
  }
  // Wrong-hop delivery is rejected rather than attempted: trying to decrypt
  // would work only by accident, and "it failed to decrypt" is a weaker
  // guarantee than "it was not addressed to me".
  if (envelope.hopId !== hopId) {
    throw new ProtocolFailure('INVALID_INPUT', 'envelope is addressed to a different hop');
  }
  if (envelope.keyEpoch !== encodeBigint(input.keyEpoch)) {
    throw new ProtocolFailure('UNTRUSTED_DIRECTORY', 'envelope was sealed to a different key epoch');
  }
  if (BigInt(envelope.expiresAt) <= now) {
    throw new ProtocolFailure('EXPIRED', 'envelope has expired');
  }
  if (replayCache.seen(envelope.hopLocalId, BigInt(envelope.expiresAt))) {
    throw new ProtocolFailure('INVALID_INPUT', 'envelope has already been processed');
  }

  const plaintext = open(envelope, input.secretKey);

  // An inner layer is another frame; the innermost is a padded JSON payload.
  // The frame's first byte is its version marker, so the two are told apart
  // structurally rather than by guessing at the bytes.
  if (plaintext.length >= LAYER_OVERHEAD && plaintext[0] === 1) {
    const inner = decodeFrame(plaintext);
    if (inner.hopId === hopId) {
      // A loop would let one relay see the same message twice at different
      // depths, which is two observations of one path from one operator.
      throw new ProtocolFailure('INVALID_INPUT', 'inner layer routes back to this hop');
    }
    if (inner.hopLocalId === envelope.hopLocalId) {
      throw new ProtocolFailure('INVALID_INPUT', 'inner layer reuses this hop-local id');
    }
    return { kind: 'FORWARD', next: inner.hopId, envelope: inner };
  }

  if (plaintext.length < 4) throw new ProtocolFailure('INVALID_INPUT', 'padded frame is truncated');
  const bodyLength = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false);
  if (bodyLength + 4 > plaintext.length) throw new ProtocolFailure('INVALID_INPUT', 'padded frame declares a bad length');

  const parsed: unknown = JSON.parse(Buffer.from(plaintext.slice(4, 4 + bodyLength)).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolFailure('INVALID_INPUT', 'layer plaintext is not an object');
  }
  const raw = parsed as Record<string, unknown>;

  const kind = raw['kind'];
  if (kind !== 'PAYMENT' && kind !== 'QUERY') {
    throw new ProtocolFailure('INVALID_INPUT', `unknown message kind ${String(kind)}`);
  }
  if (kind === 'QUERY' && (typeof raw['responseKey'] !== 'string' || typeof raw['returnRoute'] !== 'string')) {
    throw new ProtocolFailure('INVALID_INPUT', 'a QUERY must carry a response key and return route');
  }
  return { kind: 'FINAL', payload: raw as unknown as FinalPayload };
}

// ── egress allowlist ──────────────────────────────────────────────────────

/**
 * The final hop may only reach configured operations. Not a URL filter that
 * a redirect can walk out of: the caller names an operation, the map supplies
 * the destination, and a redirect is never followed.
 */
export function resolveEgress(allowlist: ReadonlyMap<string, string>, operation: string): string {
  const target = allowlist.get(operation);
  if (target === undefined) {
    throw new ProtocolFailure('INVALID_INPUT', `operation ${operation} is not allowlisted`);
  }
  return target;
}

/** Constant-time compare for any tag or capability handle checked at a hop. */
export function safeEqualHex(a: Hex, b: Hex): boolean {
  const left = fromHex(a);
  const right = fromHex(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

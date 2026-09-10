// Carrying a message larger than one mesh size class.
//
// A RING_8 spend's proof is 1,101 KiB and the mesh's largest class is 64 KiB,
// so a sealed intent crosses as ~35 chunks and is reassembled at the exit.
// docs/proof-transport.md has why this and not the alternatives.
//
// ── What each party sees ─────────────────────────────────────────────────
//
//   Relays     35 messages, each byte-identical at its size class to any other
//              message. The upload id is in the INNERMOST layer, so no relay
//              can group them. Each chunk takes a FRESH path, so no single
//              entry relay sees the burst either: with six relays, each entry
//              sees about six chunks.
//   The exit   The upload id, and ciphertext. It already saw the whole sealed
//              intent before chunking existed, so grouping here reveals nothing
//              new — and it still cannot read a byte of it.
//
// ── Why one-way, with a commit ───────────────────────────────────────────
//
// A round trip per chunk would be 35 drops and 35 polls. Instead every chunk is
// fire-and-forget and one COMMIT asks "have you got all of them?". The exit
// answers with the intent ref, or with the indices it is missing, and only
// those are resent. The payload hash in the commit is what makes a reassembly
// that is complete-but-wrong impossible to submit.

import { keccak_256 } from '@noble/hashes/sha3.js';

import { ProtocolFailure, type Bytes32 } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

const MAGIC = new Uint8Array([0x4f, 0x50, 0x51, 0x43]); // "OPQC" — JSON cannot begin with 'O'
const VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1 + 16 + 2 + 2;

/**
 * Chunk data per message. The innermost plaintext is JSON plus a 4-byte length
 * and must fit 65,536; a one-way chunk's JSON is 30 bytes of framing around a
 * hex body, and hex doubles the frame. That leaves 32,751 bytes of frame, less
 * the header. A little under, for margin — and buildOnion throws on oversize,
 * so a wrong number here fails loudly rather than truncating.
 */
export const CHUNK_DATA_BYTES = 32_640;

/** 64 × 32 KiB is 2 MiB: comfortably above the 1.25 MiB sealed-intent cap. */
export const MAX_CHUNKS = 64;

/**
 * Below this a sealed intent crosses as one message, as it always did. Above
 * it, chunked. Conservative — a single message could carry a little more — but
 * a payload that is chunked unnecessarily costs nothing but a round trip.
 */
export const CHUNK_THRESHOLD_BYTES = 12 * 1024;

export interface ChunkFrame {
  readonly uploadId: Uint8Array; // 16 random bytes
  readonly index: number;
  readonly total: number;
  readonly data: Uint8Array;
}

export const isChunkFrame = (bytes: Uint8Array): boolean =>
  bytes.length >= HEADER_BYTES && MAGIC.every((b, i) => bytes[i] === b);

export function encodeChunkFrame(frame: ChunkFrame): Uint8Array {
  if (frame.uploadId.length !== 16) throw new ProtocolFailure('INVALID_INPUT', 'upload id must be 16 bytes');
  const out = new Uint8Array(HEADER_BYTES + frame.data.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out.set(frame.uploadId, 5);
  view.setUint16(21, frame.index, false);
  view.setUint16(23, frame.total, false);
  out.set(frame.data, HEADER_BYTES);
  return out;
}

/** Strict: these bytes arrive from whichever client sent them. */
export function decodeChunkFrame(bytes: Uint8Array): ChunkFrame {
  if (!isChunkFrame(bytes)) throw new ProtocolFailure('INVALID_INPUT', 'not a chunk frame');
  if (bytes[4] !== VERSION) throw new ProtocolFailure('UNSUPPORTED_VERSION', 'unknown chunk frame version');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const index = view.getUint16(21, false);
  const total = view.getUint16(23, false);
  const data = bytes.slice(HEADER_BYTES);
  if (total === 0 || total > MAX_CHUNKS) throw new ProtocolFailure('INVALID_INPUT', `chunk total ${total} out of range`);
  if (index >= total) throw new ProtocolFailure('INVALID_INPUT', 'chunk index is past the declared total');
  if (data.length === 0 || data.length > CHUNK_DATA_BYTES) throw new ProtocolFailure('INVALID_INPUT', 'chunk data size out of range');
  return { uploadId: bytes.slice(5, 21), index, total, data };
}

export function splitPayload(payload: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < payload.length; at += CHUNK_DATA_BYTES) {
    chunks.push(payload.subarray(at, at + CHUNK_DATA_BYTES));
  }
  if (chunks.length > MAX_CHUNKS) throw new ProtocolFailure('INVALID_INPUT', 'payload is too large to chunk');
  return chunks;
}

export const payloadHash = (payload: Uint8Array): Bytes32 => toHex(keccak_256(payload)) as Bytes32;

// ── the exit's reassembly store ───────────────────────────────────────────

export interface ChunkStoreOptions {
  /** Concurrent uploads. The exit cannot rate-limit by source — it never sees one. */
  readonly maxUploads?: number;
  /** Per upload. Matches the sealed-intent cap; nothing larger can be submitted anyway. */
  readonly maxUploadBytes?: number;
  /** Across every upload. Bounded memory is the only DoS defence available here. */
  readonly maxTotalBytes?: number;
  /** An upload never committed is evicted after this. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export type Reassembly =
  | { readonly kind: 'COMPLETE'; readonly payload: Uint8Array }
  | { readonly kind: 'MISSING'; readonly missing: readonly number[] };

interface Upload {
  total: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
  createdAt: number;
}

export class ChunkStore {
  readonly #uploads = new Map<string, Upload>();
  readonly #maxUploads: number;
  readonly #maxUploadBytes: number;
  readonly #maxTotalBytes: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #totalBytes = 0;

  constructor(options: ChunkStoreOptions = {}) {
    this.#maxUploads = options.maxUploads ?? 64;
    this.#maxUploadBytes = options.maxUploadBytes ?? 1280 * 1024;
    this.#maxTotalBytes = options.maxTotalBytes ?? 48 * 1024 * 1024;
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  get uploads(): number {
    return this.#uploads.size;
  }

  get bytes(): number {
    return this.#totalBytes;
  }

  #evictExpired(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, upload] of this.#uploads) {
      if (upload.createdAt < cutoff) this.#drop(id, upload);
    }
  }

  #drop(id: string, upload: Upload): void {
    this.#totalBytes -= upload.bytes;
    this.#uploads.delete(id);
  }

  put(frame: ChunkFrame): void {
    this.#evictExpired();
    const id = toHex(frame.uploadId);
    let upload = this.#uploads.get(id);
    if (upload === undefined) {
      // Retryable: the store is full now, not forever.
      if (this.#uploads.size >= this.#maxUploads) {
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'too many uploads in progress', true);
      }
      upload = { total: frame.total, parts: new Map(), bytes: 0, createdAt: this.#now() };
      this.#uploads.set(id, upload);
    }
    // One upload, one total. A second value would let a sender stitch two
    // different payloads under one id.
    if (frame.total !== upload.total) {
      throw new ProtocolFailure('INVALID_INPUT', 'chunk total disagrees with the upload');
    }
    const previous = upload.parts.get(frame.index);
    const delta = frame.data.length - (previous?.length ?? 0);
    if (upload.bytes + delta > this.#maxUploadBytes) {
      throw new ProtocolFailure('INVALID_INPUT', 'upload exceeds the size an intent may be');
    }
    if (this.#totalBytes + delta > this.#maxTotalBytes) {
      throw new ProtocolFailure('MESH_UNAVAILABLE', 'reassembly store is full', true);
    }
    // A resend of the same index replaces it. If the two differ, the payload
    // hash at commit is what refuses the result — nothing assembled from
    // inconsistent chunks can ever be submitted.
    upload.parts.set(frame.index, frame.data);
    upload.bytes += delta;
    this.#totalBytes += delta;
  }

  /**
   * Reassembles an upload the client has committed. COMPLETE only if every
   * chunk is present AND the result hashes to what the client committed to;
   * the upload is then released. MISSING keeps it, so the resends can land.
   */
  take(uploadId: Uint8Array, total: number, expectedHash: Bytes32): Reassembly {
    this.#evictExpired();
    const id = toHex(uploadId);
    const upload = this.#uploads.get(id);
    if (upload === undefined) {
      return { kind: 'MISSING', missing: Array.from({ length: total }, (_, i) => i) };
    }
    if (upload.total !== total) throw new ProtocolFailure('INVALID_INPUT', 'commit total disagrees with the upload');

    const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !upload.parts.has(i));
    if (missing.length > 0) return { kind: 'MISSING', missing };

    const payload = new Uint8Array(upload.bytes);
    let at = 0;
    for (let i = 0; i < total; i++) {
      const part = upload.parts.get(i)!;
      payload.set(part, at);
      at += part.length;
    }
    this.#drop(id, upload);
    if (payloadHash(payload) !== expectedHash) {
      throw new ProtocolFailure('INVALID_INPUT', 'reassembled payload does not match the committed hash');
    }
    return { kind: 'COMPLETE', payload };
  }
}

/** For the exit: hex back to bytes, from a commit's JSON. */
export const uploadIdFromHex = (value: string): Uint8Array => {
  const bytes = fromHex(value as `0x${string}`);
  if (bytes.length !== 16) throw new ProtocolFailure('INVALID_INPUT', 'upload id must be 16 bytes');
  return bytes;
};

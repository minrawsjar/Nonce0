import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure } from '@opaque/protocol-types';

import {
  CHUNK_DATA_BYTES,
  ChunkStore,
  MAX_CHUNKS,
  decodeChunkFrame,
  encodeChunkFrame,
  isChunkFrame,
  payloadHash,
  splitPayload,
} from '../chunks.ts';

const failure = (code: string) => (e: unknown) => e instanceof ProtocolFailure && e.code === code;
const id = (n: number) => new Uint8Array(16).fill(n);
const payload = (bytes: number, seed = 1) => Uint8Array.from({ length: bytes }, (_, i) => (i * 31 + seed) & 0xff);


// ── the frame ─────────────────────────────────────────────────────────────

test('a frame round-trips, and is never mistaken for JSON', () => {
  const frame = { uploadId: id(7), index: 3, total: 9, data: payload(100) };
  const bytes = encodeChunkFrame(frame);
  assert.ok(isChunkFrame(bytes));
  assert.deepEqual(decodeChunkFrame(bytes), frame);
  // The exit tells a chunk from a commit by this. JSON always starts with '{'.
  assert.equal(isChunkFrame(new TextEncoder().encode('{"commit":{}}')), false);
});

test('a frame from any client is decoded strictly', () => {
  const good = encodeChunkFrame({ uploadId: id(1), index: 0, total: 2, data: payload(10) });
  const at = (i: number, v: number) => { const b = Uint8Array.from(good); b[i] = v; return b; };
  assert.throws(() => decodeChunkFrame(at(4, 9)), failure('UNSUPPORTED_VERSION'));
  // index past total, total of zero, total past the cap
  assert.throws(() => decodeChunkFrame(encodeChunkFrame({ uploadId: id(1), index: 2, total: 2, data: payload(10) })), failure('INVALID_INPUT'));
  assert.throws(() => decodeChunkFrame(encodeChunkFrame({ uploadId: id(1), index: 0, total: 0, data: payload(10) })), failure('INVALID_INPUT'));
  assert.throws(() => decodeChunkFrame(encodeChunkFrame({ uploadId: id(1), index: 0, total: MAX_CHUNKS + 1, data: payload(10) })), failure('INVALID_INPUT'));
  assert.throws(() => decodeChunkFrame(encodeChunkFrame({ uploadId: id(1), index: 0, total: 1, data: payload(CHUNK_DATA_BYTES + 1) })), failure('INVALID_INPUT'));
});

// ── reassembly ────────────────────────────────────────────────────────────

test('a complete upload reassembles byte for byte, in order, whatever order it arrived', () => {
  const store = new ChunkStore();
  const data = payload(CHUNK_DATA_BYTES * 3 + 123);
  const parts = splitPayload(data);
  // Relays delay independently, so chunks land out of order.
  for (const index of [2, 0, 3, 1]) {
    store.put({ uploadId: id(1), index, total: parts.length, data: parts[index]! });
  }
  const done = store.take(id(1), parts.length, payloadHash(data));
  assert.equal(done.kind, 'COMPLETE');
  if (done.kind === 'COMPLETE') assert.deepEqual(done.payload, data);
  assert.equal(store.uploads, 0, 'released once complete');
  assert.equal(store.bytes, 0);
});

test('a missing chunk is reported by index, and the upload is kept for the resend', () => {
  const store = new ChunkStore();
  const data = payload(CHUNK_DATA_BYTES * 4);
  const parts = splitPayload(data);
  [0, 1, 3].forEach((index) => store.put({ uploadId: id(2), index, total: 4, data: parts[index]! }));
  assert.deepEqual(store.take(id(2), 4, payloadHash(data)), { kind: 'MISSING', missing: [2] });
  store.put({ uploadId: id(2), index: 2, total: 4, data: parts[2]! });
  assert.equal(store.take(id(2), 4, payloadHash(data)).kind, 'COMPLETE');
});

/// The property the payload hash exists for: a reassembly that is COMPLETE
/// but WRONG — a substituted chunk — must never become a submitted intent.
test('a reassembly that does not match the committed hash is refused', () => {
  const store = new ChunkStore();
  const data = payload(CHUNK_DATA_BYTES * 2);
  const parts = splitPayload(data);
  store.put({ uploadId: id(3), index: 0, total: 2, data: parts[0]! });
  store.put({ uploadId: id(3), index: 1, total: 2, data: payload(CHUNK_DATA_BYTES, 99) }); // not the real chunk 1
  assert.throws(() => store.take(id(3), 2, payloadHash(data)), failure('INVALID_INPUT'));
});

test('one upload, one total: a second value cannot stitch two payloads together', () => {
  const store = new ChunkStore();
  store.put({ uploadId: id(4), index: 0, total: 3, data: payload(10) });
  assert.throws(() => store.put({ uploadId: id(4), index: 1, total: 5, data: payload(10) }), failure('INVALID_INPUT'));
});

// ── bounds: the only DoS defence the exit has ─────────────────────────────

test('the store refuses new uploads when full, retryably', () => {
  const store = new ChunkStore({ maxUploads: 2 });
  store.put({ uploadId: id(5), index: 0, total: 2, data: payload(10) });
  store.put({ uploadId: id(6), index: 0, total: 2, data: payload(10) });
  assert.throws(
    () => store.put({ uploadId: id(7), index: 0, total: 2, data: payload(10) }),
    (e: unknown) => e instanceof ProtocolFailure && e.code === 'MESH_UNAVAILABLE' && e.retryable,
  );
});

test('total bytes across every upload are bounded', () => {
  const store = new ChunkStore({ maxTotalBytes: CHUNK_DATA_BYTES * 2 });
  store.put({ uploadId: id(8), index: 0, total: 4, data: payload(CHUNK_DATA_BYTES) });
  store.put({ uploadId: id(8), index: 1, total: 4, data: payload(CHUNK_DATA_BYTES) });
  assert.throws(() => store.put({ uploadId: id(8), index: 2, total: 4, data: payload(CHUNK_DATA_BYTES) }), failure('MESH_UNAVAILABLE'));
});

test('an upload larger than an intent may be is refused', () => {
  const store = new ChunkStore({ maxUploadBytes: CHUNK_DATA_BYTES });
  store.put({ uploadId: id(9), index: 0, total: 2, data: payload(CHUNK_DATA_BYTES) });
  assert.throws(() => store.put({ uploadId: id(9), index: 1, total: 2, data: payload(10) }), failure('INVALID_INPUT'));
});

test('an upload never committed is evicted, and its bytes returned', () => {
  let t = 0;
  const store = new ChunkStore({ ttlMs: 1_000, now: () => t });
  store.put({ uploadId: id(10), index: 0, total: 2, data: payload(500) });
  assert.equal(store.bytes, 500);
  t = 5_000;
  store.put({ uploadId: id(11), index: 0, total: 2, data: payload(10) }); // triggers eviction
  assert.equal(store.uploads, 1, 'the abandoned upload is gone');
  assert.equal(store.bytes, 10, 'and its memory with it');
});

test('a resend of the same chunk replaces it without double-counting bytes', () => {
  const store = new ChunkStore();
  store.put({ uploadId: id(12), index: 0, total: 1, data: payload(300) });
  store.put({ uploadId: id(12), index: 0, total: 1, data: payload(300) });
  assert.equal(store.bytes, 300);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ProtocolFailure, type Hex, type RelayId } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { createChannel, createDropStore, decodeRoute, encodeRoute, seal } from '../return-path.ts';

const DROP = 'R3' as RelayId;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const failure = (code: string) => (error: unknown) =>
  error instanceof ProtocolFailure && error.code === code;

/** Deterministic bytes, so a failure reproduces instead of being a coin flip. */
const fixedRandom = (fill: number) => (n: number): Uint8Array => new Uint8Array(n).fill(fill);

// ── the round trip ────────────────────────────────────────────────────────

test('hop 3 seals an answer the client alone can open', () => {
  const channel = createChannel(DROP);
  const answer = utf8(JSON.stringify({ kind: 'INTENT_STATUS', value: 'SUBMITTED' }));
  assert.equal(text(channel.open(seal(channel.responseKey, answer))), text(answer));
});

test('the route round-trips, and names the drop the client chose', () => {
  const channel = createChannel(DROP);
  assert.deepEqual(decodeRoute(channel.returnRoute), { dropRelay: DROP, dropId: channel.dropId });
});

test('a reply is sealed to ONE channel and is useless to any other', () => {
  const mine = createChannel(DROP);
  const theirs = createChannel(DROP);
  const sealed = seal(mine.responseKey, utf8('the answer'));
  // Not "fails to parse" — ML-KEM decapsulation is implicit-rejection, so a
  // wrong key yields a well-formed shared secret and the GCM tag is what
  // actually refuses. This is the test that the tag is really being checked.
  assert.throws(() => theirs.open(sealed), failure('INVALID_INPUT'));
});

test('two channels never share a key or a drop id', () => {
  const a = createChannel(DROP);
  const b = createChannel(DROP);
  // Reuse would let the relay that saw both drops know they were one client.
  assert.notEqual(a.responseKey, b.responseKey);
  assert.notEqual(a.dropId, b.dropId);
});

test('sealing the same body twice produces different bytes', () => {
  const channel = createChannel(DROP);
  const body = utf8('same answer');
  // A deterministic seal would let a relay recognise a repeated answer, which
  // for a status reply is most of the information in it.
  assert.notEqual(seal(channel.responseKey, body), seal(channel.responseKey, body));
});

test('an injected random makes a channel reproducible', () => {
  const a = createChannel(DROP, fixedRandom(7));
  const b = createChannel(DROP, fixedRandom(7));
  assert.equal(a.responseKey, b.responseKey);
  assert.equal(a.dropId, b.dropId);
  assert.notEqual(createChannel(DROP, fixedRandom(8)).dropId, a.dropId);
});

// ── tampering ─────────────────────────────────────────────────────────────

test('every part of a sealed reply is authenticated', () => {
  const channel = createChannel(DROP);
  const sealed = fromHex(seal(channel.responseKey, utf8('a'.repeat(64))));
  // The KEM ciphertext, the nonce, the body and the tag in turn.
  for (const at of [0, 1100, 1120, sealed.length - 1]) {
    const edited = Uint8Array.from(sealed);
    edited[at] = edited[at]! ^ 1;
    assert.throws(() => channel.open(toHex(edited)), failure('INVALID_INPUT'), `byte ${at}`);
  }
});

test('a truncated reply is refused rather than read past its end', () => {
  const channel = createChannel(DROP);
  const sealed = fromHex(seal(channel.responseKey, utf8('body')));
  assert.throws(() => channel.open(toHex(sealed.subarray(0, 100))), failure('INVALID_INPUT'));
  assert.throws(() => channel.open('0x' as Hex), failure('INVALID_INPUT'));
});

test('a response key of the wrong length is refused before encapsulation', () => {
  assert.throws(() => seal('0xaabb' as Hex, utf8('x')), failure('INVALID_INPUT'));
});

// ── the route is untrusted input ──────────────────────────────────────────

test('a malformed route is refused, because dropRelay decides where hop 3 goes', () => {
  const bad: string[] = [
    'not json',
    '"a string"',
    'null',
    JSON.stringify({ dropRelay: '', dropId: 'a'.repeat(32) }),
    JSON.stringify({ dropRelay: 'R'.repeat(33), dropId: 'a'.repeat(32) }),
    JSON.stringify({ dropRelay: 'R3' }),
    JSON.stringify({ dropRelay: 'R3', dropId: 'nothex' }),
    JSON.stringify({ dropRelay: 'R3', dropId: 'a'.repeat(31) }),
    JSON.stringify({ dropRelay: 'R3', dropId: 'A'.repeat(32) }), // upper case is not canonical
    JSON.stringify({ dropRelay: 3, dropId: 'a'.repeat(32) }),
  ];
  for (const body of bad) {
    assert.throws(() => decodeRoute(toHex(utf8(body))), failure('INVALID_INPUT'), body);
  }
});

test('the route carries no hint of the response key', () => {
  const channel = createChannel(DROP);
  const route = text(fromHex(channel.returnRoute));
  assert.equal(route.includes(channel.responseKey.slice(2, 34)), false);
  assert.deepEqual(Object.keys(JSON.parse(route)).sort(), ['dropId', 'dropRelay']);
});

test('a route encoded by hand decodes to the same target', () => {
  const target = { dropRelay: 'R1' as RelayId, dropId: 'b'.repeat(32) };
  assert.deepEqual(decodeRoute(encodeRoute(target)), target);
});

// ── the drop store ────────────────────────────────────────────────────────

const someSealed = '0xdeadbeef' as Hex;
const id = (c: string): string => c.repeat(32);

test('a drop is write-once and single-use', () => {
  const store = createDropStore({ maxDrops: 4 });
  store.put(id('1'), someSealed, 100n);
  // Overwriting would let anyone who guesses a drop id replace a real answer.
  assert.throws(() => store.put(id('1'), '0xbeef' as Hex, 100n), failure('INVALID_INPUT'));
  assert.equal(store.take(id('1'), 50n), someSealed);
  assert.equal(store.take(id('1'), 50n), undefined);
  assert.equal(store.size, 0);
});

test('collecting an unknown drop is indistinguishable from collecting an empty one', () => {
  const store = createDropStore({ maxDrops: 4 });
  assert.equal(store.take(id('9'), 1n), undefined);
});

test('an expired drop cannot be collected, and does not linger', () => {
  const store = createDropStore({ maxDrops: 4 });
  store.put(id('2'), someSealed, 100n);
  assert.equal(store.take(id('2'), 100n), undefined);
  assert.equal(store.size, 0, 'removed on the way out, not left for a second attempt');
});

test('sweep clears only what is dead', () => {
  const store = createDropStore({ maxDrops: 4 });
  store.put(id('3'), someSealed, 100n);
  store.put(id('4'), someSealed, 300n);
  store.sweep(200n);
  assert.equal(store.size, 1);
  assert.equal(store.take(id('4'), 200n), someSealed);
});

test('a full store sweeps the dead, then refuses retryably rather than evicting a live drop', () => {
  const store = createDropStore({ maxDrops: 2 });
  store.put(id('5'), someSealed, 100n);
  store.put(id('6'), someSealed, 500n);
  // Nothing dead at t=50: refuse, do not discard an answer someone awaits.
  assert.throws(() => store.put(id('7'), someSealed, 50n), (error: unknown) =>
    error instanceof ProtocolFailure && error.code === 'MESH_UNAVAILABLE' && error.retryable);
  // At t=200 the first is dead, so the sweep makes room without losing a live one.
  store.put(id('7'), someSealed, 200n);
  assert.equal(store.take(id('6'), 200n), someSealed);
});

test('the store validates ids and bounds a reply, so one message cannot fill it', () => {
  const store = createDropStore({ maxDrops: 2 });
  assert.throws(() => store.put('nope', someSealed, 100n), failure('INVALID_INPUT'));
  const huge = toHex(new Uint8Array(256 * 1024 + 1));
  assert.throws(() => store.put(id('8'), huge, 100n), failure('INVALID_INPUT'));
  assert.throws(() => createDropStore({ maxDrops: 0 }), failure('INVALID_INPUT'));
});

// ── end to end ────────────────────────────────────────────────────────────

test('the full return path: client asks, hop 3 deposits, client collects later', () => {
  const store = createDropStore({ maxDrops: 8 }); // held by the drop relay
  const channel = createChannel(DROP); // client side

  // Hop 3 reads the innermost payload and knows only these two fields.
  const target = decodeRoute(channel.returnRoute);
  assert.equal(target.dropRelay, DROP);
  store.put(target.dropId, seal(channel.responseKey, utf8('CONFIRMED')), 900n);

  // The client collects over a FRESH path, with the drop id as its only
  // credential — there is no "reply for intent X" lookup to correlate on.
  const collected = store.take(channel.dropId, 100n);
  assert.notEqual(collected, undefined);
  assert.equal(text(channel.open(collected!)), 'CONFIRMED');
  // Single-use: the credential is spent, so a relay replaying it gets nothing.
  assert.equal(store.take(channel.dropId, 100n), undefined);
});

// §7.1 verification: fixed windows, bounded random delay, a bounded queue that
// refuses rather than drops, queue ids that cannot be joined to hop-local ids,
// expired messages dropped instead of released, and a release order that is
// uniformly random rather than arrival order with a bit of noise on top.
//
// Every clock and every random source is injected, so nothing here is timing
// dependent and the statistical tests are deterministic runs of a seeded RNG.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { ProtocolFailure, type RelayId } from '@opaque/protocol-types';
import { encodeBigint } from '@opaque/protocol-types/codecs.js';

import { createBatchScheduler } from '../scheduler.ts';
import type { SchedulerOptions } from '../contracts.ts';
import {
  MESH_VERSION,
  buildOnion,
  generateRelayKeypair,
  type MeshEnvelope,
  type PathHop,
} from '../transport.ts';

// T0 is an exact multiple of 1000ms, so the window boundary cases are exact.
const T0 = 1_760_000_000_000n;
const EXPIRY_S = 1_760_000_300n; // T0 + 300s, in the seconds the frame carries.

const env = (over: Partial<MeshEnvelope> = {}): MeshEnvelope => ({
  version: MESH_VERSION,
  hopLocalId: randomBytes(16).toString('hex'),
  hopId: 'N1' as RelayId,
  keyEpoch: '7',
  expiresAt: encodeBigint(EXPIRY_S),
  kemCiphertext: '0x00',
  nonce: '0x00',
  ciphertext: '0x00',
  ...over,
});

/** A hop-local id that encodes an arrival index, so order is checkable. */
const marked = (i: number): string => i.toString(16).padStart(32, '0');
const indexOf = (envelope: MeshEnvelope): number => Number.parseInt(envelope.hopLocalId, 16);

const scheduler = (over: Partial<SchedulerOptions> = {}) =>
  createBatchScheduler({
    batchWindowMs: 1_000,
    maxExtraDelayMs: 0,
    maxQueue: 16,
    random: () => 0,
    ...over,
  });

/** mulberry32 — seeded so a statistical assertion is a fixed run, not a flake. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ProtocolFailure).code ?? 'THREW';
  }
  return 'NO_THROW';
};

// ── fixed windows ─────────────────────────────────────────────────────────

test('a message is released at the end of its window, not when it arrived', () => {
  const s = scheduler();
  assert.equal(s.offer(env(), 'N2' as RelayId, T0 + 250n), true);

  assert.equal(s.drain(T0 + 250n).length, 0, 'an instant forward is the correlation this prevents');
  assert.equal(s.drain(T0 + 999n).length, 0, 'still inside the window');
  assert.equal(s.size, 1);

  const out = s.drain(T0 + 1_000n);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.acceptedAt, T0 + 250n);
  assert.equal(out[0]!.releaseAt, T0 + 1_000n);
  assert.equal(out[0]!.next, 'N2' as RelayId);
});

test('a message that arrives exactly on a boundary waits for the NEXT window', () => {
  const s = scheduler();
  s.offer(env(), null, T0);
  assert.equal(s.drain(T0).length, 0, 'a boundary arrival must not be released with zero delay');
  const out = s.drain(T0 + 1_000n);
  assert.equal(out[0]!.releaseAt, T0 + 1_000n);
  assert.equal(out[0]!.next, null, 'null next survives: this relay is the final hop');
});

test('two windows drain as two batches, never merged into one', () => {
  const s = scheduler();
  s.offer(env({ hopLocalId: marked(1) }), null, T0 + 100n);
  s.offer(env({ hopLocalId: marked(2) }), null, T0 + 1_500n);

  const first = s.drain(T0 + 1_000n);
  assert.deepEqual(first.map((m) => indexOf(m.envelope)), [1]);
  assert.equal(s.size, 1, 'the later window is still held');

  const second = s.drain(T0 + 2_000n);
  assert.deepEqual(second.map((m) => indexOf(m.envelope)), [2]);
  assert.equal(s.size, 0);
});

test('the extra delay stays within [0, maxExtraDelayMs] and reaches both ends', () => {
  const windowClose = T0 + 1_000n;
  const delayFor = (draw: number): bigint => {
    const s = scheduler({ maxExtraDelayMs: 400, random: () => draw });
    s.offer(env(), null, T0 + 10n);
    return s.drain(T0 + 100_000n)[0]!.releaseAt - windowClose;
  };

  assert.equal(delayFor(0), 0n, 'the low end is reachable');
  assert.equal(delayFor(0.999_999), 400n, 'and so is the high end, inclusively');
  for (const draw of [0.25, 0.5, 0.75]) {
    const delay = delayFor(draw);
    assert.ok(delay >= 0n && delay <= 400n, `delay ${delay} escaped its bound`);
  }
});

test('a broken injected random cannot push a delay out of range or lose a message', () => {
  for (const hostile of [() => 1.5, () => -3, () => Number.NaN]) {
    const s = scheduler({ maxExtraDelayMs: 400, random: hostile });
    for (let i = 0; i < 5; i++) s.offer(env({ hopLocalId: marked(i) }), null, T0);

    const out = s.drain(T0 + 100_000n);
    assert.equal(out.length, 5, 'a bad random index must never drop a message');
    assert.equal(new Set(out.map((m) => indexOf(m.envelope))).size, 5, 'nor duplicate one');
    for (const m of out) {
      const delay = m.releaseAt - (T0 + 1_000n);
      assert.ok(delay >= 0n && delay <= 400n, `delay ${delay} escaped its bound`);
    }
  }
});

// ── the bounded queue ─────────────────────────────────────────────────────

test('offer returns false at maxQueue instead of dropping silently', () => {
  const s = scheduler({ maxQueue: 2 });
  assert.equal(s.offer(env(), null, T0), true);
  assert.equal(s.offer(env(), null, T0), true);

  // A silent drop is indistinguishable from delivery to the sender, so the
  // caller has to be told in order to reject retryably.
  assert.equal(s.offer(env(), null, T0), false);
  assert.equal(s.size, 2, 'a refused message never occupies a slot');

  assert.equal(s.drain(T0 + 1_000n).length, 2);
  assert.equal(s.size, 0);
  assert.equal(s.offer(env(), null, T0 + 1_000n), true, 'capacity comes back after a drain');
});

test('drain removes what it returns', () => {
  const s = scheduler();
  s.offer(env(), null, T0);
  s.offer(env(), null, T0);
  assert.equal(s.drain(T0 + 1_000n).length, 2);
  assert.equal(s.drain(T0 + 1_000n).length, 0, 'a drained message is gone, not re-released');
  assert.equal(s.size, 0);
});

test('the options that bound the queue are validated at construction', () => {
  assert.equal(code(() => scheduler({ batchWindowMs: 0 })), 'INVALID_INPUT');
  assert.equal(code(() => scheduler({ batchWindowMs: -1_000 })), 'INVALID_INPUT');
  assert.equal(code(() => scheduler({ batchWindowMs: 1.5 })), 'INVALID_INPUT');
  assert.equal(code(() => scheduler({ maxExtraDelayMs: -1 })), 'INVALID_INPUT');
  assert.equal(code(() => scheduler({ maxQueue: 0 })), 'INVALID_INPUT', 'an unbounded queue is a memory oracle');
});

// ── property 1: a queue id is local ───────────────────────────────────────

test('a queue id is never the hop-local id and is not derived from it', () => {
  const hopLocalId = 'a'.repeat(32);
  const shared = env({ hopLocalId });

  // The SAME envelope twice: if a queue id were any function of the envelope,
  // these two would match.
  const s = scheduler({ maxQueue: 4, random: seeded(1) });
  s.offer(shared, null, T0);
  s.offer(shared, null, T0);
  const [a, b] = s.drain(T0 + 1_000n);
  assert.ok(a && b);
  assert.notEqual(a.queueId, b.queueId, 'a queue id must not be a function of the envelope');

  // A second scheduler driven by an identical seeded stream: if a queue id
  // came out of the injected random, these would match too.
  const twin = scheduler({ maxQueue: 4, random: seeded(1) });
  twin.offer(shared, null, T0);
  const [c] = twin.drain(T0 + 1_000n);
  assert.ok(c);
  assert.notEqual(a.queueId, c.queueId, 'nor a function of the injected randomness');

  for (const m of [a, b, c]) {
    assert.notEqual(m.queueId, hopLocalId, 'two operators comparing these must learn nothing');
    assert.ok(!m.queueId.includes(hopLocalId), 'a queue id must not contain the hop-local id');
    assert.ok(!hopLocalId.includes(m.queueId), 'nor be a slice of it');
    assert.ok(!JSON.stringify(m.envelope).includes(m.queueId), 'and it must not be on the wire');
  }
});

test('every queue id in a batch is distinct', () => {
  const s = scheduler({ maxQueue: 64, random: seeded(3) });
  for (let i = 0; i < 64; i++) s.offer(env({ hopLocalId: marked(i) }), null, T0);
  const ids = new Set(s.drain(T0 + 1_000n).map((m) => m.queueId));
  assert.equal(ids.size, 64);
});

// ── expiry ────────────────────────────────────────────────────────────────

test('a message that expires while queued is dropped, not released', () => {
  // Expires at T0 + 1s, but its window does not close until T0 + 5s.
  const dying = env({ expiresAt: encodeBigint(EXPIRY_S - 299n), hopLocalId: marked(1) });
  const s = scheduler({ batchWindowMs: 5_000 });

  assert.equal(s.offer(dying, null, T0), true, 'it was live when it arrived');
  assert.equal(s.offer(env({ hopLocalId: marked(2) }), null, T0), true);

  const out = s.drain(T0 + 5_000n);
  assert.deepEqual(out.map((m) => indexOf(m.envelope)), [2], 'an expired message is never forwarded');
  assert.equal(s.expired, 1, 'and expired is observable — it is not the same as delivered');
  assert.equal(s.size, 0, 'it is removed rather than held forever');

  assert.equal(s.drain(T0 + 10_000n).length, 0);
  assert.equal(s.expired, 1, 'counted once');
});

test('an already-expired envelope is refused before it can take a slot', () => {
  const s = scheduler();
  const dead = env({ expiresAt: encodeBigint(EXPIRY_S) });

  // Exactly at expiry is expired, matching peelLayer.
  assert.equal(code(() => s.offer(dead, null, EXPIRY_S * 1_000n)), 'EXPIRED');
  assert.equal(code(() => s.offer(dead, null, EXPIRY_S * 1_000n + 1n)), 'EXPIRED');
  assert.equal(s.size, 0, 'validation happens before queueing, so no slot was spent');
});

test('a non-canonical expiry is rejected rather than coerced', () => {
  const s = scheduler();
  assert.equal(code(() => s.offer(env({ expiresAt: '0042' }), null, T0)), 'INVALID_INPUT');
  assert.equal(code(() => s.offer(env({ expiresAt: 'soon' }), null, T0)), 'INVALID_INPUT');
  assert.equal(s.size, 0);
});

// ── randomised release order ──────────────────────────────────────────────

test('300 messages come out in a genuinely different order, each inside its window', () => {
  const total = 300;
  const maxExtraDelayMs = 400;
  const s = createBatchScheduler({
    batchWindowMs: 1_000,
    maxExtraDelayMs,
    maxQueue: total,
    random: seeded(42),
  });

  // Arrivals spread over ~6 windows, in a strictly fixed order.
  for (let i = 0; i < total; i++) {
    assert.equal(s.offer(env({ hopLocalId: marked(i) }), null, T0 + BigInt(i) * 17n), true);
  }

  const out = s.drain(T0 + 60_000n);
  assert.equal(out.length, total, 'everything due comes out');

  const order = out.map((m) => indexOf(m.envelope));
  assert.equal(new Set(order).size, total, 'nothing lost, nothing duplicated');

  // Every release lands in [windowClose, windowClose + maxExtraDelayMs].
  const delays: number[] = [];
  for (const m of out) {
    const close = m.acceptedAt - (m.acceptedAt % 1_000n) + 1_000n;
    assert.ok(m.releaseAt >= close, `released ${close - m.releaseAt}ms before its window closed`);
    assert.ok(m.releaseAt <= close + BigInt(maxExtraDelayMs), 'released past its bounded delay');
    delays.push(Number(m.releaseAt - close));
  }

  // Arrival order must not survive: in a uniform permutation the expected
  // number of messages still sitting at their arrival index is 1.
  const fixed = order.filter((arrival, at) => arrival === at).length;
  assert.ok(fixed <= 5, `${fixed} of ${total} kept their arrival position — that is not a shuffle`);

  // The delay is spread across its whole range, not clustered at one end.
  const mean = delays.reduce((sum, d) => sum + d, 0) / total;
  assert.ok(Math.abs(mean - maxExtraDelayMs / 2) < 30, `mean delay ${mean} is not centred`);
  assert.ok(Math.min(...delays) < 40 && Math.max(...delays) > 360, 'the delay does not use its range');
  const lower = delays.filter((d) => d < maxExtraDelayMs / 2).length;
  assert.ok(lower > 110 && lower < 190, `${lower} of ${total} in the lower half is not uniform`);
});

test('the shuffle is uniform over all orderings, not a biased comparator sort', () => {
  // A `sort(() => random() - 0.5)` shuffle fails this: with four elements it
  // leaves several of the 24 orderings far off 1/24, and favours the input.
  const rounds = 2_400;
  const s = scheduler({ maxQueue: 8, random: seeded(7) });
  const counts = new Map<string, number>();

  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < 4; i++) s.offer(env({ hopLocalId: marked(i) }), null, T0);
    const out = s.drain(T0 + 1_000n);
    assert.equal(out.length, 4);
    const key = out.map((m) => indexOf(m.envelope)).join('');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  assert.equal(counts.size, 24, 'every ordering of four must occur');
  const expected = rounds / 24; // 100; sd ~9.8, so this band is over 5 sigma.
  for (const [ordering, seen] of counts) {
    assert.ok(seen > 55 && seen < 155, `ordering ${ordering} occurred ${seen} times, expected ~${expected}`);
  }
});

// ── against the real transport ────────────────────────────────────────────

test('a real onion queues and drains byte-identical', () => {
  const relays = (['N1', 'N2', 'N3'] as RelayId[]).map((id) => ({ id, keys: generateRelayKeypair(7n) }));
  const path = relays.map((r) => ({
    id: r.id,
    kemPublicKey: r.keys.publicKey,
    keyEpoch: r.keys.keyEpoch,
  })) as unknown as readonly [PathHop, PathHop, PathHop];

  const onion = buildOnion({
    path,
    payload: { kind: 'PAYMENT', body: '0xdeadbeef' },
    expiresAt: EXPIRY_S,
  });

  const s = scheduler();
  assert.equal(s.offer(onion, 'N2' as RelayId, T0 + 1n), true);
  const out = s.drain(T0 + 1_000n);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.envelope, onion, 'the queue never rewrites a layer');
  assert.notEqual(out[0]!.queueId, onion.hopLocalId);
});

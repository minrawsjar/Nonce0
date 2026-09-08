// T10 verification: key substitution, stale directory, header tamper, replay,
// malformed/expired packet, direct unauthenticated status access and
// arbitrary/redirected URL reject; allowed logs cannot be joined using a
// common end-to-end ID.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProtocolFailure, type Hex, type RelayId } from '@opaque/protocol-types';
import {
  DEFAULT_SIZE_CLASS,
  MemoryReplayCache,
  buildOnion,
  generateRelayKeypair,
  peelLayer,
  resolveEgress,
  type FinalPayload,
  type MeshEnvelope,
  type PathHop,
} from '../transport.ts';

const NOW = 1_760_000_000n;
const EXPIRY = NOW + 300n;

function mesh() {
  const relays = (['N1', 'N2', 'N3'] as RelayId[]).map((id) => ({ id, keys: generateRelayKeypair(7n) }));
  const path = relays.map((r) => ({ id: r.id, kemPublicKey: r.keys.publicKey, keyEpoch: r.keys.keyEpoch }));
  return { relays, path: path as unknown as readonly [PathHop, PathHop, PathHop] };
}

/** Drive an envelope through all three hops, as the relays would. */
function route(net: ReturnType<typeof mesh>, outer: MeshEnvelope, now = NOW) {
  const caches = net.relays.map(() => new MemoryReplayCache());
  let envelope = outer;
  const seenIds: string[] = [];

  for (let hop = 0; hop < 3; hop++) {
    const relay = net.relays[hop]!;
    seenIds.push(envelope.hopLocalId);
    const result = peelLayer({
      envelope,
      hopId: relay.id,
      secretKey: relay.keys.secretKey,
      keyEpoch: relay.keys.keyEpoch,
      now,
      replayCache: caches[hop]!,
    });
    if (result.kind === 'FINAL') return { payload: result.payload, seenIds, hops: hop + 1 };
    envelope = result.envelope;
  }
  throw new Error('never reached the final hop');
}

const PAYMENT: FinalPayload = { kind: 'PAYMENT', body: '0xdeadbeef' };
const QUERY: FinalPayload = {
  kind: 'QUERY',
  body: '0xc0ffee',
  responseKey: '0xaabb',
  returnRoute: '0x1122',
};

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ProtocolFailure).code ?? 'THREW';
  }
  return 'NO_THROW';
};

// ── the happy path ────────────────────────────────────────────────────────

test('a payment survives three hops and arrives intact', () => {
  const net = mesh();
  const out = route(net, buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY }));
  assert.equal(out.hops, 3);
  assert.deepEqual(out.payload, PAYMENT);
});

test('a query carries its return route to the last hop only', () => {
  const net = mesh();
  const out = route(net, buildOnion({ path: net.path, payload: QUERY, expiresAt: EXPIRY }));
  assert.deepEqual(out.payload, QUERY);
});

// ── property 1: no end-to-end identifier ──────────────────────────────────

test('the three hops share no identifier that could join their logs', () => {
  const net = mesh();
  const out = route(net, buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY }));
  assert.equal(out.seenIds.length, 3);
  assert.equal(new Set(out.seenIds).size, 3, 'each hop must log a different id');
});

test('the outer id appears nowhere in the bytes a later hop receives', () => {
  const net = mesh();
  const outer = buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY });
  const second = peelLayer({
    envelope: outer,
    hopId: net.relays[0]!.id,
    secretKey: net.relays[0]!.keys.secretKey,
    keyEpoch: 7n,
    now: NOW,
    replayCache: new MemoryReplayCache(),
  });
  assert.equal(second.kind, 'FORWARD');
  if (second.kind !== 'FORWARD') return;
  assert.ok(
    !JSON.stringify(second.envelope).includes(outer.hopLocalId),
    'hop 2 must not be able to see hop 1s identifier',
  );
});

// ── property 2: the kind is invisible until the end ───────────────────────

test('an intermediate relay cannot tell a payment from a query', () => {
  const net = mesh();
  const seen = (payload: FinalPayload) => {
    const outer = buildOnion({ path: net.path, payload, expiresAt: EXPIRY });
    const first = peelLayer({
      envelope: outer,
      hopId: net.relays[0]!.id,
      secretKey: net.relays[0]!.keys.secretKey,
      keyEpoch: 7n,
      now: NOW,
      replayCache: new MemoryReplayCache(),
    });
    assert.equal(first.kind, 'FORWARD');
    return first.kind === 'FORWARD' ? JSON.stringify(first.envelope) : '';
  };

  const fromPayment = seen(PAYMENT);
  const fromQuery = seen(QUERY);
  for (const marker of ['PAYMENT', 'QUERY', 'responseKey', 'returnRoute']) {
    assert.ok(!fromPayment.includes(marker), `hop 1 leaked "${marker}" for a payment`);
    assert.ok(!fromQuery.includes(marker), `hop 1 leaked "${marker}" for a query`);
  }
  assert.equal(fromPayment.length, fromQuery.length, 'and they must be the same length');
});

// ── property 3: padding ───────────────────────────────────────────────────

test('payments and queries are byte-identical in length at every hop', () => {
  const net = mesh();
  const a = buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY });
  const b = buildOnion({ path: net.path, payload: QUERY, expiresAt: EXPIRY });
  assert.equal(a.ciphertext.length, b.ciphertext.length);

  // A much larger body inside the same class is still the same size on the wire.
  const fat: FinalPayload = { kind: 'PAYMENT', body: `0x${'ab'.repeat(20_000)}` as Hex };
  const c = buildOnion({ path: net.path, payload: fat, expiresAt: EXPIRY });
  assert.equal(c.ciphertext.length, a.ciphertext.length);
});

test('a payload that overflows its size class is refused, not silently truncated', () => {
  const net = mesh();
  const huge: FinalPayload = { kind: 'PAYMENT', body: `0x${'ab'.repeat(40_000)}` as Hex };
  assert.equal(
    code(() => buildOnion({ path: net.path, payload: huge, expiresAt: EXPIRY, sizeClass: 4_096 })),
    'INVALID_INPUT',
  );
  assert.equal(DEFAULT_SIZE_CLASS, 65_536, 'the default is the largest class, so kinds cannot be told apart');
});

// ── property 4: authenticated headers ─────────────────────────────────────

test('every header field is authenticated', () => {
  const net = mesh();
  const relay = net.relays[0]!;
  const base = buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY });

  const peel = (envelope: MeshEnvelope, over: Partial<Parameters<typeof peelLayer>[0]> = {}) =>
    peelLayer({
      envelope,
      hopId: relay.id,
      secretKey: relay.keys.secretKey,
      keyEpoch: 7n,
      now: NOW,
      replayCache: new MemoryReplayCache(),
      ...over,
    });

  assert.equal(code(() => peel(base)), 'NO_THROW', 'the untampered envelope opens');

  // Extending the expiry keeps a dead message alive; it must break the tag.
  assert.equal(
    code(() => peel({ ...base, expiresAt: String(EXPIRY + 86_400n) })),
    'INVALID_INPUT',
    'expiry is covered by the AAD',
  );
  assert.equal(code(() => peel({ ...base, hopLocalId: 'f'.repeat(32) })), 'INVALID_INPUT', 'hop-local id');
  assert.equal(code(() => peel({ ...base, ciphertext: `0x00${base.ciphertext.slice(4)}` as Hex })), 'INVALID_INPUT');
});

test('key substitution and a stale directory both fail closed', () => {
  const net = mesh();
  const base = buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY });
  const relay = net.relays[0]!;
  const impostor = generateRelayKeypair(7n);

  // Someone else's ML-KEM key: decapsulation yields a wrong shared secret and
  // the AEAD tag — not the KEM — is what rejects it.
  assert.equal(
    code(() =>
      peelLayer({
        envelope: base,
        hopId: relay.id,
        secretKey: impostor.secretKey,
        keyEpoch: 7n,
        now: NOW,
        replayCache: new MemoryReplayCache(),
      }),
    ),
    'INVALID_INPUT',
  );

  // The relay rotated to epoch 8; a layer sealed to epoch 7 is stale.
  assert.equal(
    code(() =>
      peelLayer({
        envelope: base,
        hopId: relay.id,
        secretKey: relay.keys.secretKey,
        keyEpoch: 8n,
        now: NOW,
        replayCache: new MemoryReplayCache(),
      }),
    ),
    'UNTRUSTED_DIRECTORY',
  );
});

test('misdelivery, expiry and replay each reject', () => {
  const net = mesh();
  const base = buildOnion({ path: net.path, payload: PAYMENT, expiresAt: EXPIRY });
  const relay = net.relays[0]!;
  const shared = new MemoryReplayCache();
  const peel = (over: Record<string, unknown> = {}) =>
    peelLayer({
      envelope: base,
      hopId: relay.id,
      secretKey: relay.keys.secretKey,
      keyEpoch: 7n,
      now: NOW,
      replayCache: shared,
      ...over,
    } as Parameters<typeof peelLayer>[0]);

  assert.equal(code(() => peel({ hopId: 'N2' as RelayId })), 'INVALID_INPUT', 'addressed elsewhere');
  assert.equal(code(() => peel({ now: EXPIRY })), 'EXPIRED', 'exactly at expiry');
  assert.equal(code(() => peel({ now: EXPIRY + 1n })), 'EXPIRED');

  assert.equal(code(() => peel()), 'NO_THROW', 'first delivery');
  assert.equal(code(() => peel()), 'INVALID_INPUT', 'second delivery of the same layer');
});

test('the replay cache survives a restart', () => {
  const first = new MemoryReplayCache();
  assert.equal(first.seen('abc', EXPIRY), false);

  const restarted = new MemoryReplayCache(100_000, first.entries());
  assert.equal(restarted.seen('abc', EXPIRY), true, 'a restart must not reopen the replay window');
});

test('the replay cache refuses to evict live entries under pressure', () => {
  const cache = new MemoryReplayCache(2);
  const far = BigInt(Math.floor(Date.now() / 1000)) + 3_600n;
  cache.seen('a', far);
  cache.seen('b', far);
  // Dropping 'a' to make room for 'c' would let 'a' be replayed. Refusing is
  // a retryable outage; silently forgetting is a security failure.
  assert.equal(code(() => cache.seen('c', far)), 'MESH_UNAVAILABLE');
});

// ── egress ────────────────────────────────────────────────────────────────

test('the final hop reaches only named operations, never a supplied URL', () => {
  const allow = new Map([['RING_SNAPSHOT', 'https://graph.internal/subgraphs/ring']]);
  assert.equal(resolveEgress(allow, 'RING_SNAPSHOT'), 'https://graph.internal/subgraphs/ring');
  assert.equal(code(() => resolveEgress(allow, 'ARBITRARY')), 'INVALID_INPUT');
  assert.equal(code(() => resolveEgress(allow, 'https://evil.example/steal')), 'INVALID_INPUT');
});

// ── loops ─────────────────────────────────────────────────────────────────

test('a path that repeats a relay is refused at build time', () => {
  const net = mesh();
  const looped = [net.path[0], net.path[1], net.path[0]] as unknown as readonly [PathHop, PathHop, PathHop];
  assert.equal(
    code(() => buildOnion({ path: looped, payload: PAYMENT, expiresAt: EXPIRY })),
    'INSUFFICIENT_RELAYS',
  );
});

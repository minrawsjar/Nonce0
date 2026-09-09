import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { ProtocolFailure, type Hex, type RelayId } from '@opaque/protocol-types';

import { deterministicDirectory } from '../directory.ts';
import { createChannel } from '../return-path.ts';
import { createRelay, type Relay } from '../server.ts';
import { toPath } from '../directory.ts';
import { buildOnion, encodeFrame } from '../transport.ts';
import type { FinalPayload, MeshMessageKind } from '../transport.ts';

const { directory, relays } = deterministicDirectory('server');
const NOW_MS = 1_760_003_600_000n; // inside the directory's window, in ms
const NOW_S = (NOW_MS / 1000n) as unknown as bigint;
const ids = relays.map((r) => r.id) as unknown as readonly [RelayId, RelayId, RelayId];
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const EGRESS = new Map<MeshMessageKind, string>([
  ['PAYMENT', 'https://executor.invalid/submit'],
  ['QUERY', 'https://graph.invalid/query'],
]);

/**
 * Three relays wired to each other through an in-process `deliver`, so the
 * routing is real but the sockets are not. The HTTP surface gets its own test
 * below; this one is about whether a message actually crosses three hops.
 */
function mesh(overrides: Partial<Parameters<typeof createRelay>[0]> = {}) {
  const seen: FinalPayload[] = [];
  const built = new Map<RelayId, Relay>();

  const deliver = async (url: string, body: Uint8Array): Promise<void> => {
    const target = directory.entries.find((e) => e.endpoint === url);
    assert.notEqual(target, undefined, `deliver to an unknown endpoint: ${url}`);
    await post(built.get(target!.id)!, body);
  };
  const callEgress = async (_url: string, payload: FinalPayload): Promise<Uint8Array> => {
    seen.push(payload);
    return utf8('CONFIRMED');
  };

  for (const relay of relays) {
    built.set(
      relay.id,
      createRelay({
        relayId: relay.id,
        secretKey: relay.secretKey,
        keyEpoch: relay.keyEpoch,
        directory,
        egress: EGRESS,
        // No jitter and a 1ms window: these tests assert routing, and the
        // scheduler's own suite already covers the delay.
        batchWindowMs: 1,
        maxExtraDelayMs: 0,
        random: () => 0,
        now: () => NOW_MS,
        deliver,
        callEgress,
        ...overrides,
      }),
    );
  }
  return { built, seen };
}

/** Feeds a frame straight into a relay's handler, with no socket in between. */
async function post(relay: Relay, body: Uint8Array): Promise<{ status: number; json: any }> {
  const chunks = [Buffer.from(body)];
  const req: any = {
    method: 'POST',
    url: '/v1/relay',
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
  return await respond(relay, req);
}

function respond(relay: Relay, req: any): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    let status = 0;
    let body = '';
    const res: any = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: (chunk?: string) => {
        body = chunk ?? '';
        resolve({ status, json: body === '' ? undefined : JSON.parse(body) });
      },
    };
    relay.handler(req, res);
  });
}

const get = (relay: Relay, path: string) => respond(relay, { method: 'GET', url: path });

const onionFor = (payload: FinalPayload) =>
  encodeFrame(
    buildOnion({ path: toPath(directory, ids, NOW_S as any), payload, expiresAt: NOW_S + 600n }),
  );

// ── three hops, for real ──────────────────────────────────────────────────

test('a message crosses three relays and reaches egress exactly once', async () => {
  const { built, seen } = mesh();
  // A PAYMENT is legitimately fire-and-forget. A QUERY without a return route
  // is refused by the transport, since its answer would have nowhere to go.
  const accepted = await post(built.get(ids[0]!)!, onionFor({ kind: 'PAYMENT', body: '0xabcd' }));
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.json, { status: 'ACCEPTED' });

  // Nothing has moved yet: acceptance is not delivery, which is the point of
  // the queue. Hop 1 is holding it.
  assert.equal(seen.length, 0);
  assert.equal(built.get(ids[0]!)!.queued, 1);

  // Each drain hands the message to the next relay, which queues it in turn.
  for (const id of ids) await built.get(id)!.drainOnce(NOW_MS + 10n);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { kind: 'PAYMENT', body: '0xabcd' });
  for (const id of ids) assert.equal(built.get(id)!.queued, 0, `${id} still holds something`);
});

test('the relay answers before it forwards, so acceptance leaks no timing', async () => {
  const { built, seen } = mesh();
  await post(built.get(ids[0]!)!, onionFor({ kind: 'PAYMENT', body: '0x01' }));
  // Answered 202 above with the message still queued and untouched downstream.
  assert.equal(seen.length, 0);
  assert.equal(built.get(ids[1]!)!.queued, 0);
});

// ── the return path, end to end ───────────────────────────────────────────

test('a query gets its answer back through a drop, and only once', async () => {
  const { built } = mesh();
  const channel = createChannel(ids[2]!); // the drop must be the hop that answers
  const payload: FinalPayload = {
    kind: 'QUERY',
    body: '0xabcd',
    responseKey: channel.responseKey,
    returnRoute: channel.returnRoute,
  };
  await post(built.get(ids[0]!)!, onionFor(payload));
  for (const id of ids) await built.get(id)!.drainOnce(NOW_MS + 10n);

  const collected = await get(built.get(ids[2]!)!, `/v1/status/${channel.dropId}`);
  assert.equal(collected.status, 200);
  assert.equal(text(channel.open(collected.json.sealed as Hex)), 'CONFIRMED');

  // Single-use: the credential is spent.
  assert.equal((await get(built.get(ids[2]!)!, `/v1/status/${channel.dropId}`)).status, 404);
});

test('an unknown drop and a spent one are the same 404', async () => {
  const { built } = mesh();
  const a = await get(built.get(ids[2]!)!, `/v1/status/${'0'.repeat(32)}`);
  const b = await get(built.get(ids[2]!)!, '/v1/status/not-a-drop-id');
  assert.equal(a.status, 404);
  assert.deepEqual(a.json, b.json, 'a malformed id must not be distinguishable from an absent one');
});

test('a drop is refused when the client names a relay that did not answer', async () => {
  const { built } = mesh();
  // ids[0] is hop 1, not the hop that reaches egress.
  const channel = createChannel(ids[0]!);
  await post(
    built.get(ids[0]!)!,
    onionFor({
      kind: 'QUERY',
      body: '0x00',
      responseKey: channel.responseKey,
      returnRoute: channel.returnRoute,
    }),
  );
  for (const id of ids) await built.get(id)!.drainOnce(NOW_MS + 10n);
  // Loudly nowhere, rather than silently deposited at the wrong relay.
  assert.equal((await get(built.get(ids[0]!)!, `/v1/status/${channel.dropId}`)).status, 404);
  assert.equal((await get(built.get(ids[2]!)!, `/v1/status/${channel.dropId}`)).status, 404);
});

// ── refusals ──────────────────────────────────────────────────────────────

test('a frame addressed to a different relay is refused, not attempted', async () => {
  const { built } = mesh();
  // Built for hop 1, handed to hop 2.
  const answer = await post(built.get(ids[1]!)!, onionFor({ kind: 'PAYMENT', body: '0x00' }));
  assert.equal(answer.status, 400);
  assert.equal(answer.json.code, 'INVALID_INPUT');
});

test('a replayed frame is refused the second time', async () => {
  const { built } = mesh();
  const frame = onionFor({ kind: 'PAYMENT', body: '0x00' });
  assert.equal((await post(built.get(ids[0]!)!, frame)).status, 202);
  const again = await post(built.get(ids[0]!)!, frame);
  assert.notEqual(again.status, 202);
});

test('garbage and oversized bodies are refused without a stack', async () => {
  const { built } = mesh();
  const relay = built.get(ids[0]!)!;
  const short = await post(relay, utf8('not a frame'));
  assert.equal(short.status, 400);
  assert.equal(Object.keys(short.json).sort().join(), 'code,message,retryable');

  const huge = await post(relay, new Uint8Array(200_000));
  assert.equal(huge.status, 400);
  assert.equal(relay.queued, 0, 'a refused frame must never take a queue slot');
});

test('a full queue is a retryable refusal, never a silent drop', async () => {
  const { built } = mesh({ maxQueue: 1 });
  const relay = built.get(ids[0]!)!;
  assert.equal((await post(relay, onionFor({ kind: 'PAYMENT', body: '0x01' }))).status, 202);
  const rejected = await post(relay, onionFor({ kind: 'PAYMENT', body: '0x02' }));
  assert.equal(rejected.status, 503);
  assert.equal(rejected.json.retryable, true);
  assert.equal(relay.queued, 1);
});

test('a kind this relay does not carry never reaches egress', async () => {
  const { built, seen } = mesh({ egress: new Map([['QUERY', 'https://graph.invalid/query']]) });
  await post(built.get(ids[0]!)!, onionFor({ kind: 'PAYMENT', body: '0x01' }));
  for (const id of ids) await built.get(id)!.drainOnce(NOW_MS + 10n);
  assert.equal(seen.length, 0);
});

test('a message that cannot be handed on is counted, not silently lost', async () => {
  // Egress refuses everything: the message is already acknowledged, so there
  // is nobody to report to — but a relay that quietly eats traffic and a relay
  // that works look identical from the outside, which is how a broken mesh
  // stays broken.
  const { built } = mesh({
    callEgress: async () => {
      throw new ProtocolFailure('MESH_UNAVAILABLE', 'egress is down', true);
    },
  });
  await post(built.get(ids[0]!)!, onionFor({ kind: 'PAYMENT', body: '0x01' }));
  for (const id of ids) await built.get(id)!.drainOnce(NOW_MS + 10n);

  assert.equal(built.get(ids[2]!)!.undelivered, 1);
  assert.equal(built.get(ids[0]!)!.undelivered, 0, 'the hops that succeeded count nothing');
});

test('only the two documented endpoints exist', async () => {
  const { built } = mesh();
  const relay = built.get(ids[0]!)!;
  assert.equal((await get(relay, '/')).status, 404);
  assert.equal((await get(relay, '/v1/relay')).status, 405);
  assert.equal((await respond(relay, { method: 'POST', url: '/v1/status/abc' })).status, 405);
  // No intent lookup, by design: it would be the linkage three hops remove.
  assert.equal((await get(relay, '/v1/intent/0xabc')).status, 404);
});

// ── over a real socket ────────────────────────────────────────────────────

test('the relay serves the two endpoints over actual HTTP', async () => {
  const relay = createRelay({
    relayId: ids[0]!,
    secretKey: relays[0]!.secretKey,
    keyEpoch: relays[0]!.keyEpoch,
    directory,
    egress: EGRESS,
    batchWindowMs: 1,
    maxExtraDelayMs: 0,
    now: () => NOW_MS,
    deliver: async () => {},
  });
  const server = await relay.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const accepted = await fetch(`http://127.0.0.1:${port}/v1/relay`, {
      method: 'POST',
      body: onionFor({ kind: 'PAYMENT', body: '0xabcd' }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { status: 'ACCEPTED' });
    // The acknowledgement carries no id to correlate against a relay log.
    assert.equal(accepted.headers.get('cache-control'), 'no-store');

    const missing = await fetch(`http://127.0.0.1:${port}/v1/status/${'a'.repeat(32)}`);
    assert.equal(missing.status, 404);
  } finally {
    await relay.close();
  }
});

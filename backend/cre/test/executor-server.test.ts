import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { UnixSeconds } from '@opaque/protocol-types';

import { createExecutorServer } from '../executor-server.ts';

const NOW = 1_760_000_000n as UnixSeconds;

const intentBody = (key = 'k1', deadlineOffset = 3600n) => ({
  version: '1-review',
  scope: { chainId: '5042002', pool: `0x${'11'.repeat(20)}`, denomination: 1_000_000 },
  encryptedPayload: `0x${'ab'.repeat(64)}`,
  encryptionKeyId: 'opaque-intent-key-v1',
  spendHash: `0x${'cd'.repeat(32)}`,
  minPrivacyScore: 5_000,
  deadline: (NOW + deadlineOffset).toString(10),
  idempotencyKey: key,
});

function harness(triggerUrl?: string) {
  const forwarded: unknown[] = [];
  const server = createExecutorServer({
    now: () => NOW,
    ...(triggerUrl === undefined ? {} : { triggerUrl }),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      forwarded.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { server, forwarded };
}

const call = (
  server: ReturnType<typeof createExecutorServer>,
  method: string,
  url: string,
  body?: unknown,
) =>
  new Promise<{ status: number; json: any }>((resolve) => {
    const req: any = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
    let status = 0;
    const res: any = {
      writeHead: (c: number) => ((status = c), res),
      end: (b?: string) => resolve({ status, json: b === undefined ? undefined : JSON.parse(b) }),
    };
    server.handler(req, res);
  });

test('an intent is accepted and answered with a handle', async () => {
  const { server } = harness();
  const answer = await call(server, 'POST', '/v1/intent', intentBody());
  assert.equal(answer.status, 202);
  assert.equal(typeof answer.json.intentId, 'string');
  assert.equal((answer.json.statusHandle as string).length, 64);
});

test('status is readable by the handle, and only by the handle', async () => {
  const { server } = harness();
  const { json: ref } = await call(server, 'POST', '/v1/intent', intentBody());
  const ok = await call(server, 'GET', `/v1/intent/${ref.statusHandle}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.state, 'WAITING_FOR_PRIVACY');
  // Unknown and wrong are the same refusal: otherwise this is an oracle for
  // which handles exist.
  assert.equal((await call(server, 'GET', `/v1/intent/${'0'.repeat(64)}`)).status, 400);
});

test('what it forwards to the enclave is ciphertext and nothing else', async () => {
  const { server, forwarded } = harness('https://cre.invalid/trigger');
  await call(server, 'POST', '/v1/intent', intentBody());
  assert.equal(forwarded.length, 1);
  const sent = forwarded[0] as Record<string, unknown>;
  // This service holds no key and can open nothing. The payload it relays is
  // exactly the ciphertext it received.
  assert.equal(sent['sealedIntent'], `0x${'ab'.repeat(64)}`);
  assert.equal('recipient' in sent, false);
  assert.equal('credential' in sent, false);
  // Bigints cross as decimal strings, matching the workflow's zod schema.
  assert.equal(typeof sent['deadline'], 'string');
  assert.equal(typeof (sent['scope'] as Record<string, unknown>)['chainId'], 'string');
});

test('with no trigger configured the intent queues instead of vanishing', async () => {
  const { server, forwarded } = harness();
  const { json: ref } = await call(server, 'POST', '/v1/intent', intentBody());
  assert.equal(forwarded.length, 0);
  // Visibly a queue that is not draining, rather than a payment that was
  // silently dropped while awaiting enrolment.
  assert.equal(server.executor.pending(NOW).length, 1);
  assert.equal((await call(server, 'GET', `/v1/intent/${ref.statusHandle}`)).status, 200);
});

test('malformed intents are refused, not coerced', async () => {
  const { server } = harness();
  const bad: unknown[] = [
    'a string',
    { ...intentBody(), deadline: 12 },
    { ...intentBody(), deadline: 'soon' },
    { ...intentBody(), encryptedPayload: 'not-hex' },
    (() => { const b = intentBody() as Record<string, unknown>; delete b['scope']; return b; })(),
  ];
  for (const body of bad) {
    assert.equal((await call(server, 'POST', '/v1/intent', body)).status, 400, JSON.stringify(body));
  }
});

test('an already-expired intent is refused at the door', async () => {
  const { server } = harness();
  assert.equal((await call(server, 'POST', '/v1/intent', intentBody('k9', 0n))).status, 400);
});

test('only the two endpoints exist', async () => {
  const { server } = harness();
  assert.equal((await call(server, 'GET', '/')).status, 404);
  assert.equal((await call(server, 'GET', '/v1/intent')).status, 404);
});

test('it serves over a real socket', async () => {
  const { server } = harness();
  const listening = await server.listen(0);
  const port = (listening.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intentBody('socket-1')),
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await server.close();
  }
});

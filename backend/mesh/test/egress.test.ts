import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type { IntentId, PrivateSpend, TxHash, UnixSeconds } from '@opaque/protocol-types';

import { issueRelease } from '../../cre/release.ts';
import { createEgress } from '../egress.ts';

const secret = new TextEncoder().encode('workflow-to-egress');
const NOW = 1_760_000_000n as UnixSeconds;

const spend = {
  mode: 'SINGLE_NOTE_PQ',
  scope: { chainId: 5042002n, pool: `0x${'11'.repeat(20)}`, denomination: 1_000_000 },
  recipient: `0x${'aa'.repeat(20)}`,
  nullifier: `0x${'22'.repeat(32)}`,
  paymentContext: `0x${'33'.repeat(32)}`,
  verifierId: `0x${'44'.repeat(32)}`,
  proof: '0xdeadbeef',
  commitment: `0x${'55'.repeat(32)}`,
} as unknown as PrivateSpend;

const releaseFor = (intentId: string, key = secret) =>
  issueRelease({
    intentId: intentId as IntentId,
    spend,
    policyVersion: 'opaque-policy-v1',
    issuedAt: NOW,
    ttlSeconds: 900n,
    secret: key,
  });

/** Bigints cross as decimal strings, exactly as the workflow sends them. */
const wire = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v));

function harness(options: { fail?: boolean } = {}) {
  const submitted: PrivateSpend[] = [];
  const audited: unknown[] = [];
  let n = 0;
  const egress = createEgress({
    secret,
    now: () => NOW,
    audit: (line) => audited.push(line),
    submitter: {
      async submit(s: PrivateSpend): Promise<TxHash> {
        if (options.fail) throw new Error('rpc exploded: node at 10.0.0.7 rejected nonce 42');
        submitted.push(s);
        return `0x${String(++n).padStart(64, '0')}` as TxHash;
      },
    },
  });
  return { egress, submitted, audited };
}

const post = (egress: ReturnType<typeof createEgress>, body: string, url = '/v1/release') =>
  new Promise<{ status: number; json: any }>((resolve) => {
    const req: any = {
      method: 'POST',
      url,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    };
    let status = 0;
    const res: any = {
      writeHead: (c: number) => ((status = c), res),
      end: (b?: string) => resolve({ status, json: b === undefined ? undefined : JSON.parse(b) }),
    };
    egress.handler(req, res);
  });

// ── the happy path ────────────────────────────────────────────────────────

test('a valid release is verified and submitted exactly once', async () => {
  const { egress, submitted } = harness();
  const answer = await post(egress, wire(releaseFor('intent-1')));
  assert.equal(answer.status, 202);
  assert.equal(answer.json.deduplicated, false);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.recipient, spend.recipient);
});

test('bigint timestamps survive the wire and are covered by the MAC', async () => {
  // The MAC is computed over the revived values, so a release whose timestamps
  // did not survive fails to authenticate rather than settling with wrong ones.
  const { egress } = harness();
  const release = releaseFor('intent-2');
  const body = JSON.parse(wire(release)) as Record<string, unknown>;
  assert.equal(typeof body['issuedAt'], 'string');
  body['expiresAt'] = String(release.expiresAt + 86_400n);
  assert.equal((await post(egress, JSON.stringify(body))).status, 403);
});

// ── forgery ───────────────────────────────────────────────────────────────

test('a release signed with another key never reaches the chain', async () => {
  const { egress, submitted } = harness();
  const forged = releaseFor('intent-3', new TextEncoder().encode('not-the-workflow'));
  assert.equal((await post(egress, wire(forged))).status, 403);
  assert.equal(submitted.length, 0, 'verify happens BEFORE submit, always');
});

test('an altered spend riding a valid tag is refused', async () => {
  const { egress, submitted } = harness();
  const release = releaseFor('intent-4');
  const tampered = {
    ...release,
    spend: { ...spend, recipient: `0x${'ee'.repeat(20)}` },
  };
  assert.equal((await post(egress, wire(tampered))).status, 403);
  assert.equal(submitted.length, 0);
});

test('a forged release is not written to the audit trail', async () => {
  const { egress, audited } = harness();
  await post(egress, wire(releaseFor('intent-5', new TextEncoder().encode('wrong'))));
  assert.equal(audited.length, 0, 'auditing before verification fills the trail with fictions');
});

// ── one intent settles once ───────────────────────────────────────────────

test('a duplicate returns the original transaction rather than broadcasting twice', async () => {
  const { egress, submitted } = harness();
  const release = releaseFor('intent-6');
  const first = await post(egress, wire(release));
  const again = await post(egress, wire(release));

  assert.equal(first.status, 202);
  assert.equal(again.status, 200);
  assert.equal(again.json.deduplicated, true);
  assert.equal(again.json.txHash, first.json.txHash);
  assert.equal(submitted.length, 1, 'one payment, one broadcast');
});

// ── failures ──────────────────────────────────────────────────────────────

test('a submitter error never leaks its message to the caller', async () => {
  const { egress } = harness({ fail: true });
  const answer = await post(egress, wire(releaseFor('intent-7')));
  assert.equal(answer.status, 502);
  // The real error named an internal IP and a nonce.
  assert.equal(JSON.stringify(answer.json).includes('10.0.0.7'), false);
  assert.equal(answer.json.retryable, true);
});

test('malformed bodies are refused without a stack', async () => {
  const { egress } = harness();
  assert.equal((await post(egress, 'not json')).status, 400);
  assert.equal((await post(egress, wire({ intentId: 'x' }))).status, 400);
  assert.equal((await post(egress, wire({ ...releaseFor('i8'), issuedAt: 12 }))).status, 400);
});

test('only POST /v1/release exists', async () => {
  const { egress } = harness();
  assert.equal((await post(egress, '{}', '/')).status, 404);
  assert.equal((await post(egress, '{}', '/v1/relay')).status, 404);
});

test('the audit line carries no recipient, amount or spend', async () => {
  const { egress, audited } = harness();
  await post(egress, wire(releaseFor('intent-9')));
  assert.equal(audited.length, 1);
  const line = JSON.stringify(audited[0]);
  assert.equal(line.includes(spend.recipient), false);
  assert.equal(line.includes('proof'), false);
  assert.deepEqual(Object.keys(audited[0] as object).sort(), ['at', 'intentId', 'policyVersion']);
});

test('it serves over a real socket', async () => {
  const { egress } = harness();
  const server = await egress.listen(0);
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: wire(releaseFor('intent-10')),
    });
    assert.equal(response.status, 202);
    assert.equal(((await response.json()) as { deduplicated: boolean }).deduplicated, false);
  } finally {
    await egress.close();
  }
});

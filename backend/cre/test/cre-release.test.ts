import assert from 'node:assert/strict';
import test from 'node:test';

import type { Bytes32, CredentialHandle, IdempotencyKey, NoteId, PoolScope, PrivacyScore, UnixSeconds } from '@opaque/protocol-types';
import { asAddress, asChainId, fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { utf8 } from '@opaque/pq-wallet';

import { issueCredential } from '../credential.ts';
import { decide, ringPoolKey, scoresFromGraph, type PendingIntent } from '../cre-release.ts';
import { createIntentSealer, generateIntentKeypair } from '../seal-client.ts';
import { decapsulationKey, decodeIntentPlaintext, openBulk, openEnvelope, releaseTag } from '../sealed-intent.ts';

// The v2 decision without a ring spend: the envelope is what CRE sees, and a
// placeholder spend is enough to seal one. simulator.test.ts drives a real
// ring payment through the same code to SETTLED.

const NOW = 1_800_000_000n as UnixSeconds;
const scope: PoolScope = { chainId: asChainId(5042002n), pool: asAddress('0x8b54cc1b008eafa270740d847e45954f10dbf150'), denomination: 1_000_000 };
const RECIPIENT = asAddress('0x000000000000000000000000000000000000b0b0');
const SPEND_HASH = `0x${'5a'.repeat(32)}` as Bytes32;
const mac = utf8('test-credential-and-release-mac');
const seed = new Uint8Array(64).fill(3);
const keys = generateIntentKeypair(seed);
const KEY_ID = 'opaque-intent-key-v2';
const POLICY = 'opaque-policy-v1';
const POOL = ringPoolKey({ chainId: '5042002', pool: scope.pool, denomination: scope.denomination });

async function sealed(terms: { minPrivacyScore: number; deadline: bigint; credentialFor?: string }): Promise<PendingIntent & { encryptedPayload: string }> {
  const credential = issueCredential({ recipient: asAddress(terms.credentialFor ?? RECIPIENT), policyVersion: POLICY, expiresAt: (NOW + 3600n) as UnixSeconds }, mac);
  const intent = await createIntentSealer({
    crePublicKey: keys.publicKey, encryptionKeyId: KEY_ID,
    resolveCredential: async () => JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
  })({
    scope, spendHash: SPEND_HASH, spend: { recipient: RECIPIENT, proof: '0xc0ffee' },
    request: {
      noteId: 'n' as NoteId, recipient: RECIPIENT, minPrivacyScore: terms.minPrivacyScore as PrivacyScore,
      deadline: terms.deadline as UnixSeconds, credentialHandle: 'c' as CredentialHandle, idempotencyKey: 'i' as IdempotencyKey,
    },
  });
  return { intentId: 'intent-1', spendHash: SPEND_HASH, envelope: intent.creEnvelope!, encryptedPayload: intent.encryptedPayload };
}

const run = (intent: PendingIntent, score?: number, now: bigint = NOW, secret = seed) => decide({
  intent, now: now as UnixSeconds, scoreOf: (key) => (key === POOL ? score : undefined),
  secretKey: decapsulationKey(toHex(secret)), encryptionKeyId: KEY_ID, credentialSecret: mac, policyVersion: POLICY,
});

test('the envelope carries K, the terms and the recipient, and K opens the payment', async () => {
  const intent = await sealed({ minPrivacyScore: 5000, deadline: NOW + 600n });
  assert.ok(fromHex(intent.envelope).length < 4096, 'fits what the executor accepts');
  const opened = openEnvelope(decapsulationKey(keys.secretKey), KEY_ID, intent.envelope);
  assert.equal(opened.recipient, RECIPIENT.toLowerCase());
  assert.deepEqual(opened.scope, { chainId: '5042002', pool: scope.pool.toLowerCase(), denomination: 1_000_000 });
  assert.equal(opened.minPrivacyScore, 5000);
  assert.equal(opened.deadline, String(NOW + 600n));
  const plain = decodeIntentPlaintext(openBulk(fromHex(opened.k), SPEND_HASH, intent.encryptedPayload as never));
  assert.equal(plain.spend['recipient'], RECIPIENT);
  assert.throws(() => openBulk(fromHex(opened.k), `0x${'00'.repeat(32)}`, intent.encryptedPayload as never), 'bound to its spendHash');
});

test('CRE times a payment on the terms the payer sealed', async () => {
  const intent = await sealed({ minPrivacyScore: 5000, deadline: NOW + 600n });
  assert.equal(run(intent).verdict, 'WAIT', 'no score, before the deadline');
  assert.equal(run(intent, 4999).verdict, 'WAIT', 'score below what the payer asked for');
  assert.equal(run(intent, 5000).verdict, 'RELEASE', 'score reached');
  assert.equal(run(intent, undefined, NOW + 600n).verdict, 'RELEASE', 'deadline reached, Graph or no Graph');
  assert.equal(run(await sealed({ minPrivacyScore: 0, deadline: NOW + 600n })).verdict, 'RELEASE', 'asked for no wait');
});

test('a release is tagged over exactly what it releases', async () => {
  const decision = run(await sealed({ minPrivacyScore: 0, deadline: NOW + 600n }));
  assert.equal(decision.verdict, 'RELEASE');
  if (decision.verdict !== 'RELEASE') return;
  const expect = (recipient: string) => releaseTag(mac, { intentId: 'intent-1', spendHash: SPEND_HASH, verdict: 'RELEASE', recipient, k: decision.k });
  assert.equal(decision.tag, expect(decision.recipient));
  assert.notEqual(decision.tag, expect('0x000000000000000000000000000000000000dead'));
});

test('CRE denies what it cannot vouch for', async () => {
  const intent = await sealed({ minPrivacyScore: 0, deadline: NOW + 600n });
  assert.equal(run({ ...intent, spendHash: `0x${'00'.repeat(32)}` }).verdict, 'DENY', 'envelope for another spend');
  assert.equal(run(intent, undefined, NOW, new Uint8Array(64).fill(4)).verdict, 'DENY', 'sealed to another key');
  const other = await sealed({ minPrivacyScore: 0, deadline: NOW + 600n, credentialFor: '0x000000000000000000000000000000000000dead' });
  assert.equal(run(other).verdict, 'DENY', 'credential for someone else');
});

test('the Graph score: pinned relays, stale health as the prior, a stale index as no score', () => {
  const pins = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`R${i + 1}`, `op-${i + 1}`]));
  const body = (over: { indexAt?: bigint; seenAt?: bigint; omit?: string } = {}) => ({
    data: {
      _meta: { hasIndexingErrors: false, block: { timestamp: Number(over.indexAt ?? NOW - 10n) } },
      ringPools: [{ id: POOL, poolSize: 8 }, { id: 'small', poolSize: 4 }],
      relayNodes: Object.keys(pins).filter((id) => id !== over.omit)
        .map((id) => ({ id, reliabilityScore: '10000', batchOccupancy: '2', lastSeenAt: String(over.seenAt ?? NOW - 60n) })),
    },
  });
  assert.equal(scoresFromGraph(body(), pins, NOW).get(POOL), 10_000);
  assert.equal(scoresFromGraph(body(), pins, NOW).get('small'), 5_000, 'half a ring');
  assert.equal(scoresFromGraph(body({ seenAt: NOW - 901n }), pins, NOW).get(POOL), 5_000, 'stale health is the prior');
  assert.equal(scoresFromGraph(body({ omit: 'R6' }), pins, NOW).get(POOL), Math.floor((5 * 10_000 + 5_000) / 6), 'omission cannot remove a relay');
  assert.equal(scoresFromGraph(body({ indexAt: NOW - 301n }), pins, NOW).size, 0, 'stale index');
  assert.equal(scoresFromGraph({ data: { ...body().data, _meta: { hasIndexingErrors: true } } }, pins, NOW).size, 0);
  assert.equal(scoresFromGraph({ errors: ['x'] }, pins, NOW).size, 0);
  const three = { R1: 'a', R2: 'a', R3: 'b' };
  assert.equal(scoresFromGraph(body(), three, NOW).get(POOL), 0, 'fewer than three operators is no mesh');
});

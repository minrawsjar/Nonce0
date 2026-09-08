// T7/T8/T9 verification.
//
// T8: no pre-eligibility payload decryption; Graph failure at deadline does not
//     prevent eligibility; unavailable/denied policy never authorizes;
//     immediate mode follows the same path.
// T7: missing, expired, copied-to-another-intent and altered-spend
//     authorizations reject; identical retries are idempotent.
// T9: two workers, restart after enqueue/broadcast, lost acknowledgments and
//     repeated submit do not create a second distinct spend; SETTLED requires
//     matching successful chain evidence.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ProtocolFailure,
  type Address,
  type EncryptedIntent,
  type IdempotencyKey,
  type IntentId,
  type PoolScope,
  type PrivacyScore,
  type PrivateSpend,
  type TxHash,
  type UnixSeconds,
} from '@chaff/protocol-types';
import { asPrivateSpend, derivePaymentContext, spendHash } from '@chaff/protocol-types/codecs.js';

import { evaluateIntent, type EvaluationDeps, type ScoreReading } from '../evaluate-intent.ts';
import { IntentStore } from '../intent-store.ts';
import { issueRelease, verifyRelease } from '../release.ts';

const NOW = 1_760_000_000n as UnixSeconds;
const SECRET = new Uint8Array(32).fill(7);

const SCOPE: PoolScope = {
  chainId: 5_042_002n as PoolScope['chainId'],
  pool: '0x3600000000000000000000000000000000000000' as Address,
  denomination: 1_000_000,
};
const RECIPIENT = '0x00000000000000000000000000000000000000aa' as Address;
const b32 = (fill: string) => `0x${fill.repeat(64).slice(0, 64)}`;

const SPEND: PrivateSpend = asPrivateSpend({
  mode: 'RING_8',
  scope: { chainId: '5042002', pool: SCOPE.pool, denomination: SCOPE.denomination },
  recipient: RECIPIENT,
  nullifier: b32('a'),
  paymentContext: derivePaymentContext(SCOPE, RECIPIENT),
  verifierId: b32('b'),
  proof: '0xdeadbeef',
  ring: Array.from({ length: 8 }, (_, i) => b32(String(i))),
});

const intent = (over: Partial<EncryptedIntent> = {}): EncryptedIntent => ({
  version: '1-review',
  scope: SCOPE,
  encryptedPayload: '0xc0ffee',
  encryptionKeyId: 'cre-key-1',
  spendHash: spendHash(SPEND),
  minPrivacyScore: 7_000 as PrivacyScore,
  deadline: (NOW + 3_600n) as UnixSeconds,
  idempotencyKey: 'idem-1' as IdempotencyKey,
  ...over,
});

/** Records what was actually called, so "never decrypted" is observed. */
function deps(over: Partial<EvaluationDeps> & { score?: ScoreReading; policy?: 'APPROVED' | 'DENIED' | 'UNAVAILABLE' } = {}) {
  const calls = { readFreshScore: 0, decryptInTee: 0, checkRecipientPolicy: 0 };
  const impl: EvaluationDeps = {
    async readFreshScore() {
      calls.readFreshScore++;
      return over.score ?? { kind: 'FRESH', score: 9_000 as PrivacyScore, observedAt: NOW };
    },
    async decryptInTee() {
      calls.decryptInTee++;
      return { spend: SPEND, credential: 'test-credential' };
    },
    async checkRecipientPolicy() {
      calls.checkRecipientPolicy++;
      const kind = over.policy ?? 'APPROVED';
      return kind === 'APPROVED' ? { kind } : { kind, reason: `policy ${kind}` };
    },
    ...over,
  };
  return { impl, calls };
}

const run = (input: Partial<Parameters<typeof evaluateIntent>[0]>, d: EvaluationDeps) =>
  evaluateIntent(
    {
      intentId: 'i-1' as IntentId,
      intent: intent(),
      now: NOW,
      claimAttempt: () => true,
      ...input,
    },
    d,
  );

// ── T8: nothing is decrypted while merely waiting ─────────────────────────

test('a score below threshold never decrypts the payload', async () => {
  const d = deps({ score: { kind: 'FRESH', score: 100 as PrivacyScore, observedAt: NOW } });
  const result = await run({}, d.impl);

  assert.equal(result.kind, 'WAITING');
  assert.equal(d.calls.readFreshScore, 1);
  assert.equal(d.calls.decryptInTee, 0, 'the TEE must not open a waiting intent');
  assert.equal(d.calls.checkRecipientPolicy, 0);
});

test('an unavailable or stale score waits, retryably, without decrypting', async () => {
  for (const score of [{ kind: 'UNAVAILABLE' }, { kind: 'STALE', observedAt: NOW }] as ScoreReading[]) {
    const d = deps({ score });
    const result = await run({}, d.impl);
    assert.equal(result.kind, 'WAITING');
    assert.equal(result.kind === 'WAITING' && 'retryable' in result ? result.retryable : false, true);
    assert.equal(d.calls.decryptInTee, 0);
  }
});

// ── T8: the deadline branch does not touch Graph ──────────────────────────

test('at the deadline, eligibility never asks Graph anything', async () => {
  const d = deps({ score: { kind: 'UNAVAILABLE' } });
  const result = await run({ intent: intent({ deadline: NOW }), now: NOW }, d.impl);

  assert.equal(result.kind, 'APPROVED');
  assert.equal(d.calls.readFreshScore, 0, 'a Graph outage must not strand an overdue payment');
  assert.equal(result.kind === 'APPROVED' && result.deadlineReached, true);
});

test('immediate mode is the deadline branch, not a bypass', async () => {
  // "Send now" sets deadline = now. It must take the identical path.
  const d = deps({ score: { kind: 'UNAVAILABLE' } });
  const immediate = await run({ intent: intent({ deadline: NOW }), now: NOW }, d.impl);
  assert.equal(immediate.kind, 'APPROVED');
  assert.equal(d.calls.checkRecipientPolicy, 1, 'policy still applies to an immediate payment');
});

// ── T8: policy outcomes ───────────────────────────────────────────────────

test('denied is terminal and unavailable is retryable; neither releases', async () => {
  const denied = await run({}, deps({ policy: 'DENIED' }).impl);
  assert.equal(denied.kind, 'DENIED');

  const unavailable = await run({}, deps({ policy: 'UNAVAILABLE' }).impl);
  assert.equal(unavailable.kind, 'RETRY', 'an outage is not a denial');
});

test('a payload that does not match the submitted spendHash is rejected', async () => {
  const d = deps();
  await assert.rejects(
    () => run({ intent: intent({ spendHash: b32('f') as EncryptedIntent['spendHash'] }) }, d.impl),
    (e: ProtocolFailure) => e.code === 'INVALID_INPUT',
  );
});

test('a decrypted spend scoped to another pool is rejected', async () => {
  const d = deps();
  const elsewhere = intent({ scope: { ...SCOPE, pool: '0x00000000000000000000000000000000000000ff' as Address } });
  await assert.rejects(
    () => run({ intent: elsewhere }, d.impl),
    (e: ProtocolFailure) => e.code === 'INVALID_INPUT',
  );
});

test('only one worker gets the evaluation attempt', async () => {
  const d = deps();
  const result = await run({ claimAttempt: () => false }, d.impl);
  assert.equal(result.kind, 'RETRY');
  assert.equal(d.calls.decryptInTee, 0, 'a worker that lost the claim must not decrypt');
});

// ── T7: authenticated release ─────────────────────────────────────────────

const release = (over: Record<string, unknown> = {}) =>
  issueRelease({
    intentId: 'i-1' as IntentId,
    spend: SPEND,
    policyVersion: 'policy-v1',
    issuedAt: NOW,
    ttlSeconds: 300n,
    secret: SECRET,
    ...over,
  });

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ProtocolFailure).code ?? 'THREW';
  }
  return 'NO_THROW';
};

test('a valid release verifies, and every mutation of it does not', () => {
  const good = release();
  assert.equal(code(() => verifyRelease({ release: good, secret: SECRET, now: NOW })), 'NO_THROW');

  assert.equal(
    code(() => verifyRelease({ release: good, secret: new Uint8Array(32).fill(9), now: NOW })),
    'POLICY_DENIED',
    'a different MAC secret',
  );
  assert.equal(
    code(() => verifyRelease({ release: { ...good, authenticationTag: `0x${'00'.repeat(32)}` }, secret: SECRET, now: NOW })),
    'POLICY_DENIED',
    'a forged tag',
  );
  assert.equal(
    code(() => verifyRelease({ release: { ...good, intentId: 'i-2' as IntentId }, secret: SECRET, now: NOW })),
    'POLICY_DENIED',
    'lifted onto another intent',
  );
  assert.equal(
    code(() => verifyRelease({ release: { ...good, expiresAt: (NOW + 999_999n) as UnixSeconds }, secret: SECRET, now: NOW })),
    'POLICY_DENIED',
    'delivery window widened',
  );
});

test('an altered spend riding a valid tag is caught', () => {
  const good = release();
  const swapped = asPrivateSpend({
    ...SPEND,
    scope: { chainId: '5042002', pool: SCOPE.pool, denomination: SCOPE.denomination },
    recipient: RECIPIENT,
    proof: '0xdeadbeee',
    ring: [...SPEND.mode === 'RING_8' ? SPEND.ring : []],
  });
  // spendHash still says the original; the body says otherwise.
  assert.equal(
    code(() => verifyRelease({ release: { ...good, spend: swapped }, secret: SECRET, now: NOW })),
    'POLICY_DENIED',
  );
});

test('a release expires, and is not valid before it is issued', () => {
  const good = release();
  assert.equal(code(() => verifyRelease({ release: good, secret: SECRET, now: (NOW + 300n) as UnixSeconds })), 'EXPIRED');
  assert.equal(code(() => verifyRelease({ release: good, secret: SECRET, now: (NOW - 1n) as UnixSeconds })), 'POLICY_DENIED');
});

test('an immediate payment does not mint an already-expired authorization', () => {
  // deadline = now, so reusing the deadline as the delivery window would
  // produce a release that is dead on arrival.
  const r = release({ issuedAt: NOW, ttlSeconds: 300n });
  assert.ok(r.expiresAt > NOW);
  assert.equal(code(() => issueRelease({
    intentId: 'i-1' as IntentId, spend: SPEND, policyVersion: 'v1',
    issuedAt: NOW, ttlSeconds: 0n, secret: SECRET,
  })), 'INVALID_INPUT');
});

// ── T9: durable state ─────────────────────────────────────────────────────

test('repeated submit with one key returns one intent, and a changed body rejects', () => {
  const store = new IntentStore();
  const a = store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });
  const b = store.submit({ intentId: 'i-2' as IntentId, intent: intent(), now: NOW });
  assert.equal(a.intentId, b.intentId, 'the second submit must not create a second payment');

  assert.equal(
    code(() => store.submit({
      intentId: 'i-3' as IntentId,
      intent: intent({ spendHash: b32('e') as EncryptedIntent['spendHash'] }),
      now: NOW,
    })),
    'INVALID_INPUT',
  );
});

test('two workers cannot both hold one intent', () => {
  const store = new IntentStore();
  store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });
  assert.equal(store.claimAttempt('i-1' as IntentId), true);
  assert.equal(store.claimAttempt('i-1' as IntentId), false);
  store.releaseClaim('i-1' as IntentId);
  assert.equal(store.claimAttempt('i-1' as IntentId), true);
});

test('the outbox is written once; a retry re-delivers the identical release', () => {
  const store = new IntentStore();
  store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });

  const first = store.authorize({ intentId: 'i-1' as IntentId, release: release(), now: NOW });
  const second = store.authorize({
    intentId: 'i-1' as IntentId,
    release: release({ policyVersion: 'policy-v2' }),
    now: NOW,
  });
  assert.deepEqual(second, first, 'a second evaluation must not mint a different release');
});

test('SETTLED requires matching chain evidence, not a spent nullifier', () => {
  const store = new IntentStore();
  store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });
  store.authorize({ intentId: 'i-1' as IntentId, release: release(), now: NOW });
  store.recordBroadcast('i-1' as IntentId, '0xabc' as TxHash, NOW);

  // The note is spent, but by someone else's transaction. That is not this
  // payment settling — the pool is permissionless and D1 is unresolved.
  const spentElsewhere = store.reconcile({
    intentId: 'i-1' as IntentId,
    evidence: { txHash: '0xdef' as TxHash, spendHash: b32('9'), succeeded: true },
    nullifierSpent: true,
    now: NOW,
  });
  assert.notEqual(spentElsewhere.state, 'SETTLED');
  assert.equal(spentElsewhere.error?.code, 'NULLIFIER_SPENT');
});

test('a lost acknowledgement stays resumable and never becomes FAILED', () => {
  const store = new IntentStore();
  store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });
  store.authorize({ intentId: 'i-1' as IntentId, release: release(), now: NOW });
  store.recordBroadcast('i-1' as IntentId, '0xabc' as TxHash, NOW);

  const ambiguous = store.reconcile({ intentId: 'i-1' as IntentId, evidence: null, nullifierSpent: false, now: NOW });
  assert.equal(ambiguous.state, 'RETRYING');

  // And when the receipt finally arrives, it settles.
  const settled = store.reconcile({
    intentId: 'i-1' as IntentId,
    evidence: { txHash: '0xabc' as TxHash, spendHash: spendHash(SPEND), succeeded: true },
    nullifierSpent: true,
    now: NOW,
  });
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.txHash, '0xabc');
});

test('a retryable condition cannot be recorded as a terminal failure', () => {
  const store = new IntentStore();
  store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });
  assert.equal(
    code(() => store.fail('i-1' as IntentId, { code: 'MESH_UNAVAILABLE', retryable: true, publicMessage: 'x' }, NOW)),
    'INVALID_INPUT',
  );
});

test('status is a safe projection that never exposes the outbox', () => {
  const store = new IntentStore();
  store.submit({ intentId: 'i-1' as IntentId, intent: intent(), now: NOW });
  store.authorize({ intentId: 'i-1' as IntentId, release: release(), now: NOW });

  const status = store.status('i-1' as IntentId);
  const serialized = JSON.stringify(status, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.ok(!serialized.includes('authenticationTag'));
  assert.ok(!serialized.includes('proof'));
  assert.ok(!serialized.includes('encryptedPayload'));
});

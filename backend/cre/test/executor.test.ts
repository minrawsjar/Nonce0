import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolFailure,
  type EncryptedIntent,
  type IdempotencyKey,
  type IntentId,
  type StatusHandle,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { createExecutor } from '../executor.ts';

const NOW = 1_760_000_000n as UnixSeconds;
const failure = (code: string) => (error: unknown) =>
  error instanceof ProtocolFailure && error.code === code;

const intentFor = (key: string, deadlineOffset = 3600n): EncryptedIntent =>
  ({
    version: '1-review',
    scope: { chainId: 5042002n, pool: `0x${'11'.repeat(20)}`, denomination: 1_000_000 },
    encryptedPayload: `0x${'ab'.repeat(64)}`,
    encryptionKeyId: 'opaque-intent-key-v1',
    spendHash: `0x${key.padEnd(64, '0')}`,
    minPrivacyScore: 5_000,
    deadline: (NOW + deadlineOffset) as UnixSeconds,
    idempotencyKey: key as IdempotencyKey,
  }) as unknown as EncryptedIntent;

const executor = (seq = 0) => {
  let n = seq;
  return createExecutor({
    now: () => NOW,
    newIntentId: () => `intent-${++n}` as IntentId,
    newStatusHandle: () => `handle-${n}`.padEnd(64, 'x') as StatusHandle,
  });
};

// ── submission ────────────────────────────────────────────────────────────

test('a submitted intent gets an id and a handle, and starts waiting', async () => {
  const ex = executor();
  const ref = await ex.submit(intentFor('aa'));
  assert.equal(ref.intentId, 'intent-1');
  assert.equal((await ex.getStatus(ref.statusHandle)).state, 'WAITING_FOR_PRIVACY');
});

test('the handle is not the intent id, and is not derived from the payment', async () => {
  // If the handle were the id, anyone who read an id from a log or a queue
  // could watch that payment settle.
  const ex = createExecutor({ now: () => NOW });
  const ref = await ex.submit(intentFor('bb'));
  assert.notEqual(ref.statusHandle as string, ref.intentId as string);
  assert.equal((ref.statusHandle as string).length, 64, '32 bytes of hex');
  assert.equal((ref.statusHandle as string).includes('bb'), false);
});

test('two submissions share no handle and no id', async () => {
  const ex = createExecutor({ now: () => NOW });
  const a = await ex.submit(intentFor('cc'));
  const b = await ex.submit(intentFor('dd'));
  assert.notEqual(a.statusHandle, b.statusHandle);
  assert.notEqual(a.intentId, b.intentId);
});

test('resubmitting one payment returns the SAME handle, not a second one', async () => {
  // Two live capabilities for one intent is two things that can leak.
  const ex = executor();
  const first = await ex.submit(intentFor('ee'));
  const again = await ex.submit(intentFor('ee'));
  assert.deepEqual(again, first);
});

test('an idempotency key reused with different content is refused', async () => {
  const ex = executor();
  await ex.submit(intentFor('ff'));
  const different = { ...intentFor('ff'), spendHash: `0x${'99'.repeat(32)}` } as EncryptedIntent;
  await assert.rejects(ex.submit(different), failure('INVALID_INPUT'));
});

test('an intent whose deadline has already passed is refused, not accepted', async () => {
  // Returning a handle would promise a payment that can never be made.
  const ex = executor();
  await assert.rejects(ex.submit(intentFor('gg', 0n)), failure('EXPIRED'));
  await assert.rejects(ex.submit(intentFor('hh', -60n)), failure('EXPIRED'));
});

// ── the handle is a capability ────────────────────────────────────────────

test('an unknown handle is refused exactly like a wrong one', async () => {
  const ex = executor();
  await ex.submit(intentFor('ii'));
  const unknown = ex.getStatus('z'.repeat(64) as StatusHandle);
  const malformed = ex.getStatus('nope' as StatusHandle);
  await assert.rejects(unknown, failure('INVALID_INPUT'));
  await assert.rejects(malformed, failure('INVALID_INPUT'));
  // Same message: distinguishing them is an oracle for which handles exist.
  const [a, b] = await Promise.all([
    unknown.catch((e: ProtocolFailure) => e.publicMessage),
    malformed.catch((e: ProtocolFailure) => e.publicMessage),
  ]);
  assert.equal(a, b);
});

test('one payment’s handle does not read another payment’s status', async () => {
  const ex = executor();
  const a = await ex.submit(intentFor('jj'));
  const b = await ex.submit(intentFor('kk'));
  ex.store.transition({
    intentId: b.intentId,
    from: ['WAITING_FOR_PRIVACY'],
    to: 'POLICY_CHECKING',
    now: NOW,
  });
  assert.equal((await ex.getStatus(a.statusHandle)).state, 'WAITING_FOR_PRIVACY');
  assert.equal((await ex.getStatus(b.statusHandle)).state, 'POLICY_CHECKING');
});

test('status is the safe projection: no payload, no outbox, no broadcast id', async () => {
  const ex = executor();
  const ref = await ex.submit(intentFor('ll'));
  const status = await ex.getStatus(ref.statusHandle);
  for (const leaked of ['encryptedPayload', 'outbox', 'broadcast', 'intent', 'idempotencyKey']) {
    assert.equal(leaked in status, false, `status exposes ${leaked}`);
  }
});

// ── the queue the workflow reads ──────────────────────────────────────────

test('pending lists intents in submission order and holds ciphertext only', async () => {
  const ex = executor();
  await ex.submit(intentFor('m1'));
  await ex.submit(intentFor('m2'));
  const pending = ex.pending(NOW);
  assert.deepEqual(pending.map((r) => r.intent.idempotencyKey), ['m1', 'm2']);
  // Insertion order, so two workflow nodes see the same list and can agree.
  assert.match(pending[0]!.intent.encryptedPayload, /^0x(ab)+$/);
});

test('a settled intent leaves the queue; a past-deadline one does NOT', async () => {
  const ex = executor();
  const a = await ex.submit(intentFor('n1'));
  await ex.submit(intentFor('n2'));

  ex.store.fail(a.intentId, { code: 'POLICY_DENIED', retryable: false, publicMessage: 'no' }, NOW);
  assert.deepEqual(ex.pending(NOW).map((r) => r.intent.idempotencyKey), ['n2']);

  // Past its deadline and still pending: the deadline branch is what fires it,
  // so dropping it here would strand exactly the payments that most need to go.
  const late = (NOW + 7200n) as UnixSeconds;
  assert.equal(ex.pending(late).length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { paymentDeadline } from './payment-deadline.ts';

test('uses an immediate deadline when privacy waiting is off', () => {
  assert.equal(paymentDeadline({ waitForPrivacy: false, nowMs: 1_700_000_000_450 }), 1_700_000_001n);
});

test('uses the user-selected latest settlement time when privacy waiting is on', () => {
  assert.equal(paymentDeadline({ waitForPrivacy: true, selectedMs: 1_700_003_600_999, nowMs: 1_700_000_000_000 }), 1_700_003_600n);
});

test('rejects a missing or expired privacy-wait deadline', () => {
  assert.throws(() => paymentDeadline({ waitForPrivacy: true, nowMs: 1_700_000_000_000 }), /Choose a future latest-settlement time/);
  assert.throws(() => paymentDeadline({ waitForPrivacy: true, selectedMs: 1_700_000_000_000, nowMs: 1_700_000_000_000 }), /Choose a future latest-settlement time/);
});

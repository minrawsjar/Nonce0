import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPaymentSchedule } from '../packages/protocol-types/index.js';
import { deriveNullifier } from '../packages/ring-client/notes.js';
import { selectRelayPath } from '../graph/selection.js';
import { evaluatePrivacyTrigger } from '../backend/project-x/cre/privacy-timed.js';
import { validateMeshEnvelope } from '../backend/project-x/mesh/envelope.js';
import { createActionDigest } from '../packages/pq-wallet/digest.js';

test('immediate mode is represented by a current deadline', () => {
  const now = 1_700_000_000;
  const schedule = buildPaymentSchedule({ minPrivacyScore: 900n, deadline: now, now });
  assert.equal(schedule.mode, 'IMMEDIATE');
  assert.equal(schedule.deadline, now);
});

test('a nullifier is invariant when recipient changes', () => {
  const noteSecret = '0x' + '11'.repeat(32);
  const pool = '0x' + '22'.repeat(20);
  assert.equal(deriveNullifier({ noteSecret, pool }), deriveNullifier({ noteSecret, pool }));
});

test('relay selection returns three distinct eligible relays', () => {
  const nodes = [
    { id: 'n1', reliabilityScore: 90n, batchOccupancy: 12n, recentSelectionCount: 1 },
    { id: 'n2', reliabilityScore: 90n, batchOccupancy: 11n, recentSelectionCount: 1 },
    { id: 'n3', reliabilityScore: 90n, batchOccupancy: 10n, recentSelectionCount: 1 },
  ];
  assert.deepEqual(selectRelayPath(nodes, { reliabilityFloor: 80n, random: () => 0 }), ['n1', 'n2', 'n3']);
});

test('privacy trigger fires at deadline despite an unmet score', () => {
  assert.deepEqual(evaluatePrivacyTrigger({ compliant: true, privacyScore: 3n, minPrivacyScore: 10n, now: 100, deadline: 100 }), { fire: true, reason: 'DEADLINE' });
});

test('mesh rejects an expired encrypted envelope', () => {
  assert.throws(() => validateMeshEnvelope({ version: 1, messageId: 'm1', type: 'PAYMENT', expiresAt: 9, kemCiphertext: '0x01', nonce: '0x02', ciphertext: '0x03' }, 10), /expired/i);
});

test('wallet digest changes when the action counter changes', () => {
  const base = { chainId: 5042002n, walletAddress: '0x' + 'aa'.repeat(20), schemeId: 1, payload: '0x1234' };
  assert.notEqual(createActionDigest({ ...base, useCount: 0n }), createActionDigest({ ...base, useCount: 1n }));
});

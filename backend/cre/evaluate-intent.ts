// T8 — deadline-first eligibility, decryption only after it.
//
// The original design promised "decrypt only at fire", which is not
// implementable: the handler cannot know whether a private recipient policy
// passes without first reading the private input. The honest rule, and the one
// below, is two-stage:
//
//   decrypt only for an ELIGIBLE evaluation attempt; release only after policy
//   APPROVAL.
//
// Two orderings carry the weight:
//
//   * Deadline is checked BEFORE the score. A Graph outage must not strand a
//     payment whose deadline has passed — the deadline branch makes no Graph
//     request at all.
//   * The payload is not decrypted while an intent is merely waiting. A score
//     below threshold returns without the TEE ever seeing the spend.

import {
  ProtocolFailure,
  type EncryptedIntent,
  type IntentId,
  type PrivacyScore,
  type PrivateSpend,
  type UnixSeconds,
} from '@chaff/protocol-types';
import { spendHash } from '@chaff/protocol-types/codecs.js';

export type PolicyOutcome =
  | { readonly kind: 'APPROVED' }
  | { readonly kind: 'DENIED'; readonly reason: string }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export type ScoreReading =
  | { readonly kind: 'FRESH'; readonly score: PrivacyScore; readonly observedAt: UnixSeconds }
  | { readonly kind: 'STALE'; readonly observedAt: UnixSeconds }
  | { readonly kind: 'UNAVAILABLE' };

/**
 * Everything the evaluator is allowed to touch. Passing these in rather than
 * importing them keeps the decision pure and makes "was the score even read?"
 * an observable fact in tests rather than a claim.
 */
export interface EvaluationDeps {
  /** Called ONLY on the pre-deadline branch. */
  readFreshScore(intent: EncryptedIntent): Promise<ScoreReading>;
  /** Runs inside the TEE. Called ONLY once eligible. */
  decryptInTee(intent: EncryptedIntent): Promise<{ spend: PrivateSpend; credential: string }>;
  /** Runs inside the TEE, on the decrypted credential. */
  checkRecipientPolicy(spend: PrivateSpend, credential: string): Promise<PolicyOutcome>;
}

export type EvaluationResult =
  | { readonly kind: 'TERMINAL'; readonly state: 'SETTLED' | 'FAILED' }
  | { readonly kind: 'WAITING'; readonly reason: 'SCORE_BELOW_THRESHOLD'; readonly score: PrivacyScore }
  | { readonly kind: 'WAITING'; readonly reason: 'SCORE_UNAVAILABLE' | 'SCORE_STALE'; readonly retryable: true }
  | { readonly kind: 'DENIED'; readonly reason: string }
  | { readonly kind: 'RETRY'; readonly reason: string }
  | { readonly kind: 'APPROVED'; readonly spend: PrivateSpend; readonly deadlineReached: boolean };

export interface EvaluationInput {
  readonly intentId: IntentId;
  readonly intent: EncryptedIntent;
  readonly now: UnixSeconds;
  readonly terminal?: 'SETTLED' | 'FAILED';
  /** Atomically claims one attempt. False means another worker already has it. */
  readonly claimAttempt: () => boolean;
}

export async function evaluateIntent(
  input: EvaluationInput,
  deps: EvaluationDeps,
): Promise<EvaluationResult> {
  const { intent, now } = input;

  if (input.terminal !== undefined) {
    return { kind: 'TERMINAL', state: input.terminal };
  }

  const deadlineReached = now >= intent.deadline;
  let observedScore: PrivacyScore | undefined;

  // ── stage 1: public eligibility. No payload is decrypted here. ──────────
  if (!deadlineReached) {
    const reading = await deps.readFreshScore(intent);

    if (reading.kind === 'UNAVAILABLE') {
      return { kind: 'WAITING', reason: 'SCORE_UNAVAILABLE', retryable: true };
    }
    if (reading.kind === 'STALE') {
      // A stale score cannot authorise early execution. Waiting is correct:
      // the deadline branch will fire eventually regardless.
      return { kind: 'WAITING', reason: 'SCORE_STALE', retryable: true };
    }
    if (reading.score < intent.minPrivacyScore) {
      return { kind: 'WAITING', reason: 'SCORE_BELOW_THRESHOLD', score: reading.score };
    }
    observedScore = reading.score;
  }
  void observedScore;

  // ── stage 2: eligible. One attempt, claimed atomically. ─────────────────
  if (!input.claimAttempt()) {
    return { kind: 'RETRY', reason: 'another worker holds this evaluation attempt' };
  }

  const { spend, credential } = await deps.decryptInTee(intent);

  // The intent's public spendHash is a binding, so a payload swapped after
  // submission is caught before any policy call is made on it.
  if (spendHash(spend) !== intent.spendHash) {
    throw new ProtocolFailure('INVALID_INPUT', 'decrypted spend does not match the submitted spendHash');
  }
  if (
    spend.scope.chainId !== intent.scope.chainId ||
    spend.scope.pool !== intent.scope.pool ||
    spend.scope.denomination !== intent.scope.denomination
  ) {
    throw new ProtocolFailure('INVALID_INPUT', 'decrypted spend is scoped to a different pool');
  }

  const outcome = await deps.checkRecipientPolicy(spend, credential);

  // Denied is terminal; unavailable is retryable. Neither releases. Collapsing
  // the two would either strand a payment on a transient outage or treat an
  // outage as permission.
  if (outcome.kind === 'DENIED') return { kind: 'DENIED', reason: outcome.reason };
  if (outcome.kind === 'UNAVAILABLE') return { kind: 'RETRY', reason: outcome.reason };

  return { kind: 'APPROVED', spend, deadlineReached };
}

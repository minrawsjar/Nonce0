// T9 — durable intent state, idempotency and receipt reconciliation.
//
// The failures this file exists to prevent are all failures of *ambiguity*,
// not of cryptography:
//
//   * A lost acknowledgement is not a failure. Marking FAILED because a
//     response never came back can strand a payment that actually settled.
//   * A spent nullifier is not proof THIS intent settled. Someone else may
//     have spent that note directly — the pool is permissionless. SETTLED
//     requires a matching transaction, not a matching nullifier.
//   * Two workers must not mint two different releases for one intent. State
//     transitions are compare-and-set, and the outbox is created in the same
//     step as the transition that authorises it.

import {
  ProtocolFailure,
  TERMINAL_INTENT_STATES,
  type ApprovedRelease,
  type EncryptedIntent,
  type IdempotencyKey,
  type IntentId,
  type IntentState,
  type IntentStatus,
  type ProtocolError,
  type TxHash,
  type UnixSeconds,
} from '@chaff/protocol-types';
import { spendHash } from '@chaff/protocol-types/codecs.js';

export interface IntentRecord {
  readonly intentId: IntentId;
  readonly intent: EncryptedIntent;
  readonly state: IntentState;
  readonly deadlineReached: boolean;
  readonly updatedAt: UnixSeconds;
  readonly attempts: number;
  /** Set once, when policy approves. Never replaced for the same intent. */
  readonly outbox?: ApprovedRelease;
  readonly broadcast?: TxHash;
  readonly txHash?: TxHash;
  readonly error?: ProtocolError;
}

/** Evidence that a specific transaction settled a specific spend. */
export interface SettlementEvidence {
  readonly txHash: TxHash;
  readonly spendHash: string;
  readonly succeeded: boolean;
}

const isTerminal = (state: IntentState): boolean => TERMINAL_INTENT_STATES.includes(state);

export class IntentStore {
  #byId = new Map<IntentId, IntentRecord>();
  #byIdempotency = new Map<IdempotencyKey, IntentId>();
  /** Held attempt claims, so two workers cannot evaluate the same intent. */
  #leases = new Set<IntentId>();

  /**
   * Idempotent submission. The same key with the same canonical request
   * returns the same intent; the same key with DIFFERENT content is a caller
   * bug and rejects rather than silently overwriting the first payment.
   */
  submit(input: {
    readonly intentId: IntentId;
    readonly intent: EncryptedIntent;
    readonly now: UnixSeconds;
  }): IntentRecord {
    const existing = this.#byIdempotency.get(input.intent.idempotencyKey);
    if (existing !== undefined) {
      const record = this.#byId.get(existing)!;
      if (record.intent.spendHash !== input.intent.spendHash) {
        throw new ProtocolFailure(
          'INVALID_INPUT',
          'idempotency key reused with different content',
        );
      }
      return record;
    }

    const record: IntentRecord = {
      intentId: input.intentId,
      intent: input.intent,
      state: 'WAITING_FOR_PRIVACY',
      deadlineReached: false,
      updatedAt: input.now,
      attempts: 0,
    };
    this.#byId.set(input.intentId, record);
    this.#byIdempotency.set(input.intent.idempotencyKey, input.intentId);
    return record;
  }

  get(intentId: IntentId): IntentRecord | undefined {
    return this.#byId.get(intentId);
  }

  /** Atomic claim. Returns false if another worker already holds this intent. */
  claimAttempt(intentId: IntentId): boolean {
    if (this.#leases.has(intentId)) return false;
    const record = this.#byId.get(intentId);
    if (record === undefined || isTerminal(record.state)) return false;
    this.#leases.add(intentId);
    this.#byId.set(intentId, { ...record, attempts: record.attempts + 1 });
    return true;
  }

  releaseClaim(intentId: IntentId): void {
    this.#leases.delete(intentId);
  }

  /** Compare-and-set. A stale expectation loses rather than clobbering. */
  transition(input: {
    readonly intentId: IntentId;
    readonly from: readonly IntentState[];
    readonly to: IntentState;
    readonly now: UnixSeconds;
    readonly patch?: Partial<IntentRecord>;
  }): IntentRecord {
    const record = this.#byId.get(input.intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    if (isTerminal(record.state)) {
      throw new ProtocolFailure('INVALID_INPUT', `intent is already ${record.state}`);
    }
    if (!input.from.includes(record.state)) {
      throw new ProtocolFailure('INVALID_INPUT', `intent is ${record.state}, expected one of ${input.from.join('/')}`);
    }
    const next: IntentRecord = { ...record, ...input.patch, state: input.to, updatedAt: input.now };
    this.#byId.set(input.intentId, next);
    return next;
  }

  /**
   * Records the authorised release, in the SAME step as the transition that
   * authorises it. Once an outbox entry exists it is never replaced: a retry
   * re-delivers the identical release, so a second evaluation cannot produce
   * a second, different spend.
   */
  authorize(input: {
    readonly intentId: IntentId;
    readonly release: ApprovedRelease;
    readonly now: UnixSeconds;
  }): ApprovedRelease {
    const record = this.#byId.get(input.intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    if (record.outbox !== undefined) return record.outbox;

    this.transition({
      intentId: input.intentId,
      from: ['WAITING_FOR_PRIVACY', 'POLICY_CHECKING', 'RETRYING'],
      to: 'READY_TO_RELEASE',
      now: input.now,
      patch: { outbox: input.release },
    });
    return input.release;
  }

  /** Persisted BEFORE a broadcast is declared successful, never after. */
  recordBroadcast(intentId: IntentId, txHash: TxHash, now: UnixSeconds): IntentRecord {
    return this.transition({
      intentId,
      from: ['READY_TO_RELEASE', 'RELEASING', 'RETRYING'],
      to: 'SETTLEMENT_PENDING',
      now,
      patch: { broadcast: txHash },
    });
  }

  /**
   * The only route to SETTLED. Requires a successful transaction whose spend
   * matches this intent's own outbox — a spent nullifier alone proves someone
   * spent that note, not that this intent is what did it.
   */
  reconcile(input: {
    readonly intentId: IntentId;
    readonly evidence: SettlementEvidence | null;
    readonly nullifierSpent: boolean;
    readonly now: UnixSeconds;
  }): IntentRecord {
    const record = this.#byId.get(input.intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    if (isTerminal(record.state)) return record;

    const expected = record.outbox === undefined ? undefined : spendHash(record.outbox.spend);

    if (input.evidence?.succeeded === true && input.evidence.spendHash === expected) {
      return this.transition({
        intentId: input.intentId,
        from: ['READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING'],
        to: 'SETTLED',
        now: input.now,
        patch: { txHash: input.evidence.txHash },
      });
    }

    // Someone spent the note, but not through this intent's release. The
    // reservation must be released and the note re-checked; this is NOT a
    // settlement and it is NOT this intent's failure.
    if (input.nullifierSpent) {
      return this.transition({
        intentId: input.intentId,
        from: ['READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING', 'WAITING_FOR_PRIVACY'],
        to: 'RETRYING',
        now: input.now,
        patch: {
          error: {
            code: 'NULLIFIER_SPENT',
            retryable: false,
            publicMessage: 'this note was spent by a transaction that is not this payment',
          },
        },
      });
    }

    // No conclusive evidence either way. Stay resumable — never invent a
    // terminal state from silence.
    return this.transition({
      intentId: input.intentId,
      from: ['READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING'],
      to: 'RETRYING',
      now: input.now,
    });
  }

  /** Terminal failure needs conclusive evidence, which the caller supplies. */
  fail(intentId: IntentId, error: ProtocolError, now: UnixSeconds): IntentRecord {
    if (error.retryable) {
      throw new ProtocolFailure('INVALID_INPUT', 'a retryable condition is not a terminal failure');
    }
    return this.transition({
      intentId,
      from: ['WAITING_FOR_PRIVACY', 'POLICY_CHECKING', 'READY_TO_RELEASE', 'RELEASING', 'SETTLEMENT_PENDING', 'RETRYING'],
      to: 'FAILED',
      now,
      patch: { error },
    });
  }

  /** The safe projection. Never exposes the outbox, the payload or a broadcast id. */
  status(intentId: IntentId): IntentStatus {
    const record = this.#byId.get(intentId);
    if (record === undefined) throw new ProtocolFailure('INVALID_INPUT', 'unknown intent');
    return {
      state: record.state,
      deadlineReached: record.deadlineReached,
      updatedAt: record.updatedAt,
      ...(record.txHash === undefined ? {} : { txHash: record.txHash }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }
}

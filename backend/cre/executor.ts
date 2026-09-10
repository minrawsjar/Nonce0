// The submission side of confidential execution: what accepts a payment and
// hands it to the workflow.
//
// IntentStore holds the lifecycle. This adds the two things a caller outside
// the enclave needs and the store deliberately does not have:
//
//   1. An INTENT ID that is not derived from anything about the payment.
//   2. A STATUS HANDLE that is a capability rather than a name.
//
// ── Why the handle is not the intent id ──────────────────────────────────
//
// getStatus is reachable, through the mesh, by whoever holds the handle. If
// the handle were the intent id, then anyone who learned an id from a log, a
// queue, or a relay could watch that payment settle. Worse, ids would be
// enumerable and the whole store becomes a directory of who is paying whom.
//
// So the handle is 32 bytes of OS randomness, mapped to an intent id in one
// direction only, and an unknown handle is refused exactly like a known handle
// with the wrong bytes. It is a bearer capability: holding it IS the
// authorisation, which is why it never appears in a log line.
//
// ── Why status is coarse ─────────────────────────────────────────────────
//
// The state machine already says the useful thing. Adding a reason string for
// every WAITING would leak the privacy score, the pool's occupancy, or the
// policy outcome to a caller who is only entitled to know that their payment
// has not settled yet.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  ProtocolFailure,
  type EncryptedIntent,
  type IntentId,
  type IntentRef,
  type IntentStatus,
  type PrivacyTimedExecutor,
  type StatusHandle,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { IntentStore, type IntentRecord } from './intent-store.ts';

export interface ExecutorOptions {
  readonly store?: IntentStore;
  readonly now?: () => UnixSeconds;
  /** Injected so tests are deterministic. Defaults to the OS. */
  readonly newIntentId?: () => IntentId;
  readonly newStatusHandle?: () => StatusHandle;
}

export interface OpaqueExecutor extends PrivacyTimedExecutor {
  /** The queue the confidential workflow reads. Ciphertext only. */
  pending(now: UnixSeconds): readonly IntentRecord[];
  readonly store: IntentStore;
}

/**
 * Constant-time compare over the handle, so a caller cannot narrow a valid
 * handle byte by byte from response timing. Length is compared first and
 * separately: the loop cannot leak a length it never reads.
 */
function handleMatches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createExecutor(options: ExecutorOptions = {}): OpaqueExecutor {
  const {
    store = new IntentStore(),
    now = () => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds,
    // Not derived from the intent, the payer, or a counter. A sequential id
    // would publish how many payments the deployment has ever handled.
    newIntentId = () => randomUUID() as IntentId,
    newStatusHandle = () => randomBytes(32).toString('hex') as StatusHandle,
  } = options;

  const byHandle = new Map<StatusHandle, IntentId>();
  // One handle per idempotency key, so a resubmission returns the SAME
  // capability rather than minting a second one for a payment that already
  // exists — two live handles for one intent is two things to leak.
  const handleForIntent = new Map<IntentId, StatusHandle>();

  return {
    store,

    async submit(intent: EncryptedIntent): Promise<IntentRef> {
      const at = now();
      if (intent.deadline <= at) {
        // Refused here rather than accepted and failed later: a deadline in
        // the past can never be met, and returning a handle for it would
        // promise a payment that cannot happen.
        throw new ProtocolFailure('EXPIRED', 'the intent deadline has already passed');
      }

      // Idempotent. The store rejects a reused key with different content, so
      // a retry is safe and a collision is loud.
      const record = store.submit({ intentId: newIntentId(), intent, now: at });

      const existing = handleForIntent.get(record.intentId);
      if (existing !== undefined) return { intentId: record.intentId, statusHandle: existing };

      const statusHandle = newStatusHandle();
      byHandle.set(statusHandle, record.intentId);
      handleForIntent.set(record.intentId, statusHandle);
      return { intentId: record.intentId, statusHandle };
    },

    async getStatus(handle: StatusHandle): Promise<IntentStatus> {
      // Scanned rather than looked up, so an unknown handle costs the same as
      // a known one. The map is bounded by live intents.
      let intentId: IntentId | undefined;
      for (const [known, id] of byHandle) {
        if (handleMatches(known, handle)) intentId = id;
      }
      if (intentId === undefined) {
        // One message for unknown, malformed and revoked alike. Telling the
        // caller which would turn this into an oracle for handles that exist.
        throw new ProtocolFailure('INVALID_INPUT', 'no intent for that handle');
      }
      return store.status(intentId);
    },

    pending(at: UnixSeconds): readonly IntentRecord[] {
      return store.pending(at);
    },
  };
}

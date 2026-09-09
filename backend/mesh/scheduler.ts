// §7.1 — the batch queue, the reason a relay does not forward instantly.
//
// An observer watching both sides of one relay pairs "in at t, out at t+4ms"
// and three hops buy nothing: the same correlation joins hop 1's input to hop
// 3's output without anyone decrypting anything. A fixed batch window plus a
// bounded random extra delay breaks that pairing. The latency is a real cost,
// paid on purpose.
//
// It is NOT a traffic-analysis proof. Timing correlation over enough samples,
// and a global passive observer, remain disclosed limitations (protocol.md).
//
// FIXED windows, never adaptive. A window that widens under load leaks the
// load it adapted to, which hands an observer a side channel describing
// exactly the traffic the delay exists to hide.
//
// UNITS. `now`, acceptedAt and releaseAt are unix MILLISECONDS, because the
// window and the extra delay are milliseconds. MeshEnvelope.expiresAt is unix
// SECONDS — the frame carries a u64 of seconds — so it is scaled in exactly
// one place, `expiryMs` below, and nowhere else.
//
// LOGGING. This module logs nothing, at any level, including on the error
// path. A queue id next to a hop-local id in one line would rebuild the very
// linkage property 1 exists to prevent, and the two ids meet only here.

import { randomUUID } from 'node:crypto';

import { ProtocolFailure } from '@opaque/protocol-types';
import { decodeBigint } from '@opaque/protocol-types/codecs.js';

import type { BatchScheduler, QueuedMessage, SchedulerOptions } from './contracts.ts';
import type { MeshEnvelope } from './transport.ts';

/**
 * A BatchScheduler plus the one thing the frozen contract cannot say: a
 * message dropped for expiry is not a message delivered, and the caller has to
 * be able to tell those apart. Structurally still a BatchScheduler.
 */
export interface MeshBatchScheduler extends BatchScheduler {
  /** Messages dropped by drain() because their envelope expired while queued. */
  readonly expired: number;
}

/** Envelope expiry in milliseconds. The only seconds→ms crossing in this file. */
const expiryMs = (envelope: MeshEnvelope): bigint =>
  decodeBigint(envelope.expiresAt, 'expiresAt') * 1000n;

/**
 * The end of the window a message accepted at `now` belongs to: the next
 * multiple of `window` STRICTLY after it. A message that arrives exactly on a
 * boundary waits for the following window — releasing it in the instant it
 * arrived is the zero-delay forward this whole file exists to prevent.
 */
const windowEnd = (now: bigint, window: bigint): bigint =>
  now - (((now % window) + window) % window) + window;

/**
 * An integer in [0, inclusiveMax]. Total by construction: an injected random
 * that returns 1, a negative or NaN yields a valid index rather than an
 * out-of-range swap, which in a shuffle would silently destroy a message.
 */
function pick(random: () => number, inclusiveMax: number): number {
  const n = Math.floor(random() * (inclusiveMax + 1));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), inclusiveMax) : 0;
}

/**
 * Fisher-Yates, uniform over all n! orderings.
 *
 * Not `sort(() => random() - 0.5)`: a random comparator is inconsistent, so
 * the result depends on the sort implementation and is measurably biased
 * towards the input order — which for this queue means arrival order partly
 * survives, which means the batch is not a batch.
 */
function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = pick(random, i);
    const held = items[i]!;
    items[i] = items[j]!;
    items[j] = held;
  }
  return items;
}

export function createBatchScheduler(options: SchedulerOptions): MeshBatchScheduler {
  const { batchWindowMs, maxExtraDelayMs, maxQueue, random } = options;

  if (!Number.isInteger(batchWindowMs) || batchWindowMs <= 0) {
    throw new ProtocolFailure('INVALID_INPUT', 'batchWindowMs must be a positive integer');
  }
  if (!Number.isInteger(maxExtraDelayMs) || maxExtraDelayMs < 0) {
    throw new ProtocolFailure('INVALID_INPUT', 'maxExtraDelayMs must be a non-negative integer');
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 1) {
    // Bounded on purpose: an unbounded queue is a memory oracle, and its
    // growth curve describes the traffic it holds.
    throw new ProtocolFailure('INVALID_INPUT', 'maxQueue must be at least 1');
  }

  const window = BigInt(batchWindowMs);
  let queue: QueuedMessage[] = [];
  let expired = 0;

  return {
    offer(envelope, next, now) {
      // Property 4, validate before queueing: expiry is checked before a slot
      // is taken, so a dead message cannot consume capacity just because
      // capacity happened to be there.
      if (expiryMs(envelope) <= now) {
        throw new ProtocolFailure('EXPIRED', 'envelope has expired');
      }
      // False, never a silent drop: to a sender, a drop and a delivery look
      // identical. The caller turns this into a retryable rejection.
      if (queue.length >= maxQueue) return false;

      queue.push({
        // Property 1. Fresh randomness from the OS, not from `random` and not
        // from anything in the envelope, so a queue id is a function of
        // nothing an operator can correlate. The UUID shape also differs from
        // a 32-hex hopLocalId, so the two cannot be confused for each other.
        queueId: randomUUID(),
        envelope,
        next,
        acceptedAt: now,
        releaseAt: windowEnd(now, window) + BigInt(pick(random, maxExtraDelayMs)),
      });
      return true;
    },

    drain(now) {
      const due: QueuedMessage[] = [];
      const held: QueuedMessage[] = [];

      for (const message of queue) {
        // Expired: dropped here rather than forwarded. The next hop would
        // reject it anyway, and passing it on would spend a batch slot
        // advertising that this relay is holding stale traffic.
        if (expiryMs(message.envelope) <= now) {
          expired++;
          continue;
        }
        (message.releaseAt <= now ? due : held).push(message);
      }

      queue = held;
      // Randomised, so arrival order does not survive the queue.
      return shuffle(due, random);
    },

    get size() {
      return queue.length;
    },

    get expired() {
      return expired;
    },
  };
}

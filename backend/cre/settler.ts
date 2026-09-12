// The executor's side of a CRE decision.
//
// CRE decides in the enclave (cre-release.ts) and posts its decisions to the
// executor, tagged under the secret the two share. For a RELEASE the settler:
//
//   1. checks the tag — only CRE, holding the secret, could have made it;
//   2. opens the payment with the key CRE released, and requires that it is
//      exactly the spend the intent committed to (spendHash) and pays exactly
//      the recipient CRE approved;
//   3. attests it (the attester verifies the 1.1 MiB proof at full strength
//      first — too big for CRE), issues the release, hands it to the egress,
//      and reconciles against the chain.
//
// A DENY is checked the same way and ends the intent. Anything that fails
// after authorisation is retried from the one release in the outbox, never
// re-decided, so an intent can never produce two different spends.

import { timingSafeEqual } from 'node:crypto';

import {
  ProtocolFailure,
  type ApprovedRelease,
  type IntentId,
  type PoolScope,
  type PrivateSpend,
  type ProtocolError,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { asPrivateSpend, fromHex, spendHash as hashOf } from '@opaque/protocol-types/codecs.js';

import { attestRingSpend, type AttesterIdentity } from './attest.ts';
import type { Decision, PendingBatch, PendingIntent } from './cre-release.ts';
import type { OpaqueExecutor } from './executor.ts';
import type { IntentRecord, SettlementEvidence } from './intent-store.ts';
import { issueRelease } from './release.ts';
import { decodeIntentPlaintext, openBulk, releaseTag } from './sealed-intent.ts';

export interface SettlerOptions {
  readonly executor: OpaqueExecutor;
  /** Shared with CRE: checks decision tags, and MACs the release the egress trusts. */
  readonly credentialMac: Uint8Array;
  readonly policyVersion: string;
  readonly releaseTtlSeconds: bigint;
  readonly attester: {
    /** One attester can serve several pools: then, the identity for the spend's pool. */
    readonly identity: AttesterIdentity | ((scope: PoolScope) => AttesterIdentity);
    readonly current: () => Promise<{ readonly forsSeed: Uint8Array; readonly useCount: bigint }>;
  };
  /** Hands a release to the egress and returns the broadcast tx. */
  readonly deliver: (release: ApprovedRelease) => Promise<TxHash>;
  /** What the chain says that tx did — required before anything is SETTLED. */
  readonly evidence: (txHash: TxHash, release: ApprovedRelease) => Promise<SettlementEvidence>;
  readonly nullifierSpent: (spend: PrivateSpend) => Promise<boolean>;
  /** Told when a settlement fails and will be retried. Never given a recipient. */
  readonly onError?: (intentId: IntentId, error: unknown) => void;
  readonly now?: () => UnixSeconds;
}

export interface Settler {
  /** Checks each decision's tag and settles the valid ones in the background. Returns how many it accepted. */
  accept(decisions: readonly Decision[]): number;
  /** One decision, awaited: the local stand-in and tests. */
  settle(decision: Decision): Promise<void>;
  /** Re-delivers authorised releases that have not settled yet. */
  retry(): Promise<void>;
}

/** An intent awaiting CRE: a v2 envelope, no decision yet. */
const awaitingCre = (record: IntentRecord): boolean =>
  record.intent.creEnvelope !== undefined && record.outbox === undefined
  && (record.state === 'WAITING_FOR_PRIVACY' || record.state === 'POLICY_CHECKING');

/**
 * What the executor serves CRE: every intent awaiting a decision, oldest
 * first, until the response would pass `maxBytes` (CRE reads 100 KB). Ids and
 * ciphertext only: CRE reads the terms from inside the envelope.
 */
export function pendingForCre(executor: OpaqueExecutor, now: UnixSeconds, maxBytes = 90_000): PendingBatch {
  const intents: PendingIntent[] = [];
  let size = 32;
  for (const record of executor.pending(now)) {
    if (!awaitingCre(record)) continue;
    const view: PendingIntent = { intentId: record.intentId, spendHash: record.intent.spendHash, envelope: record.intent.creEnvelope! };
    size += JSON.stringify(view).length + 1;
    if (size > maxBytes) break;
    intents.push(view);
  }
  return { intents };
}

const tagMatches = (expected: string, actual: unknown): boolean => {
  if (typeof actual !== 'string' || !/^0x[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(fromHex(expected as never)), Buffer.from(fromHex(actual as never)));
};

export function createSettler(options: SettlerOptions): Settler {
  const { executor } = options;
  const store = executor.store;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const identityFor = (scope: PoolScope): AttesterIdentity =>
    typeof options.attester.identity === 'function' ? options.attester.identity(scope) : options.attester.identity;
  const lastTry = new Map<IntentId, number>();

  // ONE ATTESTATION AT A TIME, FROM SIGNING TO A LANDED TRANSACTION.
  //
  // The registry accepts the attester's signature only for its current use
  // count, and the count moves only when a spend carrying it succeeds. Two notes
  // of one payment are decided in the same CRE tick; settled in parallel, both
  // read count N, both sign for N, the first lands and the second reverts with
  // BadSignature. It is also a few-time key signing two messages at one index,
  // which spends more of its budget than the registry counts. Reserving counts
  // ahead does not work either: if N fails, everything signed for N+1 reverts.
  let tail: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };

  /**
   * A load-balanced RPC can answer from before the block that consumed an index,
   * and the next attestation would sign that index again. Hold the turn until
   * the registry shows it moved, or a rotation replaced the key.
   * ponytail: reads through current(), which rotates near the end of a key's
   * budget; a stale read there reverts the rotation, which is retried next turn.
   * Give the settler a plain state read if that starts showing up.
   */
  async function untilConsumed(used: { readonly useCount: bigint; readonly generation?: number }): Promise<void> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const seen = await options.attester.current() as { readonly useCount: bigint; readonly generation?: number };
      if (seen.generation !== used.generation || seen.useCount > used.useCount) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /** A decision this executor should act on: a known, undecided intent, and a tag only CRE could make. */
  function authentic(decision: Decision): IntentRecord | undefined {
    const record = store.get(decision.intentId as IntentId);
    if (record === undefined || !awaitingCre(record)) return undefined;
    const expected = releaseTag(options.credentialMac, decision.verdict === 'RELEASE'
      ? { intentId: record.intentId, spendHash: record.intent.spendHash, verdict: 'RELEASE', recipient: decision.recipient, k: decision.k }
      : { intentId: record.intentId, spendHash: record.intent.spendHash, verdict: 'DENY' });
    return tagMatches(expected, decision.tag) ? record : undefined;
  }

  const refuse = (intentId: IntentId, code: ProtocolError['code'], message: string): void => {
    try {
      store.fail(intentId, { code, retryable: false, publicMessage: message } as ProtocolError, now());
    } catch { /* already terminal */ }
  };

  /** From an authorised release to SETTLED: delivery, broadcast, evidence. */
  async function deliver(intentId: IntentId, release: ApprovedRelease): Promise<void> {
    const txHash = await options.deliver(release);
    store.recordBroadcast(intentId, txHash, now());
    // SETTLED only on evidence that THIS release's spend succeeded. A spent
    // nullifier alone is not proof — the pool is permissionless.
    store.reconcile({
      intentId,
      evidence: await options.evidence(txHash, release),
      nullifierSpent: await options.nullifierSpent(release.spend),
      now: now(),
    });
  }

  async function settle(decision: Decision): Promise<void> {
    const record = authentic(decision);
    if (record === undefined) return;
    const intentId = record.intentId;
    if (decision.verdict === 'DENY') {
      refuse(intentId, 'POLICY_DENIED', decision.reason);
      return;
    }
    if (!store.claimAttempt(intentId)) return;
    try {
      // Open with the released key, and hold CRE's approval to exactly this
      // spend: the committed hash, the approved recipient, the intent's pool.
      let spend: PrivateSpend;
      try {
        spend = asPrivateSpend(decodeIntentPlaintext(openBulk(fromHex(decision.k as never), record.intent.spendHash, record.intent.encryptedPayload)).spend);
      } catch {
        refuse(intentId, 'INVALID_INPUT', 'the released key does not open this payment');
        return;
      }
      if (hashOf(spend) !== record.intent.spendHash) {
        refuse(intentId, 'INVALID_INPUT', 'the payment is not the spend this intent committed to');
        return;
      }
      if (spend.recipient.toLowerCase() !== decision.recipient.toLowerCase()) {
        refuse(intentId, 'POLICY_DENIED', 'the payment pays a different recipient than CRE approved');
        return;
      }
      if (spend.scope.pool !== record.intent.scope.pool || spend.scope.denomination !== record.intent.scope.denomination) {
        refuse(intentId, 'INVALID_INPUT', 'the payment is scoped to a different pool');
        return;
      }
      const checked = spend;
      await oneAtATime(async () => {
        const at = now();
        const key = await options.attester.current();
        const attested = attestRingSpend({ spend: checked, identity: identityFor(checked.scope), ...key });
        const release = issueRelease({
          intentId, spend: attested, policyVersion: options.policyVersion,
          issuedAt: at, ttlSeconds: options.releaseTtlSeconds, secret: options.credentialMac,
        });
        // Authorised BEFORE delivery: the outbox is created in the same step as
        // the transition that permits it, so a crash cannot mint a second one.
        store.authorize({ intentId, release, now: at });
        await deliver(intentId, release);
        if (store.get(intentId)?.state === 'SETTLED') await untilConsumed(key);
      });
    } catch (error) {
      options.onError?.(intentId, error);
      if (error instanceof ProtocolFailure && error.code === 'PROOF_REJECTED') refuse(intentId, 'PROOF_REJECTED', error.message);
      // Anything else after authorisation is retried from the outbox.
    } finally {
      store.releaseClaim(intentId);
    }
  }

  async function retry(): Promise<void> {
    for (const record of executor.pending(now())) {
      if (record.outbox === undefined) continue;
      if (Date.now() - (lastTry.get(record.intentId) ?? 0) < 10_000) continue;
      if (!store.claimAttempt(record.intentId)) continue;
      lastTry.set(record.intentId, Date.now());
      try {
        // A broadcast already made may have landed: look before resending.
        // If the note is spent, the receipt says whether it was this release.
        if (record.broadcast !== undefined) {
          const spent = await options.nullifierSpent(record.outbox.spend);
          const after = store.reconcile({
            intentId: record.intentId,
            evidence: spent ? await options.evidence(record.broadcast, record.outbox) : null,
            nullifierSpent: spent,
            now: now(),
          });
          if (spent || after.state !== 'RETRYING') continue;
        }
        // In turn with fresh attestations: this re-sends one already signed, and
        // must not race a new one for the same index. It deliberately does not
        // call current() first — that can rotate, consuming the very index this
        // stored attestation was signed for.
        const outbox = record.outbox;
        await oneAtATime(() => deliver(record.intentId, outbox));
      } catch (error) {
        options.onError?.(record.intentId, error);
      } finally {
        store.releaseClaim(record.intentId);
      }
    }
  }

  return {
    accept(decisions) {
      const valid = decisions.filter((d) => authentic(d) !== undefined);
      // In the background: CRE's request times out in 10 s, a settlement
      // takes several. The executor's own retry covers a crash mid-way.
      for (const decision of valid) void settle(decision);
      return valid.length;
    },
    settle,
    retry,
  };
}

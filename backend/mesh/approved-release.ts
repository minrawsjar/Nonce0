// T7 — the verification consumer for a CRE-managed release.
//
// The managed egress is the ONLY mesh component allowed to see a spend in the
// clear, and only after the tag verifies. Ordinary relays never reach this
// code: it runs at the final hop of the internal CRE→egress route, not on the
// public /v1/relay path.
//
// Scope, stated plainly because it is easy to overclaim: this gate governs the
// CRE-managed release route. It is NOT pool-wide policy enforcement. The pool
// verifies a proof and a nullifier and nothing else, so a holder of a valid
// spend can submit directly and never pass through here. Deferred decision D1.

import {
  ProtocolFailure,
  type ApprovedRelease,
  type IntentId,
  type PrivateSpend,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { verifyRelease, type ReleaseSeenSet } from '../cre/release.ts';

export interface EgressSubmitter {
  /** Submits the spend to the pool. Idempotent on the caller's behalf. */
  submit(spend: PrivateSpend): Promise<TxHash>;
  /** V1 settlement. Implementations must submit one CREBatchSettlement call. */
  submitAuthorizations?(authorizations: readonly { readonly id: string; readonly pool: string }[]): Promise<TxHash>;
}

export interface EgressResult {
  readonly txHash: TxHash;
  /** True when this release had already been delivered and was not re-sent. */
  readonly deduplicated: boolean;
}

/**
 * Verify, then submit — never the other way round, and never both for one
 * intent. A duplicate binds to the existing attempt instead of producing a
 * second on-chain transaction for one payment.
 */
export async function deliverApprovedRelease(input: {
  readonly release: ApprovedRelease;
  readonly secret: Uint8Array;
  readonly now: UnixSeconds;
  readonly seen: ReleaseSeenSet;
  readonly submitter: EgressSubmitter;
  readonly priorTxHash?: TxHash;
}): Promise<EgressResult> {
  const spend = verifyRelease({
    release: input.release,
    secret: input.secret,
    now: input.now,
  });

  if (input.seen.seen(input.release.intentId)) {
    if (input.priorTxHash === undefined) {
      // Delivered before but no transaction recorded: the previous attempt's
      // outcome is unknown. Submitting again could double-broadcast, so this
      // is a retryable outage for the caller to reconcile, not a new send.
      throw new ProtocolFailure(
        'MESH_UNAVAILABLE',
        'this release was already delivered; reconcile its outcome before retrying',
        true,
      );
    }
    return { txHash: input.priorTxHash, deduplicated: true };
  }

  // A submit that throws leaves no transaction hash to bind a retry to, so
  // without this the intent is wedged for the life of the process: every retry
  // is "already delivered" with nothing to reconcile against. Forgetting it is
  // safe because resending cannot double-pay. The pool spends a nullifier once,
  // and the submitter simulates first, so a spend that already landed reverts in
  // simulation rather than on chain.
  // ponytail: assumes the throw came before broadcast. A throw after it (a
  // receipt wait timing out) resends into a revert and never records the spend
  // that did land; record the hash at broadcast if receipt waits start timing out.
  try {
    const authorizations = input.release.authorizations;
    if (authorizations !== undefined) {
      if (authorizations.length === 0 || input.submitter.submitAuthorizations === undefined) {
        throw new ProtocolFailure('SETTLEMENT_REVERTED', 'CRE authorization settlement is unavailable', true);
      }
      return { txHash: await input.submitter.submitAuthorizations(authorizations), deduplicated: false };
    }
    return { txHash: await input.submitter.submit(spend), deduplicated: false };
  } catch (error) {
    input.seen.forget(input.release.intentId);
    throw error;
  }
}

/** Egress-side audit line. Deliberately free of anything that identifies a payer. */
export function releaseAuditLine(release: ApprovedRelease, at: UnixSeconds): {
  readonly intentId: IntentId;
  readonly policyVersion: string;
  readonly at: string;
} {
  return {
    intentId: release.intentId,
    policyVersion: release.policyVersion,
    at: at.toString(10),
  };
}

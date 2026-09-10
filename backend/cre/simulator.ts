// A local stand-in for the CRE confidential workflow, run in the executor's
// process until Confidential Workflows access lands.
//
// It reads the same queue the workflow would (executor.pending), runs the same
// evaluation (evaluate-intent.ts), the same credential check (credential.ts)
// and the same attestation (attest.ts) — the modules are shared, not copied —
// then drives the executor's own state machine to SETTLED.
//
// ── What it is NOT ───────────────────────────────────────────────────────
//
// It is not confidential. The whole point of CRE is that INTENT_KEY lives in
// a TEE and the decrypted recipient never leaves it; here it lives in an
// ordinary process that any root user on the box can read. That is why
// capabilities report `confidentialExecution: 'SIMULATED'`, and why this must
// never serve anyone's real payment. It exists so the path around it can be
// built and tested for real while the enclave is unavailable.
//
// ── Why it drives the store itself ───────────────────────────────────────
//
// The store has a real state machine — authorize → recordBroadcast →
// reconcile, and reconcile is the only route to SETTLED — but nothing in the
// running services ever called it. The executor queued and forwarded, so a
// payment that settled on chain still read WAITING_FOR_PRIVACY in the wallet.

import {
  ProtocolFailure,
  type ApprovedRelease,
  type Hex,
  type IntentId,
  type PrivacyScore,
  type PrivateSpend,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { asPrivateSpend } from '@opaque/protocol-types/codecs.js';

import { attestRingSpend, type AttesterIdentity } from './attest.ts';
import { checkCredential, type RecipientCredential } from './credential.ts';
import { evaluateIntent, type ScoreReading } from './evaluate-intent.ts';
import type { OpaqueExecutor } from './executor.ts';
import type { SettlementEvidence } from './intent-store.ts';
import { issueRelease } from './release.ts';
import { decodeIntentPlaintext, openIntent } from './sealed-intent.ts';

export interface CreSimulatorOptions {
  readonly executor: OpaqueExecutor;
  /** ML-KEM decapsulation key. In production, a Vault DON secret. */
  readonly intentSecretKey: Hex;
  readonly encryptionKeyId: string;
  /** Verifies recipient credentials AND MACs the release the egress trusts. */
  readonly credentialMac: Uint8Array;
  readonly policyVersion: string;
  readonly releaseTtlSeconds: bigint;
  readonly attester: {
    readonly identity: AttesterIdentity;
    readonly forsSeed: Uint8Array;
    /** The attester's CURRENT index in PQKeyRegistry. */
    readonly useCount: () => Promise<bigint>;
  };
  /** Hands a release to the egress and returns the broadcast tx. */
  readonly deliver: (release: ApprovedRelease) => Promise<TxHash>;
  /** What the chain says that tx did — required before anything is SETTLED. */
  readonly evidence: (txHash: TxHash, release: ApprovedRelease) => Promise<SettlementEvidence>;
  readonly nullifierSpent: (spend: PrivateSpend) => Promise<boolean>;
  /** Optional pre-deadline score. Absent: an intent fires at its deadline. */
  readonly readFreshScore?: () => Promise<{ score: PrivacyScore; observedAt: UnixSeconds } | null>;
  readonly now?: () => UnixSeconds;
}

export interface CreSimulator {
  /** One pass over the queue. Returns how many intents moved. */
  tick(): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function createCreSimulator(options: CreSimulatorOptions): CreSimulator {
  const { executor } = options;
  const store = executor.store;
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function settle(intentId: IntentId, spend: PrivateSpend, at: UnixSeconds): Promise<void> {
    const attested = attestRingSpend({
      spend,
      identity: options.attester.identity,
      forsSeed: options.attester.forsSeed,
      useCount: await options.attester.useCount(),
    });
    const release = issueRelease({
      intentId,
      spend: attested,
      policyVersion: options.policyVersion,
      issuedAt: at,
      ttlSeconds: options.releaseTtlSeconds,
      secret: options.credentialMac,
    });
    // authorize BEFORE delivery: the outbox is created in the same step as
    // the transition that permits it, so a crash here cannot mint a second,
    // different release for the same intent on the next pass.
    store.authorize({ intentId, release, now: at });
    const txHash = await options.deliver(release);
    store.recordBroadcast(intentId, txHash, at);
    // SETTLED only on evidence that THIS release's spend succeeded. A spent
    // nullifier alone is not proof — the pool is permissionless.
    store.reconcile({
      intentId,
      evidence: await options.evidence(txHash, release),
      nullifierSpent: await options.nullifierSpent(attested),
      now: now(),
    });
  }

  async function tick(): Promise<number> {
    if (running) return 0; // one pass at a time; the store also refuses double claims
    running = true;
    let moved = 0;
    try {
      const at = now();
      for (const record of executor.pending(at)) {
        const result = await evaluateIntent(
          {
            intentId: record.intentId,
            intent: record.intent,
            now: at,
            claimAttempt: () => store.claimAttempt(record.intentId),
          },
          {
            async readFreshScore(): Promise<ScoreReading> {
              const reading = await options.readFreshScore?.();
              return reading === null || reading === undefined
                ? { kind: 'UNAVAILABLE' }
                : { kind: 'FRESH', score: reading.score, observedAt: reading.observedAt };
            },
            async decryptInTee(intent) {
              const plain = openIntent(options.intentSecretKey, options.encryptionKeyId, intent.encryptedPayload);
              const opened = decodeIntentPlaintext(plain);
              // The real codec, not a hand-revived chainId: it validates the
              // whole spend and revives every bigint that crossed as decimal.
              return { spend: asPrivateSpend(opened.spend), credential: opened.credential };
            },
            async checkRecipientPolicy(spend, credential) {
              let parsed: RecipientCredential;
              try {
                const raw = JSON.parse(credential) as Record<string, unknown>;
                parsed = {
                  recipient: raw['recipient'] as RecipientCredential['recipient'],
                  policyVersion: String(raw['policyVersion'] ?? ''),
                  expiresAt: BigInt(String(raw['expiresAt'] ?? '0')) as UnixSeconds,
                  tag: raw['tag'] as Hex,
                };
              } catch {
                return { kind: 'DENIED', reason: 'credential is not readable' };
              }
              // The recipient comes from the DECRYPTED SPEND, never the
              // credential — the same rule the enclave workflow holds.
              return checkCredential({
                recipient: spend.recipient,
                credential: parsed,
                policyVersion: options.policyVersion,
                now: at,
                secret: options.credentialMac,
              });
            },
          },
        );

        try {
          if (result.kind === 'APPROVED') {
            await settle(record.intentId, result.spend, at);
            moved += 1;
          } else if (result.kind === 'DENIED') {
            store.transition({ intentId: record.intentId, from: ['WAITING_FOR_PRIVACY', 'POLICY_CHECKING'], to: 'FAILED', now: at });
            moved += 1;
          }
        } catch (error) {
          // Anything after authorize is recoverable: the outbox holds the ONE
          // release for this intent, so the next pass retries it rather than
          // minting another. Never FAILED on a lost acknowledgement.
          if (error instanceof ProtocolFailure && error.code === 'PROOF_REJECTED') {
            store.transition({ intentId: record.intentId, from: ['WAITING_FOR_PRIVACY', 'POLICY_CHECKING', 'READY_TO_RELEASE'], to: 'FAILED', now: at });
            moved += 1;
          }
        } finally {
          store.releaseClaim(record.intentId);
        }
      }
    } finally {
      running = false;
    }
    return moved;
  }

  return {
    tick,
    start(intervalMs = 3_000) {
      if (timer === undefined) timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

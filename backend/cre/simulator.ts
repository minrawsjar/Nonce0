// A local stand-in for the CRE confidential workflow, for a stack without a
// deployed one (a laptop, the tests).
//
// It runs the workflow's own decision (cre-release.ts) over the executor's own
// pending view, and hands the decisions to the executor's own settler — the
// modules are shared, not copied — so local runs exercise exactly the path a
// deployed workflow drives over HTTP. Only the transport differs: in process
// here, GET /v1/cre/pending and POST /v1/cre/release there.
//
// ── What it is NOT ───────────────────────────────────────────────────────
//
// It is not confidential. The CRE key lives in an ordinary process, so
// nothing it opens is protected; capabilities say `confidentialExecution:
// 'SIMULATED'` whenever this runs. A deployed stack does not run it at all:
// its key exists only in Chainlink's Vault DON.

import type { ApprovedRelease, Hex, IntentId, PoolScope, PrivacyScore, PrivateSpend, TxHash, UnixSeconds } from '@opaque/protocol-types';

import type { AttesterIdentity } from './attest.ts';
import { decide, ringPoolKey } from './cre-release.ts';
import type { OpaqueExecutor } from './executor.ts';
import type { SettlementEvidence } from './intent-store.ts';
import { decapsulationKey } from './sealed-intent.ts';
import { createSettler, pendingForCre } from './settler.ts';

export interface CreSimulatorOptions {
  readonly executor: OpaqueExecutor;
  /** The CRE key: its 64-byte seed (as Vault holds it) or the decapsulation key. */
  readonly intentSecretKey: Hex;
  readonly encryptionKeyId: string;
  /** Verifies recipient credentials, tags decisions, and MACs the release the egress trusts. */
  readonly credentialMac: Uint8Array;
  readonly policyVersion: string;
  readonly releaseTtlSeconds: bigint;
  readonly attester: {
    /** One attester can serve several pools: then, the identity for the spend's pool. */
    readonly identity: AttesterIdentity | ((scope: PoolScope) => AttesterIdentity);
    readonly current: () => Promise<{ readonly forsSeed: Uint8Array; readonly useCount: bigint }>;
  };
  readonly deliver: (release: ApprovedRelease) => Promise<TxHash>;
  readonly evidence: (txHash: TxHash, release: ApprovedRelease) => Promise<SettlementEvidence>;
  readonly nullifierSpent: (spend: PrivateSpend) => Promise<boolean>;
  /** The pool's current privacy score. Absent or null: payments wait for their deadline (or go at once if they asked for 0). */
  readonly readFreshScore?: (scope: PoolScope) => Promise<{ score: PrivacyScore; observedAt: UnixSeconds } | null>;
  /** Told when a settlement fails and will be retried. Never given a recipient. */
  readonly onError?: (intentId: IntentId, error: unknown) => void;
  readonly now?: () => UnixSeconds;
}

export interface CreSimulator {
  /** One pass, as one workflow execution would make. Returns how many intents moved. */
  tick(): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
}

export function createCreSimulator(options: CreSimulatorOptions): CreSimulator {
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const secretKey = decapsulationKey(options.intentSecretKey);
  const settler = createSettler(options);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    let moved = 0;
    try {
      const at = now();
      const pending = pendingForCre(options.executor, at).intents;
      // The workflow reads every pool's score from the subgraph; the stand-in
      // reads those its pending intents are in, by the same key.
      const scores = new Map<string, number>();
      for (const intent of pending) {
        const scope = options.executor.store.get(intent.intentId as IntentId)!.intent.scope;
        const key = ringPoolKey({ chainId: String(scope.chainId), pool: scope.pool.toLowerCase(), denomination: scope.denomination });
        if (scores.has(key)) continue;
        const reading = await options.readFreshScore?.(scope).catch(() => null);
        if (reading != null) scores.set(key, Number(reading.score));
      }
      for (const intent of pending) {
        const decision = decide({
          intent, now: at, scoreOf: (key) => scores.get(key), secretKey,
          encryptionKeyId: options.encryptionKeyId, credentialSecret: options.credentialMac, policyVersion: options.policyVersion,
        });
        if (decision.verdict === 'WAIT') continue;
        await settler.settle(decision);
        moved += 1;
      }
      await settler.retry();
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

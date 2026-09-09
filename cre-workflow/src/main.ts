// The Opaque confidential workflow.
//
// This is the only place in the system where a payment's recipient exists in
// plaintext. Not the relays — they carry an onion. Not the executor — it gets
// an already-approved release. Not the chain — it sees a proof and a
// nullifier. Here, inside a Nitro enclave, for as long as one policy decision
// takes.
//
// ── What CRE actually gives us, and what it does not ─────────────────────
//
// Chainlink documents NO API for encrypting a fresh per-request payload to an
// enclave key. Building against one would mean inventing it. So we don't:
//
//   1. We generate our own ML-KEM-768 keypair offline (tools/keygen.ts).
//   2. The SECRET half becomes a Vault DON secret. `runtime.getSecret` hands
//      it back to this code — the hinge is that a secret is arbitrary bytes we
//      choose, not only an API key.
//   3. The PUBLIC half is published in the signed relay directory, so it
//      inherits an authenticated, versioned origin for free and rotating it is
//      a directory version bump.
//   4. Clients seal each intent to it themselves.
//
// Chainlink holds a key. It does not define our cryptography — which is what
// keeps the sealed intent POST-QUANTUM. A sealed intent is a durable
// ciphertext that must stay secret for years, so "harvest now, decrypt later"
// is the exact risk shape this project exists to move away from.
//
// ── The runtime is not Node ──────────────────────────────────────────────
//
// This compiles to WASM and runs under Javy (QuickJS). node:crypto, Buffer,
// fetch and setTimeout do not exist. Every import below is pure JS for that
// reason, and it is why backend/mesh — which is built on node:crypto — cannot
// be reached from here at all.
//
// ── What leaves the enclave ──────────────────────────────────────────────
//
// Checked against the SDK's own types, not assumed:
//
//   * TeeRuntime.usingTheDons() and reportFromDon() are documented as routed
//     OUTSIDE the TEE. Neither is used anywhere in this file.
//   * ConfidentialHTTPClient.sendRequest takes a Runtime, which a TEE handler
//     does NOT have — so reaching it would mean going through usingTheDons()
//     and leaving the enclave. It is therefore not used either. The plain
//     HTTPClient accepts a TeeRuntime directly, and that is the TEE-mode call.
//
// THE RECIPIENT NEVER LEAVES. There is no policy lookup on the decrypted
// path: the client obtains a credential from the authority once, out of band,
// and seals it in with the spend. The enclave verifies it locally
// (credential.ts). A compliance service that were asked per payment would
// learn every recipient and the exact moment it was paid, which is most of
// what this system exists to withhold.
//
// So the only things crossing the boundary are: sealed intents in (ciphertext),
// a pool privacy score (public, scope only, no recipient), and an
// ApprovedRelease out (a spend policy already approved, plus a MAC).

import { cre, json, ok, type TeeRuntime } from '@chainlink/cre-sdk';

import type { EncryptedIntent, IntentId, PrivacyScore, PrivateSpend, UnixSeconds } from '@opaque/protocol-types';

import { checkCredential, type RecipientCredential } from '../../backend/cre/credential.ts';
import { evaluateIntent, type EvaluationDeps, type PolicyOutcome, type ScoreReading } from '../../backend/cre/evaluate-intent.ts';
import { openIntent } from '../../backend/cre/sealed-intent.ts';
import { issueRelease } from '../../backend/cre/release.ts';

/** Cron, not an HTTP trigger: an inbound request per intent would time the enclave. */
const SCHEDULE = '0 */1 * * * *'; // every minute

export interface Config {
  /** Vault DON secret ids. The VALUES never appear in this file or in config. */
  readonly intentKeySecretId: string;
  readonly releaseMacSecretId: string;
  readonly credentialSecretId: string;
  /** Which key version clients sealed to. Bound into the AEAD's AAD. */
  readonly encryptionKeyId: string;
  /** Where sealed intents are collected from, and where a release is delivered. */
  readonly intentQueueUrl: string;
  readonly egressUrl: string;
  /** Public pool conditions. Carries a scope and never a recipient. */
  readonly scoreUrl: string;
  readonly policyVersion: string;
  /** Delivery window for a release. Deliberately not the payment deadline. */
  readonly releaseTtlSeconds: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Bigints cross as decimal strings, matching encodeBigint everywhere else.
 * JSON.parse gives them back as strings, so every read below converts
 * explicitly rather than trusting a number to have survived.
 */
const bigintFrom = (value: unknown, fallback = 0n): bigint =>
  typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : fallback;

/**
 * protobuf JSON encodes a `bytes` field as base64, and Javy has no Buffer and
 * no guaranteed btoa — so it is spelled out. Ten lines beats a runtime global
 * whose presence under QuickJS nobody has confirmed.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += c === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

const http = new cre.capabilities.HTTPClient();

/**
 * An HTTP call made FROM the enclave. The plain HTTP client is the one whose
 * signature accepts a TeeRuntime; ConfidentialHTTPClient wants a Runtime,
 * which a TEE handler can only reach via usingTheDons() — outside the TEE.
 *
 * Every call site below sends either ciphertext or public data. Nothing that
 * has been decrypted is ever passed to this function except an ApprovedRelease
 * that policy has already approved.
 */
function call(
  runtime: TeeRuntime<Config>,
  url: string,
  method: 'GET' | 'POST',
  body?: unknown,
): unknown {
  const response = http
    .sendRequest(runtime, {
      url,
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: toBase64(utf8(JSON.stringify(body))),
          }),
    })
    .result();
  if (!ok(response)) {
    throw new Error(`${url} answered ${response.statusCode}`);
  }
  return json(response);
}

interface PendingIntent {
  readonly intentId: IntentId;
  readonly intent: EncryptedIntent;
  /** The ciphertext the client sealed to our published ML-KEM key. */
  readonly sealed: `0x${string}`;
  readonly terminal?: 'SETTLED' | 'FAILED';
}

/**
 * The evaluator's dependencies, bound to this runtime and these secrets.
 *
 * evaluate-intent.ts holds the ORDERING that matters — deadline before score,
 * and no decryption while an intent is merely waiting. It is pure, and tested
 * in backend/cre without any of this. What follows is wiring, and deliberately
 * contains no policy of its own.
 */
function depsFor(
  runtime: TeeRuntime<Config>,
  intentSecretKey: `0x${string}`,
  credentialSecret: Uint8Array,
  now: UnixSeconds,
): EvaluationDeps {
  const config = runtime.config;
  return {
    async readFreshScore(intent: EncryptedIntent): Promise<ScoreReading> {
      // Public: the pool's privacy conditions. The request carries a scope and
      // no recipient, which is why it may be made before anything is decrypted
      // and why it is safe to make at all.
      const reading = call(runtime, config.scoreUrl, 'POST', {
        scope: {
          chainId: intent.scope.chainId.toString(),
          pool: intent.scope.pool,
          denomination: intent.scope.denomination,
        },
      }) as { kind?: string; score?: number; observedAt?: string };

      if (reading.kind === 'FRESH' && typeof reading.score === 'number') {
        return {
          kind: 'FRESH',
          score: reading.score as PrivacyScore,
          observedAt: bigintFrom(reading.observedAt) as UnixSeconds,
        };
      }
      if (reading.kind === 'STALE') {
        return { kind: 'STALE', observedAt: bigintFrom(reading.observedAt) as UnixSeconds };
      }
      return { kind: 'UNAVAILABLE' };
    },

    async decryptInTee(intent: EncryptedIntent) {
      // THE line. Everything above handled ciphertext. Everything below holds
      // a recipient in plaintext, inside the enclave, and must never reach
      // usingTheDons(), reportFromDon(), an outbound request or a log.
      const opened = openIntent(intentSecretKey, config.encryptionKeyId, intent.encryptedPayload);
      const parsed = JSON.parse(new TextDecoder().decode(opened)) as {
        spend: PrivateSpend;
        credential: string;
      };
      return { spend: parsed.spend, credential: parsed.credential };
    },

    async checkRecipientPolicy(spend: PrivateSpend, credential: string): Promise<PolicyOutcome> {
      // NO NETWORK CALL. The credential was issued out of band and sealed in
      // with the spend, so the authority never learns which payment used it.
      let parsed: RecipientCredential;
      try {
        const raw = JSON.parse(credential) as Record<string, unknown>;
        parsed = {
          recipient: raw['recipient'] as RecipientCredential['recipient'],
          policyVersion: String(raw['policyVersion'] ?? ''),
          expiresAt: bigintFrom(raw['expiresAt']) as UnixSeconds,
          tag: raw['tag'] as RecipientCredential['tag'],
        };
      } catch {
        return { kind: 'DENIED', reason: 'credential is not readable' };
      }
      return checkCredential({
        // From the DECRYPTED SPEND, never from the credential itself.
        recipient: spend.recipient,
        credential: parsed,
        policyVersion: config.policyVersion,
        now,
        secret: credentialSecret,
      });
    },
  };
}

export async function evaluatePending(runtime: TeeRuntime<Config>): Promise<{
  readonly evaluated: number;
  readonly released: number;
}> {
  const config = runtime.config;

  // The two secrets. getSecret returns a Vault DON secret's VALUE to workflow
  // code — arbitrary bytes we chose, carried as hex because the SDK types a
  // secret's value as a string.
  const intentSecretKey = runtime.getSecret({ id: config.intentKeySecretId }).result()
    .value as `0x${string}`;
  const releaseMac = utf8(runtime.getSecret({ id: config.releaseMacSecretId }).result().value);
  const credentialSecret = utf8(runtime.getSecret({ id: config.credentialSecretId }).result().value);

  const now = BigInt(Math.floor(runtime.now().getTime() / 1000)) as UnixSeconds;
  const pending = call(runtime, config.intentQueueUrl, 'GET') as { intents: PendingIntent[] };

  const claimed = new Set<IntentId>();
  const deps = depsFor(runtime, intentSecretKey, credentialSecret, now);

  let released = 0;
  for (const entry of pending.intents) {
    const result = await evaluateIntent(
      {
        intentId: entry.intentId,
        intent: { ...entry.intent, encryptedPayload: entry.sealed },
        now,
        ...(entry.terminal === undefined ? {} : { terminal: entry.terminal }),
        // One attempt per intent per run. evaluate-intent.ts refuses to
        // decrypt twice for the same claim, so this is the decryption budget.
        claimAttempt: () => (claimed.has(entry.intentId) ? false : (claimed.add(entry.intentId), true)),
      },
      deps,
    );

    if (result.kind !== 'APPROVED') continue;

    // Approved. The release is the ONLY thing that crosses the boundary, and
    // the MAC is what lets the managed egress believe it without re-running
    // any of the policy that produced it.
    const release = issueRelease({
      intentId: entry.intentId,
      spend: result.spend,
      policyVersion: config.policyVersion,
      issuedAt: now,
      ttlSeconds: BigInt(config.releaseTtlSeconds),
      secret: releaseMac,
    });
    call(runtime, config.egressUrl, 'POST', {
      ...release,
      issuedAt: release.issuedAt.toString(),
      expiresAt: release.expiresAt.toString(),
    });
    released++;
  }

  // A COUNT, never an id. "which intents ran" is the correlation this whole
  // system exists to withhold, and a workflow log is not a private place.
  runtime.log(`evaluated ${pending.intents.length}, released ${released}`);
  return { evaluated: pending.intents.length, released };
}

const cron = new cre.capabilities.CronCapability();

export const workflow = [
  cre.handlerInTee(
    cron.trigger({ schedule: SCHEDULE }),
    evaluatePending,
    // AWS Nitro, us-west-2 — the only TEE and region the SDK admits today.
    // Pinned explicitly rather than left to a default, so a widening of the
    // list is a review rather than a silent change of who holds our plaintext.
    [{ tee: 'nitro', regions: ['us-west-2'] }],
  ),
];

export default workflow;

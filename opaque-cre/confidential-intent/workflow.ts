// Opaque — the confidential leg of a private payment.
//
// This handler is the only place in the system where a payment's recipient
// exists in plaintext. Not the relays: they carry a three-hop onion. Not the
// executor: it receives an already-approved release. Not the chain: it sees a
// proof and a nullifier. Here, inside an AWS Nitro enclave, for as long as one
// policy decision takes.
//
// ── Why the key is ours and not Chainlink's ──────────────────────────────
//
// Chainlink documents no API for encrypting a fresh per-request payload to an
// enclave key, so we do not pretend one exists. Instead:
//
//   1. We generate an ML-KEM-768 keypair offline (tools/make-fixture.ts does
//      it for simulation; a real deployment does it on an air-gapped box).
//   2. The SECRET half becomes a Vault DON secret. getSecret() hands it back
//      here — the hinge being that a secret is arbitrary bytes we choose, not
//      only an API key.
//   3. The PUBLIC half is published in the signed relay directory, so the key
//      inherits an authenticated, versioned origin and rotating it is a
//      directory version bump.
//   4. Clients seal each intent to it themselves.
//
// Chainlink holds a key; it does not define our cryptography. That is what
// keeps the sealed intent POST-QUANTUM, which matters here more than almost
// anywhere else: a sealed intent is a durable ciphertext that must stay secret
// for years, so "harvest now, decrypt later" is the exact risk this project
// exists to move away from.
//
// ── What is and is not confidential ──────────────────────────────────────
//
// Confidential: the two Vault secrets, the decrypted spend, the recipient, the
// credential, and every intermediate value — while the computation is inside
// the enclave.
//
// NOT confidential: this logic. The binary is handed to the enclave by the
// Workflow DON, so the code is revealed. The enclave protects the DATA it
// computes over, and nothing here relies on the algorithm being secret.
// Also not confidential: the cron trigger, and anything crossed back out
// through usingTheDons().
//
// ── The recipient never leaves ───────────────────────────────────────────
//
// The obvious design — POST the recipient to a compliance API — is also the
// one that gives the game away, and CRE makes it worse: ConfidentialHTTPClient
// takes a Runtime, which a TEE handler does not have, so reaching it means
// usingTheDons(), which is routed OUTSIDE the enclave.
//
// So there is no policy call. The client obtains a credential from the
// authority once, out of band, and seals it in with the spend. The enclave
// verifies it locally. The authority never learns which payment used it, or
// when. The cost, stated where it is paid: revocation is only as fast as the
// credential TTL.

import { cre, hexToBase64, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

import type {
	Address,
	Bytes32,
	EncryptedIntent,
	Hex,
	IntentId,
	UnixSeconds,
} from '@opaque/protocol-types'

import { checkCredential, type RecipientCredential } from '../../backend/cre/credential.ts'
import { evaluateIntent, type EvaluationDeps } from '../../backend/cre/evaluate-intent.ts'
import { issueRelease } from '../../backend/cre/release.ts'
import { openIntent } from '../../backend/cre/sealed-intent.ts'

// ─── Config ─────────────────────────────────────────────────────────────────

export const configSchema = z.object({
	schedule: z.string(),
	/** Which key version the client sealed to. Bound into the AEAD's AAD. */
	encryptionKeyId: z.string(),
	policyVersion: z.string(),
	/** The ciphertext. Safe in a config file — that is the entire point. */
	sealedIntent: z.string(),
	/** Decimal strings: JSON has no bigint, and JSON.stringify throws on one. */
	deadline: z.string(),
	releaseTtlSeconds: z.string(),
	expectedSpendHash: z.string(),
	chainId: z.string(),
	pool: z.string(),
	denomination: z.number(),
})
type Config = z.infer<typeof configSchema>

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

// ─── The confidential handler ───────────────────────────────────────────────

export const onCronTrigger = async (runtime: TeeRuntime<Config>): Promise<string> => {
	const config = runtime.config

	// ── Step 1: the secrets, released only into an attested enclave ──
	// Nothing is declared upfront. That is Confidential HTTP's mechanism
	// (vaultDonSecrets); a confidential workflow asks at the point of use.
	const intentSecretKey = runtime.getSecret({ id: 'INTENT_KEY' }).result().value as Hex
	const credentialSecret = utf8(runtime.getSecret({ id: 'CREDENTIAL_MAC' }).result().value)

	const now = BigInt(Math.floor(runtime.now().getTime() / 1000)) as UnixSeconds

	// What the relays, the executor and the chain all see: a scope, a hash, a
	// deadline, and an opaque blob. No recipient, no amount beyond the pool's
	// fixed denomination, no policy data.
	const intent: EncryptedIntent = {
		version: 'opaque/v1' as EncryptedIntent['version'],
		scope: {
			chainId: BigInt(config.chainId) as EncryptedIntent['scope']['chainId'],
			pool: config.pool as Address,
			denomination: config.denomination as EncryptedIntent['scope']['denomination'],
		},
		encryptedPayload: config.sealedIntent as Hex,
		encryptionKeyId: config.encryptionKeyId,
		spendHash: config.expectedSpendHash as Bytes32,
		minPrivacyScore: 5_000 as EncryptedIntent['minPrivacyScore'],
		deadline: BigInt(config.deadline) as UnixSeconds,
		idempotencyKey: 'sim-intent-1' as EncryptedIntent['idempotencyKey'],
	}

	let claimed = false

	const deps: EvaluationDeps = {
		// Public data: a pool's privacy conditions, keyed by scope. Carries no
		// recipient, which is why it may be read before anything is decrypted.
		// Not reached in this fixture — the deadline has passed, and the whole
		// point of checking the deadline FIRST is that a Graph outage must never
		// strand a payment whose deadline is up.
		async readFreshScore() {
			return { kind: 'UNAVAILABLE' }
		},

		// ── Step 2: THE line ──
		// Above this point everything handled ciphertext. Below it, a recipient
		// exists in plaintext inside the enclave — and must never reach
		// usingTheDons(), reportFromDon(), an outbound request, or a log.
		async decryptInTee(encrypted: EncryptedIntent) {
			const opened = openIntent(
				intentSecretKey,
				config.encryptionKeyId,
				encrypted.encryptedPayload,
			)
			const parsed = JSON.parse(text(opened)) as {
				spend: Record<string, any>
				credential: string
			}
			// Bigints crossed as decimal strings, because JSON.stringify throws on
			// one outright. They have to be revived before evaluateIntent compares
			// the decrypted scope against the intent's — otherwise "5042002" is
			// tested against 5042002n and every payment is refused as
			// cross-pool. Revived here, at the boundary, so nothing downstream has
			// to remember.
			const spend = {
				...parsed.spend,
				scope: { ...parsed.spend['scope'], chainId: BigInt(parsed.spend['scope'].chainId) },
			}
			return {
				spend: spend as Parameters<typeof issueRelease>[0]['spend'],
				credential: parsed.credential,
			}
		},

		// ── Step 3: policy, in-enclave, with no network call ──
		async checkRecipientPolicy(spend, credential) {
			let parsed: RecipientCredential
			try {
				const raw = JSON.parse(credential) as Record<string, unknown>
				parsed = {
					recipient: raw['recipient'] as Address,
					policyVersion: String(raw['policyVersion'] ?? ''),
					expiresAt: BigInt(String(raw['expiresAt'] ?? '0')) as UnixSeconds,
					tag: raw['tag'] as Hex,
				}
			} catch {
				return { kind: 'DENIED', reason: 'credential is not readable' }
			}
			return checkCredential({
				// Taken from the DECRYPTED SPEND, never from the credential. A
				// credential is only ever accepted for the recipient actually being
				// paid; reading it off the credential would let one issued for an
				// allowed address authorise payment to any other.
				recipient: spend.recipient,
				credential: parsed,
				policyVersion: config.policyVersion,
				now,
				secret: credentialSecret,
			})
		},
	}

	const result = await evaluateIntent(
		{
			intentId: 'sim-intent-1' as IntentId,
			intent,
			now,
			claimAttempt: () => (claimed ? false : ((claimed = true), true)),
		},
		deps,
	)

	// ⚠️ Simulation only. Logs leave the enclave, so this must go before a
	// production deploy. It is a verdict and a count — never a recipient, an
	// amount, or an intent id that could be joined against a relay's records.
	runtime.log(`Enclave decision: ${result.kind}`)

	if (result.kind !== 'APPROVED') {
		return `${result.kind}${'reason' in result ? `: ${result.reason}` : ''}`
	}

	// ── Step 4: mint the release, then cross back ──
	// The release is the ONLY thing that crosses the boundary: a spend policy
	// has already approved, plus a MAC that lets the managed egress believe it
	// without re-running any of the policy that produced it.
	const release = issueRelease({
		intentId: 'sim-intent-1' as IntentId,
		spend: result.spend,
		policyVersion: config.policyVersion,
		issuedAt: now,
		ttlSeconds: BigInt(config.releaseTtlSeconds),
		secret: utf8(runtime.getSecret({ id: 'CREDENTIAL_MAC' }).result().value),
	})

	const donRuntime = runtime.usingTheDons()

	// spendHash and the authentication tag only. The recipient stays behind:
	// crossing it here would undo everything above, and it would still compile.
	const encodedPayload = encodeAbiParameters(
		parseAbiParameters('bytes32 spendHash, bytes32 authTag, uint64 expiresAt'),
		[
			release.spendHash as `0x${string}`,
			release.authenticationTag as `0x${string}`,
			release.expiresAt,
		],
	)

	donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	return `APPROVED (spendHash ${release.spendHash.slice(0, 12)}…, deadline reached: ${result.deadlineReached})`
}

// ─── Workflow init ──────────────────────────────────────────────────────────

export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		// AWS Nitro, us-west-2 — currently the only registered TEE and region.
		// Pinned explicitly rather than left permissive, so a widening of that
		// list is a review rather than a silent change of who holds our plaintext.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}

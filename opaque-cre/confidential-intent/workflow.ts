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

import { cre, hexToBase64, TxStatus, type HTTPPayload, type TeeRuntime } from '@chainlink/cre-sdk'
import { bytesToHex } from 'viem'
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
import { decodeIntentPlaintext, openIntent } from '../../backend/cre/sealed-intent.ts'

// ─── Config ─────────────────────────────────────────────────────────────────

export const configSchema = z.object({
	/**
	 * Ethereum addresses allowed to sign a trigger request. EMPTY ACCEPTS
	 * ANYTHING, which is correct for simulation and wrong for a deployment:
	 * anyone could then queue an intent for the enclave to work through.
	 */
	authorizedKeys: z.array(z.string()),
	/** Which key version clients sealed to. Bound into the AEAD's AAD. */
	encryptionKeyId: z.string(),
	policyVersion: z.string(),
	releaseTtlSeconds: z.string(),
	/**
	 * Where an approved release settles. Optional on purpose: with no receiver
	 * the workflow stops at a signed report, which is what simulation and any
	 * deployment without a live pool should do. Writing to a placeholder
	 * address would look like settlement and settle nothing.
	 */
	settlement: z
		.object({ chainSelector: z.string(), receiver: z.string(), gasLimit: z.string() })
		.optional(),
})

/**
 * What arrives per request. The sealed intent is no longer in config: one
 * intent baked into configuration is a fixture, and a payment protocol needs
 * a payment to arrive.
 *
 * Every bigint is a decimal string, because JSON.stringify throws on a bigint
 * outright. This schema is the boundary where they are revived.
 */
const requestSchema = z.object({
	intentId: z.string(),
	sealedIntent: z.string(),
	spendHash: z.string(),
	deadline: z.string(),
	minPrivacyScore: z.number(),
	idempotencyKey: z.string(),
	scope: z.object({
		chainId: z.string(),
		pool: z.string(),
		denomination: z.number(),
	}),
})
type Config = z.infer<typeof configSchema>

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

// ─── The confidential handler ───────────────────────────────────────────────

export const onIntentSubmitted = async (
	runtime: TeeRuntime<Config>,
	trigger: HTTPPayload,
): Promise<string> => {
	const config = runtime.config

	// The request body arrives as bytes. Parsed and VALIDATED before anything
	// else: this is attacker-supplied input, and the fields below decide which
	// pool a payment is checked against.
	const request = requestSchema.parse(JSON.parse(text(trigger.input)))

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
			chainId: BigInt(request.scope.chainId) as EncryptedIntent['scope']['chainId'],
			pool: request.scope.pool as Address,
			denomination: request.scope.denomination as EncryptedIntent['scope']['denomination'],
		},
		encryptedPayload: request.sealedIntent as Hex,
		encryptionKeyId: config.encryptionKeyId,
		spendHash: request.spendHash as Bytes32,
		minPrivacyScore: request.minPrivacyScore as EncryptedIntent['minPrivacyScore'],
		deadline: BigInt(request.deadline) as UnixSeconds,
		idempotencyKey: request.idempotencyKey as EncryptedIntent['idempotencyKey'],
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
			// The container, not bare JSON: a ring spend's 1.1 MiB proof follows
			// the JSON as raw bytes. decodeIntentPlaintext also still reads the
			// all-JSON form, which the committed simulate fixture uses.
			const parsed = decodeIntentPlaintext(opened) as {
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
			intentId: request.intentId as IntentId,
			intent,
			now,
			claimAttempt: () => (claimed ? false : ((claimed = true), true)),
		},
		deps,
	)

	// NO LOGGING IN HERE. Log output leaves the enclave, so a line written on
	// this side of the boundary is not confidential — and by this point a
	// recipient is in scope. The handler's return value is the only channel,
	// and it carries a verdict and a hash, never a recipient. This is why the
	// decision is not logged even though the reason would be convenient.
	if (result.kind !== 'APPROVED') {
		return `${result.kind}${'reason' in result ? `: ${result.reason}` : ''}`
	}

	// ── Step 4: mint the release, then cross back ──
	// The release is the ONLY thing that crosses the boundary: a spend policy
	// has already approved, plus a MAC that lets the managed egress believe it
	// without re-running any of the policy that produced it.
	const release = issueRelease({
		intentId: request.intentId as IntentId,
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

	const signedReport = donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// ── Step 5: settle, if a receiver is configured ──
	// The write runs on DON nodes, never in the enclave, and carries only what
	// was encoded above. Chain writes are never confidential, which is exactly
	// why the recipient is not in the payload.
	if (config.settlement !== undefined) {
		// The chain selector is a bigint, and arrives as a decimal string for
		// the same reason every other bigint in this project does.
		const txResult = new cre.capabilities.EVMClient(BigInt(config.settlement.chainSelector))
			.writeReport(donRuntime, {
				receiver: config.settlement.receiver,
				report: signedReport,
				gasConfig: { gasLimit: config.settlement.gasLimit },
			})
			.result()

		if (txResult.txStatus !== TxStatus.SUCCESS) {
			// The message can name a node or a nonce, so it is thrown rather
			// than returned: the handler's return value is a caller-facing
			// channel and this is an operator-facing failure.
			throw new Error(`settlement failed with status ${txResult.txStatus}`)
		}
		return `SETTLED ${bytesToHex(txResult.txHash ?? new Uint8Array(32)).slice(0, 12)}…`
	}

	return `APPROVED (spendHash ${release.spendHash.slice(0, 12)}…, deadline reached: ${result.deadlineReached})`
}

// ─── Workflow init ──────────────────────────────────────────────────────────

export function initWorkflow(config: Config) {
	const httpTrigger = new cre.capabilities.HTTPCapability()

	return [
		// AWS Nitro, us-west-2 — currently the only registered TEE and region.
		// Pinned explicitly rather than left permissive, so a widening of that
		// list is a review rather than a silent change of who holds our plaintext.
		cre.handlerInTee(
			httpTrigger.trigger({
				// ECDSA_EVM is the only key type the capability defines. Spelled
				// out rather than defaulted, so an empty list reads as a
				// deliberate "simulation only" and not as a forgotten field.
				authorizedKeys: config.authorizedKeys.map((publicKey) => ({
					type: 'KEY_TYPE_ECDSA_EVM' as const,
					publicKey,
				})),
			}),
			onIntentSubmitted,
			[{ tee: 'nitro', regions: ['us-west-2'] }],
		),
	]
}

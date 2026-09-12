// Opaque — the confidential leg of a private payment.
//
// Every 30 s, inside an AWS Nitro enclave, this handler:
//
//   1. reads the executor's pending payments: ids and sealed envelopes, no
//      more (GET /v1/cre/pending);
//   2. reads every pool's public privacy conditions from The Graph — the
//      same question whichever pools have payments waiting;
//   3. opens each envelope with the CRE key from the Vault DON, and decides
//      on the payer's own sealed terms: WAIT for the pool to reach the score
//      they asked for (or their deadline), RELEASE once it has and the
//      recipient's credential verifies, DENY if either fails;
//   4. posts the decisions back (POST /v1/cre/release), each tagged under a
//      secret shared with the executor. A RELEASE carries the recipient and the
//      key K that opens the payment, so the executor can read a payment only
//      after this enclave has approved it — and only that one.
//
// The decision is backend/cre/cre-release.ts, shared with the local stand-in
// the tests drive, so what runs here is what was tested.
//
// ── Why the executor still settles ───────────────────────────────────────
//
// A ring payment carries a 1.1 MiB zero-knowledge proof; CRE takes 100 KB per
// response. So the proof never comes here: the executor verifies it at full
// strength before its attester signs, and submits the spend through its own
// egress. Arc testnet has a KeystoneForwarder now, so that last write could
// move here; it would need a receiver contract in front of the pools.
//
// ── What is and is not confidential ──────────────────────────────────────
//
// Confidential: the two Vault secrets, every opened envelope — recipient,
// credential, K — and the payloads of the calls below, made from inside the
// enclave.
//
// NOT confidential: this logic. The binary is handed to the enclave by the
// Workflow DON, so the code is revealed; the enclave protects the data it
// computes over. Nor the cron trigger, nor the return value, which is why it
// carries counts only. NOTHING IS LOGGED: log output leaves the enclave.

import { bytesToBase64, CronCapability, handlerInTee, HTTPClient, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { z } from 'zod'

import type { Hex, UnixSeconds } from '@opaque/protocol-types'
import { fromHex } from '@opaque/protocol-types/codecs.js'

import { decide, GRAPH_QUERY, scoresFromGraph, type Decision, type PendingIntent } from '../../backend/cre/cre-release.ts'
import { decapsulationKey, utf8 } from '../../backend/cre/sealed-intent.ts'

export const configSchema = z.object({
	/** Six-field cron; CRE's minimum interval is 30 s. */
	schedule: z.string(),
	/** The executor's public origin: /v1/cre/pending and /v1/cre/release. */
	executorUrl: z.string(),
	/** The subgraph's query URL. */
	graphUrl: z.string(),
	/** The signed relay directory's relays, id → operator. The Graph reports health for these; it cannot add or remove one. */
	relayOperators: z.record(z.string()),
	/** Which CRE key clients sealed to. Bound into every envelope's AAD. */
	encryptionKeyId: z.string(),
	policyVersion: z.string(),
})
type Config = z.infer<typeof configSchema>

// CRE allows 5 HTTP calls per execution: the pending read, the Graph read,
// and three posts. Decisions past that wait a tick; they are re-derived the
// same way, from the same envelopes.
const PER_POST = 20
const POSTS = 3

export const onTick = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config
	const http = new HTTPClient()
	const call = (what: string, url: string, body?: string): string => {
		const response = http
			.sendRequest(runtime, {
				url,
				method: body === undefined ? 'GET' : 'POST',
				...(body === undefined ? {} : { body: bytesToBase64(utf8(body)), multiHeaders: { 'content-type': { values: ['application/json'] } } }),
				cacheSettings: { store: false },
			})
			.result()
		// The status only: a response body could echo what was sent.
		if (!ok(response)) throw new Error(`${what}: HTTP ${response.statusCode}`)
		return text(response)
	}

	const batch = JSON.parse(call('pending', `${config.executorUrl}/v1/cre/pending`)) as { intents?: unknown }
	const intents = (Array.isArray(batch.intents) ? batch.intents : []).filter(
		(i): i is PendingIntent => typeof i?.intentId === 'string' && typeof i.spendHash === 'string' && typeof i.envelope === 'string',
	)
	if (intents.length === 0) return 'idle'

	const now = BigInt(Math.floor(runtime.now().getTime() / 1000)) as UnixSeconds

	// Public data, read before anything is opened. A Graph that is down gives
	// no scores, and payments wait for their deadlines — never go early.
	let scores = new Map<string, number>()
	try {
		scores = scoresFromGraph(JSON.parse(call('graph', config.graphUrl, JSON.stringify({ query: GRAPH_QUERY }))), config.relayOperators, now)
	} catch {
		// Deadlines still release below.
	}

	// Released by the Vault DON into this attested enclave. The CRE key is
	// stored as its 64-byte ML-KEM seed: a 2,400-byte decapsulation key does
	// not fit a 2 KB secret.
	const secretKey = decapsulationKey(runtime.getSecret({ id: 'INTENT_KEY_SEED' }).result().value.trim() as Hex)
	const credentialSecret = fromHex(runtime.getSecret({ id: 'CREDENTIAL_MAC' }).result().value.trim() as Hex)

	const decisions: Decision[] = []
	let waiting = 0
	for (const intent of intents) {
		const decision = decide({
			intent, now, scoreOf: (pool) => scores.get(pool), secretKey,
			encryptionKeyId: config.encryptionKeyId, credentialSecret, policyVersion: config.policyVersion,
		})
		if (decision.verdict === 'WAIT') waiting += 1
		else decisions.push(decision)
	}

	let accepted = 0
	const sent = decisions.slice(0, PER_POST * POSTS)
	for (let i = 0; i < sent.length; i += PER_POST) {
		const reply = JSON.parse(call('release', `${config.executorUrl}/v1/cre/release`, JSON.stringify({ decisions: sent.slice(i, i + PER_POST) }))) as { accepted?: unknown }
		accepted += Number(reply.accepted) || 0
	}

	const released = sent.filter((d) => d.verdict === 'RELEASE').length
	return `${intents.length} pending: ${released} released, ${sent.length - released} denied, ${waiting} waiting, ${accepted} accepted` +
		(decisions.length > sent.length ? `, ${decisions.length - sent.length} next tick` : '')
}

export function initWorkflow(config: Config) {
	// AWS Nitro, us-west-2 — currently the only registered TEE and region.
	// Pinned rather than left permissive, so a widening of that list is a
	// review rather than a silent change of who holds our plaintext.
	return [handlerInTee(new CronCapability().trigger({ schedule: config.schedule }), onTick, [{ tee: 'nitro', regions: ['us-west-2'] }])]
}

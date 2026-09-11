# Opaque — the CRE confidential workflow

The one place a payment's recipient exists in plaintext before it settles.
`confidential-intent/workflow.ts` runs every 30 s in an AWS Nitro enclave
(Chainlink CRE Confidential Workflows) and decides when each pending payment
may go.

```
wallet ──(3-hop relay mesh)──▶ executor (Railway)          CRE enclave, every 30 s
  seals:                         holds, cannot read:        ┌───────────────────────────┐
  · payment under a fresh K       · the payment (under K) ◀─┤ GET  /v1/cre/pending      │
  · envelope → CRE key:           · the envelope            │ POST the Graph: every     │
    K, recipient, credential,                               │      pool's size + relays │
    pool, min score, deadline                               │ open envelopes (Vault key)│
                                                            │ WAIT / RELEASE / DENY     │
                                 on RELEASE (tagged):     ◀─┤ POST /v1/cre/release      │
                                  opens the payment with K, └───────────────────────────┘
                                  checks spend = approved recipient,
                                  verifies the 1.1 MiB proof, attests, settles on Arc
```

- **WAIT**: the pool's privacy score is below what the payer asked for, and
  their deadline has not come.
- **RELEASE**: the score is reached, the deadline has come, or the payer asked
  for no wait. The recipient's credential must also verify. The decision
  carries the recipient and K.
- **DENY**: the envelope does not open, is for another spend, or the
  credential fails.

The decision is `backend/cre/cre-release.ts`. The local stand-in
(`backend/cre/simulator.ts`) and the tests run the same file.

## Why it is split this way

| Constraint (CRE service quotas) | Consequence |
|---|---|
| HTTP response 100 KB; a ring proof is 1.1 MiB | The proof never enters CRE. The executor verifies it at full strength before its attester signs. |
| HTTP trigger: 1 request per 60 s | CRE polls on a cron trigger instead of receiving each payment. |
| A secret holds 2 KB; an ML-KEM-768 decapsulation key is 2,400 bytes | The Vault holds the 64-byte seed, and the enclave derives the key. |
| No CRE forwarder on Arc | A release settles through the executor's egress, not a CRE chain write. |

The executor holds only the CRE **public** key, so it can read a payment only
after CRE releases that payment's K. Timing is decided on the payer's terms,
which are sealed *inside* the envelope. An executor that restated a deadline
could otherwise have every recipient released at once.

## What is and is not confidential

**Confidential:**
- the two Vault secrets;
- every opened envelope: recipient, credential and K;
- the payloads of the three HTTP calls, which are made from inside the enclave.

**Not confidential:**
- **This logic.** The binary is revealed to the Workflow DON; the enclave
  protects the data, not the code.
- The cron trigger.
- The return value, which carries counts only.
- Logs. The handler logs nothing.

## Files

| File | |
|---|---|
| `confidential-intent/workflow.ts` | The TEE handler: cron trigger, three HTTP calls, `decide`. |
| `confidential-intent/config.*.json` | Executor URL, subgraph URL, the pinned relays (id → operator), key id, policy version. |
| `secrets.live.yaml` | Secret ids → environment variable names. Names only. |
| `tools/make-keys.ts` | The key ceremony. |
| `cre-public-key.hex` | The public half. The executor's `CRE_INTENT_PUBLIC_KEY`. |

## Key ceremony

```bash
npm run keys        # writes .env.live (0600, gitignored); refuses to overwrite
```

`.env.live` holds `OPAQUE_SEED_HEX` (the Vault's `INTENT_KEY_SEED`) and
`OPAQUE_MAC_HEX` (`CREDENTIAL_MAC`). The MAC is shared with the executor: it
verifies recipient credentials and tags CRE's decisions. Move it to Railway
without printing it:

```bash
sed -n 's/^OPAQUE_MAC_HEX=//p' .env.live | tr -d '\n' | railway variable set CREDENTIAL_MAC --stdin --skip-deploys
tr -d '\n' < cre-public-key.hex | railway variable set CRE_INTENT_PUBLIC_KEY --stdin --skip-deploys
railway variable set CRE_MODE=workflow
```

## Simulate, deploy

```bash
(cd confidential-intent && bun install)
npm run simulate    # one tick against the live executor, secrets from .env.live
cre secrets create secrets.live.yaml --target staging-settings --secrets-auth browser --env .env.live --yes
cre workflow deploy ./confidential-intent --target staging-settings --yes
cre execution list opaque-confidential-release
```

Both targets use the Chainlink-hosted **private** registry (`deployment-registry`
in `workflow.yaml`): your logged-in account authorises it in the browser, with
no wallet and no gas. The only on-chain registry is on Ethereum mainnet. A
workflow deployed to the private registry is active at once; `cre workflow
pause` stops it.

Simulation runs one real tick. It reads the live pending list, decides, and
posts real decisions, so a pending payment settles. Deploying a TEE handler
requires [Confidential Workflows access](https://docs.chain.link/cre/account/confidential-workflows-access)
(private beta); simulation does not. The executor reports
`confidentialExecution: 'ATTESTED'` only with `CRE_TEE=1`, which is set once the
deployed workflow runs in the enclave.

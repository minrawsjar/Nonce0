# Opaque CRE: The Confidential Workflow

> **Chainlink CRE Confidential Workflows, TypeScript SDK, AWS Nitro. Deployed and active.**

The one place a payment's recipient exists in plaintext before it settles. [`confidential-intent/workflow.ts`](confidential-intent/workflow.ts) runs every 30 seconds in an AWS Nitro enclave and decides when each waiting payment may go. The partner write-up, with deployment evidence, is [partner-docs/chainlink.md](../partner-docs/chainlink.md).

| | |
|---|---|
| **Workflow** | `opaque-confidential-release` |
| **Workflow ID** | `003e31eff41f5e26b3a5c7414efba42245ba4687550a43986e15e51e4e71686e` |
| **Registry** | Chainlink-hosted private registry |
| **Enclave** | `nitro`, `us-west-2` |
| **Trigger** | Cron, every 30 seconds |

## What It Does

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

| Decision | When |
|---|---|
| **WAIT** | The pool's privacy score is below what the payer asked for, and their deadline has not come |
| **RELEASE** | The score is reached, the deadline has come, or the payer asked for no wait; and the recipient's credential verifies. The decision carries the recipient and K |
| **DENY** | The envelope does not open, is for another spend, or the credential fails |

The decision itself is [`backend/cre/cre-release.ts`](../backend/cre/cre-release.ts). The local stand-in ([`backend/cre/simulator.ts`](../backend/cre/simulator.ts)) and the tests run the same file, so what runs in the enclave is what was tested.

## Folder Structure

```
opaque-cre/
├── project.yaml                  # CRE project settings and targets
├── confidential-intent/
│   ├── workflow.ts               #   The TEE handler: cron trigger, three HTTP calls, decide
│   ├── main.ts                   #   Entry point
│   ├── workflow.yaml             #   Name, private registry, secrets path
│   ├── config.staging.json       #   Executor URL, subgraph URL, pinned relays, key id, policy
│   └── config.production.json
├── secrets.live.yaml             # Secret ids → environment variable names. Names only
├── tools/make-keys.ts            # The key ceremony
└── cre-public-key.hex            # The public half: the executor's CRE_INTENT_PUBLIC_KEY
```

## Why the Work Is Split

| CRE limit | Consequence |
|---|---|
| HTTP response of 100 KB; a ring proof is 1.1 MiB | The proof never enters CRE. The executor verifies it at full strength before its attester signs |
| HTTP trigger: one request per 60 seconds | CRE polls on a cron trigger instead of receiving each payment |
| 5 HTTP calls per execution | One pending read, one Graph read, up to three posts of 20 decisions |
| A secret holds 2 KB; an ML-KEM-768 decapsulation key is 2,400 bytes | The Vault holds the 64-byte seed and the enclave derives the key |

Settlement still goes through the executor's egress, because the executor is what verified the proof. Arc testnet now has a KeystoneForwarder, so the final write could move into the workflow; it needs a small receiver contract in front of the pools.

The executor holds only the CRE **public** key, so it can read a payment only after CRE releases that payment's K. Timing is decided on the payer's terms, which are sealed inside the envelope. An executor that could restate a deadline could otherwise release every payment at once.

## What Is and Is Not Confidential

**Confidential:**

- the two Vault DON secrets;
- every opened envelope: recipient, credential and K;
- the payloads of the three HTTP calls, made from inside the enclave.

**Not confidential:**

- **This logic.** The binary is revealed to the Workflow DON; the enclave protects the data, not the code.
- The cron trigger.
- The return value, which carries counts only.
- Logs. The handler logs nothing.

## Setup

### Prerequisites

- The [CRE CLI](https://docs.chain.link/cre), logged in with `cre login`
- [Confidential Workflows access](https://docs.chain.link/cre/account/confidential-workflows-access) to deploy; simulation does not need it
- Bun, to install the workflow's dependencies

### Key ceremony

```bash
npm run keys        # writes .env.live (0600, gitignored); refuses to overwrite
```

`.env.live` holds `OPAQUE_SEED_HEX` (the Vault's `INTENT_KEY_SEED`) and `OPAQUE_MAC_HEX` (`CREDENTIAL_MAC`). The MAC is shared with the executor, which uses it to check recipient credentials and CRE's decision tags. Move it to Railway without printing it:

```bash
sed -n 's/^OPAQUE_MAC_HEX=//p' .env.live | tr -d '\n' | railway variable set CREDENTIAL_MAC --stdin --skip-deploys
tr -d '\n' < cre-public-key.hex | railway variable set CRE_INTENT_PUBLIC_KEY --stdin --skip-deploys
railway variable set CRE_MODE=workflow
```

### Simulate and deploy

```bash
(cd confidential-intent && bun install)
npm run simulate    # one real tick against the live executor, secrets from .env.live
cre secrets create secrets.live.yaml --target staging-settings --secrets-auth browser --env .env.live --yes
cre workflow deploy ./confidential-intent --target staging-settings --yes
cre execution list opaque-confidential-release --target staging-settings
```

Both targets use the private registry (`deployment-registry` in `workflow.yaml`). The logged-in account authorises it in the browser, with no wallet and no gas, and a workflow deployed there is active at once. `cre workflow pause` stops it.

Simulation runs one real tick: it reads the live pending list, decides and posts real decisions, so a pending payment settles. The executor reports `confidentialExecution: 'ATTESTED'` only with `CRE_TEE=1`, which is set once the deployed workflow runs in the enclave.

## Tech Stack

| Technology | Purpose |
|---|---|
| **`@chainlink/cre-sdk`** | `handlerInTee`, `CronCapability`, `HTTPClient`, Vault DON secrets |
| **zod** | Config validation |
| **`@noble/post-quantum`** | ML-KEM-768, through `backend/cre/sealed-intent.ts` |
| **QuickJS / WASM** | The CRE runtime; no Node built-ins in the handler |

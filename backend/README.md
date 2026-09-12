# Backend: The Opaque Stack

> **TypeScript on Node 22.18+, no build step. Runs as one Railway service.**

Everything between the wallet and Arc, except the release decision. One process, [`stack.ts`](stack.ts), runs six relays, the mesh exit, the release egress and the credential authority, and serves the wallet's config at `/stack.json`. The Chainlink CRE workflow in [`../opaque-cre`](../opaque-cre/) decides which payments go; this stack carries them and can read a payment only after the enclave releases it.

Live at [`opaque-stack-production.up.railway.app`](https://opaque-stack-production.up.railway.app/stack.json).

## Architecture

```
wallet ──▶ /r1 … /r6 ──▶ relay ──▶ relay ──▶ relay ──▶ exit
           (3 of 6, drawn fresh per message)            │
                                                        ├─ /v1/mesh/query    wallet reads: pool, ring, relay
                                                        │                    health, account state, bundler
                                                        ├─ /v1/mesh/payment  sealed payments, in chunks
                                                        │
          Chainlink CRE ── GET  /v1/cre/pending ───────▶│  holds sealed payments, cannot open them
                        ◀─ POST /v1/cre/release ────────│  on a tagged RELEASE:
                                                        │    open with K, check the recipient,
                                                        │    verify the proof, attester signs
                                                        ▼
                                                  egress (loopback only) ──▶ Arc: pool.spend()
```

## Folder Structure

```
backend/
├── stack.ts                  # The whole stack in one process; the Railway entry point
├── mesh/                     # Onion transport (§7)
│   ├── transport.ts          #   ML-KEM-768 + HKDF + AES-256-GCM onion layers, padding
│   ├── server.ts             #   A relay: batch, delay, forward
│   ├── scheduler.ts          #   Batch window plus a bounded random delay
│   ├── directory.ts          #   The signed relay directory and its trust root
│   ├── chunks.ts             #   Splits a 1.1 MiB payment into 32 KB chunks
│   ├── return-path.ts        #   Replies left at a drop, collected by a fresh path
│   ├── graph-health.ts       #   Relay health from The Graph, clamped
│   ├── egress.ts             #   The one component that signs a settlement
│   ├── protocol.md           #   The wire protocol a relay implements
│   └── deploy/               #   Running a relay on your own host
├── cre/                      # Confidential intent execution (§9, §10)
│   ├── sealed-intent.ts      #   The envelope and the ML-KEM key derivation
│   ├── seal-client.ts        #   What the wallet runs to seal a payment
│   ├── cre-release.ts        #   The decision: shared by the enclave, stand-in and tests
│   ├── executor-server.ts    #   The exit's HTTP surface
│   ├── settler.ts            #   Acting on a decision: attest, release, reconcile
│   ├── attester-keys.ts      #   The attester's FORS+C key, rotated before it runs out
│   ├── credential.ts         #   Recipient credentials
│   └── simulator.ts          #   The local stand-in for the CRE workflow
├── chain/                    # Arc
│   ├── pool.ts               #   Pool client and the RPC fallback
│   ├── ring-source.ts        #   Ring members from the chain, weights from The Graph
│   ├── wallet-rpc.ts         #   Wallet reads and UserOperations, answered at the exit
│   ├── pq-wallet-chain.ts    #   PQ account deployment and UserOperations
│   ├── relay-directory.ts    #   Announces relays and reports their health on chain
│   ├── bridge-sepolia.ts     #   CCTP V2: USDC from Sepolia to Arc
│   ├── fill-pools.ts         #   Seeds pools from several accounts at random intervals
│   └── e2e-*.ts              #   Real payments and account flows on Arc
├── zk/                       # The ring proof (§6); see zk/README.md
├── deploy/                   # Dockerfiles, Caddyfile, compose
└── server.js                 # The old nonce0 scan API, unrelated to Opaque
```

## Mesh

Every wallet request, payment or read, is wrapped in three onion layers and sent through three of the six relays.

| | |
|---|---|
| **Relays** | 6 in the directory, 3 per message, never two from one operator |
| **Hop encryption** | ML-KEM-768, HKDF-SHA-256, AES-256-GCM |
| **Padding** | Every message is 4 KB, 16 KB or 64 KB |
| **Timing** | Each relay forwards in batches, plus a bounded random delay |
| **Large payloads** | Split into chunks of 32,640 bytes, at most 64, reassembled at the exit |
| **Replies** | Left at a drop on a relay and collected through a fresh path; a browser has no inbound address |
| **Trust root** | The directory is signed with a FORS+C key; the wallet pins its root at build time and walks the weekly chain from it |
| **Logs** | None. There is no `/health`; `GET /v1/status/<id>` is the liveness probe |

The mesh turns over weekly. Relay keys and the directory belong to a week-long generation derived from `MESH_MASTER`. At the end of it the stack exits with code 75, Railway restarts it, and the next boot serves the next generation.

The wire format is [mesh/protocol.md](mesh/protocol.md). Running relays on separate hosts is [mesh/deploy/README.md](mesh/deploy/README.md) and [docs/hosting.md](../docs/hosting.md).

## CRE

The executor holds each payment in two parts it cannot open: the payment, encrypted under a fresh key K, and an envelope sealed to the CRE enclave's ML-KEM key. The envelope carries K, the recipient, the recipient's credential, the pool, the minimum privacy score and the deadline.

| Decision | When |
|---|---|
| **WAIT** | The pool's score is below the payer's minimum and the deadline has not come |
| **RELEASE** | The score is reached, the deadline has come, or the payer asked for no wait; and the credential verifies |
| **DENY** | The envelope does not open, is for another spend, or the credential fails |

A RELEASE carries the recipient and K, tagged with an HMAC under `CREDENTIAL_MAC`. The settler then opens the payment, refuses it unless it pays exactly the approved recipient, verifies the 1.1 MiB ring proof, has the attester sign with its FORS+C key, and hands the spend to the egress. It confirms settlement from the pool's own `Spent` event.

With `CRE_MODE=workflow` the deployed workflow decides, and the executor refuses any payment not sealed to the CRE key. Without it, [`cre/simulator.ts`](cre/simulator.ts) decides in-process with a key kept in `.stack`, which is what a laptop runs. Both call [`cre/cre-release.ts`](cre/cre-release.ts).

## Chain

- **RPC fallback.** [`chain/pool.ts`](chain/pool.ts) tries Circle's Arc RPC, then QuickNode's, then Blockdaemon's. A rate-limit error moves to the next provider.
- **Ring source.** Members come from the pool's `Deposited` events, paged in 10,000-block windows. The Graph only adds weights to members the chain already named.
- **Attester.** One FORS+C key with 32 signatures. It rotates on chain when four are left.
- **Relay health.** With `PUBLIC_URL` set, the stack announces its relays to `RelayDirectory` and reports their health every 10 minutes, so The Graph has something to index.

## Public Routes

Everything is served on one port. The egress is never routed.

| Method | Route | What |
|---|---|---|
| `POST` | `/r1/v1/relay` … `/r6/v1/relay` | A relay's inbox |
| `GET` | `/rN/v1/status/<id>` | Collect a reply from a drop; also the liveness probe |
| `POST` | `/v1/mesh/payment` | The exit, for payment chunks from the last relay |
| `POST` | `/v1/mesh/query` | The exit, for wallet reads from the last relay |
| `GET` | `/v1/cre/pending` | Pending intent ids and sealed envelopes, for the CRE workflow |
| `POST` | `/v1/cre/release` | Tagged decisions from the CRE workflow |
| `POST` | `/v1/credential` | The test credential authority |
| `GET` | `/stack.json` | The wallet's config: signed directory, trust root, CRE public key |

## Environment

Names only. Secrets go into Railway over stdin, never in argv ([docs/hosting.md](../docs/hosting.md)).

| Variable | Purpose |
|---|---|
| `EGRESS_PRIVATE_KEY` | Pays gas for settlements and the attester's rotations |
| `ATTESTER_FORS_MASTER` | Derives every generation of the attester's FORS+C key |
| `MESH_MASTER` | Derives every relay key and weekly directory; must match the root compiled into the wallet |
| `RELAY_OPERATOR_KEY` | Announces the relays and reports their health to `RelayDirectory` |
| `CREDENTIAL_MAC` | Shared with the CRE workflow: checks credentials and authenticates decisions |
| `CRE_INTENT_PUBLIC_KEY` | The public half of the CRE key, which wallets seal to |
| `CRE_MODE` | `workflow` lets the deployed CRE workflow decide |
| `CRE_TEE` | `1` once the workflow runs in the enclave, so `stack.json` reports `ATTESTED` |
| `PUBLIC_URL` | The public origin; set from `RAILWAY_PUBLIC_DOMAIN` on Railway |
| `PORT` | The one public port |
| `MESH_CONFIG` | A directory of relay config when the relays run on other hosts |

## Setup

### Run

From the repository root; the backend imports the sibling packages.

```bash
for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend; do npm ci --prefix "$d"; done
cd backend
set -a && . ./.env && set +a
node stack.ts
```

The stack writes `../frontend/public/stack.json`, so `npm run dev` in `frontend/` talks to it.

### Test

```bash
npm test               # 271 tests: mesh, CRE, ZK, ring source
npm run test:chain     # against live Arc
npm run typecheck
```

### Scripts

```bash
node chain/e2e-ring-payment.ts                 # one real private payment on Arc
node chain/e2e-pq-account.ts                   # deploy a PQ account and deposit, on Arc
node chain/bridge-sepolia.ts --amount 100      # USDC from Sepolia to Arc over CCTP V2
node chain/fill-pools.ts --pools 2,5           # seed pools from several accounts over time
node zk/bench.ts                               # the ring proof benchmark
```

### Deploy

```bash
railway up --detach
```

The service is not connected to GitHub, so a push does not redeploy it. [docs/hosting.md](../docs/hosting.md) has the full setup.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Node 22.18+** | Runs TypeScript directly |
| **viem** | Arc, with a fallback transport |
| **@noble/post-quantum** | ML-KEM-768 |
| **@noble/hashes, @noble/ciphers** | keccak, SHA-256, HKDF, HMAC, AES-GCM |
| **Pimlico** | ERC-4337 bundler on Arc |
| **Railway** | Hosting, one replica |

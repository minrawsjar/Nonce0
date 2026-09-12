# Opaque

**Private USDC payments on Arc, from a wallet a quantum computer cannot take over.**

Opaque is a post-quantum wallet and private payment protocol for USDC on Arc. The key that controls your account is hash-based. The proof that hides which deposit paid uses only hashes. The relays that carry your payment encrypt every hop with ML-KEM. A Chainlink CRE confidential workflow holds each payment until the pool hiding it is strong enough, and The Graph tells it when that is.

> Deposit 10 USDC. Send 5 to a friend. On chain, a pool pays them, and nobody can tell which of eight deposits the money came from.

| | |
|---|---|
| **Web wallet** | [opaque.credit/app.html](https://www.opaque.credit/app.html) |
| **Browser extension** | [opaque-extension.zip](https://www.opaque.credit/opaque-extension.zip) for Chrome, Brave and Edge ([install steps](extension/README.md#install-from-the-zip)) |
| **Chainlink CRE workflow** | `opaque-confidential-release`, status ACTIVE, ID `003e31eff41f5e26b3a5c7414efba42245ba4687550a43986e15e51e4e71686e` |
| **Subgraph** | [`opaque/v0.3.0`](https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0) on Subgraph Studio, network `arc-testnet` |
| **Backend** | [`stack.json`](https://opaque-stack-production.up.railway.app/stack.json) on Railway |
| **Network** | Arc testnet, chain id 5042002, [explorer](https://testnet.arcscan.app) |

## The Problem

Every wallet in use today signs with an elliptic curve key. A large enough quantum computer can work out that private key from the public key, and the public key is on chain from the first transaction an account ever sends. That machine does not exist yet. But anything on chain, and any encrypted payment, can be recorded today and broken later. NIST has already standardised the replacements and plans to retire today's curves by 2035, so the switch has to happen before the machine exists, not after.

Privacy has the same problem. The tools that hide payments today rest on elliptic curves too: pairing-based SNARKs and Diffie-Hellman key exchange. Whoever stores today's chain history gets it all back once those break.

### What a payment leaks today

- **The key.** One signature puts the public key on chain, and a quantum computer turns it into the private key.
- **The payment.** Every USDC transfer names the sender, the recipient and the amount.
- **The network.** The RPC and every server your wallet touches see your IP address next to what you asked for.
- **The timing.** A payment that settles the moment it is sent can be matched to the deposit that funded it.

## The Solution

Opaque replaces each of those with a mechanism that does not rest on elliptic curves.

| What it protects | How | Code |
|---|---|---|
| Your account | FORS+C hash-based signatures, checked on chain by an ERC-4337 account | [contracts](contracts/), [packages/pq-wallet](packages/pq-wallet/) |
| Who paid | An 8-note ring, proved with ZKBoo (MPC-in-the-head): hashes and AES only | [backend/zk](backend/zk/) |
| Where you are | A 3-hop onion mesh over 6 relays, ML-KEM-768 per hop | [backend/mesh](backend/README.md#mesh) |
| When it settles | A Chainlink CRE confidential workflow waits until the pool is strong enough | [opaque-cre](opaque-cre/) |
| Which decoys and routes | The Graph indexes pool sizes, note usage and relay health | [graph](graph/) |

### Capabilities

**Post-quantum account on Arc.** Your account is an ERC-4337 smart account whose only signer is a FORS+C key made in your browser. The signature is checked on chain in Solidity using nothing but keccak. No ECDSA key, owner or admin can rotate it.

**Eight-note ring, hashes only.** Deposits become notes of 1, 2, 5, 10, 20, 50 or 100 USDC. A payment proves "I own one of these eight notes" without saying which one. The browser builds the proof: 219 repetitions of ZKBoo, 128-bit soundness, 1.08 MiB. That is too large for any chain, so an attester checks it off chain and signs with its own post-quantum key. The pool then checks that all eight notes are real deposits and that the note has not been spent.

**Three-hop relay mesh.** Every payment and every wallet read goes through three of six relays, drawn fresh each time. Each hop is encrypted with ML-KEM-768 and AES-256-GCM, and traffic is padded, batched and delayed. The RPC and the bundler see the exit, never your wallet.

**Payments that wait for privacy.** Tick "Wait for stronger privacy" and pick a latest-settlement time. The recipient, the deadline and the minimum privacy score are sealed to a key that exists only inside a Chainlink CRE enclave. Every 30 seconds the enclave scores each pool from The Graph and decides to wait, release or deny. The backend can read a payment only after the enclave releases it.

**Decoys and routes weighted by The Graph.** The subgraph indexes deposits, ring usage and relay health on Arc. The wallet uses it to choose decoys that look like real spends and relays that are healthy and not overused. The enclave uses it to score each pool. Members and keys always come from the chain and a signed directory: The Graph can weigh them, but never add one.

**USDC in, USDC out.** Fund your account by sending USDC to its address from anywhere, including over Circle CCTP from Ethereum Sepolia. Gas on Arc is paid in USDC. Withdraw everything to any address in one step.

**One wallet, two places.** The same page runs at opaque.credit and in the Chrome side panel. It needs no MetaMask.

## Technical Architecture

### Core Technologies

| Technology | Purpose |
|---|---|
| **TypeScript on Node 22.18+** | Every package runs `.ts` directly; the only build step is Vite for the frontend |
| **Solidity 0.8.26 and Foundry** | Accounts, key registry, pools, verifiers, relay directory |
| **ZKBoo** | The ring proof, MPC-in-the-head over AES-128 and keccak |
| **FORS+C** | Few-time hash-based signatures for accounts and the attester |
| **ML-KEM-768** (`@noble/post-quantum`) | Mesh onion layers, and sealing payments to the CRE enclave |
| **Chainlink CRE** | Confidential Workflow in an AWS Nitro enclave |
| **The Graph** | Subgraph on Arc testnet, hosted on Subgraph Studio |
| **Arc and USDC** | Settlement chain; USDC is both the money and the gas |
| **Circle CCTP V2** | Bridging USDC from Ethereum Sepolia to Arc |
| **ERC-4337 v0.7 and Pimlico** | Account deployment and UserOperations on Arc |
| **viem** | Chain access, falling back across three Arc RPC providers |
| **Vite, Vercel and Railway** | Wallet hosting, and the backend stack |

### System Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                               WALLET                                 │
│              opaque.credit, or the Chrome side panel                 │
│                                                                      │
│   FORS+C account key ─── Note vault ─── ZKBoo prover (Web Worker)    │
│   (IndexedDB)            (8-note rings)  seals to the CRE key        │
└───────────────────────────────────┬──────────────────────────────────┘
                                    │ onion layers, 3 of 6 relays,
                                    │ padded 32 KB chunks
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                RELAY MESH (6 relays, ML-KEM-768 per hop)             │
└───────────────────────────────────┬──────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     EXECUTOR (Railway, stack.ts)                     │
│                                                                      │
│   Sealed payments ─── Wallet reads ─── Proof check ─── Attester      │
│   (cannot open)       (RPC, bundler)   (1.08 MiB)      (FORS+C)      │
└───────┬───────────────────────▲──────────────────────────────┬───────┘
        │ GET pending           │ POST decisions               │ spend
        ▼                       │                              ▼
┌───────────────────────────────┴──────┐  ┌────────────────────────────┐
│    CHAINLINK CRE (AWS Nitro TEE)     │  │        ARC TESTNET         │
│                                      │  │                            │
│  every 30 s:                         │  │  PQ accounts (ERC-4337)    │
│  open envelopes with the Vault key   │  │  PQKeyRegistry             │
│  score each pool from The Graph      │  │  7 RING_8 pools, USDC      │
│  WAIT, RELEASE or DENY               │  │  RelayDirectory            │
└───────────────────▲──────────────────┘  └─────────────┬──────────────┘
                    │ pool sizes, relay health          │ events
┌───────────────────┴───────────────────────────────────▼──────────────┐
│               THE GRAPH (Subgraph Studio, arc-testnet)               │
│         RingPool · RingMember · RelayNode · RelayDirectory           │
└──────────────────────────────────────────────────────────────────────┘
```

**CRE decides, Railway carries.** The enclave is the only place a payment's recipient exists in plaintext before settlement. Railway runs what CRE cannot: servers that take traffic, state between runs, a 1.1 MiB proof check and a stateful signing key. It can delay or drop a payment, but it cannot read, redirect or hurry one.

→ **[Specification](docs/spec-v2.md)**: the protocol, the threat model and the decision log.

→ **[Documentation index](docs/README.md)**: every document, in reading order.

## Wallet Actions

| Action | What happens | On chain |
|---|---|---|
| **Receive** | Shows your account address. Send USDC to it from any wallet, exchange or faucet. | A USDC transfer to your address |
| **Deposit** | Splits the amount into notes of 1 to 100 USDC and deposits them in one UserOperation your PQ key signs. The first deposit also deploys the account. | `deposit(commitment)` per note, attributable by design |
| **Send** | Picks notes, builds one ring proof per note, seals each payment to the CRE key and sends it through the mesh. | The pool pays the recipient; no sender is named |
| **Wait for stronger privacy** | Holds the payment until the pool's privacy score reaches the level the wallet asks for, or until your deadline. | Same as Send, later |
| **Privacy** | Shows the eight-note cover set and the relay route. Every member is drawn the same way. | None |
| **Withdraw** | Sends all USDC in the account to an address you choose. | One UserOperation |
| **Backup and Restore** | Exports the account key and notes, encrypted under a passphrase. | None |
| **Key rotation** | Automatic. Near the end of the key's budget the wallet signs a rotation to its pre-committed next key, and the mesh exit submits and pays for it. No prompt, no button. | One registry update |

## Project Structure

```
opaque/
│
├── frontend/                  # Landing page and wallet (Vite, Vercel)
│   ├── index.html             #   opaque.credit
│   ├── app.html               #   The wallet, also the extension's side panel
│   └── src/lib/               #   Runtime, prover worker, note storage, backup
│
├── extension/                 # Chrome, Brave and Edge side panel build
│
├── backend/                   # The stack that runs on Railway
│   ├── stack.ts               #   Six relays, executor, egress, credentials
│   ├── mesh/                  #   Onion transport, relays, directory, chunking
│   ├── cre/                   #   Sealing, the release decision, settlement
│   ├── chain/                 #   Arc clients, attester, pool fill, CCTP bridge
│   └── zk/                    #   ZKBoo ring proof (Node and browser)
│
├── opaque-cre/                # Chainlink CRE confidential workflow
│   └── confidential-intent/   #   The TEE handler and its config
│
├── graph/                     # The Graph subgraph and its clients
│
├── contracts/                 # Solidity, Foundry
│   └── src/opaque/            #   wallet/, pool/, mesh/, lib/
│
├── packages/
│   ├── protocol-types/        #   The shared contract: types, codecs, errors
│   ├── pq-wallet/             #   FORS+C signer and account SDK
│   └── ring-client/           #   Note vault and decoy selection
│
├── deployments/               # Every public address on Arc testnet
├── partner-docs/              # Chainlink, Arc and The Graph write-ups
└── docs/                      # Spec, hosting, design notes
```

## Smart Contracts

Deployed on **Arc testnet**. The source of truth is [`deployments/arc-testnet.json`](deployments/arc-testnet.json), and `backend/chain/test/deployments.test.ts` checks every address in it against the chain.

| Contract | Address | Role |
|---|---|---|
| **PQKeyRegistry** | [`0x6eb5…8e8f`](https://testnet.arcscan.app/address/0x6eb5b42373191121d31dfc4b5c8571c4eaf58e8f) | Each account's FORS+C key, use count and rotation |
| **PQAccountFactory** | [`0x13be…b214`](https://testnet.arcscan.app/address/0x13beaec42922e3f63fa0dbe5bba270edf46ab214) | Deploys accounts at predictable addresses |
| **PQAccount** (implementation) | [`0xecce…5012`](https://testnet.arcscan.app/address/0xeccec6b1e6a2e5367902675c49e577633f705012) | ERC-4337 v0.7 account |
| **PQValidator** | [`0xfad5…6ea2`](https://testnet.arcscan.app/address/0xfad5b4149489eaf9bbe402eca4b26f9284046ea2) | Checks UserOperation signatures against the registry |
| **RelayDirectory** | [`0xcf58…6653`](https://testnet.arcscan.app/address/0xcf588b5b8ab2fa11ccf28a5c0631da4269a36653) | Relay announcements and health reports, indexed by The Graph |

## Tests

| Suite | Tests |
|---|---|
| `contracts` (Foundry) | 97 passing, 1 skipped |
| `backend` (mesh, CRE, ZK, chain) | 271 passing |
| `packages/pq-wallet` | 88 passing, 2 skipped (opt-in browser suite) |
| `packages/protocol-types` | 16 passing |
| `packages/ring-client` | 6 passing |
| `graph` | 8 passing |
| `frontend` | 9 passing |

## Key Flows

### Deposit

```
Wallet: "Deposit 10 USDC"
  → Split into notes: one 10 USDC note
  → Derive the commitment: AES-128 under the note secret (backend/zk)
  → One UserOperation, signed by the account's FORS+C key
      (the first one also deploys the account through PQAccountFactory)
  → Sent through the mesh to the exit, which forwards it to the bundler
  → Pool: deposit(commitment), 10 USDC moves into the pool
  → The subgraph indexes the new RingMember
```

### Private payment

```
Wallet: "Send 5 USDC to 0xabc…", wait for stronger privacy
  → Pick a 5 USDC note and seven decoys from the pool (The Graph weighs them)
  → Build the ZKBoo proof in a Web Worker: 1.08 MiB, a few seconds
  → Encrypt the payment under a fresh key K
  → Seal K, recipient, credential, minimum score and deadline to the CRE key
  → Split into padded chunks, send through 3 of 6 relays
  → The executor holds it and cannot read it
  → CRE, within 30 s: open, score the pool, WAIT / RELEASE / DENY
  → On RELEASE: the executor opens the payment with K, checks the recipient
      matches, verifies the proof, and the attester signs
  → Pool: spend(), 5 USDC to the recipient; the nullifier is marked spent
```

A payment that does not wait settles in about a minute and a half, end to end.

### The release decision

```
CRE enclave, every 30 s
  → GET /v1/cre/pending: intent ids and sealed envelopes, nothing else
  → Query The Graph: every pool's size and the six relays' health
  → For each envelope, with the ML-KEM key derived from the Vault DON seed:
      does not open, or is for another spend           → DENY
      score below the payer's minimum, before deadline → WAIT
      recipient credential fails                       → DENY
      otherwise                                        → RELEASE, with K and a tag
  → POST /v1/cre/release: up to 60 decisions per tick
```

### Bridging USDC from Sepolia

```
node chain/bridge-sepolia.ts --amount 100
  → approve and depositForBurn on Sepolia (domain 0 → Arc, domain 26)
  → poll Circle's attestation service (fast transfer, finality 1000)
  → receiveMessage on Arc: USDC minted to the same address
```

## Quick Start

### Prerequisites

- **Node.js 22.18 or later**, which runs TypeScript without a build step
- **Foundry**, for the contracts
- **Bun**, for the subgraph scripts (optional)
- **CRE CLI**, to simulate or deploy the workflow (optional)

### Install and test

```bash
git clone https://github.com/minrawsjar/Opaque.git
cd Opaque
for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend frontend; do npm ci --prefix "$d"; done

npm run typecheck:all          # every package, strict
npm run test:all               # every suite
node backend/zk/bench.ts       # the ring proof benchmark
(cd contracts && forge test)
```

### Run the wallet against the hosted backend

```bash
cd frontend
VITE_STACK_URL=https://opaque-stack-production.up.railway.app/stack.json npm run dev
```

### Run the whole stack locally

```bash
# terminal 1
cd backend && set -a && . ./.env && set +a && node stack.ts

# terminal 2
cd frontend && npm run dev
```

The local stack writes `frontend/public/stack.json`, so the dev wallet talks to it and nothing else. Its variables are listed in [backend/README.md](backend/README.md#environment). Without `CRE_MODE=workflow` a stand-in in the same process makes the release decisions.

## Deployment

| Piece | Where | How |
|---|---|---|
| Wallet | Vercel, [opaque.credit](https://www.opaque.credit) | `frontend/`, with `VITE_STACK_URL` set |
| Relays, executor, egress | Railway, one service | [docs/hosting.md](docs/hosting.md) |
| Release decisions | Chainlink CRE, private registry | [opaque-cre/README.md](opaque-cre/README.md) |
| Subgraph | Subgraph Studio | [graph/README.md](graph/README.md) |
| Contracts | Arc testnet | [contracts/README.md](contracts/README.md) |

## Security and Honest Limits

Three things carry weight, and all three are stated plainly, because a privacy protocol that hides its gaps is the failure this project exists to move away from.

**1. The ring proof is checked off chain, so an attester is trusted for soundness.** On-chain verification was measured at 1.08 MiB and about nine times an Arc block, so it was never available. The chain still checks everything else: all eight ring members are real deposits, the nullifier is used once, the right denomination goes to the bound recipient, and the attester's post-quantum key is live and within its signature budget. A dishonest attester could approve a spend no proof supports. It cannot learn who paid, because the proof is zero-knowledge, and it cannot cheat quietly, because anyone can re-verify a published proof. Trusted for soundness, never for privacy. See [AttestedRingVerifier.sol](contracts/src/opaque/pool/AttestedRingVerifier.sol).

**2. There is no recovery for notes.** A note is a secret in your browser storage and nothing else. Clear your browser data without a backup and unspent notes are gone. A real version needs seed-derived notes or trial-decryption scanning.

**3. The relays are not attested; the CRE enclave is.** The six relays run on one Railway service, so one operator could link a wallet's IP address to its payment. The release decision runs in an attested AWS Nitro enclave, whose code is public by design; what it protects is the data.

Also by design:

- **No `balanceOf` for private funds.** A deposit creates an opaque commitment. Your balance is the set of notes you hold secrets for.
- **No event links a nullifier to a ring member.** `Spent` names the nullifier and the recipient, never the commitment it opened.
- **The nullifier never binds the recipient.** A recipient-dependent nullifier would let one note be spent once per recipient.
- **No admin key on any account.** Only a signature under the account's current PQ key can change that key.
- **Secrets never travel in argv.** Railway variables are set over stdin; CRE secrets live in the Vault DON.

The threat model is [spec-v2.md §3](docs/spec-v2.md). It does not claim to stop a global passive observer, collusion across all three hops, or an adversary who fills a pool with their own deposits. The decoy heuristics and the cost of a deposit raise the price of that last attack; they do not remove it.

## Built With

| Partner | Integration | Write-up |
|---|---|---|
| **Chainlink** | CRE Confidential Workflow in AWS Nitro: sealed payments, Vault DON secrets, release timing | [partner-docs/chainlink.md](partner-docs/chainlink.md) |
| **Arc and Circle** | Settlement chain, USDC as money and gas, CCTP V2 bridging from Sepolia | [partner-docs/arc.md](partner-docs/arc.md) |
| **The Graph** | Subgraph on Arc testnet: decoy weights, relay routing, pool privacy scores | [partner-docs/the-graph.md](partner-docs/the-graph.md) |
| **Pimlico** | ERC-4337 bundler on Arc | |
| **Railway and Vercel** | Backend stack and wallet hosting | |

## Not the Scanner

This repository began as **nonce0**, a cross-chain public-key exposure scanner. That tool still lives in [`src/`](src/) and [`bin/`](bin/) with its own tests, and has nothing to do with the payment stack. `npx nonce0 scan .` still works.

## License

[MIT](LICENSE)

<p align="center">Built privately for ETHOnline 2026.</p>

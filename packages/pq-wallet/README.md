# @opaque/pq-wallet: The Post-Quantum Signer

> **FORS+C few-time signatures and the wallet SDK around them. TypeScript, runs in Node and the browser.**

The signature scheme behind every Opaque key. The live system signs with this package in three places: every user account on Arc, the attester that approves ring spends, and the relay directory the wallet pins. It also holds the wallet SDK: key storage in IndexedDB, signing reservations that never reuse an index, rotation and a mock chain for tests.

## What It Signs With

| | |
|---|---|
| **Scheme** | FORS+C: hash-based, few-time. Security rests on keccak alone |
| **Default parameters** | k=32, a=8 (`FORS_C_DEFAULT`) |
| **Signature** | 9,251 bytes |
| **Uses per key** | 32 for a live account (`ACCOUNT_MAX_USES` in `backend/chain/pq-wallet-chain.ts`) |
| **Signing time** | About 140 ms median in Node; 231 to 313 ms in three Chromium samples |
| **On-chain check** | `ForsVerifier.sol`, measured in [contracts/README.md](../../contracts/README.md#forsverifiersol) |

A few-time key signs a bounded number of messages before forgery becomes feasible. So every signature is counted, locally and on chain, and the account rotates to a precommitted next key before the budget runs out.

## Where It Runs

| Use | Code | Status |
|---|---|---|
| **User accounts** | `backend/chain/pq-wallet-chain.ts`, through `frontend/src/lib/runtime.ts` | Live on Arc: ERC-4337 accounts from `PQAccountFactory` |
| **Attester** | `backend/cre/attester-keys.ts` | Live: signs every ring spend, rotates itself near the end of each key |
| **Relay directory** | `backend/mesh/directory.ts` | Live: the weekly directory is signed and checked with this scheme |
| **Opt-in account** | `src/account-wallet.ts`, `contracts/src/opaque/wallet/account/` | Tested locally with its own demo page; not deployed |

## Folder Structure

```
packages/pq-wallet/
├── src/
│   ├── fors.ts               #   keyGen, sign, verify, codecs, scheme id
│   ├── digest.ts             #   The canonical length-prefixed digest
│   ├── registry.ts           #   PQKeyRegistry actions and payloads
│   ├── authority.ts          #   Rotation, disable and takeover rules
│   ├── signer-state.ts       #   Reservations: an index is never signed twice
│   ├── indexeddb-store.ts    #   Encrypted keys in IndexedDB ('@opaque/pq-wallet/browser')
│   ├── wallet.ts             #   createPqWallet
│   ├── user-operation.ts     #   ERC-4337 v0.7 UserOperations
│   ├── bundler-client.ts     #   Bundler JSON-RPC
│   ├── operation-outbox.ts   #   Submitted operations and their outcomes
│   └── mock.ts               #   A mock chain for tests and demos
├── demo/                     # A local browser demo with real signatures
├── scripts/                  # Vectors, benchmarks, lifecycle checks
├── abi/                      # PQKeyRegistry ABI snapshot and its provenance
├── benchmarks/               # Recorded measurements
└── test/                     # 90 tests; the browser suite is opt-in
```

## Public API

```ts
import { createMockPqWallet, keyGen, sign, forsVerify, pqDigest, FORS_C_DEFAULT } from '@opaque/pq-wallet';
import { IndexedDbSignerStore } from '@opaque/pq-wallet/browser';

const wallet = createMockPqWallet();
await wallet.create();
await wallet.register();
const signed = await wallet.signUserOperation('0x1234');
```

The high-level wallet implements the frozen `PqWallet` methods: `create`, `register`, `getState`, `signUserOperation`, `rotate`, `disable`. `createPqWallet(options)` assembles it with explicit storage, chain adapter and lifecycle rules.

The low-level exports are `keyGen`, `sign`, `forsVerify`, `pkCommitment`, `pqDigest`, `PQ_DOMAIN` and the signature codecs. `verify` is exported only as `forsVerify`, because this codebase also verifies proofs and directories. `IndexedDbSignerStore` lives at `@opaque/pq-wallet/browser`, so a Node consumer never pulls the DOM types into its build.

## The Digest

```text
keccak256(length-prefixed[
  PQ_DOMAIN, chainId, walletAddress, schemeId, useCount, keccak256(payload)
])
```

Every field is length-prefixed, because a separator that can occur inside a field lets two different inputs hash alike. Keccak-256 here is `keccak_256` from `@noble/hashes/sha3.js`; Node's `sha3-256` is a different function.

## Signing and Storage Invariants

- **A reservation is committed before a signature exists.** The signature is committed in a second transaction before it is returned.
- **A retry of the same digest returns the cached signature.** A concurrent request that meets an unfinished reservation fails with `SIGNER_STATE_UNSAFE`.
- **A crash after reserving burns that index.** The same uncertain digest is never signed again automatically, and a dropped submission never gives capacity back.
- **Local reservations and the chain's use count are separate counters.** They are never reconciled downward.
- **Tabs coordinate** through strict-durability IndexedDB transactions and Web Locks. A configuration fingerprint stops the same wallet reopening under a different chain, account or EntryPoint.
- **Seeds are encrypted** with AES-GCM under a non-exportable WebCrypto key in the same origin. That does not protect against a compromised origin, and no password or hardware binding is claimed.
- **Missing, malformed or regressed state fails closed.** Storage loss has no recovery, and a restored backup whose signing log is behind the chain is refused for signing.

## Registry Boundaries

The registry fields are `pkCommitment`, `nextCommitment`, `useCount`, `maxUses`, `rotationDeadline` and `disableAfter`. Rotation requires the current PQ key. Takeover after the 30-day disable timelock requires the precommitted next key. There is no owner, admin, ECDSA or upgrade recovery path. At `maxUses`, every further transition is refused.

Registry action payloads match the Solidity ABI encoding, and the committed ABI snapshot is pinned by source hash in `abi/provenance.json`; a test rejects a stale one.

## Setup

Node 22.18 or later.

```bash
cd packages/pq-wallet
npm ci
npm test               # 88 passing, 2 skipped
npx tsc --noEmit
```

### Browser suite

```bash
npx playwright install chromium
PQ_BROWSER_TESTS=1 node --test --test-isolation=none test/browser-signer.test.ts
```

### Local demo

```bash
npm run dev            # http://127.0.0.1:4173
```

Real post-quantum signatures against a simulated chain: create a wallet, sign, rotate, schedule a disable and move the demo clock. No funds and no Arc connection.

### Vectors and benchmarks

```bash
node scripts/generate-vectors.ts                              # fixtures the Solidity tests check
node scripts/benchmark.ts --network local --output benchmarks/local-node.json
node scripts/check-lifecycle.ts --mock                        # replay, rotation and disable
```

Synthetic fixture seeds are public test data. Never pass a real wallet key to a vector generator.

## More

| Document | What it covers |
|---|---|
| [ACCOUNT_IMPLEMENTATION.md](ACCOUNT_IMPLEMENTATION.md) | The opt-in ERC-4337 account and its contract decisions |
| [LIVE_SETUP.md](LIVE_SETUP.md) | Arc testnet setup for that account |
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | Installing and running the package |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | The build plan and its execution log |

FORS+C authorises wallet actions. Spending a note anonymously is the ring proof's job, in `backend/zk`, and uses the note secret, not this key. No claim is made that Arc's consensus is post-quantum.

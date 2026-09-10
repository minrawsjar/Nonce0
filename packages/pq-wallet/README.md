# @opaque/pq-wallet

Browser-local PQ signer and wallet SDK based on the original `handoff-manan.md` and spec-v2 §5. The original six-field registry and six-field signing digest are preserved. The package export map is unchanged.

**Status: SDK/reference implementation with a conforming mock. G2 is not passed; no final live PQ-authority claim.** No production `PQValidator`, account/factory integration, or Arc deployment was added. The approved epoch/payload/deadline rules and deployment configuration have been requested but not supplied in this session.

Prior SDK verification: strict typecheck passed; the SDK suite with Chromium enabled passed **72 tests, zero failures and zero skips**. The unchanged Solidity registry/verifier passed **29 existing tests** in the isolated verification checkout. See `benchmarks/verification.json` for that snapshot's commands and scope; it predates the browser demo.

## Run

### Browser wallet

With Node >=22.18 installed, run from the repository root:

```sh
cd packages/pq-wallet
npm ci
npm run dev
```

This starts the local server and opens your default browser at **http://127.0.0.1:4173**. If automatic opening is unavailable, open that address yourself. Stop the server with Ctrl+C. Use `npm run dev -- --port 4174` for another port or `npm run dev -- --no-open` to skip opening a tab.

Click **Create wallet**, activate it on the demo network, then sign and submit a demo action. You can also rotate the signing key or schedule its disable and advance the demo clock by 30 days. The interface separates signing capacity already used from transactions accepted by the simulated network.

This is a local demo with real PQ signatures, simulated transactions, and no real funds or Arc connection. Encrypted keys stay in IndexedDB; public simulation history stays in localStorage. Refreshing restores both, and Web Locks coordinate tabs. Use the same browser and address each time: changing the hostname or port creates a separate storage origin. Clearing browser storage loses the demo wallet.

`npm run build:demo` builds the browser assets into the ignored `.demo-dist/` directory. The page uses `demo/adapter.ts` to call the SDK; private signer material is not exposed to the page controller.

Demo validation: typecheck, browser asset build, and 68 Node tests passed; the opt-in browser suite was skipped in this run. Browser UI testing was not performed. An optional feature-detected WebMCP `create_demo_wallet` tool shares the page's creation action; its browser registration and execution remain unverified because no supported browser context was available.

### SDK checks and command-line demos

Node >=22.18 is required by this package. From the repository root:

```sh
cd packages/pq-wallet
npm ci
npx tsc --noEmit
node --test test/*.test.ts
```

For individually reported cases on the tested Node 24 runtime:

```sh
node --test --test-isolation=none test/*.test.ts
```

The real browser suite is intentionally opt-in; ordinary Node checks do not establish IndexedDB durability. Install the test browser, then run:

```sh
npx playwright install chromium
PQ_BROWSER_TESTS=1 node --test --test-isolation=none test/browser-signer.test.ts
```

Alternatively set `PQ_CHROMIUM_EXECUTABLE` to an existing compatible Chromium executable. `PQ_WRITE_BENCHMARKS=1` records browser performance samples in `benchmarks/browser.json`. Tests serve an ephemeral page on loopback and open two tabs; they make no chain or external service requests.

Explicit mock demonstrations:

```sh
node scripts/create-register.ts --mock
node scripts/check-lifecycle.ts --mock
```

The first returns `mode: "MOCK"`, `g2Passed: false`, a synthetic transaction hash and safe wallet state. The second tests signing exposure, replay rejection, rotation and disable, then writes `benchmarks/mock-lifecycle.json`. Both refuse to label a mock run as live. Mock time, addresses, epochs and payload encoding are synthetic; its UserOperation hash is not an ERC-4337 implementation.

## Public API

```ts
import { createMockPqWallet } from '@opaque/pq-wallet';

const wallet = createMockPqWallet();
await wallet.create();
await wallet.register();
const signed = await wallet.signUserOperation('0x1234');
const state = await wallet.getState();
```

The high-level wallet implements the frozen `PqWallet` methods exactly: `create`, `register`, `getState`, `signUserOperation`, `rotate`, `disable`. It returns only the existing shared DTO fields. `register`, `rotate`, and `disable` return submission hashes; those hashes do not prove confirmation. The mock confirms immediately unless a test enables deferred transactions.

`createPqWallet(options)` assembles the SDK with explicit storage, chain adapters, configuration and lifecycle rules. `WalletOptions` is a construction/dependency-injection contract, not a replacement for frozen protocol DTOs. Its port declarations are in `src/chain-adapter.ts`; the current concrete adapter is MOCK only.

For browser storage, construct one `IndexedDbSignerStore` and supply it as both `signerStore` and `walletStore`. Use a persistent `walletId` scoped to your application/account. The store persists encrypted signer material and wallet metadata; no memory store is selected by the SDK factory. `MemorySignerStore` and `MemoryWalletStateStore` are explicit internal test/mock adapters.

The approved signature-scheme exports are `keyGen`, `sign`, `verify`, `pkCommitment`, plus `pqDigest` and `PQ_DOMAIN`. These low-level primitives do not replace the high-level wallet's exposure accounting. Application pages must use the wallet/application adapter, not raw signer keys. Ring code must not import FORS parameters, tree helpers, paths, seeds, or wallet-internal files. A boundary test checks ring-client imports; ring fixes belong to its owner.

## Signing and storage invariants

- A storage transaction commits each reservation before generating a signature. Signature bytes are committed in a second transaction before they are returned.
- An identical digest retry returns the cached signature and original `signingReservation`. A concurrent request encountering an unfinished reservation fails with `SIGNER_STATE_UNSAFE`; retry after the first request completes can use the cache.
- A crash after reservation and before result persistence leaves the reservation burned. The same uncertain digest is never automatically signed again. Failed/dropped submissions do not reclaim capacity.
- `localSigningReservations` counts exposure under the key. Registry `useCount`/public `chainUseCount` counts accepted authority transitions. Different operations may compete for the same chain replay nonce while each consumes a distinct local reservation; only one can be accepted at that nonce. The counters are never equated or reconciled downward.
- Ordinary signatures cannot consume `lifecycleReserve`; lifecycle actions still obey the absolute `maxUses`. The mock uses `maxUses=8` and reserves two signatures for lifecycle actions. Those are explicit mock choices, not an approved production security parameter set.
- Browser transactions coordinate independent tabs, use strict durability, and validate append-only reservation history. Wallet metadata uses compare-and-swap. A configuration fingerprint prevents reopening the same local wallet under a different chain/account/EntryPoint configuration.
- Seeds are generated with WebCrypto randomness and stored AES-GCM encrypted with a non-exportable WebCrypto key. The encryption key is persisted in the same origin's IndexedDB. This does not protect against a compromised browser/origin or someone able to use that origin's stored key; no password-derived or hardware-bound encryption claim is made.
- Missing, malformed, regressed, or ambiguous signer/chain state fails closed. A trusted normal refresh is supported. Storage loss has no recovery promise, and an arbitrary historically valid backup rollback is not claimed detectable or safe.

Old key records remain stored after rotation to retain exposure history. The active key changes only after chain observations match the locally staged next commitments and expected epoch. Unexpected external key changes fail closed. A pending rotation blocks new ordinary signing until reconciliation. The reference registry supports next-key takeover after the 30-day disable timelock; exposing this through the frozen wallet API still requires a team decision, so the SDK does not invent a `takeover()` method.

## Registry and authority boundaries

The reference registry fields are exactly `pkCommitment`, `nextCommitment`, `useCount`, `maxUses`, `rotationDeadline`, `disableAfter`. `keyEpoch` is not silently added to the original Solidity contract. The SDK requires an authoritative epoch from its configured adapter and validates it against local key identity/history. Only the mock supplies a synthetic epoch model today.

Rotation requires the current PQ key. Timelocked takeover requires the precommitted next PQ key. There is no owner/admin/ECDSA/upgrade recovery authority. At and beyond `maxUses`, further accepted transitions reject.

The reference registry requires an explicit `RegistryPolicy`. Deadline enforcement, permission for late lifecycle actions (`allowLateRotation` in the current policy type), timer preservation on rotation, and repeated-disable behavior are not inferred. `MOCK_POLICY` is a selected test policy, not a claim of team agreement. The existing Solidity contract observes rather than enforces `rotationDeadline`, preserves a pending timer on rotation, and restarts the timer on repeated disable. Contract changes and final timing semantics remain jointly reviewed with Aditya.

The digest remains:

```text
keccak256(length-prefixed[
  PQ_DOMAIN, chainId, walletAddress, schemeId, useCount, keccak256(payload)
])
```

Current registry action payload helpers match its typed Solidity ABI encoding. Full live UserOperation payload composition remains unapproved. The SDK checks complete encoded operation identity, chain, account, EntryPoint, scheme, epoch, nonce, expiry and agreement with the canonical digest supplied by the adapter. It then requires the adapter's full payload verification, using a frozen copy to prevent changes between checking and signing. These checks do not replace a reviewed on-chain helper, trusted EntryPoint execution boundary, or a real full `userOpHash` implementation.

Live construction must supply chain ID, EntryPoint version/address, account implementation/factory, registry/validator addresses, bundler endpoint, explicit paymaster mode, approved epoch progression, and approved deadline/capacity rules. No production addresses or reduced operation encoding are hardcoded. Shared DTO additions must be coordinated with protocol-types owners.

## Tests, ABI and vectors

Tests cover the original sign/verify cases, Keccak versus SHA3 regression, unambiguous length-prefixing, malformed codecs, registration isolation, nonce/key replay, limits, typed action separation, disable boundaries, next-key takeover, atomic reservations, cached retries, crashes, dropped operations, multi-tab transactions, configuration changes, operation mutations and safe error/result boundaries.

Four pre-existing FORS validation defects were fixed without changing valid signature bytes or digest encoding: short seeds, short public keys, incomplete encoded paths, and missing verification nodes.

Generate public synthetic fixtures:

```sh
node scripts/generate-vectors.ts
```

`test/fixtures/authority-vectors.json` contains deterministic synthetic signatures for consume, rotate, disable and takeover. Tests also verify the already committed Solidity fixtures. Synthetic fixture seeds are public test data; never pass a real wallet key to a vector generator.

`abi/PQKeyRegistry.json` is a snapshot of the unchanged current registry. `abi/provenance.json` pins its source hash and compiler settings. A test rejects stale snapshots. Refresh with the contract owner after an ABI change. No validator ABI is fabricated.

The existing 13 registry and 16 verifier Solidity tests passed using the repository-pinned forge-std commit in an isolated `/tmp` checkout, with Solc 0.8.26, optimizer 200 runs, via-IR and Cancun. The source contracts, tests and shared packages were not changed. The normal commands, from the repository root after the contract owner initializes the pinned submodule, are:

```sh
cd contracts
forge test --match-path test/PQKeyRegistry.t.sol
forge test --match-path test/ForsVerifier.t.sol
```

These are local contract tests, not Arc receipts. Direct account/validator caller restrictions still require the missing validator/account integration and its tests.

## Measurements

```sh
cd packages/pq-wallet
node scripts/benchmark.ts --network local --output benchmarks/local-node.json
```

The recorded default scheme signature is **9,251 bytes**. Local Node measurements and Chromium samples are saved separately, with runtime identity, timestamps and sample counts. The recorded Node median signing time was about 140 ms; the three Chromium signing samples were about 231–313 ms. These are local observations, not performance guarantees. Browser memory was not measured.

After the contract owner deploys and submits a real verification transaction on Arc testnet, the receipt collector can check exact transaction/chain/calldata identity and record `gasUsed`:

```sh
node scripts/benchmark.ts --network arc-testnet --output benchmarks/arc-wallet.json
```

Required environment: `PQ_RPC_URL`, `PQ_CHAIN_ID`, `PQ_VERIFICATION_TX_HASH`, `PQ_VERIFIER_ADDRESS`, `PQ_EXPECTED_CALLDATA`. Set them through your configuration environment, not by committing credentials. The collector does not deploy, fund, sign or submit a transaction; those steps remain blocked on the agreed live configuration. It rejects missing/reverted/unrelated receipts. It reports whole transaction gas, not isolated hashing cost. Unit-test receipts are fixtures, not live evidence.

The handoff's rough gas estimate is not repeated as a measured result. The 288 leaf/path hash calls omit index derivation and commitment work; receipt gas also includes execution and encoding overhead. No Arc gas number was obtained in this implementation session.

## Remaining G2 gate

G2 remains **mock integration only; no final PQ authority claim**. Required next inputs/work:

1. Supply the approved epoch, full-operation payload and deadline/disable policies. Finalize how the frozen API handles timelocked takeover.
2. Confirm ownership and implement/review the actual validator/account/factory path, trusted EntryPoint caller restrictions, and registration/consumption binding with Aditya.
3. Supply real Arc configuration and obtain deployment/verification and UserOperation receipts through the actual bundler/EntryPoint.
4. Capture live replay/mutation and lifecycle evidence, measured verification gas, and any remaining scheme security review. Unit tests, browser tests and local gas probes alone do not pass G2.

FORS+C authorizes wallet actions. Anonymous note spending remains outside this package and uses the note witness. No claim is made that Arc consensus is post-quantum.

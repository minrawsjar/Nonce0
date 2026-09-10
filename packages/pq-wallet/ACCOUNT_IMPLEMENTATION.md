# Smart-account implementation — no MetaMask

This is an implemented experimental ERC-4337 **v0.7** account path, with local contract/SDK tests. It is **not deployed on Arc** and has **not passed a production bundler's simulation rules**. The existing mock UI remains at `/`; the new account UI is at `/live`.

## Implemented

- `contracts/src/opaque/wallet/account/AccountBoundPQKeyRegistry.sol`: a new registry revision with the original six-field state tuple, separate authoritative `keyEpoch`, fixed experimental k=32/a=8 and maxUses=8, account-bound signature acceptance, rotation, disable and next-key takeover.
- `OpaquePqAccount.sol`: immutable-authority v0.7 account, full-operation PQ authorization and bounded call batches. Validation is integrated rather than delegated to an independently upgradeable validator.
- `OpaquePqAccountFactory.sol`: deterministic minimal-proxy accounts with a fixed implementation. The proxy's delegate target cannot be changed; users cannot supply delegatecall targets. Creation and initialization are atomic. The account calls the registry itself.
- `contracts/script/DeployPqAccount.s.sol`: deployment script requiring an existing EntryPoint and its expected code hash. No broadcast has been made.
- `src/user-operation.ts`: full v0.7 operation hashing, canonical encoding, action encoding, authority digest and fixed-width signature envelope.
- `src/arc-chain-adapter.ts`: code-hash/configuration checks, pinned-block account observations, deployment address prediction, estimation and sponsorship integration.
- `src/bundler-client.ts`: bounded RPC, v0.7 split-field conversion, expected hash checks and operation-level receipt handling. Sponsorship implements an explicit `pm_sponsorUserOperation` split-field dialect; a provider with a different API needs its own adapter.
- `src/account-wallet.ts`: unchanged six-method `PqWallet` facade plus an internal application controller for transfer preparation, delivery, expired-request abandonment and next-key takeover. The current package root exports remain compatible with the existing wallet/mesh consumers; this application controller is currently imported internally by the browser page.
- `src/operation-outbox.ts`: durable IndexedDB operation records and compare-and-swap updates. Existing encrypted signer storage and signing reservations are reused in a separate live namespace.
- `src/account-config.ts`: explicit configuration parsing; placeholder addresses fail rather than silently selecting mock state.
- `demo/live.*`: create, sponsored activation, receive address/balance, native-USDC transfer review/sign/submit, refresh, rotation, disable and takeover controls. No `window.ethereum` or user ECDSA key dependency.
- `scripts/account-gateway.ts`: local development proxy with fixed upstreams, method allowlists, body limits and same-origin browser checks. Provider URLs/credentials remain server-side. This is not a production sponsorship policy service or a privacy-mesh integration.

## Authority decisions in this revision

These decisions are concrete review proposals under the authorized implementation plan. They do not modify the existing deployed registry or silently revise its ABI. Joint contract/spec review is still needed before deployment.

1. Account-bound calls: the new registry never accepts an arbitrary victim account argument for consumption. It mutates only `msg.sender`'s record. The immutable account cannot call registry functions through ordinary batches. A relay cannot submit a consume-only request for another account.
2. The six digest fields remain domain, chain, account, scheme, accepted use count and payload hash, with the original length-prefix encoding. The payload is `abi.encode("opaque/v1/pq-wallet/erc4337-v07", entryPoint, fullUserOpHash, epoch, validAfter, validUntil)`. The full operation hash binds action type, action parameters, initCode, nonce, fees, gas and sponsorship. This is a new operation payload revision, not the original standalone registry action encoding.
3. Envelope: uint256 epoch, uint48 validAfter, uint48 validUntil, then the 9,251-byte FORS signature. It is 9,295 bytes total. Hash calculation excludes the signature according to v0.7; validity and epoch are explicitly included in the PQ digest.
4. Action kinds: 0 activation; 1 bounded calls; 2 rotation; 3 disable; 4 next-key takeover. A lifecycle operation uses one PQ signature over the complete operation, not a second nested lifecycle signature.
5. Registry authorization occurs during EntryPoint validation. A successful validation advances accepted usage even if subsequent execution fails. EntryPoint rejects invalid time ranges and rolls the entire invalid validation back. Local reservations never decrease in either case.
6. Execution requires the exact operation hash's validation record and the resulting key epoch. A later key change cannot authorize an earlier operation under a different epoch. Failed executions may leave an unreachable authorization record; the pinned EntryPoint nonce prevents re-execution, and direct callers cannot use it. No account-level unvalidated execution path exists.
7. `rotationDeadline` remains observational, matching the original deployed contract. Rotation preserves an existing disable timer. Repeated disable is explicitly rejected in this revision. Disable time is set in **execution**, using actual inclusion time plus 30 days; no simulated clock controls exist on the live page. Next-key takeover clears the timer, advances epoch, and consumes one use of the incoming key.
8. Key generation tracking is a separate mapping, preserving the six-field tuple. Retired commitments cannot be cycled back through rotation. The experimental profile allows six accepted ordinary/activation uses and reserves two slots for lifecycle; local exposure may reach its limit sooner. Activation itself consumes one ordinary signing slot.
9. Fee sponsorship is transport/funding only. Sponsor or relay keys have no account recovery, rotation, upgrade or spending authority. Sponsorship availability is not guaranteed. The test sponsor accepts everything **only inside the tests**; it is not deployed by the deployment script.
10. The factory uses non-upgradeable EIP-1167 clones to keep activation within the test's v0.7 validation budget. Actual provider admission, storage-access restrictions and stake requirements remain unverified. Passing `handleOps` on Anvil is not a bundler simulation result.

## Run and configure

From the repository root:

```sh
cd packages/pq-wallet
npm ci
npm run dev
```

Open `http://127.0.0.1:4173/live`. Without deployment configuration the page clearly reports that setup is missing and disables account actions. The existing `/` demo still works independently.

For a configured account network, copy `config/account.example.json` to `.account-config.local.json` (ignored by Git) and replace every placeholder with independently verified deployment/provider values. The three earlier Arc contract addresses cannot replace the new account-bound registry/factory/implementation. Do not paste provider secrets into a public frontend bundle.

```sh
PQ_ACCOUNT_CONFIG="$PWD/.account-config.local.json" node scripts/check-account-network.ts
PQ_ACCOUNT_CONFIG="$PWD/.account-config.local.json" npm run dev
```

The server exposes sanitized public configuration and proxies the RPC calls. Use the same hostname, port and browser profile for the same wallet. Imported or historical demo keys are not migrated.

Configuration uses decimal strings for fee/gas ceilings. The sample ceilings are starting limits, not validated Arc recommendations. A supported provider must estimate the full operation and confirm its sponsorship fields. A failed or insufficient estimate stops preparation before signing. The dummy estimation signature uses synthetic bytes; no live key is used for estimation.

The browser currently sends **native USDC**, using 18-decimal amounts. The token pool interface uses six decimals and is separate. Pool deposit/spend integration is deliberately not wired before the first real Arc transfer milestone. Note custody and anonymous-spend authority are not supplied by this account implementation.

## Reproducible checks

Install the repository's pinned forge-std submodule and package dependencies first:

```sh
git submodule update --init contracts/lib/forge-std
npm ci --prefix packages/pq-wallet
npm run typecheck --prefix packages/pq-wallet
npm run build:demo --prefix packages/pq-wallet
node --test --test-isolation=none packages/pq-wallet/test/*.test.ts
PQ_ACCOUNT_TESTS=true forge test --root contracts --ffi --match-contract OpaquePqAccountTest
```

The new contract suite is opt-in because it uses Foundry FFI to ask the TypeScript signer for **public deterministic test signatures**. FFI invokes only the committed `sign-account-fixture.ts` helper; no private wallet key is read.

For the actual SDK-to-EntryPoint integration, first build the contract test artifacts using the command above, then:

```sh
PQ_ACCOUNT_INTEGRATION=1 node --test --test-isolation=none packages/pq-wallet/test/account-integration.test.ts
```

This starts Anvil and a **test-only RPC harness**, deploys the real v0.7 EntryPoint/account/factory/registry and a test sponsor, then exercises the SDK. The harness uses fixed gas estimates and therefore does not establish public bundler compatibility. It submits transactions only to loopback using Anvil's public test key.

For the browser version in a clean profile, install Chromium or set `PQ_CHROMIUM_EXECUTABLE`:

```sh
PQ_ACCOUNT_INTEGRATION=1 PQ_ACCOUNT_BROWSER=1 node --test --test-isolation=none packages/pq-wallet/test/account-integration.test.ts
```

Existing browser-signer storage tests remain separately opt-in with `PQ_BROWSER_TESTS=1`.

## Verification recorded

Typecheck and browser build passed. The Node suite passed 74 cases (two opt-in suites skipped); 45 Solidity tests passed, including 1,024 factory-address fuzz cases. The separate local Anvil SDK/browser integration passed with a fresh Chromium profile and no extension: create, sponsored activation, transfer, refresh/retry, rotation and disable. See `benchmarks/account-local-verification.json`. The test RPC harness does not implement public-bundler admission rules.

## Required before Arc activation

- Joint review of the account-bound registry, payload, epoch and lifecycle decisions above, plus independent scheme/security review for any production claim.
- Verified v0.7 EntryPoint address/code hash and a bundler supporting this custom account and signature profile; run actual provider simulation including deployment and external storage access.
- Deploy the new registry/factory and record implementation addresses, ABI/source/compiler provenance and runtime code hashes. Existing accounts are not automatically migrated.
- A funded paymaster and compatible sponsorship endpoint, or explicit account prefunding. The project—not the user—funds sponsored gas.
- Actual operation receipts and controlled-recipient balance changes on Arc. No live receipts or final G2 claim exist yet.
- Live elapsed-disable/takeover requires the actual 30-day wait; local boundary tests do not shorten or substitute it.

No contracts were pushed or deployed by this implementation work. Provider/deployment setup is still required to enable the live page.

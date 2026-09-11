# PQ wallet without MetaMask — implementation plan

Status: implementation in progress, 2026-09-10. The account contracts, SDK/outbox, provider adapters and browser page are implemented locally; see ACCOUNT_IMPLEMENTATION.md for exact scope and verification. Actual Arc provider compatibility, reviewed deployment, funding and live receipts remain pending. Pool integration remains gated on a live transfer.

## Outcome

A user opens Opaque, creates PQ keys locally, receives a real smart-account address, and sends test USDC after approving with the PQ wallet. No browser extension, imported Ethereum private key, or hidden user ECDSA wallet is required.

Use ERC-4337 as the preferred delivery architecture, subject to an early compatibility gate. A bundler delivers requests through a pinned EntryPoint; a funded paymaster sponsors initial testnet fees. Neither the bundler, sponsor, deployer, nor server has spending, rotation, recovery, or upgrade authority over the account. Infrastructure can refuse service; it cannot fabricate PQ approval. This does not claim the underlying chain or transaction transport is post-quantum.

The original handoff remains the baseline: preserve the six-field digest, the six-field registry state tuple, the frozen PqWallet API, current-key rotation, next-key timelocked takeover, and durable local exposure accounting. Any additional authoritative metadata or caller restrictions require explicit joint contract/spec review, not an unnoticed compatibility change.

## Existing pieces and remaining work

Reuse fors.ts, digest.ts, sign.ts, signer-state.ts, indexeddb-store.ts and wallet-state.ts, including their reservations and exact-retry behavior. Extend wallet orchestration rather than implementing a second signer. Keep mock mode separately available, with a separate storage namespace and visible mode label.

The deployed registry at 0x7FC11e0f5d224439b2d710BB1c141913F454eF17 remains useful for standalone integration evidence. It is not an account and does not execute approved transfers. The deployed SingleNotePqVerifier is a note verifier, not a wallet validator. The deployed PrivatePool is a single-note, commit-reveal pool and does not enforce registry approval.

New components:

- OpaquePqAccount: the contract address that holds funds and executes approved calls.
- OpaquePqAccountFactory: deterministic account creation, with initialization bound to the user's commitments and full configuration.
- PQ validation logic: verifies the exact operation and authorization context. Prefer an immutable linked/internal component, with a separate contract only if the measured design requires one.
- Reviewed account-bound registry integration: binds acceptance and execution safely; likely a new registry deployment.
- Arc chain adapter and operation builder: actual contract reads, full UserOperations, simulation, submission, receipts, and reconciliation.
- Bundler and paymaster integration: request delivery and explicitly budgeted sponsorship.
- Browser onboarding, transfer, history, rotation, and disable flows using those components.

## Phase 0 — resolve compatibility and authority before building the full UI

Owners: Manan for SDK/browser; Aditya with Manan for wallet contracts; assigned infrastructure owner for bundler/sponsorship. New account/factory and service ownership must be assigned explicitly.

1. Verify chain ID 5042002, runtime bytecode and verified source/ABI of any reused contract at a pinned block. Record code hashes, deployment blocks and compiler provenance. Existing code-presence checks do not establish source equality.
2. Identify an available Arc bundler and its supported EntryPoint version/address using its supported-entrypoints API. Verify the EntryPoint bytecode. Pin exact contract/package versions and provider configuration; do not infer deployment addresses from other chains.
3. Run the real 9,251-byte signature through the selected account's complete validation path. Measure validation gas, calldata/pre-verification gas, deployment overhead and provider request limits. Check external registry storage access, factory/paymaster stake rules, timestamp handling and full-bundle simulation. A standalone verifier benchmark is insufficient.
4. Never use a real signing key merely to estimate gas. Use a specified dummy signature or dedicated synthetic test keys. Build an estimate path whose control flow and size conservatively represent valid signatures. Provider estimation behavior must be measured.
5. Fix the public-consume problem. The current registry allows anybody with the exposed signature to consume it independently, invalidating a pending wallet request without performing its action. Do not solve this by hiding the request in a trusted relay. Preferred proposal: a new account-bound registry permits ordinary consumption only from the registered account, which binds consumption to its validated execution path. Preserve the original tuple and digest. Jointly review caller rules for lifecycle actions and migration behavior.
6. Define authoritative keyEpoch. The deployed tuple does not contain it. Preferred proposal: a separately exposed, on-chain generation counter in the reviewed registry revision, incremented on rotation and takeover, without altering the original tuple. This is an explicit contract/spec addition requiring review. If it is not accepted, stop the dependent implementation until a reviewed equivalent exists; never use a constant or browser-only counter as chain authority.
7. Pin lifecycle semantics: deadline enforcement, late rotation, timer preservation, repeated disable, takeover state and expiry. The existing deployed source stores but does not enforce rotationDeadline, preserves pending disable through rotation, and restarts the timer on repeated disable; the current mock differs. Name any deliberate revision and deploy separately.
8. Approve the exact full-operation payload and signature envelope, signing parameters and exposure limit. Retain all six digest fields. Specify nonce lane, validAfter/validUntil, key epoch, scheme, and operation/action domain. The full EntryPoint userOpHash must bind sender, deployment data, call data, gas/fee fields and paymaster fields according to the selected EntryPoint version. Put additional validity/epoch context outside userOpHash in the signed payload, not in an unsigned envelope.

Deliverables: docs/pq-account-authority.md, deployment/config manifest, cross-language payload vectors, actual bundler compatibility results, and explicit contract decisions.

Gate: no claim of ERC-4337 compatibility until the real path passes provider simulation and receipt checks. If the provider rejects the design, first assess a compliant self-hosted bundler. A direct-relay account can be a separately approved alternative, but must use its own explicit API and evidence; never label it ERC-4337 or pass fake EntryPoint fields to the current adapter.

## Phase 1 — account and factory

Proposed files under contracts/src/opaque/wallet/:

- OpaquePqAccount.sol
- OpaquePqAccountFactory.sol
- PqOperationValidator.sol (or an internal validation library)
- AccountBoundPQKeyRegistry.sol (proposed revision; no replacement of the live registry)

Requirements:

- Immutable validation authority and pinned EntryPoint. No owner key, ECDSA guardian, arbitrary delegatecall, privileged plugin installation, or upgrade path that bypasses PQ authorization.
- Account executes a bounded call or batch only through the reviewed authorized path. EntryPoint caller checks alone are insufficient if any unvalidated route could reach execution; bind the exact validated operation to execution.
- Use CREATE2 with initialization data bound to active/next commitments, scheme, budgets, registry/EntryPoint configuration and salt. Initialization must be one-time and atomic. Follow the pinned EntryPoint version's factory-caller rules.
- During deployment the account itself calls registry.register, so msg.sender is the account, not a relay or factory. Factory/address calculations must match browser predictions byte-for-byte. Copying deployment data must never let another party substitute keys.
- Implement token transfer and a limited batch for approval plus pool deposit. Restrict self-calls and registry calls so ordinary execution cannot bypass lifecycle signing rules or consume reserved capacity using an ordinary signature.
- Separate EntryPoint nonce, registry accepted-use count, key epoch, and local signing reservations. Document exactly when each changes.
- Implement validation/consumption in the phase permitted by the pinned EntryPoint and bundler. Specify behavior for successful validation followed by failed execution. Never count one signature twice. If execution-phase consumption is chosen, analyze state changes between validation and execution and simulate the entire bundle.
- Serialize initial operations per account. Rotation, disable and takeover cannot race pending ordinary operations silently. Tests must cover lifecycle transitions interleaved with validation/execution and multiple operations in one bundle.
- Takeover validates the precommitted next key after the real timelock through a separately domain-separated path; it does not require approval from the disabled key. Budget any outer and inner signatures explicitly and do not reuse a takeover signature as an ordinary transfer approval.

Tests: wrong key; altered target/value/calldata/gas/paymaster/expiry; wrong chain/account/EntryPoint; copied registration; second initialization; direct execute; consumed-signature front-running; cross-operation replay; stale epoch; failed calls; reentrancy; key exhaustion; unauthorized upgrades; lifecycle races; takeover boundaries.

Gate: Foundry unit, fuzz and invariant tests pass, vectors match TypeScript, and complete account validation passes Phase 0 bundler checks.

## Phase 2 — no-extension account creation and fee payment

Default testnet experience: sponsored creation and a capped number of supported actions. No fees are literally free; the project funds the sponsor's EntryPoint deposit and any required stake in native test USDC.

1. Browser creates active/next keys, stores encrypted records, and obtains the deterministic smart-account address before deployment.
2. An application service prepares a bounded sponsorship quote. It checks allowed factory/account versions, action type, spending/gas ceilings, expiry and abuse limits. Credentials and any sponsorship signing key stay on the server.
3. Estimate using the synthetic signature path. Finalize deployment fields, gas, fees, paymaster data and expiry before requesting a real PQ signature. Sponsor authorization must not create a circular dependency on the final PQ signature.
4. The first signed UserOperation deploys and registers the account atomically, then performs a narrowly defined activation action. Verification can use the initial commitments for this first operation without requiring a pre-existing registration read.
5. Current SDK creation/signing assumes an observed registered account before signing ordinary operations. Add an internal, narrowly scoped bootstrap operation path with the same durable reservation mechanism. Keep PqWallet.create local/idempotent and use register for activation submission; do not add methods to frozen shared interfaces.
6. Wait for the operation receipt, check success and expected account/registry state, then show Active. A userOpHash or transaction hash by itself is not confirmation.
7. If sponsorship is unavailable, show a clear pending/unavailable state. Optional self-funding means sending native test USDC to the predicted account/required EntryPoint deposit from another source, not requiring MetaMask inside this wallet. Any deposit-management execution must itself obey PQ authority.

Sponsor administrative authority may withdraw its own funding or refuse sponsorship; it must never change wallet keys or spend account assets. A sender's conventional chain transaction key is infrastructure authority only.

## Phase 3 — live SDK adapter and durable operation outbox

Proposed files under packages/pq-wallet/src/:

- arc-chain-adapter.ts: pinned-block reads, registry/epoch observations, deployment detection, receipt confirmation.
- account-address.ts: factory address prediction and initialization encoding.
- user-operation.ts: pinned-version UserOperation codec, canonical hash and signature envelope.
- bundler-client.ts: supported-entrypoints check, estimation, submission and operation receipt retrieval.
- sponsorship-client.ts: bounded quote retrieval without embedded service credentials.
- operation-outbox.ts: persist unsigned/finalized/signed/submitted/confirmed/failed/unknown operation states.
- bootstrap.ts: restricted first-deployment/registration signing path.
- lifecycle.ts: typed rotation/disable/takeover preparation and status handling.
- config/arc-testnet.ts: public addresses, code hashes, versions, RPC and non-secret service configuration.

Integrate with wallet.ts, authority.ts and chain-adapter.ts. Preserve the six public PqWallet methods and existing mesh exports; operation delivery, transfer composition and takeover live in application/internal adapters unless a shared API revision is approved.

Persist the exact operation bytes, userOpHash, PQ signature, reservation and submission identifiers before returning actionable success. On network uncertainty, query state/receipt and retry identical bytes. A fee bump, different expiry, gas change or sponsorship replacement changes the approved request and needs another reservation; never automatically re-sign forever. Keep capacity for lifecycle actions.

Distinguish rejected submission, accepted-but-pending, included operation failure, and confirmed success. A successful bundle transaction does not prove a particular operation executed successfully. Local reservations never decrease, including after an execution revert or chain read failure.

Fresh live keys and storage namespaces only. Do not import the demo's synthetic account or treat simulated event history as live chain facts. Missing or inconsistent signer history fails closed.

## Phase 4 — browser flow

Update demo/app.ts and demo/adapter.ts (or promote their application logic into a dedicated wallet surface without changing signer ownership).

Screens and actions:

1. Create wallet: local keys and predicted real address, then Activate with visible sponsorship/deployment status.
2. Receive: actual address, copy/QR if useful, clearly labeled Arc Testnet.
3. Send: recipient and amount, explicit review, PQ approval, submitting/confirmed/failed states.
4. Activity: actual operation and transaction identifiers, explorer links, receipt-derived success.
5. Manage keys: remaining local signing capacity, accepted network count, rotation and disable status.
6. Recovery: only the supported next-key takeover path when the required key is still available and the timer elapsed. Do not promise recovery after all browser keys are lost.

Remove any dependency on window.ethereum, wallet-extension discovery, Ethereum seed phrases or user ECDSA keys from live onboarding. Keep mock mode visually distinct. Do not expose the simulated clock control in live mode. Browser key storage remains browser key storage, not hardware-wallet protection.

## Phase 5 — pool integration, after a real transfer works

Reuse/review backend/chain/pool.ts rather than duplicating commit-reveal logic. Route deposit token approval and deposit through PQ-authorized account execution. Validate actual pool token, denomination and capabilities on startup.

Keep note spending authority separate from wallet FORS signatures as the original handoff requires. Persist note secrets and commit-reveal progress with an explicitly designed storage/recovery lifecycle; wallet key storage alone does not implement note custody. Do not assume PQ key rotation rotates note secrets.

The supplied PrivatePool deployment remains SINGLE_NOTE_PQ with ring size 1 and requires commit-reveal. Label its linkability accurately. A ring-mode pool is a separate deployment/migration, not a toggle in this wallet plan.

## Phase 6 — validation and live acceptance

Local checks:

- TypeScript checks, wallet/storage suite, shared ABI and payload vectors.
- Contract tests and full pinned EntryPoint integration, including sponsor exhaustion and denied sponsorship.
- Browser tests in a clean profile with no extension installed: create, activate, receive, transfer, refresh, rotate, sign again, schedule disable.
- Crash/retry/two-tab scenarios; changed fee/expiry; missing outbox or signer records; copied signatures; malformed RPC observations.
- Prove relayer/sponsor compromise cannot transfer funds or alter keys; it can at most refuse or delay service within the designed trust boundary.

Arc acceptance:

1. Fresh wallet created without an extension; predicted/deployed addresses match.
2. Sponsored activation produces a confirmed registration owned by the smart-account address.
3. Fund with test USDC and execute a PQ-authorized transfer to a controlled recipient; verify both receipt and balance change.
4. Replay and mutation attempts fail. Verify no public consume-only route can invalidate an approved operation independently.
5. Rotate with stable account address, confirm new epoch/commitments and old-key rejection, then successfully transfer again.
6. Schedule real disable and record its timestamp. Test full 30-day boundary locally; do not pretend a clock jump happened on Arc. Live elapsed-disable/takeover remains explicitly unobserved until actually exercised.
7. Record gas, 9,251-byte signature handling, browser timing, EntryPoint/provider compatibility and sponsor cost.

Evidence: scripts/g2-live.ts and benchmarks/g2-evidence.json containing public addresses, versions, code hashes, operation/transaction hashes and outcomes, never live secret material. Do not claim production security or final G2 acceptance solely from deployment or successful signature verification.

## Delivery order and estimates

Rough engineering estimates, not guarantees; independent security review and provider/deployment waits are additional.

| Milestone | Estimate | Result |
|---|---:|---|
| 0. Authority decisions and bundler spike | 2–4 days | Proven route and reviewed contract changes |
| 1. Account, factory, registry integration and tests | 5–8 days | Locally enforced PQ execution |
| 2–3. Sponsorship, bootstrap, live adapter and outbox | 4–7 days | No-extension account creation and submission |
| 4. Browser integration | 2–3 days | Complete user flow |
| 6. Adversarial testing and Arc evidence | 3–5 days | Reviewable live testnet milestone |
| 5. Optional pool integration | 2–4 additional days | Explicit single-note deposit/spend flow |

Dependencies: Phase 0 gates production contract choices; Phase 1 gates deployment; bootstrap and sponsorship must pass before the browser advertises activation; a live transfer precedes pool integration. No automatic deploy/push is authorized by this planning document.

## Sources and reference files

- Original handoff: /home/manan/Downloads/handoff-manan.md.
- Existing local design: IMPLEMENTATION_PLAN.md; src/wallet.ts; src/authority.ts; src/chain-adapter.ts.
- Existing contracts: contracts/src/opaque/wallet/PQKeyRegistry.sol; docs/deployment-arc-testnet.md.
- Arc account abstraction: https://docs.arc.io/arc/tools/account-abstraction — supports ERC-4337 and lists providers; provider support for this custom account still needs testing.
- ERC-4337 specification: https://ercs.ethereum.org/ERCS/erc-4337 — source for operation hashing, account creation and validation rules. Implementation must pin a release, not track an evolving page implicitly.
- Bundler role: https://docs.erc4337.io/bundlers/index.html.

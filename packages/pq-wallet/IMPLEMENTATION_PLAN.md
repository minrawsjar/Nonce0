# PQ wallet implementation plan

Planning baseline: repository HEAD `7cea558`, inspected 9 September 2026.

## Execution update — 9 September 2026

Implemented in `packages/pq-wallet/`: primitive regression tests and four validation fixes; original-field registry with explicit timing policy; encrypted signer storage and atomic reservations; IndexedDB and wallet metadata transactions; frozen six-method wallet with injected authority/chain adapters; conforming mock; package barrel; operation/boundary tests; synthetic vectors; existing registry ABI snapshot; local/browser measurements; mock create/register and lifecycle scripts; README.

The live adapter, validator/account/factory integration, final epoch/payload/deadline decisions, Arc deployment and live G2 evidence remain incomplete. The user confirmed approved configuration exists, but its actual values/rules have not yet been provided. The SDK does not invent that configuration. `RegistryPolicy` is explicit, and only the mock selects example timing/epoch/payload semantics.

Existing Solidity sources/tests and frozen protocol-types remain unchanged. Their 13 registry and 16 verifier tests passed in an isolated checkout with the pinned forge-std dependency. Chromium verified actual two-tab reservations and reload/abort behavior. See [README.md](README.md), [benchmarks/local-node.json](benchmarks/local-node.json), [benchmarks/browser.json](benchmarks/browser.json), and [benchmarks/mock-lifecycle.json](benchmarks/mock-lifecycle.json).

Plan adjustments: the runnable lifecycle script is `scripts/check-lifecycle.ts --mock`; no fake live runner was added. The Arc benchmark command currently collects and checks a previously submitted verification receipt rather than deploying an unconfigured account. Browser memory is not measured. G2 remains **mock integration only; no final PQ authority claim**.

The sections below preserve the planning baseline and decision history; this update and the README describe the implemented state.

Final checks: `npx tsc --noEmit` and the exact handoff test command passed. With Chromium enabled, the individually reported SDK suite passed 72 tests with no failures or skips. The existing Solidity suites passed 29 tests. `git diff --check` passed. No live deployment or Arc verification receipt was obtained.

## 1. Authority, scope, and current state

The user's reference to `handoff-manan.pdf` is interpreted as the original attached `handoff-manan.md`; no separate file with that PDF name was supplied. That handoff wins wherever it conflicts with the updated engineering handoff. It explicitly incorporates `docs/spec-v2.md` §5. The updated PDF supplies compatible browser-safety, integration, and evidence requirements. This document is a plan, not an implementation or security review.

Ownership: Manan owns `packages/pq-wallet/` and jointly owns `contracts/src/opaque/wallet/PQKeyRegistry.sol` with Aditya. Changes to that contract require Aditya's sign-off. Pool/ring protocol, node infrastructure, product pages, and `packages/protocol-types` are outside this scope. Validator/account work required for G2 must have an agreed owner; its appearance in the updated PDF does not silently expand the narrower ownership instruction. Existing contract tests outside the permitted folders are explicitly cross-team work.

| Component | Verified current state | Target |
| --- | --- | --- |
| `src/digest.ts` | Exists; six-field, length-prefixed Keccak digest | Tested implementation retaining every §5.3 field |
| `src/fors.ts` | Exists; key/sign/verify/commitment and wire codecs; default `k=32,a=8` | Tested, precisely documented scheme with cross-language vectors and measured costs |
| SDK tests | No test files | Cryptographic, registry, signer lifecycle, API, and boundary tests |
| `src/registry.ts`, `src/wallet.ts`, `src/index.ts` | Absent | Implemented in that order after primitive tests |
| Durable signer storage | Absent | Atomic reservations, cached retry bytes, trusted refresh/recovery behavior |
| Package exports | Already `{ ".": "./src/index.ts" }` | Same export map; target file supplied |
| Solidity | `PQKeyRegistry.sol`, `ForsVerifier.sol`, registry/verifier tests and fixtures exist | Reviewed conformance; required missing tests and integration added by agreed owners |
| Validator/account integration | No `PQValidator` implementation found in the wallet contract folder | Pinned, tested account/EntryPoint/validator/bundler path |

The wallet package has no diff between `3ca4fe9` and current HEAD. The handoff reports historical strict typecheck success only. A fresh typecheck could not be confirmed in this environment: no local TypeScript executable was present, and the attempted command did not complete. Existing Solidity tests were inspected, not executed. Neither their presence nor the historical typecheck establishes correctness.

### Conflict resolutions

- Preserve §5.2's actual `PQKeyState`: `pkCommitment`, `nextCommitment`, `useCount`, `maxUses`, `rotationDeadline`, `disableAfter`. Do not silently replace `useCount` with `chainUseCount` or add an on-chain `keyEpoch`.
- Preserve §5.3's digest fields: `PQ_DOMAIN`, `chainId`, `walletAddress`, `schemeId`, `useCount`, `keccak256(payload)`. The exact structured `payload` for full operation binding needs team review before implementation, as §5.3 requires. A compatible extension may place full `userOpHash`, epoch/context/validity information inside that payload; no encoding is considered approved merely because it appears in this plan.
- The frozen public API still requires `keyEpoch` and `chainUseCount`. `chainUseCount` can describe accepted registry `useCount` for the active key. The authoritative source and reconciliation of `keyEpoch` remain a decision gate. Do not manufacture a constant epoch or a second public interface to hide the mismatch.
- Keep ordinary rotation authorized by the current key. Preserve §5.2's distinct takeover by the precommitted next key after the 30-day disable timelock. This is PQ authority, not an admin/EOA recovery route. How takeover is invoked through the frozen SDK remains unresolved.
- Follow tests → in-memory registry → wallet → barrel. Add durable storage within the wallet phase; the in-memory registry is a reference state machine, not a production browser persistence solution.

## 2. Ordered build phases

All proposed SDK paths below are relative to `packages/pq-wallet/`. Each named task touches at most three files. Estimates are focused engineering effort including tests and fixes, excluding cross-team waiting and testnet outages. They are planning estimates, not delivery guarantees.

After each code task, run the handoff commands from the package directory:

```sh
cd packages/pq-wallet
npx tsc --noEmit
node --test test/*.test.ts
```

Install the package's declared dependencies before running these checks. Do not report a blocked command as passing. Browser concurrency tests also need a real browser harness; Node-only tests cannot establish multi-tab IndexedDB behavior.

### Phase 1 — tests for the existing primitives

**T1a: Cryptographic regression tests — 1–2 days.**

Files: `test/digest.test.ts`, `test/fors.test.ts`.

Interfaces: `pqDigest(DigestInput)` and `keyGen`, `sign`, `verify`, `pkCommitment`, `encodeSignature`, `decodeSignature`. `DigestInput` remains `chainId`, `walletAddress`, `schemeId`, `useCount`, `payload`; `PQ_DOMAIN` is the pinned constant.

Named cases:

- `sign_verify_round_trip`
- `tampered_signature_rejected`
- `tampered_digest_rejected`
- `cross_key_verification_rejected`
- `signature_codec_round_trip`
- `signature_codec_rejects_truncation_and_trailing_bytes`
- `signature_codec_rejects_malformed_parameters`
- `digest_matches_pinned_keccak_vector_not_node_sha3_256`: use `keccak_256` from `@noble/hashes/sha3.js`, a fixed independently checked expected digest, and Node's `sha3-256` as a negative comparison.
- `length_prefix_distinguishes_ambiguous_field_splits`: compare canonical `["a:b", "c"]` with `["a", "b:c"]`; assert distinct encoded bytes and hashes.
- `digest_binds_each_of_the_six_spec_fields`: cover domain separation with a pinned vector and changed-domain reference calculation, alongside mutations of every input field.
- `digest_rejects_invalid_boundary_values`

Checklist coverage: malformed input and cryptographic mutation foundation. Does not claim complete UserOperation or EntryPoint coverage yet.

**T1b: Fix evidenced primitive defects — allow 0.5–1.5 days.**

Split fixes by primitive: `src/digest.ts` + `test/digest.test.ts`, or `src/fors.ts` + `test/fors.test.ts`. Add a failing regression before the fix. No speculative refactor or scheme change. Any wire-format/scheme change requires version/fixture coordination.

Dependency: none to begin testing. Cross-language expected values should be checked with Aditya; agreement between two implementations alone is not a proof of cryptographic security.

Exit: all minimum handoff tests and hash/encoding regressions pass. Start the benchmark spike once verifier conformance is sufficient; do not wait for UI integration.

### Phase 2 — in-memory registry

**T2: Reference state machine — 1.5–2.5 days.**

Files: `src/registry.ts`, `test/registry.test.ts`.

Exact state:

```text
pkCommitment: bytes32
nextCommitment: bytes32
useCount: uint64
maxUses: uint64
rotationDeadline: uint64
disableAfter: uint64
```

Represent Solidity integers as validated bigint values with uint64 bounds. Registry instances hold per-account records; the account identifier is not an extra field silently added to the struct. Inject chain/time observations and signature verification dependencies; keep RPC/storage effects out of the pure state machine.

Implement registration, authenticated consumption, rotation, disable initiation, and next-key takeover as specified. Failed validation changes no state. For normal rotation, promote `nextCommitment`, stage a subsequent commitment, and reset usage only because a new key has become active. Do not reset the old key's signing-exposure history. Resolve undocumented deadline and pending-disable interactions before coding those branches.

Named cases:

- `registration_isolated_between_accounts`
- `registration_cannot_overwrite_existing_authority`
- `registration_rejects_invalid_commitments_and_limits`
- `rotation_requires_current_pq_key_no_fallback`
- `old_use_count_replay_rejected`
- `user_action_signature_cannot_authorize_rotation_or_disable`
- `last_permitted_use_succeeds_at_maxUses_minus_one`
- `verification_rejected_at_maxUses`
- `verification_rejected_at_maxUses_plus_one`: inject an invalid persisted/reference state to ensure it also fails closed; valid transitions must never reach it.
- `failed_verification_does_not_increment_useCount`
- `rotation_promotes_next_key_and_rejects_retired_key_signature`
- `disable_requires_current_pq_authority`
- `disable_boundary_before_at_after_30_days`
- `takeover_requires_precommitted_next_key_and_elapsed_timelock`
- `expired_rotation_follows_agreed_policy`: acceptance rule is blocked on the deadline decision.

Checklist coverage: registration isolation, nonce replay, exhaustion, authenticated rotation, expired rotation, disable timelock.

Dependencies: Aditya reviews TS/Solidity parity. Do not copy an existing contract discrepancy into the model as if it were normative. Matching Solidity tests are a separate cross-team task under section 4.

### Phase 3 — signer lifecycle and frozen wallet API

**T3a: Atomic signer state and signing coordinator — 2–3 days.**

Files: `src/signer-state.ts`, `src/sign.ts`, `test/signer-state.test.ts`.

Track active/next secret material privately, a trusted key identity/epoch mapping, `localSigningReservations`, operation identity, and immutable cached signing outputs. A durable reservation must commit before signature production. A dropped operation still consumes exposure. Identical retries return cached signed bytes; changed fields require a new reservation. Distinguish the replay nonce used by the registry from the amount of exposed signing capacity; do not blindly use one counter for both.

Define crash checkpoints: before reservation, after reservation/before signing, after signing/before durable result, and after durable result/before return. Uncertain state must produce `SIGNER_STATE_UNSAFE`, never automatic regeneration from a potentially stale snapshot. Preserve headroom for lifecycle actions; the precise exposure cap and reserve policy require agreement.

Cases: `reservation_precedes_signature`, `identical_retry_returns_cached_bytes`, `changed_retry_reserves_fresh_capacity`, `dropped_operation_chain_read_does_not_unburn_reservation`, `crash_at_each_checkpoint_preserves_budget`, `uncertain_state_fails_closed`, `ordinary_actions_preserve_lifecycle_capacity`, `exhausted_local_budget_rejected_even_when_chain_count_is_lower`.

**T3b: Browser durability — 1.5–2.5 days.**

Files: `src/indexeddb-store.ts`, `test/browser-signer.test.ts`, `tsconfig.json`.

Provide an IndexedDB storage adapter with transactional coordination across tabs. Use WebCrypto randomness. Evaluate at-rest encryption and document key handling; do not promise protection from a compromised origin or recovery from storage loss. Add DOM type support without weakening existing strict checks.

Cases: `two_tabs_cannot_reserve_same_capacity`, `refresh_restores_trusted_state_and_reconciles_chain`, `storage_transaction_abort_cannot_return_signature`, `missing_or_inconsistent_state_fails_closed`, `storage_errors_do_not_leak_secrets`.

The browser harness is an additional bounded setup task if required: `package.json`, `package-lock.json`, `test/browser-harness.ts`. The export map stays unchanged. Agree the harness dependency before installation; provide a browser-specific runnable command in the implemented README. Do not claim an in-memory mock proves these cases.

**T3c: Complete operation encoding and chain adapter — 1.5–2.5 days.**

Files: `src/authority.ts`, `src/chain-adapter.ts`, `test/authority.test.ts`.

Implement only the agreed composition around the existing §5.3 digest. Decode the complete operation for the configured EntryPoint version; reject incomplete or mismatched input. Bind the canonical full `userOpHash` and agreed context/epoch/validity fields. Use typed, domain-separated rotation/disable payloads. Configure chain ID, EntryPoint version/address, account implementation/factory, registry/validator, bundler endpoint, and explicit paymaster or no-paymaster mode.

Cases: `mutated_chain_account_entrypoint_scheme_operation_expiry_rejected`, `old_epoch_replay_rejected`, `registry_action_domains_cannot_cross_replay`, `canonical_sdk_and_contract_digest_vectors_match`, `unavailable_dependency_returns_safe_error`.

Dependencies: reviewed payload format and epoch source; pinned ABI/version; assigned contract integration owner. Public RPC/ABI transport mappings must remain behind approved adapters. Shared DTO/error additions go to the protocol-types owners, not local public substitutes.

**T3d: Wallet implementation — 1–2 days.**

Files: `src/wallet.ts`, `test/wallet.test.ts`, `src/mock.ts`.

Implement the frozen declarations exactly:

```ts
interface PqWallet {
  create(): Promise<PqWalletState>;
  register(): Promise<TxHash>;
  getState(): Promise<PqWalletState>;
  signUserOperation(encodedUserOperation: Hex): Promise<{
    readonly digest: Bytes32;
    readonly signature: Hex;
    readonly keyEpoch: bigint;
    readonly signingReservation: bigint;
  }>;
  rotate(): Promise<TxHash>;
  disable(): Promise<TxHash>;
}
```

`PqWalletState` fields: `accountAddress: Address`, `pkCommitment: Bytes32`, `keyEpoch: bigint`, `chainUseCount: bigint`, `localSigningReservations: bigint`, `maxUses: bigint`, `rotationDeadline: UnixSeconds`, `active: boolean` (all readonly).

Use existing branded types and runtime codecs. Generate replacement keys internally. Returned transaction hashes mean submission, not confirmation. `getState()` combines trusted local facts with authoritative chain observations without making their counters equal. Do not expose mutable signer objects or add a public takeover method without cross-team resolution.

Cases: `frozen_wallet_interface_conformance`, `create_register_getState_happy_path`, `submitted_rotation_does_not_prematurely_activate_next_key`, `confirmed_rotation_updates_active_key`, `failed_submission_preserves_signing_exposure`, `getState_never_lowers_local_reservations`, `disable_reports_correct_timelock_state`, `public_results_errors_and_network_calls_do_not_leak_secrets`, `mock_matches_real_public_shapes_and_errors`.

Checklist coverage across T3: full operation/epoch mutation, multi-tab/crash/dropped-operation signing, refresh reconciliation, exhaustion/headroom, secret leakage. Direct unauthorized validator calls require Solidity/live coverage too.

### Phase 4 — barrel and consumer boundary

**T4: Public package completion — 0.5 day.**

Files: `src/index.ts`, `test/public-api.test.ts`, `test/module-boundary.test.ts`.

Export the wallet construction surface and approved scheme interface; no signer seeds, tree state, or mutable signer store objects cross the application boundary. Keep external callers on `keyGen/sign/verify/pkCommitment` and the §5.3 digest where the scheme boundary applies. Do not encourage ring consumers to import parameter/tree helpers.

Cases: `package_root_import_resolves`, `public_api_matches_frozen_contract`, `package_export_map_remains_unchanged`, `ring_client_has_no_pq_wallet_internal_imports`. The boundary test may read ring-client sources; fixes there belong to Aditya. Include source import and public API usage checks so a root re-export cannot disguise an internal dependency.

Dependency: phases 1–3. No export-map change is needed for the barrel.

## 3. Invariant test matrix

| Hard rule | SDK test file/case | Solidity or integration evidence |
| --- | --- | --- |
| No fallback rotation authority | `test/registry.test.ts`: `rotation_requires_current_pq_key_no_fallback` | Cross-team `contracts/test/PQKeyRegistry.t.sol`: retain existing `test_noAddressCanChangeAKeyWithoutAPqSignature`; extend negative paths and review reachable account/admin/upgrade routes |
| `maxUses` is a security boundary | `test/registry.test.ts`: last allowed use, rejection at `maxUses`, rejection at `maxUses+1`; signer-state local exposure exhaustion | Existing `test_refusesPastMaxUses` plus explicit boundary/state-unchanged assertions; accepted transitions never exceed cap |
| Never lower local reservations to chain count | `test/signer-state.test.ts`: `dropped_operation_chain_read_does_not_unburn_reservation` | Browser crash/refresh tests plus a dropped/rejected live operation and subsequent authoritative chain read |
| Wallet authority is separate from anonymous note spending | `test/module-boundary.test.ts`: `ring_client_has_no_pq_wallet_internal_imports` | Aditya verifies note-witness proof authority and no FORS verification inside the spend circuit |

The handoff quotes `(1-(1-2^-a)^q)^k`, with approximately `2^-256`, `2^-160`, and `2^-121` at 1, 8, and 32 signatures for `k=32,a=8`. Preserve this as the handoff's analytic rationale, not a completed security proof of the custom implementation. The scheme revision, exposure definition, parameter choice, and cap require review. Tests/benchmarks alone do not establish the quoted security level.

## 4. On-chain binding checklist and cross-team tasks

- [ ] Pin explicit configuration: chain ID, EntryPoint version/address, account implementation/factory, validator/registry addresses, bundler, paymaster mode/configuration. No guessed deployment addresses.
- [ ] Retain all six §5.3 digest bindings and the length-prefixed Keccak encoding.
- [ ] Review exact structured payload composition with the whole team before implementation.
- [ ] Include complete canonical `userOpHash`, with chain/EntryPoint binding present and tested; reject reduced target/value/calldata-only authorization.
- [ ] Resolve epoch authority and bind context/validity fields without silently changing the frozen registry schema.
- [ ] Expose canonical on-chain digest helpers and match SDK vectors; application pages do not implement hashing.
- [ ] Restrict account validation/execution to the pinned EntryPoint as required; enforce validator caller restrictions for the selected account integration.
- [ ] Keep registry action domains and replay protection separate; tie accepted consumption to the actual validated operation. Review publicly callable `consume` for unauthorized counter consumption/front-running rather than assuming a valid signature is sufficient to permit arbitrary consumption.
- [ ] Prove registration isolation, trusted account initialization, wrong-caller rejection, old nonce/epoch/key rejection, field mutation, expiry, rotation, disable, and takeover boundaries.
- [ ] Complete a real Arc testnet UserOperation through the actual bundler and EntryPoint, with a PQ signature and matching receipt; repeat relevant negative cases and preserve rejection evidence.

Bounded contract task C1 (1.5–3 days, joint with Aditya): `contracts/src/opaque/wallet/PQKeyRegistry.sol` and existing `contracts/test/PQKeyRegistry.t.sol` (test change is explicitly cross-team/outside Manan's permitted folders). Make only agreed spec-conformance fixes; preserve the original schema unless the team explicitly approves a revision.

Bounded contract task C2 (2–4 days after ownership assignment): `contracts/src/opaque/wallet/PQValidator.sol` plus an agreed contract test file owned by the contract team, at most three files total. Factory/account integration is a separate bounded task; its paths and ownership are not invented here. Adapt the updated PDF's proposed `contracts/src/wallet/` paths to the actual repository through team agreement.

Contract owners run existing registry checks from `contracts/`:

```sh
forge test --match-path test/PQKeyRegistry.t.sol
```

Verifier, validator, and account tests must also run once their concrete test files are agreed. SDK checks remain the exact handoff commands above.

## 5. Benchmark and live compatibility tasks

**B1: Measurement runner — 1–2 days, plus deployment access/waiting.**

Proposed files: `scripts/benchmark.ts`, `test/benchmark.test.ts`, `benchmarks/arc-wallet.json`. The script does not exist yet. It consumes explicit runtime configuration and contract build artifacts supplied by the contract owner; it does not place deployment scripts outside the permitted scope.

Network: Arc testnet. Verify current endpoint, chain ID, deployed EntryPoint, account compatibility, funding requirements, and bundler/paymaster support when executing. Nothing in this plan verifies their present availability.

Measure:

1. Browser key-generation/sign/verify latency and memory, with browser/device, scheme revision, and parameters recorded.
2. Actual encoded signature bytes; assert the handoff's expected `3 + 32 + k*32*(1+a) = 9,251` at `k=32,a=8` against generated bytes.
3. Deploy a test verifier/registry or use an explicitly identified test deployment; submit a real verification/consumption transaction and record receipt `gasUsed`. Use an agreed wrapper only if isolated verification cannot otherwise be transacted; any new wrapper is a separate contract-owner task.
4. Separately measure full PQ UserOperation execution through the pinned account/validator/EntryPoint/bundler. Record transaction hash, operation hash, receipt, calldata length, gas quantities with units, and success/failure.
5. Include malformed/wrong-signature rejection evidence. Distinguish measured receipt gas from simulated estimates and isolated verifier cost from full transaction cost.

The handoff's 288 leaf/path hashes plus roots hash is not a full accounting of this implementation. Source also derives per-tree indices and computes commitments; count those and encoding/memory overhead when explaining measurements. The approximately 150k calldata-gas estimate and 30M block comparison remain unverified source estimates, not reported measurements.

Proposed command, runnable only after B1 is implemented and configuration/artifacts are supplied:

```sh
cd packages/pq-wallet
node scripts/benchmark.ts --network arc-testnet --output benchmarks/arc-wallet.json
```

Document the exact environment/config contract in the runner and README. Obtain test funding and deployment authority through the contract owner; do not print funding keys. Unit tests validate measurement output/receipt interpretation, not live compatibility.

**B2: G2 end-to-end runner — 1–2 days after account infrastructure is available.**

Files: `scripts/g2-live.ts`, `test/g2-runner.test.ts`, `benchmarks/g2-evidence.json`.

Create/register a test account, submit a PQ-authorized operation, test replay/mutations, exercise lifecycle transitions and dropped-operation reconciliation, and capture actual bundler/EntryPoint results. Timelock boundary coverage is practical locally; do not shorten the production 30-day constant to make the demo pass. Record which timelock behavior is locally tested versus observed live, and whether G2 reviewers require further live evidence.

## 6. Gate G2 readiness

Current evidence status: **G2 not demonstrated — mock integration only; no final PQ authority claim.** This is the permitted integration posture, not a claim that a conforming mock is already implemented.

| Requirement | Current evidence | Remaining blocker |
| --- | --- | --- |
| Primitive correctness | Draft code; historical typecheck report | Fresh dependency setup, tests, review, shared vectors |
| Replay/mutation rejection | Some Solidity test source exists; not run here | Complete operation/caller/epoch/expiry coverage and live evidence |
| Safe signer lifecycle | No SDK lifecycle/storage code | Atomic durable reservations, crash/retry/refresh tests |
| Registry lifecycle | Contract and tests exist | TS parity, boundary checks, deadline/takeover decisions, contract review |
| Actual PQ validator/EntryPoint/bundler path | No runnable path established in this inspection | Assigned integration owner, configuration, implementation, live receipts |
| Measured feasibility | Gas probe source exists | Real browser and Arc testnet measurements for the selected scheme |

Do not label the wallet LIVE solely because primitives typecheck, unit tests pass, or a standalone verifier transaction succeeds. Gate pass requires replay/mutation, state lifecycle, and the actual PQ validator/EntryPoint/bundler path to work live, with precisely stated evidence gaps.

## 7. Handoff package

**H1: Consumer instructions and demo entry point — 0.5–1 day.**

Files: `README.md`, `scripts/create-register.ts`, `test/create-register.test.ts`.

**H2: Cross-language fixtures — 0.5–1 day.**

Files: `scripts/generate-vectors.ts`, `test/fixtures/authority-vectors.json`, `test/vectors.test.ts`. Contract owners copy or consume the approved fixtures in their own test location as a separate dependency. Use clearly synthetic test seeds only; never record live secret material.

Deliver:

- Package root API, unchanged frozen public types, safe state/error examples, and conforming mock.
- Registry/validator ABI references and build provenance from contract owners; no unilateral shared-types edits.
- Scheme revision/parameters, primitive and authority vectors, and reproducible commands.
- Actual gas/browser results and G2 evidence, with estimates/mocks identified.
- Chain, registry, validator, EntryPoint, account/factory addresses and versioned configuration; bundler/paymaster configuration without credentials.
- Create/register script and expected output, one failure example, configuration requirements, and transaction-confirmation semantics.
- Explicit limitations: browser storage loss has no recovery promise; no arbitrary backup rollback guarantee; no compromised-origin protection claim; no claim that Arc consensus is PQ; no wallet FORS inside anonymous note spending.

Proposed create/register command after H1 is implemented:

```sh
cd packages/pq-wallet
node scripts/create-register.ts --network arc-testnet
npx tsc --noEmit
node --test test/*.test.ts
```

Budget: roughly 12–20 focused SDK engineering days for implementation, tests, and documentation, plus 2–4 days for measurement/live runners, any browser-harness setup, separately assigned contract work, and deployment waiting. Re-estimate after primitive tests and the first verifier benchmark; this is security-sensitive custom cryptography, so unresolved scheme defects may materially change the effort.

## 8. Open decisions for Aditya and the team

These decisions block the affected task, not tests for existing primitives. The original handoff remains the baseline while they are unresolved.

1. **Epoch compatibility:** how does the frozen SDK obtain authoritative `keyEpoch` without adding it to §5.2's registry? Is a reviewed epoch binding possible within existing semantics, or does the team need an explicit spec/ABI revision? No constant/stale/local-only epoch masquerading as chain authority.
2. **Canonical payload:** approve the full operation and typed rotation/disable encodings, action/registry domain binding, replay nonce, validity fields, and corresponding Solidity helper. Preserve every §5.3 field and perform the whole-team digest review.
3. **Exposure versus replay count:** define dropped/changed operation behavior when local reservations exceed accepted `useCount`. Pin scheme exposure rules, `maxUses`, and rotation/disable headroom; enforce both local security capacity and chain replay rules.
4. **Rotation deadline:** specify behavior before, at, and after `rotationDeadline`; determine whether lifecycle actions remain possible and which timestamps reset on ordinary rotation or takeover.
5. **Disable interactions:** specify whether rotation during a pending disable carries or clears the timer, and how repeated disable requests behave. The existing code is not sufficient authority for an unspecified policy.
6. **Takeover API:** preserve precommitted-next-key takeover after 30 days, but decide how it is invoked without adding a frozen `PqWallet` method. If an interface change is required, escalate to protocol-types owners.
7. **Account and validator ownership:** assign account/factory, validator, registration binding, shared ABI/test updates, deployment funding, and bundler integration. Preserve joint review of `PQKeyRegistry.sol`.
8. **Configuration and security review:** agree deployed versions/providers and the precise FORS+C variant, parameters, exposure rationale, and review owner. A benchmark pass cannot stand in for scheme security validation.

Immediate authorized implementation work after this planning task: T1a, followed by regression-driven T1b. Do not begin registry branches with unresolved semantics or silently migrate the schema to the updated PDF.

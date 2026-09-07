# nonce0 x Project X — integration design

**Status:** design. No implementation implied by this document.
**Written:** 2026-09-07. **Deadline:** Sept 16. **Nine days.**

Read [integration-brief.md](integration-brief.md) first for the verified findings this
design assumes and does not re-argue.

---

## 1. The thesis

> Your admin key is already public — you just haven't looked on the chain where it
> leaked. nonce0 finds it. PQGuard stops the break from being a theft. And when you
> move, **where you move to is the whole problem**, because a fresh address is safe for
> exactly one transaction, and ten million people escaping at once is the largest
> deanonymization event in the history of the chain. Project X is the only destination
> that is permanently post-quantum and doesn't publish the map on the way out.

**diagnosis → treatment → destination.** Each third is a different sponsor's technology
and none of the three works alone. That is the merge's justification, and it is the
sentence to say on camera.

---

## 2. The structural decision: two lanes

The single most important thing in this design. Project X's on-chain lattice ring
verifier is, by its own spec, "the single hardest, highest-risk engineering task in the
whole build," with no EVM precedent and a closest comparison burning 1.9M–8.8M gas for a
*single signer with no ring aggregation*. nonce0's scanner spine does not exist beyond
repo mode.

**Nine days does not fit both on one critical path.** So they do not share one.

| | Lane A — the spine | Lane B — the destination |
|---|---|---|
| **Owns** | scanner, PQGuard contracts, x402 API, MCP, CRE gate, Arc leg | lattice ring verifier, range proof, relay mesh, pool |
| **Depends on** | nothing in Lane B | nothing in Lane A |
| **Demoable without the other** | yes, against a mock pool | yes, as a standalone pool |
| **Integrates** | day 8, by changing one address | day 8, by publishing one address |

Lane A must be recordable end-to-end **without a single line of Lane B existing**. If
Lane B lands, the demo swaps a constant. If it does not, the demo says "the destination
interface is implemented against a fixed-denomination mock; the lattice verifier is
Lane B's deliverable" — and every sponsor submission still qualifies.

This is not pessimism about Lane B. It is the same doctrine that picked Uniswap over
higher-value tracks in `sponsor-plan.md`: never let the riskiest dependency be load
bearing for more than one deliverable.

---

## 3. The seam

One interface. Three valid implementations: a mock pool, an existing pool (Railgun,
Tornado-shaped), and Project X.

```solidity
interface IShieldedDestination {
    /// @param noteCommitment  H(secret, nullifier, denomination) — opaque to the guard
    /// @param denomination    MUST be one of the pool's fixed denominations
    function deposit(bytes32 noteCommitment, uint256 denomination) external payable;
    function denominations() external view returns (uint256[] memory);
}
```

Migration is **not a new contract**. It is `PQOwnableAdapter.execute` with the target
frozen at arm time, which `pqguard-spec.md` §4 already does:

```
payload = abi.encode(target, selector, keccak256(callData), value, deadline)
digest  = keccak256(abi.encode(
              PQ_DOMAIN, block.chainid, address(core),
              account, schemeId, useCount, keccak256(payload)))
```

`target` and `keccak256(callData)` are already bound into the digest, so:

- the destination **cannot be redirected** after arming — a different pool or a
  different note is a different digest, and the PQ signature does not verify;
- **front-running gains nothing** — the armed call is public but only executable with a
  signature the adversary cannot forge;
- the ECDSA key is used **only at arm time, while it still works**. After arming, no
  ECDSA signature appears anywhere in the path.

The only deliberate change to the existing spec: §6.1 defines `arm()` as short-lived
(single block or short deadline). Migration wants **arm now, execute at Q-day**. Long
deadlines are safe precisely because the digest pins the target — but make the change on
purpose, and cap it (e.g. 10 years) rather than leaving it unbounded.

### 3.1 Where keccak256 happens — resolved

Node has **no keccak256** (verified: only NIST SHA3, different padding). It does have
SHA-256, SHA3, SHAKE128 and **SHAKE256 with arbitrary output length** (verified working).
So:

| Operation | Where | Why |
|---|---|---|
| FORS+C keygen and signing | **CLI, natively** | hash-based, SHAKE256, zero dependencies |
| Note commitment | **CLI, natively** | the pool defines it over SHAKE/SHA — do not define it over keccak |
| The PQGuard digest | **on-chain, via `eth_call`** | it is keccak, and it must match what the contract computes anyway |

Add one view function and the CLI never needs keccak:

```solidity
function digestFor(address account, address target, uint256 value,
                   bytes32 calldataHash, uint64 deadline)
    external view returns (bytes32);
```

The CLI calls it, signs the returned 32 bytes with the PQ key locally, and submits.
**Design rule: never define a commitment the CLI must compute over keccak256.** Choosing
SHAKE256 for the note commitment costs the pool nothing and keeps the scanner
dependency-free. Decide this before writing the pool, not after.

---

## 4. The scanner-native feature: ring integrity

The highest value-per-hour item in the merge. It needs **no lattice crypto**, ships in
Lane A, and works against Railgun and Tornado today.

> A ring of 8 whose members' keys are already exposed on some chain does not have an
> anonymity set of 8. A quantum adversary derives those private keys, rules those
> members out, and the ring collapses to the members still hidden.

```
nonce0 ring 0xPool --size 8
  ring members reported     8
  keys already exposed      6   (4 mainnet, 2 testnet-only)
  effective anonymity       2   ← what a quantum adversary actually faces
```

Computed entirely from the existing exposure oracle plus authority traversal — the same
shape as the v4 hook ecosystem scan: same engine, new target set.

**State it as a lower bound, not a measurement.** It captures anonymity lost to key
exposure. It does not capture anonymity lost to timing, amount correlation, or common
funding. Effective anonymity is *at most* this number, never more.

This is also the honest answer to "why does a scanner belong in a privacy project": the
pool cannot measure its own anonymity set, because doing so requires cross-chain
exposure data that only the scanner has.

---

## 5. Sponsor decisions

Five tracks, $16,667, nine days. Entering five is how you ship none of them well.

| Sponsor | Pool | Verdict | Reasoning |
|---|---|---|---|
| **Hedera** | $6,000 | **ENTER** | Largest pool, and tiering-as-access-control is the strongest "removing it breaks the product" argument of any track: a kill-chain report on an unpatched protocol *is* an attack plan. Independent of both lanes' risk. |
| **Chainlink** | $1,000 | **ENTER** | "Up to 2 teams" is the best odds-per-dollar on the board. The eligibility gate is genuinely load-bearing: who may enter a shielded pool is the one question a privacy pool cannot answer in public. Independent of the lattice verifier. |
| **Arc / Circle** | $1,667 | **ENTER** | The migration settles in USDC; conditional-release-after-policy-check *is* their stated requirement, with no invented DeFi. Frontend and backend already exist. Marginal cost is the lowest of the five. |
| **The Graph** | $5,000 | **ENTER — but via the AI Tooling pivot, not Substreams** | `sponsor-plan.md` §4.1's own documented fallback: same sponsor, same pool, and the MCP server was already build step 11. A Substreams module in Rust is 2 days on the critical path for a dataset the RPC oracle already produces as a boolean. Take the pivot on day one deliberately rather than at 3am on day seven. |
| **Uniswap** | $3,000 | **DROP** | The painful one. It is the lowest-risk track on the board, but under the merged thesis the v4 containment hook is the only component that serves no part of diagnosis→treatment→destination. It costs v4-periphery, HookMiner, a hook contract, the ecosystem scan, plus an external form — roughly 1.5 days for a component the narrative no longer needs. Keep `FEEDBACK.md`; it costs nothing and is honest feedback either way. |

**Entered: 4 tracks, $13,667.** Dropping Uniswap buys back the day that makes the other
four finishable.

> Caveat: the Graph AI Tooling track's existence and its $5,000 pool come from
> `sponsor-plan.md` §4.1, not from a source I verified. **Confirm it on the prize page
> before betting a day on it.** If it does not exist, the choice is Substreams or drop
> The Graph, and that decision belongs on day one.

---

## 6. Nine days, with camera days

The rule: **nothing is recorded for the first time on the last day.** Every day that
produces something demoable records it that evening, rough. Polish later, but never
arrive at day nine with no footage.

| Day | Deliverable | Record that evening | If it slips |
|---|---|---|---|
| **1** Sep 8 | `PQKeyRegistry` + `PQGuardCore` + `MockVerifier`; fuzz rotation, `useCount`, exhaustion. Add `digestFor` view. | — | Nothing downstream moves. This is the one day with no slack. |
| **2** Sep 9 | `PQOwnableAdapter` end to end against a real OZ `Ownable`. FORS+C verifier if it comes cheap, else stay on the mock. | adapter install, 3 transactions | Stay on `MockVerifier` all week. The before/after exploit is equally convincing. |
| **3** Sep 10 | **CRQC fork harness.** Oracle returns the private key for any exposed pubkey; identical exploit before and after install. | **THE DEMO — record it properly** | If day 3 slips, cut a sponsor, not this. |
| **4** Sep 11 | Chain mode: RPC client with disk cache, EIP-1967 slots, authority traversal, exposure oracle across 8 chains. | the scan finding a real exposed admin key | Fall back to repo mode + a known address. Cache responses to disk the first time. |
| **5** Sep 12 | x402 gateway, three tiers, HCS disclosure topic, monitor agent. | **the paid request settling** | Hedera is the biggest pool — protect this day. |
| **6** Sep 13 | MCP server (`nonce0 mcp`), non-paying. Graph AI Tooling submission. | assistant running a scan in natural language | Graph submission drops to whatever the MCP server already does. |
| **7** Sep 14 | Chainlink CRE confidential workflow gating migration eligibility + Arc USDC settlement leg. | CLI simulation of the enclave check | If CRE's toolchain fights back, Arc still stands alone; drop Chainlink, keep Arc. |
| **8** Sep 15 | `migrate --arm` / `--execute` against the mock pool. Swap in Lane B's address if it landed. `nonce0 ring`. | **the full chain: scan → arm → break → denied → migrate** | Mock pool is the plan, not the fallback. Lane B landing is upside. |
| **9** Sep 16 | Four READMEs, videos (Graph ≤4 min, Hedera ≤5 min, Arc + diagram), submission forms. | assemble, do not shoot | Budget the whole day. It is always longer than it looks. |

Lane B runs Sept 8–15 in parallel, owned by whoever is not on Lane A, and publishes one
address on day 8.

---

## 7. Cut list

Deleted from combined scope. Each was a real candidate; each loses to the calendar.

- **The Substreams module and subgraph.** Replaced by the AI Tooling pivot. Keep any code written as a contributed artifact; do not delete the directory, just stop feeding it.
- **`PQContainmentHook` and the v4 ecosystem scan.** With Uniswap dropped, this goes. It is the best thing on this list and the most painful cut.
- **The relay mesh** as a demo requirement. It is Lane B, and network-origin privacy is not visible on camera in a way a judge can verify in five minutes. Keep it in the threat model as the entry-side protection the pool needs; do not budget days for it in Lane A.
- **The `simulate` tier.** Already cut: it needs `forge` on a host that has none.
- **WOTS+C, SLH-DSA, ML-DSA, `PQSafeGuard` and the appended-envelope path, recovery beyond a timelock stub, SARIF, CBOM.** All previously on the cut list; nothing here rescues them.
- **EIP-7702 as a migration destination.** Not a scheduling cut — it is *wrong*. See the brief.

---

## 8. Honesty guardrails

This project touches quantum resistance, anonymity sets, and TEEs. Every one of those is
a place a competent judge probes, and the credible parts of the project go down with an
overclaim. Say these, in these words:

| Claim to avoid | Say instead |
|---|---|
| "Quantum-secure" | "The **authority path** is post-quantum. The wallet layer is still ECDSA — that is an Ethereum-wide gap and not one we fix." |
| "Anonymity set of 8" | "Ring size 8, a proof-of-concept number. Our own tool reports the **effective** anonymity, which is lower." |
| "TEE-attested" (simulated) | "Attestation is **simulated** in this build; the hardware path is unchanged but unverified here." |
| "We broke ECDSA" | "Our quantum adversary is an **oracle that already holds the private key**. We are not claiming a break — we are showing what happens after one." |
| "Migration is anonymous" | "It severs **deposit → spend**. The deposit itself is public. Anonymity lives entirely in the ring at spend time." |
| "Effective anonymity is 2" | "**At most** 2 — this measures anonymity lost to key exposure only, not timing or amount correlation." |
| "We protect your funds" | "PQGuard can only ever **deny**, never grant. The worst case if it malfunctions is your admin calls get stuck and you use the recovery timer." |

And the one from `sponsor-plan.md` that still governs: you cannot restore privacy for
anything already on chain, and you cannot make an immutable pairing verifier sound.

---

## 9. Open questions — do not resolve unilaterally

1. **Who is on which lane?** This design assumes Lane B has people who are not Lane A. If
   the same person owns both, Lane B does not exist and the mock pool is the final
   destination — which is still a coherent submission, but the pitch changes from
   "we built it" to "we defined the interface and built against it."
2. **Does The Graph's AI Tooling track exist at the stated $5,000?** Sourced from our own
   plan doc, unverified. Confirm on the prize page **day one**. It decides whether 2 days
   of Rust go on the critical path.
3. **Is dropping Uniswap acceptable?** $3,000 and the lowest-risk track on the board,
   dropped for narrative coherence and one day of calendar. Defensible either way — but
   if it stays, something else in §6 must go, and it should be Chainlink.

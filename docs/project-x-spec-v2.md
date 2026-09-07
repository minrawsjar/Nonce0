# Project X — Technical Specification v2

**Event:** ETHGlobal ETHOnline 2026 (Sept 4–16, async, 4-person team)
**Status:** Locked direction. This supersedes all earlier Project X and PQGuard specs. Everyone should build from this document.

**Open item — Arc scope:** the intent-based settlement feature (§9) is the only Arc-side piece that's locked. Everything beyond that is explicitly open — see §9.4 for the bar any new Arc idea has to clear before it gets added (it has to emerge from the wallet/ring/mesh/Graph stack already here, not be reverse-engineered from Arc's prize rubric). Don't start building a second Arc feature without checking it against that bar first.

---

## 1. Overview

Project X is a private payment protocol where the key that authorizes a spend is post-quantum secure today, sender/amount privacy comes from a small on-chain ring signature verified with pure hashing (no lattice math, no ZK/SNARK/STARK proof system anywhere in the trust path), and network-origin privacy comes from a relay mesh. Payments can also be submitted as confidential *intents* that wait for the best available privacy conditions before executing.

**One-line pitch:** *A payment protocol where the key that authorizes your spend is already quantum-safe, sender/amount privacy comes from pure hashing instead of unbuilt cryptography, and your payment can wait to execute until the network's anonymity conditions are actually strong.*

**Why this version, not the original lattice-based design:** the original design needed a custom Ring-LWE (lattice) signature verifier on EVM — no such verifier exists anywhere, and it was independently flagged as the single highest-risk task in a 12-day build. This version replaces that primitive with hash-based signatures (the same family used in SPHINCS+/FORS), a well-trodden category of post-quantum cryptography with dramatically lower implementation risk.

---

## 2. Goals / Non-goals

**In scope:**
- PQ wallet (ERC-4337) using a hash-based signature as the sole signer
- Small anonymity ring (~8 members) for sender/amount privacy, verified fully on-chain, no proof system
- 3-hop relay mesh for network-origin privacy
- Graph-powered decoy selection (ring) and hop selection (mesh) — genuine functional dependencies, not dashboards
- One Chainlink CRE Confidential Workflow doing two jobs: compliance/eligibility gating, and confidential intent execution
- "Intents that wait for the best privacy moment" — Arc/USDC settlement, with Gateway handling cross-chain sourcing/dispersal

**Explicitly out of scope:**
- Any SNARK/STARK proof system in the spend-authorization path (the standard way to make such proofs cheap on EVM — e.g. RISC Zero's Groth16 wrapping — reintroduces an elliptic-curve dependency at the exact point meant to be quantum-proof; RISC Zero's own docs confirm that wrapping step is not quantum-safe)
- Large/production-scale anonymity sets — ring stays small, labeled PoC
- A "your key is already exposed" reveal feature — cut. Any address that has sent a transaction already has an exposed public key via `ecrecover`; not a novel finding
- Non-USDC payments — Arc is stablecoin-native and Gateway is USDC-specific; a swap leg would add its own privacy leak (visible swap size/timing) for little payoff
- ENS — dropped. Not part of this build.
- Retrofitting or scanning other protocols
- A 5th sponsor (1inch/SwapVM or otherwise) — holding at 3: Arc, Chainlink, Graph

---

## 3. Threat model

| | Detail |
|---|---|
| Hides | Which ring member signed; the amount; sender's network origin (IP); intent parameters (recipient, amount, timing) before execution; the compliance-check input |
| Does not claim to prevent | A global passive network adversary; simultaneous compromise of all 3 relay hops; weak OPSEC |
| Trust assumption for fund safety | None — spend authorization is a hash-based signature checked directly on-chain; no relay, enclave, or operator sits in that path |
| Trust assumption for anonymity | The ring's OR-proof mechanism (§6) and the relay mesh's hop diversity (§7) |
| Trust assumption for intent execution | The Chainlink CRE TEE holds intent parameters confidentially until the trigger condition fires |
| Quantum-specific claim | The key an attacker needs to forge a spend is hash-based — no elliptic curve or lattice assumption anywhere in that path |

---

## 4. Full architecture

```
PQ Wallet (§5) ── FORS+C hash-based key, ERC-4337 (PQValidator), PQKeyRegistry
     │
     ▼
Intent submission (§9) ── confidential (recipient, amount, deadline) held in
     │                     the Chainlink CRE enclave, not the public mempool
     ▼
Chainlink CRE Confidential Workflow (§10) ── compliance check AND
     │        privacy-timing check (reads Graph-indexed ring/mesh health)
     ▼
Ring-signed payment (§6) ── ring ~8, hash-based, verified directly on-chain
     │        Ring membership drawn via Graph-powered decoy selection (§8.1)
     ▼
Relay mesh (§7) ── 3 hops, batched + randomly delayed, TEE-hosted
     │        Hops chosen via Graph-powered hop selection (§8.2)
     ▼
Settlement (Arc/USDC) ── Gateway draw #1 sources USDC from sender's unified
     │                    cross-chain balance at the exact moment of execution
     ▼
Recipient ── Gateway draw #2 (optional) redistributes to recipient's chain
```

---

## 5. PQ Wallet

### 5.1 Signature scheme

- **FORS+C** — a few-time, hash-based signature scheme, same family as the FORS component of SPHINCS+/FIPS 205. Chosen over WOTS+ (strictly one-time, catastrophic on key reuse) because a few-time scheme degrades gracefully rather than catastrophically if `useCount` is mismanaged.
- Underlying hash function: Keccak256, to match native EVM opcode cost (no external precompile needed for hashing).
- Parameters (to be benchmarked, not assumed): FORS typically uses `k` trees of height `a`, trading signature size against forgery resistance. Team must pick `(k, a)` early and benchmark actual verification gas before committing — do not assume a parameter set works without measuring it on a testnet.

### 5.2 `PQKeyRegistry` (per-account state)

```solidity
struct PQKeyState {
    bytes32 pkCommitment;       // hash commitment to the active FORS+C public key
    bytes32 nextCommitment;     // hash-chained commitment to the pre-registered next key
    uint64  useCount;           // signatures issued under pkCommitment so far
    uint64  maxUses;            // hard cap before forced rotation
    uint64  rotationDeadline;   // timestamp by which rotation must occur
    uint64  disableAfter;       // 0 = active; else timelocked disable timestamp
}
```

- `useCount` is monotonic and checked on every verification; exceeding `maxUses` invalidates further signatures under that commitment.
- `disableAfter` is the escape hatch: a 30-day timelock initiated on suspected compromise. Once elapsed, the key is permanently disabled and only `nextCommitment` can take over.
- **Rotation must be authenticated by the current PQ key, never a fallback.** If any non-PQ path (e.g., a legacy ECDSA guardian) could rotate `pkCommitment`, a quantum adversary holding that fallback key could hijack the wallet's PQ identity — this would defeat the wallet's entire purpose. No exceptions to this rule.

### 5.3 Digest construction

Every signed action commits to:

```
digest = keccak256(
    PQ_DOMAIN,           // domain separation tag, prevents cross-protocol replay
    chainId,             // prevents cross-chain replay
    walletAddress,        // binds to this specific account
    schemeId,             // prevents downgrade-replay (e.g. FORS+C sig replayed as if WOTS+C)
    useCount,             // one-time-index enforcement, prevents replay of a used signature
    keccak256(payload)    // the actual call data being authorized
)
```

Every field is load-bearing — dropping any one reopens a replay class. This must be reviewed by the whole team before implementation starts, not just the person writing the verifier.

### 5.4 ERC-4337 integration

- `PQValidator` implements the ERC-7579/4337 validator interface. The signature field in a UserOperation is arbitrary bytes, so it carries the FORS+C signature directly — no reinterpretation of existing 4337 infrastructure needed.
- Validator calls into `PQKeyRegistry` to check `useCount < maxUses`, `disableAfter == 0 || block.timestamp < disableAfter`, and verifies the FORS+C signature against `pkCommitment` using the digest in §5.3.

### 5.5 Cost estimate

Hash-based verification is pure Keccak evaluation — no elliptic-curve or lattice arithmetic — so gas cost scales with the number of hash evaluations FORS+C requires for the chosen `(k, a)`. Benchmark early; do not hand-wave this into the pitch deck as "cheap" without a number.

---

## 6. PQ Ring Signatures

### 6.1 What's being proven

Statement: *"I possess a valid FORS+C signature under one of the 8 public key commitments in this ring, over this specific payment digest, without revealing which commitment."*

This is fundamentally different from a Sigma-protocol OR-proof (used for Schnorr/EdDSA ring signatures) because FORS+C verification isn't algebraic — it's "reveal the correct hash preimages according to a public challenge." Standard OR-composition techniques (Cramer–Damgård–Schoenmakers) assume Sigma-protocol structure and don't directly transfer.

### 6.2 Recommended construction: MPC-in-the-head

- The Picnic/KKW/Banquet family: real, published, NIST-round-reviewed constructions proving statements about hash/symmetric-key relations in zero knowledge, using only symmetric primitives — consistent with the rest of the stack's "no lattice, no elliptic curve" posture.
- Statement to encode in the MPC-in-the-head circuit: "I know a FORS+C secret key whose public commitment matches ring slot `i`, for some `i` in `[0,7]`, and a valid signature over `digest` under that key."
- Witness: the actual FORS+C secret key material and the index `i` (kept hidden).
- Public inputs: the 8 commitments, the digest, the proof itself.

### 6.3 Mandatory day 1–2 spike

Before any other component depends on this:
1. Implement the above statement in an existing MPC-in-the-head proving library.
2. Measure proof size and generation time for the real FORS+C parameters chosen in §5.1.
3. Measure on-chain verification gas for that proof.
4. Go/no-go decision, documented, before Day 3.

**Fallback if the spike fails:** ship a non-anonymous, single-signer path for the demo — fully PQ-secure, just not anonymous — and present the ring as designed-but-not-proven-in-time. Do not silently downgrade the pitch; state it plainly in the README.

### 6.4 Double-spend prevention

Each spend derives a **linkability tag** (nullifier) deterministically from the signer's secret key and the payment context, without revealing which ring member produced it:

```
nullifier = H(secretKeyMaterial, paymentContext)
```

The contract maintains a `mapping(bytes32 => bool) spentNullifiers`. A ring-signed payment is rejected if its nullifier has been seen before. This is standard for linkable ring signatures — verify this specific derivation is compatible with whatever MPC-in-the-head construction is chosen in §6.2; the nullifier computation likely needs to be part of the same circuit so its correctness is proven alongside ring membership.

### 6.5 Cost and size — explicitly unknown

MPC-in-the-head proofs are historically larger than SNARKs (tens of KB, not hundreds of bytes) though smaller than raw STARKs for small circuits. Do not put a number in the pitch deck until §6.3's spike produces one.

---

## 7. Relay Mesh

### 7.1 Topology

- 6 independent relay nodes, no operator grouping. Every payment uses a fixed-length 3-hop path drawn from this pool via the Markov chain described in §8.2 — not random, not deterministic top-3.
- Each hop: receives an encrypted, ring-signed payment; holds it for a fixed batch window (not adaptive); forwards with a randomized per-item delay within that window; the final hop submits to L1 where the ring signature is verified on-chain (§6).
- Relay nodes run inside TEEs. Their job is purely batching + delay + multi-hop forwarding — they never touch signature verification, so a compromised relay cannot forge or approve a spend, only potentially deanonymize network origin if enough hops collude (see threat model, §3).
- Path *length* stays fixed at 3 hops (2 transitions) — this is a deliberate non-goal, not a missed feature. The classic Crowds protocol (§8.2) uses a variable-length forward-or-stop chain; adopting that here would reopen a scoping decision already settled to keep the build tractable.

### 7.2 Message format (draft)

```
RelayMessage {
    encryptedPayload: bytes      // the ring-signed payment, encrypted hop-to-hop
    hopIndex: uint8              // which hop this message currently is at
    batchId: bytes32             // groups messages released together
}
```

### 7.3 Hop encryption

Use a PQ-hybrid handshake between consecutive hops — the same shape as Signal's PQXDH (X25519 + ML-KEM combined), not plain classical ECDH. This closes the one remaining "is the mesh actually fully PQ" gap in the design. Lower priority than §6; ship with classical ECDH for the MVP if time runs short, and state that explicitly as a scoped, known gap in the README rather than silently omitting it.

### 7.4 TEE attestation

If real hardware TEE attestation (Intel TDX/SGX or equivalent) isn't practical in the build window, simulate attestation and say so explicitly in the README — do not imply real attestation if it isn't there.

---

## 8. Graph Integration

**Hard constraint for both subgraphs below:** index the *eligible pool* and aggregate statistics only. Never index which specific ring member or relay hop was used for a given payment — that would itself be a privacy leak, defeating the exact thing the ring signature and relay mesh exist to hide.

### 8.1 Ring decoy selection

**Why it matters:** poor decoy selection is a documented, real way ring-signature systems get deanonymized — Monero's early history includes exactly this failure mode via weak mixin selection and output-age analysis.

**Substreams module** — input: raw chain events; output: enrollment events (new `pkCommitment` joining the ring-eligible pool) and per-member usage counts (aggregate, not per-payment linkage).

**Subgraph schema:**

```graphql
type RingMember @entity {
  id: ID!                  # pkCommitment
  enrolledAt: BigInt!
  timesUsedInRing: Int!    # aggregate count only, never which ring/payment
  lastUsedAt: BigInt
}

type RingPool @entity {
  id: ID!                  # singleton or per-epoch
  poolSize: Int!
  avgMemberAge: BigInt!
  freshnessScore: BigInt!  # derived metric, see §9.2
}
```

**Selection algorithm (wallet client, at ring-construction time):** query `RingMember` entities, exclude anything used above a reuse-frequency threshold, weight toward diversity in `enrolledAt`, sample 7 decoys plus the real signer.

### 8.2 Relay hop selection — Markov chain over the node pool

**Why it matters:** naive/predictable hop selection is the same class of failure Tor's own path-selection algorithm defends against — an adversary controlling or correlating multiple hops on one path can deanonymize network origin. With 6 independent relay nodes and no operator grouping to lean on, path construction is modeled as a short-run Markov chain over the node pool — the same formal structure used to define and analyze the Crowds anonymity protocol (Reiter & Rubin), a well-established academic precedent for probabilistic multi-hop path construction, not a novel or unproven technique.

**Substreams module** — indexes relay-node liveness/participation events and per-node batching/usage statistics.

**Subgraph schema:**

```graphql
type RelayNode @entity {
  id: ID!                       # nodeId, one of 6
  reliabilityScore: BigInt!     # % of recent batch windows successfully served
  batchOccupancy: BigInt!       # avg # of other messages batched alongside this node's traffic recently
  recentSelectionCount: Int!    # how often this node has been picked recently, aggregate only
  lastSeenAt: BigInt!
}
```

**State space:** `S = {N1, N2, N3, N4, N5, N6}` — the 6 relay nodes, nothing more compound than that.

**Initial distribution (hop 1):**

```
P(hop1 = j) ∝ batchOccupancy(j) / (1 + recentSelectionCount(j))     for j passing the reliability floor
```
normalized over all eligible `j`.

**Transition matrix (hop k → hop k+1):**

```
P(i → j) = 0                                                         for j = i (no repeated node in one path)
P(i → j) = 0                                                         for j below the reliability floor
P(i → j) ∝ batchOccupancy(j) / (1 + recentSelectionCount(j))         otherwise, row-normalized to sum to 1
```

**Selection algorithm (client, at send time):**
1. Query `RelayNode` entities from the subgraph.
2. Filter out anything below the reliability floor.
3. Draw hop 1 from the initial distribution.
4. Draw hop 2 from row `P(hop1 → ·)`.
5. Draw hop 3 from row `P(hop2 → ·)`.

Deliberately not deterministic top-3: always picking the objectively "best" 3 nodes would just create a new, guaranteed static pattern instead of a randomized one — exactly the failure mode `recentSelectionCount` exists to prevent.

**Bonus, not required for the MVP:** this same transition matrix can be used to compute a formal anonymity/traceability estimate (via mixing time or steady-state distribution) instead of the ad hoc `freshnessScore` currently feeding §9.2's trigger condition — worth exploring if time allows, since it upgrades that check from a heuristic to something with real probabilistic meaning behind it.

**Why this clears Graph's composability bar:** a standardized, reusable schema over a public pool — not one subgraph indexing only this app's own settlement events, which was already flagged early on as too weak on its own.

---

## 9. "Intents that wait for the best privacy moment" (Arc)

Designed to only make sense because of this specific privacy stack — not a generic conditional-payment feature imported from a DeFi intents system (UniswapX/CoW Swap-style intents optimize for price/MEV; this one optimizes for privacy quality).

### 9.1 Intent structure

```solidity
struct PaymentIntent {
    address recipient;
    uint256 amount;
    uint64  deadline;
    uint16  minFreshnessScore;   // minimum RingPool.freshnessScore to fire early
}
```

Submitted encrypted to the Chainlink CRE enclave — recipient, amount, and deadline are not visible in the public mempool before execution, preventing front-running or snooping on an intent before it fires.

### 9.2 Trigger condition (evaluated inside the CRE enclave)

```
fire = complianceCheck(recipient) AND (
    graphQuery(RingPool.freshnessScore) >= intent.minFreshnessScore
    OR block.timestamp >= intent.deadline
)
```

Both the recipient's compliance status and the intent's parameters are the sensitive inputs justifying the TEE. `freshnessScore` itself is public data (§8.1) — it's read *inside* the enclave as part of evaluating a confidential decision, which is different from an earlier, since-cut design where ring-health lived in the CRE workflow as its own gate (public data doesn't need a TEE on its own).

### 9.3 Gateway multi-step settlement

- **Gateway** gives a USDC holder a single, unified balance across multiple chains — no need to pre-fund Arc specifically.
- **Draw #1 (sender side, privacy-critical):** when `fire` evaluates true, Gateway pulls the exact amount from the sender's unified balance and settles on Arc *in the same moment the payment executes*, never pre-staged. A separate earlier "bridge to Arc" transaction would itself be a correlatable event linking sender identity to payment timing, undermining the point of the timing-based intent.
- **Draw #2 (recipient side, optional):** if the recipient's home chain isn't Arc, a second Gateway draw redistributes settled USDC there after settlement — lower stakes, it's the recipient's own funds post-settlement.
- **Verify before building:** Gateway's exact attestation/draw latency isn't confirmed against Circle's docs. If it isn't fast enough to feel simultaneous with settlement, draw #1 becomes its own visible step again, undercutting the timing-privacy argument. Check this in week 1, not week 2.
- **App Kits:** use for the intent-submission/payment frontend — satisfies "workflows using App Kits where relevant" directly, low risk.
- **StableFX:** gated behind institutional KYB/AML approval, not usable in this build. One roadmap line in the pitch only; no working integration claimed.

### 9.4 Arc scope is open

Any additional Arc-side idea must pass the same bar this feature passed: it has to emerge from something this specific stack already has (the wallet, the ring, the mesh, the Graph signal) — not be reverse-engineered from Arc's prize rubric. If a new idea doesn't need those pieces to make sense, it's probably generic and doesn't belong here.

---

## 10. Chainlink CRE — merged workflow

One Confidential Workflow, two jobs, both genuinely requiring confidentiality:

1. **Compliance/eligibility check** — evaluates a sensitive credential/flag inside the enclave, gating settlement. Satisfies Chainlink's literal track requirement (process a sensitive input inside the enclave, contribute to a state change) and is sound design for any privacy product operating in the real world — a shielded system with zero compliance mechanism is exactly the profile that gets sanctioned (see Tornado Cash's OFAC listing as the cautionary precedent).
2. **Confidential intent execution** (§9.2) — holds intent parameters confidentially and evaluates the combined trigger condition.

**Note on a cut design:** an earlier draft had a standalone "ring-health risk gate" as the workflow's second job. That was removed — ring-health data is public by necessity (ring-signature verifiability requires it), so there was no genuine reason for it to live inside a confidential workflow on its own. It's correctly absorbed into intent execution instead, where the actual sensitive thing (the intent) justifies the TEE.

---

## 11. Sponsor coverage summary

| Sponsor | Role | Status |
|---|---|---|
| Arc | Intent-based settlement, Gateway multi-step sourcing/dispersal | Locked, scope open for further ideas (§9.4) |
| Chainlink | Merged CRE workflow (compliance + intent execution) | Locked, indispensable |
| The Graph | Ring decoy selection + relay hop selection (§8) | Locked, both load-bearing |

---

## 12. Risk table

| Risk | Severity | Mitigation |
|---|---|---|
| Ring OR-proof (§6) has no off-the-shelf reference | High | Day 1–2 spike, hard go/no-go, single-signer fallback |
| FORS+C parameters unbenchmarked (§5.1, §6.5) | Medium-High | Benchmark gas/size before committing to a parameter set |
| Gateway draw latency unverified (§9.3) | Medium | Check Circle docs before treating "simultaneous" as a design assumption |
| PQXDH hop-encryption upgrade adds scope | Low-Medium | Ship with classical hop encryption for MVP if time is short, label as known gap |
| Arc's "open scope" invites scope creep | Medium | Any new Arc idea must pass the §9.4 bar before it's approved |

---

## 13. Build order (12 days, 4 people, async)

| Days | Deliverable |
|---|---|
| 1–2 | Ring OR-proof spike (§6.3): MPC-in-the-head feasibility, 1-of-8. Go/no-go decision. Also: pick and benchmark FORS+C `(k, a)` parameters (§5.1). |
| 2–5 | `PQKeyRegistry` + `PQValidator` wallet, FORS+C verifier, ring verification per spike outcome, nullifier/double-spend logic (§6.4) |
| 5–7 | Relay mesh (3-hop, batch+delay, TEE-hosted, PQXDH hop encryption if time allows) |
| 7–9 | Chainlink CRE merged workflow (compliance + intent execution); Arc/USDC settlement + Gateway draws |
| 9–10 | Graph: Substreams + subgraphs for ring decoys and relay hops (§8); wire client-side selection logic |
| 10–11 | Frontend: wallet setup, intent submission, payment flow, App Kits integration |
| 12 | Demo script, README with threat model stated plainly, sponsor-specific writeups |

---

## 14. Deliverables checklist by workstream

**Cryptography / contracts**
- [ ] FORS+C signer + on-chain verifier, parameters benchmarked (§5.1)
- [ ] Ring OR-proof (MPC-in-the-head) — or fallback single-signer path (§6.2–6.3)
- [ ] Nullifier/double-spend logic (§6.4)
- [ ] `PQKeyRegistry` (§5.2)
- [ ] `PQValidator` ERC-4337 adapter (§5.4)

**Network layer**
- [ ] Relay mesh nodes (3-hop, batch+delay, TEE-hosted) (§7.1)
- [ ] PQXDH hop encryption (stretch, §7.3)

**Confidential workflows**
- [ ] Chainlink CRE workflow: compliance check (§10.1)
- [ ] Chainlink CRE workflow: confidential intent execution (§9.2, §10.2)

**Settlement**
- [ ] Arc/USDC settlement contract
- [ ] Gateway integration: draw #1 (sender-side) and draw #2 (recipient-side) (§9.3)

**Data layer**
- [ ] Substreams: ring-member enrollment (§8.1)
- [ ] Substreams: relay-node metadata (§8.2)
- [ ] Subgraphs: `RingMember`/`RingPool`, `RelayNode`
- [ ] Client: decoy-selection query logic
- [ ] Client: hop-selection query logic

**Frontend**
- [ ] Wallet setup / migration UI (App Kits)
- [ ] Intent submission UI (§9.1)
- [ ] Payment flow UI

**Submission**
- [ ] Demo script (§15)
- [ ] README with threat model stated plainly
- [ ] Sponsor-specific writeups (Arc, Chainlink, Graph)

---

## 15. Demo script

1. Set up a PQ wallet
2. Submit a payment as an intent — confidential, held in the CRE enclave
3. Show it wait, then fire once the Graph-indexed privacy signal crosses threshold (or hit the deadline live if time allows)
4. Ring-signed, relay-meshed execution — show the decoy and hop selection happening
5. Settle in USDC on Arc via Gateway — show the unified-balance draw happening at the exact moment of execution
6. Close on the threat model: what's hidden, what's not claimed, and why the spend key itself can't be forged even by a quantum computer

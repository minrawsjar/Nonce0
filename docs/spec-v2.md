# Opaque — Technical Specification v2

**Event:** ETHGlobal ETHOnline 2026 (Sept 4–16, async, 4-person team)
**Status:** Locked direction. This supersedes all earlier Opaque and PQGuard specs. Everyone should build from this document.

**Open item — Arc scope:** the intent-based settlement feature (§9) is the only Arc-side piece that's locked. Everything beyond that is explicitly open — see §9.4 for the bar any new Arc idea has to clear before it gets added (it has to emerge from the wallet/ring/mesh/Graph stack already here, not be reverse-engineered from Arc's prize rubric). Don't start building a second Arc feature without checking it against that bar first.

---

## 1. Overview

Opaque is a private payment protocol where the key that authorizes a spend is post-quantum secure today, sender/amount privacy comes from a small on-chain ring signature verified with pure hashing (no lattice math, no ZK/SNARK/STARK proof system anywhere in the trust path), and network-origin privacy comes from a relay mesh. Payments can also be submitted as confidential *intents* that wait for the best available privacy conditions before executing.

**One-line pitch:** *A payment protocol where the key that authorizes your spend is already quantum-safe, sender/amount privacy comes from pure hashing instead of unbuilt cryptography, and your payment can wait to execute until the network's anonymity conditions are actually strong.*

**Why this version, not the original lattice-based design:** the original design needed a custom Ring-LWE (lattice) signature verifier on EVM — no such verifier exists anywhere, and it was independently flagged as the single highest-risk task in a 12-day build. This version replaces that primitive with hash-based signatures (the same family used in SPHINCS+/FORS), a well-trodden category of post-quantum cryptography with dramatically lower implementation risk.

---

## 2. Goals / Non-goals

**In scope:**
- PQ wallet (ERC-4337) using a hash-based signature as the sole signer
- Small anonymity ring (~8 members) for sender/amount privacy, verified fully on-chain, no proof system
- 3-hop relay mesh, generalized into a reusable anonymizing transport for both payment submission and RPC/Graph query relaying (§7)
- Graph-powered decoy selection (ring) and hop selection (mesh) — genuine functional dependencies, not dashboards
- One Chainlink CRE Confidential Workflow doing two jobs: compliance/eligibility gating, and confidential intent execution
- "Intents that wait for the best privacy moment" — Arc/USDC settlement, with Gateway handling cross-chain sourcing/dispersal

**Architecture principle — modularity:** the wallet, ring, and mesh modules communicate only through explicit data contracts, never shared internal state:
- Wallet → Ring: a signature-scheme interface (keygen/sign/verify/commitment) plus a list of `pkCommitment`s. The ring module never touches live `PQKeyRegistry` state (useCount, rotation deadlines) — ring membership is a snapshot of committed public keys, nothing more.
- Wallet/Ring/Client → Mesh: an opaque encrypted payload plus a message type (`PAYMENT` or `QUERY`) and, for queries, a response route. The mesh never needs to know what it's carrying.
This is what lets any one module change (a different signature scheme post-benchmarking, a different OR-proof construction if the §6.3 spike fails, a different transport crypto) without the others noticing.

**Explicitly out of scope:**
- Any SNARK/STARK proof system in the spend-authorization path (the standard way to make such proofs cheap on EVM — e.g. RISC Zero's Groth16 wrapping — reintroduces an elliptic-curve dependency at the exact point meant to be quantum-proof; RISC Zero's own docs confirm that wrapping step is not quantum-safe)
- Large/production-scale anonymity sets — ring stays small, labeled PoC
- A "your key is already exposed" reveal feature — cut. Any address that has sent a transaction already has an exposed public key via `ecrecover`; not a novel finding
- Non-USDC payments — Arc is stablecoin-native and Gateway is USDC-specific; a swap leg would add its own privacy leak (visible swap size/timing) for little payoff
- ENS — dropped. Not part of this build.
- Retrofitting or scanning other protocols
- A 4th/5th sponsor (World ID, 1inch/SwapVM, or otherwise) — holding at 3: Arc, Chainlink, Graph. World ID was seriously considered as a fix for the ring-enrollment Sybil vector (§3, §12) — a real, well-composed fix, not a bolt-on — but left out on scope-discipline grounds and because the World track wasn't assessed as a strong winning chance. Mitigated instead with Graph-side heuristics (§8.1) plus a structural improvement from the note-based custody model (§6.6), explicitly labeled as raising attacker cost, not eliminating the vector.
- Arbitrary-amount confidential transfers — fixed-denomination pools only (§6.6). Variable amounts need elliptic-curve-based value commitments/range proofs (RingCT-style), which would crack the "no EC anywhere" posture at the amount-hiding layer.
- Note recovery via seed phrase or pool scanning — notes are tracked in local client storage only (§6.6). Losing local storage means losing access to unspent notes; there is no recovery mechanism in this PoC.

---

## 3. Threat model

| | Detail |
|---|---|
| Hides | Which ring member signed; the amount; sender's network origin (IP) for both payment submission and the RPC/Graph reads that precede it (§7.5); intent parameters (recipient, amount, timing) before execution; the compliance-check input |
| Does not claim to prevent | A global passive network adversary; simultaneous compromise of all 3 relay hops; weak OPSEC; a well-resourced, patient adversary Sybil-enrolling ring members to erode the anonymity set — the §8.1 heuristics and the deposit-cost structure of §6.6 raise the cost of this attack, they do not eliminate it; latency cost of routing queries through the mesh (a real UX tradeoff, not hidden — see §7.5); loss of unspent funds if the local device holding note secrets is lost — there is no seed-based recovery for notes in this PoC (§6.6) |
| Trust assumption for fund safety | None against forgery — spend authorization is a hash-based signature checked directly on-chain; no relay, enclave, or operator sits in that path. This does not cover loss of the local device holding note secrets (§6.6) |
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
Ring-signed note-spend (§6) ── ring ~8 note commitments (§6.6), hash-only
     │        OR-proof over "I know a secret opening one of these notes" —
     │        not a FORS+C signature (§6.1). Nullifier authorizes pool release.
     │        Ring membership drawn via Graph-powered decoy selection (§8.1)
     ▼
Relay mesh (§7) ── 3 hops, batched + randomly delayed, TEE-hosted
     │        Generalized transport: also carries wallet RPC reads and
     │        Graph queries (§7.5), not just payment submission
     │        Hops chosen via Graph-powered hop selection (§8.2)
     ▼
Settlement (Arc/USDC, §9.3) ── the pool releases the note's fixed denomination
     │        directly. No sender is named at this step — Gateway only touched
     │        an identity earlier, at deposit time, which is fine (§9.3).
     ▼
Recipient ── Gateway draw (optional) redistributes to recipient's chain
```

**Where deposit happens (attributable, and separate from the anonymous spend above):** PQ Wallet (§5, FORS+C-authenticated) → Gateway sources USDC into the pool → a note commitment is created (§6.6). This is a disclosed event by design; only the later spend, shown above, is anonymous.

---

## 5. PQ Wallet

**Module boundary:** everything outside this section (the ring module, §6) talks to the wallet only through a signature-scheme interface — `keyGen()`, `sign(sk, digest)`, `verify(pk, digest, sig)`, `pkCommitment(pk)` — plus the digest construction in §5.3. Nothing outside this section should reference FORS+C internals (tree height, `k`/`a` parameters, hash-chain structure) directly. That's what lets the team change the scheme or its parameters after the §6.3 spike without touching the ring module or `PQKeyRegistry` callers.

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

**Module boundary:** this module depends on the wallet (§5) only through the signature-scheme interface and a list of `pkCommitment`s — never on live `PQKeyRegistry` state (useCount, rotation deadlines, `disableAfter`). Ring membership is a snapshot of committed public keys; the ring has no legitimate reason to know an account's rotation schedule. Keeping this boundary honest means a change to the OR-proof construction (if §6.3's spike forces a fallback) never touches wallet or registry code, and vice versa.

### 6.1 What's being proven

**Corrected statement (this changed once §6.6 introduced notes — see below):** *"I know a secret `S` whose hash matches one of the 8 note commitments in this ring, and I have correctly derived this payment's nullifier from `S` and the payment context (recipient, denomination, anti-replay data), without revealing which commitment `S` opens."*

**Why this changed:** this section originally stated the proof as "I possess a valid FORS+C signature under one of the 8 public key commitments in this ring" — written before §6.6 moved spending authority to note secrets. That version was wrong once notes existed: it would require embedding FORS+C's *entire* signature-verification logic (many hash evaluations across a Merkle-style authentication structure) inside the MPC-in-the-head circuit, when a note-spend never needed a wallet signature in the first place — the note secret itself is the spending authority, the same way it is in Tornado Cash. Proving "I know a preimage matching one of 8 commitments" is a tiny circuit; proving "I hold a valid FORS+C signature" is a dramatically larger one. Keeping them separate matters for feasibility, not just cleanliness: FORS+C authenticates wallet-level actions only — deposits, intent submission, key rotation (§5) — and has no role in this statement at all.

This is still not a Sigma-protocol OR-proof in the Schnorr/EdDSA sense — it's a hash relation, not an algebraic one — but it's now a far smaller hash relation than the original version, which materially improves the odds of §6.3's spike actually succeeding.

### 6.2 Recommended construction: MPC-in-the-head

- The Picnic/KKW/Banquet family: real, published, NIST-round-reviewed constructions proving statements about hash/symmetric-key relations in zero knowledge, using only symmetric primitives — consistent with the rest of the stack's "no lattice, no elliptic curve" posture.
- Statement to encode in the MPC-in-the-head circuit: "I know a secret `S` such that `H(S)` equals the note commitment at ring slot `i`, for some `i` in `[0,7]`, and the nullifier `H(S, paymentContext)` is correctly derived." Binding the nullifier derivation into the same circuit (not computing it separately) is what stops a relay or mesh node from intercepting a valid proof and redirecting it to a different payment context.
- Witness: the note secret `S` and the index `i` (kept hidden).
- Public inputs: the 8 note commitments, the payment context (recipient, denomination), the nullifier, the proof itself.
- FORS+C plays no role in this circuit — see §6.1.

### 6.3 Mandatory day 1–2 spike

Before any other component depends on this:
1. Implement the above statement in an existing MPC-in-the-head proving library.
2. Measure proof size and generation time for the real FORS+C parameters chosen in §5.1.
3. Measure on-chain verification gas for that proof.
4. Go/no-go decision, documented, before Day 3.

**Fallback if the spike fails:** ship a non-anonymous, single-signer path for the demo — fully PQ-secure, just not anonymous — and present the ring as designed-but-not-proven-in-time. Do not silently downgrade the pitch; state it plainly in the README.

### 6.4 Double-spend prevention

Each spend derives a **linkability tag** (nullifier) deterministically from the note secret and the payment context, without revealing which ring member produced it:

```
nullifier = H(noteSecret, paymentContext)
```

The contract maintains a `mapping(bytes32 => bool) spentNullifiers`. A ring-signed payment is rejected if its nullifier has been seen before. The nullifier computation is part of the same MPC-in-the-head circuit as the note-opening statement (§6.2), so its correctness is proven alongside ring membership, not checked separately.

### 6.5 Cost and size — explicitly unknown

MPC-in-the-head proofs are historically larger than SNARKs (tens of KB, not hundreds of bytes) though smaller than raw STARKs for small circuits. Do not put a number in the pitch deck until §6.3's spike produces one.

### 6.6 Note-based value custody (the pool)

**Why this exists:** a ring signature only hides which of 8 keys signed — it says nothing about fund custody. If each PQ wallet directly holds and transfers its own on-chain tokens, the token transfer's `from` address is unavoidably that specific wallet, and the ring does nothing. Privacy requires pooled custody: a single contract holds all deposited funds, so the only address ever publicly visible moving tokens is the pool, never an individual depositor.

**Notes, not balances.** There is no `mapping(address => uint256)` anywhere in this design. A deposit creates a note — an opaque commitment, not a balance entry — and a user's "balance" is simply the set of notes they hold secrets for. Spending consumes a note entirely and proves ring membership over 8 **note commitments** (not wallet `pkCommitment`s) using the note-opening OR-proof in §6.1–6.2 — a hash-preimage statement, not a FORS+C signature statement; the existing nullifier (§6.4) marks that specific note spent. This also means ring membership requires an actual pool deposit, not just a `pkCommitment` registration — see the Sybil-cost note in §8.1.

**Fixed denominations, not arbitrary amounts.** With public, varying per-note amounts, decoys only provide anonymity if they match the real note's size — otherwise an observer just matches amounts and the ring is trivially broken. Arbitrary confidential amounts (the Monero/Zcash RingCT approach) need homomorphic value commitments and range proofs, which are elliptic-curve constructions — a real crack in the "fully PQ" story if adopted, even though it would sit at the amount-hiding layer rather than the spend-authorization layer. **Decision:** pool(s) of fixed denominations (Tornado Cash's approach) — no commitment arithmetic, no change outputs needed. Arbitrary-amount transfers are explicit future work, not attempted here. This changes §9.1's `PaymentIntent.amount` to mean "which denomination," not a free integer — see §9.1.

**Note storage — local only, no recovery.** Deposits are self-initiated: a wallet creates its own notes and already knows every one it holds from the moment of deposit, so there's no need to scan the pool to discover incoming payments (that would only be true for a different, Monero-style model where someone else creates a hidden note *for* you that you must go discover — this design doesn't use that; settlement to a recipient is a plain named transfer via Arc/Gateway, §9.3, not a hidden note the recipient must find). For this build: each note (secret, commitment, denomination, a locally-cached spent flag) is tracked in the client's local browser storage only — never transmitted, never indexed anywhere, including Graph (an earlier idea to store per-user deposit/withdraw history on Graph, even encrypted, was rejected: it reopens exactly the identity-to-activity linkage §8's hard constraint exists to prevent, provides no functional benefit over local storage if only the user can decrypt it, and is the same "durable ciphertext that must stay secret forever" risk shape this entire project exists to move away from). The locally-cached spent flag is a convenience only — always re-check the on-chain `spentNullifiers` set before attempting a spend.

**The real cost of this call, stated plainly:** there is no seed-phrase-style recovery for notes in this PoC. Losing local storage (cleared browser data, a lost device) means permanently losing access to any unspent notes — a genuine fund-safety gap, not a cosmetic one. State this in the README exactly as plainly as the other labeled gaps (simulated TEE attestation, classical hop encryption). A real production version would need wallet-recovery scanning (Monero/Zcash-style trial decryption, with a hash-based "view tag" analog to keep it cheap rather than Monero's elliptic-curve-based one) or notes deterministically derived from a wallet seed — both explicitly out of scope here.

---

## 7. Network Mesh (generalized anonymizing transport)

The mesh is not "the payment-submission feature" — it's a generic anonymizing transport that any sensitive request can ride on. Payment submission is one consumer of it; RPC reads and Graph queries (§7.5) are two more. This generalization is what closes the RPC/Graph IP-leak gap without standing up a second system.

### 7.1 Topology

- 6 independent relay nodes, no operator grouping. Every message (payment or query) uses a fixed-length 3-hop path drawn from this pool via the Markov chain described in §8.2 — not random, not deterministic top-3.
- Each hop: receives an encrypted message; holds it for a fixed batch window (not adaptive); forwards with a randomized per-item delay within that window; the final hop either submits to L1 (payment messages) or forwards to the actual RPC/Graph gateway and routes the reply back (query messages — §7.5).
- Relay nodes run inside TEEs. Their job is purely batching + delay + multi-hop forwarding — they never touch signature verification or see plaintext query contents, so a compromised relay cannot forge or approve a spend, only potentially deanonymize network origin if enough hops collude (see threat model, §3).
- Path *length* stays fixed at 3 hops (2 transitions) for both message types — this is a deliberate non-goal, not a missed feature. The classic Crowds protocol (§8.2) uses a variable-length forward-or-stop chain; adopting that here would reopen a scoping decision already settled to keep the build tractable.
- Bootstrapping is not a hard problem here the way it is for Tor: the 6 relay endpoints are a small, publicly known set (not secret guard nodes), so there's no discovery/enumeration attack to defend against — the goal is hiding sender-IP-to-payload linkage, not hiding who runs relays.

### 7.2 Message format (draft)

```
RelayMessage {
    messageType: PAYMENT | QUERY   // what kind of payload this is (§7.5)
    encryptedPayload: bytes        // payment: the ring-signed tx. query: the RPC/Graph request
    hopIndex: uint8                // which hop this message currently is at
    batchId: bytes32               // groups messages released together
    responseRoute: bytes?          // QUERY only — one-time key + return path for the reply
}
```

### 7.3 Hop encryption

Use a PQ-hybrid handshake between consecutive hops — the same shape as Signal's PQXDH (X25519 + ML-KEM combined), not plain classical ECDH. This closes the one remaining "is the mesh actually fully PQ" gap in the design. Lower priority than §6; ship with classical ECDH for the MVP if time runs short, and state that explicitly as a scoped, known gap in the README rather than silently omitting it.

### 7.4 TEE attestation

If real hardware TEE attestation (Intel TDX/SGX or equivalent) isn't practical in the build window, simulate attestation and say so explicitly in the README — do not imply real attestation if it isn't there.

### 7.5 RPC/Graph query relaying (closes the IP-leak gap)

**The gap:** before any ring/mesh privacy applies, the client makes direct calls that leak real IP-to-identity: reading `PQKeyRegistry` state (nonce, useCount, rotation status) from an RPC provider, and querying `RingMember`/`RelayNode` data from the Graph gateway for decoy/hop selection (§8). Both directly link a real IP to a specific wallet, and the Graph queries in particular correlate in time with an imminent ring-formation event landing on-chain moments later.

**Fix:** route these specific reads — not all reads — through the same mesh transport as §7.1–7.4, using `messageType: QUERY`. The final hop forwards the request to the real RPC/Graph gateway, gets the response, and encrypts it back through `responseRoute` to the origin instead of forwarding to L1.

**What to route vs. not:** only reads tied to a specific wallet or an imminent ring/mesh construction — `PQKeyRegistry` state for the acting wallet, `RingMember` and `RelayNode` subgraph queries. Generic, non-identifying chain data (e.g. a public gas price oracle) can go direct — it doesn't leak anything wallet-specific, and routing it would only add latency for no privacy gain.

**Real cost, stated plainly:** query latency gets worse by design — that's what batching + delay costs. Nonce/balance-style lookups that users expect to feel instant will feel slower. This is a genuine UX tradeoff to test, not a free upgrade, and it's why the threat model (§3) lists it under "does not claim to prevent" rather than pretending it's free.

**A genuine second-order benefit:** queries happen far more often than payments. Once both ride the same mesh, traffic into hop 1 looks like a constant stream of generic mesh activity rather than a sparse, easy-to-flag "payment submission" signal — the frequent query traffic functions as cover traffic that strengthens payment-side anonymity too, not just a fix bolted on for its own sake.

**What this still doesn't solve:** the underlying trust assumption is unchanged — if all 3 hops on a path collude, network origin is still exposed, same as §3 already states for payment traffic. This closes "reads bypass the mesh entirely," not the mesh's own collusion assumption.

---

## 8. Graph Integration

**Hard constraint for both subgraphs below:** index the *eligible pool* and aggregate statistics only. Never index which specific ring member or relay hop was used for a given payment — that would itself be a privacy leak, defeating the exact thing the ring signature and relay mesh exist to hide.

### 8.1 Ring decoy selection

**Why it matters:** poor decoy selection is a documented, real way ring-signature systems get deanonymized — Monero's early history includes exactly this failure mode via weak mixin selection and output-age analysis.

**Known gap, addressed below:** ring membership is keyed on a note commitment (§6.6), which requires an actual pool deposit — this already raises Sybil cost from "free hash" to "real, locked capital per fake decoy," compared to the originally-considered model of a bare, freely-registerable `pkCommitment`. It does not eliminate the attack: a well-resourced adversary can still flood the pool with real deposits, and the original "weight toward diversity in `enrolledAt`" rule still actively favors a freshly-deposited Sybil batch on volume once an attacker is willing to pay for it. World ID and a further bonding/staking mechanism on top of the deposit requirement were both considered as harder fixes and deliberately left out of scope (§2) — mitigated instead with the two heuristics below, plus the deposit-cost floor from §6.6. These raise the cost of the attack; they do not eliminate it (§3).

**Substreams module** — input: raw chain events; output: enrollment events (new note commitment joining the ring-eligible pool via a deposit, §6.6), per-member usage counts (aggregate, not per-payment linkage), funding provenance (traced a few hops back from the depositing address), and other on-chain activity by that address.

**Subgraph schema:**

```graphql
type RingMember @entity {
  id: ID!                     # note commitment (§6.6) — requires a real pool deposit, not a free registration
  enrolledAt: BigInt!
  timesUsedInRing: Int!       # aggregate count only, never which ring/payment
  lastUsedAt: BigInt
  fundingSourceCluster: ID!   # groups members whose funding traces back to the same source(s)
  hasOtherActivity: Boolean!  # any on-chain activity besides enrollment/ring use
}

type RingPool @entity {
  id: ID!                  # singleton or per-epoch
  poolSize: Int!
  avgMemberAge: BigInt!
  freshnessScore: BigInt!  # derived metric, see §9.2
}
```

**Selection algorithm (wallet client, at ring-construction time):**
1. Exclude anything used above a reuse-frequency threshold.
2. **Funding-clustering heuristic:** deprioritize members whose `fundingSourceCluster` accounts for an unusually large share of the pool — a real, well-precedented Sybil tell (the same technique airdrop-farming detection uses to trace many "independent" addresses back to a common source).
3. **Organic-activity heuristic:** prefer members with `hasOtherActivity = true` over ones that only exist to sit in the ring pool.
4. Weight toward diversity in `enrolledAt` only among what survives steps 2–3 — applying this before the Sybil heuristics is exactly what made the original algorithm favor a flood attack.
5. Sample 7 decoys plus the real signer.

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

**`amount` must match one of the pool's fixed denominations (§6.6), not a free integer** — arbitrary-amount transfers are out of scope for this build (would need elliptic-curve value commitments/range proofs, cracking the no-EC posture at the amount-hiding layer).

Submitted encrypted to the Chainlink CRE enclave — recipient, amount, and deadline are not visible in the public mempool before execution, preventing front-running or snooping on an intent before it fires.

### 9.2 Trigger condition (evaluated inside the CRE enclave)

```
fire = complianceCheck(recipient) AND (
    graphQuery(RingPool.freshnessScore) >= intent.minFreshnessScore
    OR block.timestamp >= intent.deadline
)
```

Both the recipient's compliance status and the intent's parameters are the sensitive inputs justifying the TEE. `freshnessScore` itself is public data (§8.1) — it's read *inside* the enclave as part of evaluating a confidential decision, which is different from an earlier, since-cut design where ring-health lived in the CRE workflow as its own gate (public data doesn't need a TEE on its own).

### 9.3 Settlement — corrected to match pool custody (§6.6)

**This section originally had Gateway pull funds from "the sender's" unified balance at the exact moment of spend. That directly re-attaches a named payer to what's supposed to be an anonymous ring-signed spend, and flatly contradicts §6.6's whole premise — that the pool, not an individual depositor, is the only thing ever visibly moving funds. Corrected below; this was a real internal inconsistency, not a nitpick.**

- **Gateway** gives a USDC holder a single, unified balance across multiple chains — no need to pre-fund Arc specifically.
- **Funding the pool (attributable, and that's fine):** a depositor uses Gateway to source USDC *into the pool at deposit time*, from their own unified cross-chain balance. This is a named, correlatable action — but that was already true before Gateway entered the picture (§6.6: deposit is the disclosed event; anonymity applies to spending a note later, not to depositing). Using Gateway here spends no privacy budget that wasn't already spent.
- **Spending (anonymous — no draw tied to a sender):** when `fire` evaluates true, the ring-signed note-spend proof (§6.1–6.2) plus nullifier check authorizes the *pool* to release the note's fixed denomination. Nothing is drawn from an individual's identity at this step — the pool already holds the funds from some earlier, unlinked deposit. This is the step that must never name a sender, and now doesn't.
- **Draw (recipient side, optional):** if the recipient's home chain isn't Arc, a Gateway draw redistributes the released funds there after settlement — this only reveals the recipient, which was never hidden (`PaymentIntent.recipient` is already a plain field, §9.1).
- **Verify before building:** Gateway's exact attestation/draw latency isn't confirmed against Circle's docs, for either the deposit-time draw or the recipient-side one. Check this in week 1, not week 2.
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
| Ring OR-proof (§6) has no off-the-shelf reference | High (was existential when the statement wrongly embedded FORS+C verification — corrected in §6.1–6.2 to a much smaller note-opening statement) | Day 1–2 spike on the note-opening statement specifically, hard go/no-go, single-signer fallback |
| Settlement previously named a sender via Gateway draw #1 at spend time, contradicting §6.6's pool-custody premise | Was existential for the privacy claim | Corrected in §9.3: Gateway only touches identity at deposit time (already attributable); spend-time release comes from the pool, never a named sender |
| FORS+C parameters unbenchmarked (§5.1, §6.5) | Medium-High | Benchmark gas/size before committing to a parameter set |
| Gateway draw latency unverified (§9.3) | Medium | Check Circle docs before treating "simultaneous" as a design assumption |
| PQXDH hop-encryption upgrade adds scope | Low-Medium | Ship with classical hop encryption for MVP if time is short, label as known gap |
| Arc's "open scope" invites scope creep | Medium | Any new Arc idea must pass the §9.4 bar before it's approved |
| Ring enrollment is Sybil-able (free, unlimited `pkCommitment` registration) | High | Funding-clustering + organic-activity heuristics in §8.1. World ID and bonding both considered, deliberately left out of scope (§2). Have the one-line judge answer ready: identified, mitigated what's cheap, made an informed scoping call — not unaddressed. |
| Mesh generalization to carry queries (§7.5) needs a response-routing path the mesh never had before | Medium | Scope response-routing as its own build item (§13), not an assumed side effect of the existing payment-forwarding logic |
| Routing RPC/Graph reads through the mesh adds real latency to nonce/balance-style lookups | Medium | Only route wallet-specific and ring/mesh-construction reads (§7.5); test perceived latency early, don't discover it during demo prep |
| No recovery mechanism for lost/cleared local note storage (§6.6) | High for real funds, low for a demo | Explicitly out of scope, stated plainly in README. Real version would need Monero/Zcash-style scanning (hash-based view-tag analog) or notes deterministically derived from a wallet seed |
| Fixed-denomination pools mean no arbitrary-amount payments (§6.6) | Medium | Deliberate scope decision to avoid EC-based value commitments; document as a stated PoC constraint, not a missing feature |

---

## 13. Build order (12 days, 4 people, async)

| Days | Deliverable |
|---|---|
| 1–2 | Ring OR-proof spike (§6.3): MPC-in-the-head feasibility, 1-of-8. Go/no-go decision. Also: pick and benchmark FORS+C `(k, a)` parameters (§5.1). |
| 2–5 | `PQKeyRegistry` + `PQValidator` wallet, FORS+C verifier, ring verification per spike outcome, nullifier/double-spend logic (§6.4) |
| 5–7 | Relay mesh (3-hop, batch+delay, TEE-hosted, PQXDH hop encryption if time allows); generalize to `messageType: PAYMENT/QUERY` and build response-routing for query traffic (§7.5) |
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
- [ ] Pool contract: note commitments, nullifier check, fixed-denomination release (§6.6)
- [ ] Arc/USDC settlement contract
- [ ] Gateway integration: deposit-time draw (funds the pool) and recipient-side draw (§9.3) — never a sender-identified draw at spend time

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
4. Ring-signed note-spend, relay-meshed execution — show the decoy and hop selection happening, and be explicit that no wallet signature or named sender appears at this step (§6.1, §9.3)
5. Settle in USDC on Arc — pool releases the note's denomination, Gateway disperses to the recipient's chain if needed. Contrast with the earlier deposit step, which was attributable on purpose
6. Close on the threat model: what's hidden, what's not claimed, and why the spend key itself can't be forged even by a quantum computer
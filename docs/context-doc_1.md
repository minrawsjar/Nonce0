# Opaque — Full Context Handoff

## 0. How to use this document

Paste this whole document into a new chat to resume work on Opaque with zero context loss. It contains three things a fresh chat wouldn't otherwise have: (1) the full technical spec, (2) the decision log — what was tried, rejected, and why, so settled debates don't get accidentally reopened, and (3) what the two existing architecture diagrams contain. Read the decision log before proposing changes to anything it covers; several ideas in there (STARK proofs, World ID, a 4th sponsor, non-USDC payments, ENS) were seriously considered and deliberately cut, not overlooked.

---

## 1. Event & team logistics

- **Event:** ETHGlobal ETHOnline 2026, September 4–16, fully async
- **Team:** 4 people
- **Working title:** "Opaque" — this is a placeholder, not a finalized name. ("Quorin" was proposed earlier as a name for a different candidate direction that was ultimately not pursued — it was never adopted for this project. Naming is still an open item if you want to revisit it.)

---

## 2. One-paragraph pitch

Opaque is a private payment protocol where the key that authorizes a spend is post-quantum secure today, sender/amount privacy comes from a small on-chain ring signature verified with pure hashing (no lattice math, no ZK/SNARK/STARK proof system anywhere in the trust path), and network-origin privacy comes from a relay mesh — generalized to also anonymize the RPC/Graph queries that precede a payment, not just the payment itself. Payments can also be submitted as confidential *intents* that wait for the best available privacy conditions before executing.

**One-liner:** *A payment protocol where the key that authorizes your spend is already quantum-safe, sender/amount privacy comes from pure hashing instead of unbuilt cryptography, and your payment can wait to execute until the network's anonymity conditions are actually strong.*

---

## 3. Decision log — what got tried, rejected, and why

In chronological order. This is the part most likely to get lost without this doc — the spec below captures *what* was decided, this captures *why*, including the paths not taken.

1. **PQGuard vs. Opaque.** Two directions were on the table: PQGuard (broad, multi-chain post-quantum security scanning/migration tooling) and Opaque (private PQ payments). Opaque was chosen — it reads as a concrete, coherent product rather than a scanning utility, and gave a clearer story for judges.

2. **"Exposure oracle" opening feature — cut.** An early plan borrowed from PQGuard: scan a connected wallet and show it's already publicly exposed across chains, as a dramatic opening demo beat. Killed because it's not a real finding — any address that has ever sent a transaction already has an exposed public key via `ecrecover`. Technical judges would recognize this immediately; keeping it would have undercut credibility rather than building it.

3. **Lattice-based (Ring-LWE) signatures — rejected in favor of hash-based (FORS+C).** The original wallet/ring design needed a custom Ring-LWE signature verifier on the EVM. No such verifier exists anywhere — it was independently flagged as the single highest-risk task in a 12-day build. Replaced with FORS+C, a hash-based, few-time signature scheme (same family as SPHINCS+/FORS, part of FIPS 205), which needs only Keccak256 — no elliptic-curve or lattice arithmetic, dramatically lower implementation risk.

4. **STARK/zkVM ring-anonymity proof — proposed, then fully retracted.** A zkVM approach (RISC Zero/SP1) was floated for proving ring membership on-chain, on the assumption that STARKs are inherently post-quantum-safe end to end. Retracted after verification: raw STARK verification is gas/calldata-prohibitive on Ethereum — even StarkWare's own production system (SHARP) has to split proofs into pieces just to fit gas limits, and a trivial toy proof is already ~166KB. The standard fix (RISC Zero's/SP1's cheap EVM verifiers) wraps the STARK in a Groth16 SNARK for final on-chain verification — and RISC Zero's own security-model docs confirm that final step is **not quantum-safe** (elliptic curve pairing over BN254), which would silently reintroduce the exact vulnerability this project exists to eliminate, at the one point that authorizes spending. Replaced with **MPC-in-the-head** (Picnic/KKW/Banquet family) — a real, published, NIST-round-reviewed OR-proof construction using only symmetric primitives. This remains the one genuine open R&D risk in the design, gated by a mandatory Day 1–2 feasibility spike with a hard go/no-go and a documented non-anonymous single-signer fallback.

5. **Generic "conditional payments" for Arc — rejected as reverse-engineered from the rubric.** The first pass at an Arc feature was built directly from Arc's prize-criteria language ("conditional payments," "onchain automation") rather than emerging from the product itself. Replaced with **"intents that wait for the best privacy moment"** — an intent that fires when a Graph-indexed ring/mesh privacy signal crosses a threshold (or a deadline hits), which only makes sense because this specific stack has a ring, a mesh, and a Graph-indexed anonymity signal to evaluate. Explicitly contrasted against generic DeFi intent systems (UniswapX, CoW Swap) that optimize for price/MEV instead of privacy quality. Any future Arc idea has to clear the same bar: emerge from the wallet/ring/mesh/Graph stack already here, not from the rubric.

6. **Standalone Chainlink CRE "ring-health risk gate" — cut.** An earlier design had ring-pool health/freshness as its own confidential workflow job. Removed because that data (pool size, freshness) is necessarily public — ring-signature verifiability requires it — so there was no genuinely sensitive input to justify a TEE on its own. Correctly re-absorbed into the intent-execution job instead, where the intent's own parameters (recipient, amount, deadline) are the actual sensitive thing justifying confidentiality.

7. **Non-USDC support via SwapVM/1inch — considered, left out.** Would have let payments work in other tokens. Rejected to avoid a 4th sponsor dependency, and because a swap leg would add its own visible-size/timing privacy leak — a real cost, not just scope discipline for its own sake.

8. **ENS — dropped entirely.** Not part of this build in any form.

9. **Relay hop selection: random vs. Graph-driven.** An early simplification ("6 independent nodes, no groups, random 3 selected") was flagged as making the Graph integration pointless — no reason to query indexed data for a purely random pick. Resolved by formalizing hop selection as a **Markov chain** over the 6-node pool: state space `S = {N1..N6}`, transition probabilities driven by real per-node metrics (`batchOccupancy`, `recentSelectionCount`, a reliability floor), deliberately not deterministic top-3 (which would just create a new static, fingerprintable pattern). Grounded in real academic precedent — the Crowds anonymity protocol (Reiter & Rubin), formally analyzed the same way in the literature (including a PRISM model-checker study).

10. **Ring-enrollment Sybil vulnerability — identified, World ID considered and rejected.** External feedback correctly identified a real flaw: ring enrollment is a free, unlimited `pkCommitment` hash, and the original "weight toward diversity in `enrolledAt`" rule actively favors a Sybil-flooding attacker on volume. World ID (proof-of-unique-human via Incognito Actions/nullifiers) was seriously evaluated as a well-composed hard fix — genuinely compatible with the pool's necessary publicness, not a bolt-on. **Deliberately left out**: it would mean a 4th sponsor, and the World track wasn't assessed as a strong winning chance. Mitigated instead with two heuristics that raise attacker cost without eliminating the vector: funding-source clustering (the same technique used in airdrop-farming Sybil detection) and an organic-activity signal, applied *before* the diversity-weighting step (applying diversity-weighting first is exactly what made the original algorithm favor a flood). This is treated as acceptable for a hackathon PoC specifically because it's disclosed plainly in the threat model and risk table, not silently ignored — the reasoning: identified a real, well-known attack class in this space, mitigated what's cheap, made an informed scoping call.

11. **RPC/Graph-level IP anonymity — identified as a real gap, then actually solved (not just documented).** The relay mesh only ever protected the ring-signed payment's path to L1. Three things bypassed it entirely and leaked real IP-to-wallet linkage: the wallet's own RPC reads of `PQKeyRegistry` state, the Graph queries used for decoy/hop selection, and the connection to the mesh's first hop itself. The first proposal was the industry-standard punt (document it as a known gap, recommend Tor/VPN, following Tornado Cash's/Wasabi's precedent). Instead, the mesh was **generalized from a payment-only transport into a reusable anonymizing transport** carrying two message types (`PAYMENT`, `QUERY`), with response-routing added for the query case (a genuinely new piece of engineering the mesh never needed before). Only wallet-specific and ring/mesh-construction reads route through it — generic non-identifying reads (e.g. a public gas oracle) go direct, since routing everything would add latency for no privacy gain. A real secondary benefit: since queries happen far more often than payments, mixing both traffic types on the same hops means frequent query traffic functions as cover traffic that strengthens payment-side anonymity too. Real costs stated plainly: added latency on nonce/balance-style lookups (a genuine UX tradeoff to test, not hidden), and the underlying hop-collusion trust assumption is unchanged.

12. **Modularity as an explicit architecture principle.** Following on from #11, the Wallet, Ring, and Mesh components were formalized as independent modules that only ever talk through explicit contracts, never shared internal state: Wallet → Ring exposes only a signature-scheme interface (keygen/sign/verify/commitment) plus a list of `pkCommitment`s — the ring module never touches live `PQKeyRegistry` state. Any module → Mesh passes only an opaque encrypted payload plus a message type — the mesh never inspects what it's carrying. This is what lets any one piece (the signature scheme's parameters, the OR-proof construction if the spike fails, the mesh's hop-encryption crypto) change without the others needing to.

---

## 4. Full technical specification

*(This is the complete, current spec — everything below reflects the decisions in the log above.)*

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
- A 4th/5th sponsor (World ID, 1inch/SwapVM, or otherwise) — holding at 3: Arc, Chainlink, Graph. World ID was seriously considered as a fix for the ring-enrollment Sybil vector (§3, §12) — a real, well-composed fix, not a bolt-on — but left out on scope-discipline grounds and because the World track wasn't assessed as a strong winning chance. Mitigated instead with Graph-side heuristics (§8.1), explicitly labeled as raising attacker cost, not eliminating the vector.

---

## 3. Threat model

| | Detail |
|---|---|
| Hides | Which ring member signed; the amount; sender's network origin (IP) for both payment submission and the RPC/Graph reads that precede it (§7.5); intent parameters (recipient, amount, timing) before execution; the compliance-check input |
| Does not claim to prevent | A global passive network adversary; simultaneous compromise of all 3 relay hops; weak OPSEC; a well-resourced, patient adversary Sybil-enrolling ring members to erode the anonymity set — the §8.1 heuristics raise the cost of this attack, they do not eliminate it; latency cost of routing queries through the mesh (a real UX tradeoff, not hidden — see §7.5) |
| Trust assumption for fund safety | None — spend authorization is a hash-based signature checked directly on-chain; no relay, enclave, or operator sits in that path |
| Trust assumption for anonymity | The ring's OR-proof mechanism (§6) and the relay mesh's hop diversity (§7) |
| Trust assumption for intent execution | The Chainlink CRE TEE holds intent parameters confidentially until the trigger condition fires |
| Quantum-specific claim | The key an attacker needs to forge a spend is hash-based — no elliptic curve or lattice assumption anywhere in that path |

**Plain-language note — "a global passive network adversary":** the standard anonymity-network threat-modeling term (same disclaimer Tor uses). It means an adversary who can observe *all* traffic on *all* links at once (global) but who only watches — doesn't inject, modify, or drop anything (passive). No batching/delay scheme, including this one, can defeat someone with that much simultaneous visibility; that's why it's explicitly excluded from what the mesh claims to defend against, not an oversight.

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
     │        Generalized transport: also carries wallet RPC reads and
     │        Graph queries (§7.5), not just payment submission
     │        Hops chosen via Graph-powered hop selection (§8.2)
     ▼
Settlement (Arc/USDC) ── Gateway draw #1 sources USDC from sender's unified
     │                    cross-chain balance at the exact moment of execution
     ▼
Recipient ── Gateway draw #2 (optional) redistributes to recipient's chain
```

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

**Known gap, addressed below:** enrollment is a bare `pkCommitment` hash — free and unlimited. An adversary can flood the pool with Sybil commitments; the original "weight toward diversity in `enrolledAt`" rule actually favors a freshly-enrolled Sybil batch on volume, since it's rewarding spread across a population the attacker just filled. World ID and a bonding/staking mechanism were both considered as hard fixes and deliberately left out of scope (§2) — mitigated instead with the two heuristics below. These raise the cost of the attack; they do not eliminate it (§3).

**Substreams module** — input: raw chain events; output: enrollment events (new `pkCommitment` joining the ring-eligible pool), per-member usage counts (aggregate, not per-payment linkage), funding provenance (traced a few hops back from the enrolling address), and other on-chain activity by that address.

**Subgraph schema:**

```graphql
type RingMember @entity {
  id: ID!                     # pkCommitment
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
| Ring enrollment is Sybil-able (free, unlimited `pkCommitment` registration) | High | Funding-clustering + organic-activity heuristics in §8.1. World ID and bonding both considered, deliberately left out of scope (§2). Have the one-line judge answer ready: identified, mitigated what's cheap, made an informed scoping call — not unaddressed. |
| Mesh generalization to carry queries (§7.5) needs a response-routing path the mesh never had before | Medium | Scope response-routing as its own build item (§13), not an assumed side effect of the existing payment-forwarding logic |
| Routing RPC/Graph reads through the mesh adds real latency to nonce/balance-style lookups | Medium | Only route wallet-specific and ring/mesh-construction reads (§7.5); test perceived latency early, don't discover it during demo prep |

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
- [ ] `messageType` generalization + response-routing for query traffic (§7.5)

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

---

## 5. Architecture diagrams (Excalidraw files, delivered separately)

Two native `.excalidraw` files exist for this project, styled to match the team's existing PQGuard diagrams (color coding: blue = wallet/host layer, purple = ring/core crypto, teal = mesh/transport, orange = Graph/data layer, green = sponsor/execution layer, red dashed = threat-model/out-of-scope callouts, gray = modularity/build-order/orientation). If picking this up in a new chat and these files aren't attached, they'd need to be regenerated from the spec above — the content is fully described here so nothing is lost even without the files themselves.

**`opaque-architecture.excalidraw`** — the main pipeline-flow diagram: title/subtitle, a threat-model callout, a 6-box horizontal flow (PQ Wallet → Intent Submission → Chainlink CRE → Ring-Signed Payment → Relay Mesh → Settlement → Recipient) connected by arrows, two Graph-integration boxes (ring decoy selection, Markov-chain hop selection) feeding up into the Ring and Mesh boxes, three sponsor-coverage boxes (Arc/Chainlink/Graph) with detailed status text, an out-of-scope callout, and a build-order strip.

**`opaque-modules.excalidraw`** — the modular-architecture breakdown diagram: a modularity-principle callout stating the contracts exactly, a condensed threat-model callout, three core module boxes side by side (PQ Wallet, Ring Signature, Network Mesh) each with their internal technical details and dependency boundaries, a dashed cross-arrow noting that wallet reads and Graph queries also ride the mesh, a data/detail row (the §7.5 RPC/Graph relaying box plus the two Graph modules, each wired to the module it feeds), an execution layer (Chainlink CRE and Arc/Settlement modules with their struct fields and trigger logic), and the out-of-scope callout.

A third diagram (a simpler linear component-flow view, mirroring a third PQGuard reference image) was offered but not yet built as of this doc's writing — worth asking about if picking this up fresh.

---

## 6. Open items / not yet resolved

- Arc scope beyond the locked intent feature (§9.4) — genuinely open, needs to pass the stated bar
- Ring OR-proof feasibility (§6.3) — the Day 1–2 spike hasn't been run yet; this is the single highest-uncertainty item in the whole build
- FORS+C `(k, a)` parameters — not yet benchmarked
- Gateway draw latency — not yet verified against Circle's docs
- Response-routing for `QUERY` messages through the mesh (§7.5) — designed, not yet built or estimated for effort
- Whether real hardware TEE attestation is feasible in the build window, or will be simulated (§7.4) — not yet decided
- Project name — "Opaque" is a working title, not final
- Whether a third, simpler linear-flow diagram is wanted

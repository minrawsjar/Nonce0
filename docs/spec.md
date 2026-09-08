# Opaque — Technical Specification

**For:** ETHGlobal ETHOnline 2026 (Sept 4–16, async, 4-person team).
**Status:** locked direction, spec v1. Anything under "Open decisions" is genuinely
undecided; do not silently pick for the team.

## 1. Overview

A private payment stack on Ethereum composing three things nothing surveyed does together:

1. **Sender/amount privacy that is quantum-resistant** — a post-quantum (lattice-based)
   ring signature, not an elliptic-curve ZK-SNARK.
2. **Network-origin privacy** — a relay mesh decoupling a sender's IP from their
   on-chain transaction via batching, delay, and multi-hop forwarding.
3. **Confidential policy evaluation** — an eligibility/compliance check run inside a
   Chainlink CRE Confidential Workflow (TEE), so the input is never exposed.

Settlement in USDC via Arc.

Railgun, Aztec and Privacy Pools solve (1) with elliptic-curve ZK-SNARKs —
quantum-vulnerable — and none solve (2). Monero solves (1)+(2) with classical ring
signatures on a non-programmable chain. Opaque is (1)+(2)+(3), PQ, on Ethereum.

## 2. Goals / Non-goals

**In scope:** payment contract where spend authorization is a ring signature over a
fixed member set (ring size 8 for demo); relay mesh of 3–5 nodes batching and delaying
inside TEEs (simulated attestation acceptable if noted); one Chainlink CRE Confidential
Workflow performing a real eligibility check; settlement leg on Arc in USDC; a "Network
Observer" dashboard showing naive-vs-Opaque correlation.

**Explicitly out of scope — do not attempt:**
- Post-quantum wallet signatures (ECDSA stays at the wallet layer — a known
  Ethereum-wide gap, not this project's to fix).
- Real production-scale anonymity sets. Ring size 8 and any anonymity numbers must be
  labeled PoC/simulated, never implied as live production figures.
- Adaptive/dynamic relay topology. Fixed 3-hop path, fixed batch window.

## 3. Architecture

```
Wallet -> Payment Privacy -> Network Privacy -> Policy Check -> Settlement
(EOA/     (PQ ring sig +     (relay mesh:      (Chainlink       (Arc /
smart      range proof,       3 hops, batch     CRE Confidential  USDC)
account)   verified fully     + random delay,   Workflow, TEE)
           on-chain)          TEE-hosted)
```

### 3.2 Payment privacy — post-quantum ring signature
- **Primitive:** Ring-LWE lattice ring signature. References: **ChipmunkRing**
  (arXiv:2510.09617, reference code `github.com/demlabs-cellframe/dap-sdk`) and
  **MatRiCT/MatRiCT+** (Monash; deployed in Hcash — module-SIS/module-LWE ring
  confidential transactions, ring signature + range proof together).
- **Ring size:** 8 for the demo. State it explicitly in README and narration.
- **Amount hiding:** lattice-based range proof/commitment (MatRiCT-style), NOT Pedersen
  + Bulletproofs — those rely on discrete log and would silently break the
  "fully quantum-secure" claim.
- **Double-spend:** linkability tag / key-image, so the contract rejects a second spend
  without learning which ring member spent it.
- **Signature size:** 20–150KB depending on ring size (ChipmunkRing 28.9KB at ring=4,
  45.6KB at ring≈8). Drives real calldata gas on top of verifier compute.

### 3.3 Network privacy — relay mesh
Fixed 3-hop. Each node receives an encrypted ring-signed payment, holds it in a fixed
batch window, forwards with randomized per-item delay; the final hop submits to L1.
Nodes should run in TEEs — their job is network-origin privacy only, never signature
verification. Simulate attestation if hardware is unavailable, and say so.

### 3.4 Policy check — Chainlink CRE Confidential Workflow
One workflow taking a sensitive input (eligibility credential / compliance flag),
evaluating a rule inside the TEE handler, returning only a boolean on-chain. Must
actually gate settlement, not run alongside it.

### 3.5 Settlement — Arc / USDC
Move funds to the recipient in USDC over Arc after the policy check passes. The
conditional-release-after-policy-check flow already satisfies Arc's track; do not add
unrelated DeFi features to chase it further.

## 4. On-chain verification (read before writing any contract)

**Decision: the ring signature is verified fully on-chain**, in the L1 contract, not in
the relay mesh. The mesh only ever handles network-origin privacy. Deliberate, to avoid
the trust assumption an off-chain/TEE-attested verification path introduces: the
contract is the only thing deciding a payment is valid.

**What this requires, stated plainly so it isn't underestimated:**
- A custom Solidity/EVM verifier for a Ring-LWE ring signature + range proof. No
  existing EVM port covers this. Closest precedent, zkNox's ETHFALCON/ETHDILITHIUM,
  verifies *single-signer* Falcon/Dilithium at 1.9M–8.8M gas and does not handle ring
  aggregation at all. Must be built from the underlying math. **Single hardest,
  highest-risk task in the build — prioritize first; Days 1–3 is not enough time.**
- Calldata: tens of KB per transaction at ring 8. Budget calldata gas, or investigate
  EIP-4844 blobs if prohibitive.
- Gas is very likely the binding constraint on ring size. Ring 8 is a target, not a
  guarantee.
- **Plan B, documented not silent:** if the on-chain verifier is infeasible in the
  window, fall back to off-chain verification inside the TEE mesh with an on-chain
  attestation check.

## 5. Sponsor integration requirements

| Sponsor | Track | Prize | Exact requirement |
|---|---|---|---|
| Chainlink | Best Confidential Workflow | up to $1,000 (of up to 2 teams) | Register a confidential TEE handler; process >=1 sensitive input inside the enclave; show via CLI simulation or live deployment. |
| Arc/Circle | Best DeFi/Onchain Finance Application | $1,667 | Programmable money flow (conditional payments/multi-step settlement) using Arc + USDC; working MVP with frontend+backend; architecture diagram; video demo. |
| *Open — 3rd sponsor* | — | — | See §6. Do not build toward this until decided. |

## 6. Open decisions — do not resolve unilaterally

- **Third sponsor.** Leading candidate: The Graph, pairing a Substreams package with a
  Subgraph over both Opaque's mesh/batch events and Arc's settlement events (this
  genuinely satisfies "compose two Graph products" + "query pattern spanning multiple
  protocols"; a subgraph indexing only your own contract would not clear that bar).
  Only build if the team confirms and the dashboard needs it anyway.
- **Exact ring signature construction to port to Solidity.** ChipmunkRing has public
  reference code (Rust/C); MatRiCT+ is better documented academically but no public
  reference implementation found. This decision determines whether Days 1–4 succeed.
- **Real vs. simulated TEE attestation**, depending on actual hardware access.

## 7. Threat model (state in README)

**Hides:** which ring member signed; the payment amount; the sender's network origin
(IP); the input evaluated by the CRE policy check.

**Does not claim to prevent:** a global passive network adversary; simultaneous
compromise of every relay; weak user OPSEC (timing/amount patterns).

**Trust assumption:** none, for payment validity — the ring signature is verified
entirely on-chain. The mesh is trusted only for network-origin privacy.

## 8. Build phases — 12 days, 4 people

| Days | Deliverable |
|---|---|
| 1–4 | **Highest-risk, start first:** on-chain verifier for ring signature + range proof (§4). Note commitments, linkability-tag double-spend, wallet flow for signing within a group of 8. If gas forces a smaller ring or the off-chain fallback, decide HERE, not Day 10. |
| 5–7 | Relay mesh: 3 hops, batching, randomized delay. TEE hosting (simulated attestation acceptable if noted). |
| 8–9 | Chainlink CRE Confidential Workflow + Arc/USDC settlement; 3rd sponsor if resolved. |
| 10–11 | Network Observer dashboard: naive-vs-Opaque correlation, simulated traffic, labeled. |
| 12 | Demo script (90s), architecture diagram, README with §7 threat model, sponsor writeups. |

## 9. References

- ChipmunkRing: https://arxiv.org/pdf/2510.09617
- MatRiCT / MatRiCT+: https://eprint.iacr.org/2019/1287 , https://eprint.iacr.org/2021/545
- Ethereum quantum-resistance roadmap: https://ethereum.org/roadmap/security/quantum-resistance/
- Ethereum privacy roadmap: https://ethereum.org/roadmap/privacy/
- ETHOnline 2026 prizes: https://ethglobal.com/events/ethonline2026/prizes
- ETHFALCON/ETHDILITHIUM: https://zknox.eth.limo/posts/2025/03/21/ETHFALCON.html

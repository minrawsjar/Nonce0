# Opaque

**A payment protocol where the key that authorises your spend is already
quantum-safe, sender privacy comes from pure hashing instead of unbuilt
cryptography, and your payment can wait until the network's anonymity
conditions are actually strong.**

Private USDC payments on Arc. Three properties, each from a different mechanism:

| Property | Mechanism | Section |
|---|---|---|
| The spend key survives a quantum adversary | FORS+C hash-based few-time signatures | §5 |
| Sender and amount are hidden | An 8-member ring over note commitments, proved with MPC-in-the-head — hashes only, no elliptic curve, no lattice | §6 |
| Network origin is hidden | A 3-hop onion relay mesh, ML-KEM-768 per hop | §7 |
| The payment waits for a good privacy moment | A Chainlink CRE confidential workflow | §9, §10 |

Decoy selection and relay hop selection both read a Graph subgraph — real
functional dependencies, not a dashboard.

## Read this before the pitch

Three things are load-bearing and all three are stated plainly, because a
protocol that hides its gaps is the failure mode this project exists to move
away from.

**1. On-chain ring verification does not work, and we measured it.** §6.3
required a spike before anything depended on the ring. It is built, and
`node backend/zk/bench.ts` runs it. At 219 repetitions (2⁻¹²⁸ soundness) the
proof is **1.08 MiB**: calldata alone is 18M gas against Arc's 30M block limit,
and verification is ~9× a whole block at a charitable 3 gas per boolean gate.
Off-chain verification works, at 2.0 s, and stays publicly verifiable. The
three ways forward — and the fact that choosing between them changes the trust
model — are in [backend/zk/README.md](backend/zk/README.md). **§2's "verified
fully on-chain" does not survive this measurement.**

**2. There is no recovery for notes.** A note is a secret in local browser
storage and nothing else. Clear your browser data and any unspent notes are
gone permanently. That is a genuine fund-safety gap, not a cosmetic one. A real
version needs seed-derived notes or trial-decryption scanning; both are out of
scope here.

**3. TEE attestation is simulated.** Relay nodes and the CRE enclave are not
running attested hardware in this build. Where the design says "the enclave
holds this confidentially", read "the enclave would hold this confidentially".

The threat model is in [docs/spec-v2.md §3](docs/spec-v2.md). It does not claim
to stop a global passive observer, collusion across all three relay hops, or a
well-resourced adversary Sybil-enrolling ring members — the §8.1 heuristics and
the deposit cost of §6.6 raise that attack's price, they do not eliminate it.

## How a payment works

```
PQ wallet (§5)            FORS+C key, ERC-4337. Authorises deposits and
    │                     rotation — never the anonymous spend.
    ▼
Deposit                   Creates a note: an opaque commitment in a pooled
    │                     contract. Attributable by design, and separate.
    ▼
Encrypted intent (§9)     (recipient, amount, deadline) sealed to the CRE
    │                     enclave, never the public mempool.
    ▼
CRE workflow (§10)        Fires when compliance passes AND
    │                     (privacyScore >= minimum OR now >= deadline).
    ▼
Ring spend (§6)           Proves "I know a secret opening one of these 8 note
    │                     commitments" without saying which. Hashes only.
    ▼
Relay mesh (§7)           3 hops, onion-encrypted, batched, randomly delayed.
    │                     Carries queries too, so query traffic covers payments.
    ▼
Settlement               The pool releases a fixed denomination. No sender is
                          named at this step.
```

Fixed denominations only — 1, 5 and 10 USDC. Variable amounts need
elliptic-curve value commitments and range proofs, which would crack the "no EC
anywhere" posture at the amount-hiding layer.

## Layout

Ownership, boundaries and commands: **[docs/workspace.md](docs/workspace.md)**.
Start with [docs/spec-v2.md](docs/spec-v2.md); [docs/README.md](docs/README.md)
indexes everything and records the open contradictions between documents.

```sh
npm run typecheck:all      # every package, strict
npm run test:all           # every suite
cd contracts && forge test
node backend/zk/bench.ts    # the §6.3 spike
```

Node ≥22.18 required — it strips TypeScript natively, so there is no build step
anywhere except Vite for the frontend.

## Not the scanner

This repository began as **nonce0**, a cross-chain public-key exposure scanner,
and that tool still lives in [`src/`](src/) and [`bin/`](bin/) with its own
tests and its zero-runtime-dependency guarantee intact. It is unrelated to the
payment stack above. `npx nonce0 scan .` still works.

## Licence

MIT.

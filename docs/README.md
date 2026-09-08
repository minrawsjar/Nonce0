# opaque docs

## Read in this order

| Document | What it is |
|---|---|
| [context-doc_1.md](context-doc_1.md) | Full context handoff, including the decision log — *why* things were cut. Read §3 before reopening a settled debate. |
| [spec-v2.md](spec-v2.md) | The technical spec. Supersedes every earlier Opaque and PQGuard spec. |
| `output/pdf/opaque-v1-team-handoff.pdf` | The V1 execution contract: ownership, frozen interfaces, per-owner build steps, G0–G5 gates. |
| [interfaces.md](interfaces.md) | The frozen exports each module may depend on. |
| [workspace.md](workspace.md) | Where each owner's code lives. |

[spec.md](spec.md) is v1, kept only for the record. **Do not
build from it.** It specifies the Ring-LWE (lattice) ring signature that v2
replaced with FORS+C and an MPC-in-the-head proof, because no on-chain lattice
verifier exists anywhere and it was the highest-risk task in the build.

## Known contradiction — resolve before writing `spend()`

The spec and the V1 handoff PDF give **different nullifier definitions, and the
spec's version allows a double-spend.**

```
spec §6.4   nullifier = H(noteSecret, paymentContext)          ← wrong
PDF  p.3    nullifier = H(NULLIFIER_DOMAIN, noteSecret, poolId) ← correct
```

`paymentContext` contains `recipient`, so under the spec's version one note
yields a fresh nullifier for every recipient — the same deposit spends without
limit. The PDF states the rule correctly and says why. Until §6.4 is corrected,
**the PDF wins on this one point**, and it is the only place the two disagree
where the spec is not authoritative.

Four smaller discrepancies are open at the same time: the PDF says three relays
while §7.1/§8.2 say six (with three, every path visits every node and the Markov
hop selection does nothing); `MeshMessage.type` is plaintext, so PAYMENT and
QUERY are trivially separable and the cover-traffic argument in the context doc
does not hold as designed; `graph/schema.graphql` indexes `fundingSourceCluster`
per note commitment, which is a public per-member link the ring exists to
destroy; and the pool's `spend()` takes no authorization argument, so the
Chainlink CRE gate is advisory rather than enforced.

## What used to be here

This directory held the design for nonce0, a cross-chain key-exposure scanner,
and PQGuard, its authorization layer. Both were dropped when the project narrowed
to the payment stack. Nothing was lost:

```
git show 1dd4004:docs/<filename>      # read one file
git checkout 1dd4004 -- docs/         # restore the whole directory
```

Removed: `nonce0-complete-design.md` (+ `.pdf`), `nonce0-architecture.excalidraw`,
`pqguard-spec.md`, `privacy-layer-design.md` (+ `.pdf`), `scanner-design.md`,
`value-proposition.md`, `sponsor-plan.md`, `integration-brief.md`,
`integration-design.md`.

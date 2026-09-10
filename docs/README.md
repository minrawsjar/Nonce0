# opaque docs

## Read in this order

| Document | What it is |
|---|---|
| [context-doc_1.md](context-doc_1.md) | Full context handoff, including the decision log — *why* things were cut. Read §3 before reopening a settled debate. |
| [spec-v2.md](spec-v2.md) | The technical spec. Supersedes every earlier Opaque and PQGuard spec. |
| `output/pdf/opaque-v1-team-handoff.pdf` | The V1 execution contract: ownership, frozen interfaces, per-owner build steps, G0–G5 gates. |
| [interfaces.md](interfaces.md) | The frozen exports each module may depend on. |
| [workspace.md](workspace.md) | Where each owner's code lives. |
| [handoff-manan.md](handoff-manan.md) | Manan: PQ wallet (§5) — what exists, what is missing, and the three rules that matter. |
| [cre-key-origin.md](cre-key-origin.md) | What Chainlink CRE actually supports for encrypted inputs, and the sealing path that works without inventing an API. |
| [handoff-aditya.md](handoff-aditya.md) | Aditya: notes, selection, Graph and contracts — including the decision that blocks the pool. |

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

Three smaller discrepancies are open at the same time. A fourth is now closed:
the PDF said three relays while §7.1/§8.2 said six, and **§7.1 wins** — the mesh
runs six and draws three per payment. With three, every path visits every node
and the Markov hop selection decides nothing, which is the argument §7.1 was
making. `MIN_POOL_RELAYS` in `backend/mesh/contracts.ts` is the number, and
`bootstrap.ts` refuses a thinner pool rather than quietly narrowing it.
`MeshMessage.type` is plaintext, so PAYMENT and
QUERY are trivially separable and the cover-traffic argument in the context doc
does not hold as designed; `graph/schema.graphql` indexes `fundingSourceCluster`
per note commitment, which is a public per-member link the ring exists to
destroy; and the pool's `spend()` takes no authorization argument, so the
Chainlink CRE gate is advisory rather than enforced.

## §6.3 spike result — measured, not estimated

`backend/zk` implements the §6.2 statement and `node zk/bench.ts` runs the spike
§6.3 makes mandatory. Numbers, 219 repetitions (soundness 2^-128), ring of 8:

| | |
|---|---|
| Proof | 1.08 MiB (2.15 MiB as the `0x`-hex `PrivateSpend.proof` carries) |
| Prove / verify | 2.2 s / 2.0 s |
| Calldata alone, on Arc | 18.0M gas — 60% of a whole 30M block, before a gate runs |
| Verification, at a charitable 3 gas/gate | 270M gas — 9x a whole block |

**On-chain verification is NO-GO.** §6.5 said to put no number in the deck until
the spike produced one; this is the number. §2's "verified fully on-chain, no
proof system" cannot survive it, and no optimisation closes a 9x-a-block gap —
the EVM has no SHAKE and no raw keccak-f opcode either, so the random tapes
alone would have to be built in Solidity and run 438 times per spend.
Off-chain verification is GO at 2.0 s and stays publicly verifiable.

**The routing is decided: verify off-chain, enforce through the contract.**
`AttestedRingVerifier` is that decision in code. The ring proof is checked off
the chain; the contract enforces ring membership, single-use nullifiers, the
denomination and recipient, and a live attester key inside its few-time bound.

It changes §3 and the change is not hidden: a dishonest attester can approve a
spend no proof supports. It cannot learn who paid, because the proof it checks
is zero-knowledge, and it cannot forge undetectably, because the proofs are
publishable and re-verifiable. The rejected alternative was `SINGLE_NOTE_PQ`
(§6.3's own fallback — post-quantum, on-chain, and no anonymity at all), which
is still what the currently deployed Arc pool runs.
`backend/zk/README.md` has the full argument and the spec deviations it forced —
including that the in-circuit one-way function is AES-128, not keccak, and that
commitments and nullifiers are therefore 128-bit values right-padded into
`bytes32`. **NoteVault (T1) must derive notes through `backend/zk`, not hash its
own.**

Two smaller consequences: a 1.08 MiB proof does not fit the mesh, whose largest
padding class is 65,536 bytes, so payment submission is 17 messages and needs a
chunking rule; and `verifierId` binds the repetition count, so call sites must
pass `capabilities.verifierId` to `verifyRingSpend` or a self-consistent
4-repetition proof passes on its own terms.

## Superseded scaffolds, still present

`backend/opaque/{mesh,cre}` and `frontend/src/opaque/protocol` are the original
plain-JS stubs. The working implementations are `backend/mesh`, `backend/cre`
and `frontend/src/lib/protocol` (the path the handoff PDF specifies). The stubs
are still what `test/opaque-protocol.test.js` covers, so they are left in place
rather than deleted by one owner on another's behalf — but they are duplicates,
and two mesh definitions is how the two drift apart.

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

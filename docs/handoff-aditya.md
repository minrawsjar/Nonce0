# Handoff — Aditya · notes, selection, Graph, contracts

You own `packages/ring-client` (`@opaque/ring-client`), `graph`
(`@opaque/graph`), and `contracts`.

Read [spec-v2.md](spec-v2.md) §6.6, §8 and §6.3, plus
[backend/zk/README.md](../backend/zk/README.md) — the last one changes what you
can build in contracts, so read it before writing Solidity.

## The one thing to read first

**The ring proof already exists and works.** `@opaque/zk` is linked into your
package and exports `buildRingSpend`, `verifyRingSpend`, `deriveCommitment`,
`deriveNullifier`, `createNoteSecret`, `verifierId`, `RING_SIZE`,
`SECRET_BYTES`. You do not implement any cryptography. You implement the note
lifecycle and the selection algorithms *around* it.

**Never derive a commitment or nullifier yourself.** The proof proves *that
exact* derivation (AES-128 keyed by the note secret, not keccak — see the ZK
README for why). The stub this replaced hashed its own with sha256, which would
have verified against nothing. That is the single easiest way to lose a day here.

Proving at the default 219 repetitions takes **~2.2 seconds**. In tests pass a
small `reps` value or your suite will crawl.

## What is already there

Committed as `3ca4fe9`. **All of it typechecks and none of it is tested or
reviewed.** Strong drafts, not done.

| File | State |
|---|---|
| `ring-client/src/note-vault.ts` | `NoteVault` over injected `NoteStorage` + `ChainObserver`, with the `NoteState` machine and its guards. |
| `ring-client/src/selection.ts` | `selectDecoys`, `DEFAULT_SELECTION_POLICY`, age-diverse sampling, a crypto RNG. |
| `graph/src/path-policy.ts` | `MarkovPathPolicy implements PathSelectionPolicy` — the §8.2 chain. |
| `graph/schema.graphql` | Rewritten (+104 lines). **Unreviewed — check it against §8 before trusting it.** |

## What is missing, in build order

1. **Tests for all of the above.** Before anything new.
2. **`ring-client/src/ring-client.ts`** — implement the `RingClient` interface
   from `@opaque/protocol-types` exactly. `buildSpend` resolves and reserves the
   note internally, selects decoys locally, then calls `@opaque/zk`.
3. **`graph/src/client.ts`** — `GraphSelectionClient` over an injected fetch,
   plus a fixture-backed implementation for offline work.
4. **`index.ts` barrels** for both packages — the manifests already point at them.
5. **`contracts/`** — nothing is built yet. See the blocker below.

## Four rules that will bite

**The nullifier binds the note secret and the pool. Never the recipient.**
Spec §6.4 writes it as `H(noteSecret, paymentContext)` and `paymentContext`
contains the recipient — that version is **wrong and allows an unlimited mint**,
because one note then yields a fresh nullifier per recipient and spends without
limit. The handoff PDF has it right. `@opaque/zk` implements the correct rule; a
test asserting "same note, two recipients, same nullifier" is worth writing early.

**Selection order is the whole point of §8.1.** Apply the Sybil heuristics
*before* age diversity: exclude over-reused members, deprioritise an
over-represented `fundingSourceCluster`, prefer `hasOtherActivity`, and only
*then* weight toward `enrolledAt` diversity among the survivors. Doing age first
is exactly what made the original algorithm favour a freshly-deposited Sybil
batch.

**`fundingCluster` and `hasOtherActivity` are nullable, and null means
UNKNOWN.** Treating null as zero or false turns an absence of evidence into a
signal, which is worse than not having the heuristic.

**Selection is local, and it fails loudly.** Never ask a remote service to
exclude or locate the real note — that hands the correlation straight to whoever
answers. If the candidate set is too small or too poisoned, raise
`INSUFFICIENT_ANONYMITY` rather than padding a short ring; a 5-member ring
wearing an 8-member label is the one outcome the module exists to prevent. No
witness — not the secret, not the ring index — may appear in a `RingClient`
argument or return value.

## The subgraph has a live privacy bug

§8's hard constraint is: index the **eligible pool and aggregate statistics
only**, never which member or hop served a given payment. The pre-existing
schema stored `fundingSourceCluster` **per note commitment**, which publishes a
link between every note funded from the same source — precisely the linkage the
ring exists to destroy. The rewritten `schema.graphql` may or may not have fixed
this; verify it, and record what you changed and why in `graph/README.md`.

Same constraint applies to the events `PrivatePool` emits. An event that ties a
nullifier to a ring member undoes the design from the other side.

## Contracts are blocked on a team decision

Do not start `PrivatePool.spend()` until this is settled, because the current
interface **cannot be implemented**:

```solidity
function spend(bytes32[8] ring, bytes proof, bytes32 nullifier, ...)
```

`node backend/zk/bench.ts` measures the proof at **1.08 MiB**. Calldata alone is
18M gas against Arc's 30M block limit, and verification is ~9× a whole block at
a charitable estimate. On-chain ring verification is **NO-GO** and no
optimisation closes that gap.

Three routes, and picking one changes the **trust model**, so it is a team call
and not yours alone:

1. `SINGLE_NOTE_PQ` — §6.3's own stated fallback. On-chain, post-quantum, **not
   anonymous**. Already a `ProofMode` in the frozen contract.
2. CRE-verified — keeps anonymity, but puts a trusted party in a fund-safety path
   §3 currently promises is empty. Also needs the `spend()` authorization gap
   closed first.
3. Both, each labelled with the property it actually provides.

What you *can* build now regardless: `PQKeyRegistry.sol` (§5.2, with Manan), an
`IRingVerifier` seam so the pool never hardcodes a scheme, and a `capabilities()`
view that reports the truth — `proofMode`, `pqWallet: MOCK`, `graph: FIXTURE`,
`confidentialExecution: SIMULATED` — so a UI can never render a single-note
spend as eight-member anonymity.

Note for both: commitments and nullifiers are **128-bit values right-padded into
`bytes32`** (Solidity's `bytes16` widening). Anything with data past 16 bytes is
not a valid commitment.

`foundry.toml` already sets 1024 fuzz runs and 256 invariant runs, with a comment
saying the state machine is the risk and not the crypto. That is right — fuzz
deposit/spend/nullifier hard, and write at least one invariant: a spent nullifier
is never unspent, and the pool never pays twice for one nullifier.

## Commands

```sh
cd packages/ring-client && npx tsc --noEmit && node --test test/*.test.ts
cd graph            && npx tsc --noEmit && node --test test/*.test.ts
cd contracts        && forge build && forge test
node backend/zk/bench.ts     # the §6.3 numbers, reproducible
```

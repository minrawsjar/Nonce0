# Two settlement paths, and which one ships

The repository contains two ways to settle a private payment. That was not a
plan; it was two people solving §6.3 independently. This records what each one
actually is, what the chain can and cannot check in each, and the
recommendation — so the choice is made once, deliberately, rather than by
whichever contract someone deploys first.

Both were reconciled on one point before this was written: **neither has an
elliptic-curve key on its mint path any more.** See "What changed" below.

## The two

| | `PrivatePool` + `AttestedRingVerifier` | `CREAuthorizedPool` + `CREPolicyGate` |
|---|---|---|
| Custody | `PrivatePool` (unchanged, already deployed) | its own mappings, a second custody implementation |
| Authority | FORS+C via `PQKeyRegistry` | FORS+C via `PQKeyRegistry` |
| Shape | attestation presented inline with the spend | publish, then consume |
| Transactions per payment | 1 | 2 |
| `capabilities().proofMode` | `RING_8` | `ATTESTED_OFFCHAIN` |
| Ring checked on chain | **yes** — 8 members, each proven a real deposit | **no** — there is no ring in the contract |
| Anonymity set a chain reader can see | 8 | none |
| Fees | no | yes, validated exactly |
| Atomic multi-denomination settlement | no | yes, via `CREBatchSettlement` |

## The difference that decides it

`PrivatePool.spend` carries eight commitments in its calldata and refuses
unless every one of them is a real deposit. Anyone reading the transaction can
see the anonymity set and check it themselves.

`CREAuthorizedPool.settle` takes an authorization id. The word "ring" appears
in that file exactly once, in a comment. Whether eight candidates were ever
considered is a fact about the CRE, not about the contract, and **no reader of
the chain can verify it happened at all.**

Both trust an attester for soundness — that is inherent to verifying a 1.08 MiB
proof off-chain, and it is disclosed in both. Only one of them lets the chain
corroborate the privacy claim independently of that trust.

## Recommendation

**Ship `PrivatePool` + `AttestedRingVerifier`.** One custody contract, already
deployed and fuzzed; one fewer transaction per payment; and an anonymity set an
auditor can count without being told.

Two things must be carried across before the CRE path is retired, because they
are real requirements and the ring path does not have them:

1. **Fees.** `CREAuthorizedPool` validates `feeAmount` against `feeBps` exactly
   and pays the collector in the same transaction. `PrivatePool` has no fee
   concept. Adding one is a custody change and needs its own review.
2. **Atomic multi-denomination settlement.** Aditya's greedy decomposition
   turns 47 USDC into 20 + 20 + 5 + 2, which is four pools that must all settle
   or none. `CREBatchSettlement` does this over `settle(id)`; the equivalent
   over `PrivatePool.spend(...)` does not exist yet.

Until both exist, **keep both paths and keep them labelled.** That is now
enforceable rather than a matter of care: every pool answers `capabilities()`,
and `ATTESTED_OFFCHAIN` cannot be mistaken for `RING_8` by anything that reads
it. `backend/chain/pool.ts` refuses a mode it does not know rather than
guessing, and an interface that renders eight-member anonymity copy over an
`ATTESTED_OFFCHAIN` pool is lying about what a user is getting.

## What changed to make this comparable

`CREPolicyGate` authorised `publish` with `msg.sender == crePublisher` — a
secp256k1 address. Whoever held that key could publish an authorization for any
nullifier, to any recipient, and drain every pool pointing at the gate. In a
protocol whose whole claim is that no elliptic curve sits anywhere in its
application crypto, that was the one place the claim was untrue, and the place
it mattered most.

The distinction being drawn is not a purity argument. Every transaction on an
EVM chain is ECDSA-signed by whoever pays the gas, and that is unavoidable.
What is avoidable is making the **authority to move funds** an ECDSA key.
`PrivatePool` never did — `msg.sender` there pays for a deposit and authorises
nothing. The gate now matches.

Authority is a FORS+C signature verified through `PQKeyRegistry`, which also
enforces the few-time bound that makes such a signature safe. `msg.sender`
authorises nothing, so anyone may relay a signed batch: the CRE needs neither
gas nor a hot key, and a compromised relayer can only pay for a batch it cannot
alter.

`publish` takes a **batch** under one signature. FORS security decays with
every signature under one key, so one signature per payment would exhaust a key
in a day — and the batch is exactly the unit `CREBatchSettlement` settles.
Validation runs before the signing index is burned, so a batch with one bad
entry does not cost an index it never used.

## Open

Fees and atomic multi-pool settlement on the ring path, per above. Both are
custody changes and belong to whoever owns `PrivatePool` for that work.

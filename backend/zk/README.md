# Ring proofs (§6) — MPC-in-the-head

The §6.2 statement, built and measured:

> *I know a secret `S` whose one-way image equals one of these 8 note
> commitments, and this payment's nullifier is that same `S`'s image under a
> different, pool-bound block — without revealing which commitment.*

`node zk/bench.ts` runs the §6.3 spike. `npm test` runs 20 tests.

| | |
|---|---|
| Construction | ZKBoo (2,3)-decomposition, Fiat-Shamir |
| One-way function | AES-128 keyed by the note secret |
| Ring | 8 members, 3 secret index bits |
| Repetitions | 219 — soundness `(2/3)^219 < 2^-128` |
| Dependencies | `@noble/hashes` only (keccak256, SHAKE256) |

## §6.3 go/no-go

Measured on this machine, 219 repetitions, ring of 8:

| | |
|---|---|
| AND gates / repetition | 39,264 |
| XOR gates / repetition | 372,192 |
| Proof | **1.08 MiB** (2.15 MiB as `0x`-hex, which is what `PrivateSpend.proof` carries) |
| Prove | 2.2 s |
| Verify, off-chain | 2.0 s |
| Calldata alone, on Arc | 18.0M gas — **60% of a whole 30M block**, before a single gate runs |
| Verification, at 3 gas/gate | 270M gas — **9x a whole block** |

**On-chain verification: NO-GO.** Not close, and not an optimisation problem.
3 gas/gate is charity — it assumes one EVM operation per boolean gate with no
memory traffic and no loop overhead, where real Solidity spends 20–50. Three
things the model doesn't even price, each fatal on its own:

- The random tapes are SHAKE256. The EVM has no SHAKE and no raw keccak-f
  opcode — `KECCAK256` is the padded sponge — so an extendable-output function
  would have to be built in Solidity from scratch, then run 438 times.
- 438 view commitments per spend, each hashing ~4.8 KiB.
- 1.08 MiB exceeds ordinary transaction size limits before it is priced at all.

**Off-chain verification: GO**, at 2.0 s, and publicly verifiable — the proof is
a string of bytes anyone can check, no trusted party and no enclave. What
on-chain NO-GO removes is only the *pool's own* ability to check it.

§2 says the ring is "verified fully on-chain, no proof system". That sentence
cannot survive this measurement. Three ways forward, and **this is the team's
call, not this module's** — it changes the trust model, which is §3's territory:

1. **`SINGLE_NOTE_PQ`.** §6.3's own stated fallback, and already a `ProofMode`
   in the contract. Fully PQ, publicly verifiable, on-chain — and not anonymous.
   Say so in the README rather than downgrading the pitch quietly.
2. **CRE-verified.** The workflow verifies the proof in the enclave and the pool
   trusts its release. Keeps anonymity, and puts a trusted party in the
   fund-safety path — which §3 currently promises is empty. It also needs D1
   closed first: the pool takes no authorization argument today, so a valid
   spend can bypass the CRE entirely.
3. **Ship both, labelled.** Demo the real ring proof off-chain, settle through
   `SINGLE_NOTE_PQ`, and state exactly which property each half provides.

Nothing here says the ring is a dead end — only that a hash-only ring proof and
on-chain verification cannot both be true at this size.

## Deviations from the written spec

**The one-way function is AES-128, not keccak.** §6.4 and the §2 contract write
the commitment and nullifier as keccak preimages. Proving a keccak preimage
costs ~38,400 AND gates per call against AES-128's ~5,760, and the statement
needs two calls. AES is Picnic's reasoning applied unchanged, and it is why the
numbers above are 1 MiB rather than 8. keccak still derives the *public* block
constants, so domain separation and pool binding are untouched:

```
noteBlock  = keccak256(NOTE_DOMAIN,      poolId, denomination)[0..16]
nullBlock  = keccak256(NULLIFIER_DOMAIN, poolId)[0..16]
commitment = AES128(key = noteSecret, block = noteBlock)     -> bytes32, right-padded
nullifier  = AES128(key = noteSecret, block = nullBlock)     -> bytes32, right-padded
```

**Commitments and nullifiers are 128-bit**, right-padded into `bytes32` the way
Solidity widens `bytes16`. That is AES-128's security level and the soundness
target, not an encoding accident — but it is narrower than the type suggests,
and `narrow()` rejects any value with data past 16 bytes rather than truncating
one. **NoteVault (T1) must derive notes through `deriveCommitment` /
`deriveNullifier` here, not hash its own.**

**The nullifier does not bind the recipient**, matching the §2 contract and
contradicting the handoff PDF. §6.2 says binding the nullifier into the circuit
is what stops a proof being redirected to another payment context. Half of that
is right and half is not: the nullifier *is* proven in-circuit, but it cannot
depend on the recipient — a nullifier that varied per recipient would let one
note be spent once per recipient, without limit. Redirection is prevented
instead by the Fiat-Shamir challenge, which binds `verifierId`, `poolId`,
`chainId`, `denomination`, `recipient`, `paymentContext`, the ring and the
nullifier. Both properties hold; they just come from different places.

## What each file is

| | |
|---|---|
| `bits.ts` | The three evaluators: plain (and gate-counting), prover, verifier |
| `aes.ts` | AES-128 as a circuit, written once against `Gates` |
| `statement.ts` | Derivations, the ring statement, the 8-way multiplexer |
| `zkboo.ts` | Prover, verifier, Fiat-Shamir, wire format |
| `spend.ts` | `PrivateSpend` in and out — what `RingClient` reduces to |
| `index.ts` | The public surface; everything else is internal |

The circuit is written **once**, against an interface, and run under a
different backend per role. A prover and a verifier that are two transcriptions
of "the same" circuit are one typo away from a system that accepts nothing —
or, worse, one that accepts anything. It also means the FIPS-197 test vector is
evidence about the prover, not about a second implementation that happens to
agree with the test.

The S-box is derived, not copied: GF(2^8) inversion by an Itoh-Tsujii addition
chain, then the FIPS-197 affine map, at 108 AND gates. The published
Boyar-Peralta circuit does it in 32 and would cut the proof to ~350 KiB — the
obvious next optimisation, and it does not change the go/no-go. It is ~115
hand-copied gates, and a typo in it is invisible until it is a soundness bug,
so it is worth doing deliberately rather than in passing.

## Integration notes

- **The proof does not fit the mesh.** `SIZE_CLASSES` tops out at 65,536 bytes,
  so 1.08 MiB is 17 messages. Payment submission needs either chunking with a
  reassembly rule at the egress, or a larger class — and a larger class is not
  free, because every padding class is also a traffic-analysis bucket.
- `verifyRingSpend(spend, capabilities.verifierId)` is the call sites should
  make. `verifierId` includes the repetition count, so a 4-repetition proof is
  a *different verifier*, not a cheaper one; without the second argument a
  self-consistent 2^-2.3 proof passes. Both cases are tested.
- Ring order is the canonical ascending sort, and `verifyRingSpend` enforces
  it. Order can therefore never encode the spender's index, and one spend
  cannot have two `spendHash`es.
- Selection stays in the caller (T6). This module is handed 7 decoys and never
  asks anyone to exclude or locate the real note.

## What this does not claim

Off-chain verification is public, not trustless-on-chain. Timing and size are
unprotected: every proof is the same size, but a spend is 17 mesh messages and
a query is one. ZKBoo is honest-verifier zero-knowledge made non-interactive by
Fiat-Shamir in the random-oracle model — standard, and worth stating rather
than implying something stronger. And 219 repetitions is 128-bit soundness
*for this construction*; it is not a statement about the anonymity set, which
is 8.

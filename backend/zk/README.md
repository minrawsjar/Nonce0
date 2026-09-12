# ZK: The Ring Proof

> **ZKBoo (MPC-in-the-head), AES-128 and keccak. Runs in Node and in the browser. 20 tests.**

The proof behind every private payment:

> *I know a secret `S` whose one-way image equals one of these 8 note commitments, and this payment's nullifier is that same `S`'s image under a different, pool-bound block. I am not saying which commitment.*

It uses hashes and a block cipher only, so no part of it falls to a quantum computer the way elliptic-curve proofs do. The wallet builds it in a Web Worker; the executor verifies it before the attester signs.

| | |
|---|---|
| **Construction** | ZKBoo (2,3)-decomposition, made non-interactive with Fiat-Shamir |
| **One-way function** | AES-128 keyed by the note secret |
| **Ring** | 8 members, 3 secret index bits |
| **Repetitions** | 219, so soundness is `(2/3)^219 < 2^-128` |
| **Dependencies** | `@noble/hashes` only (keccak256, SHAKE256) |

## Measured

`node zk/bench.ts`, 219 repetitions, ring of 8:

| | |
|---|---|
| AND gates per repetition | 39,264 |
| XOR gates per repetition | 372,192 |
| Proof | **1.08 MiB** (2.15 MiB as the `0x`-hex that `PrivateSpend.proof` carries) |
| Prove | 2.2 s |
| Verify, off chain | 2.0 s |
| Calldata alone, on Arc | 18.0M gas: **60% of a 30M block**, before a single gate runs |
| Verification, at 3 gas per gate | 270M gas: **9 times a block** |

**On-chain verification is not possible, and no optimisation closes the gap.** Three gas per gate is generous: real Solidity spends 20 to 50. And three costs the model does not even count are each fatal alone:

- The random tapes are SHAKE256. The EVM has no SHAKE and no raw keccak-f opcode, so an extendable-output function would have to be built in Solidity and run 438 times.
- 438 view commitments per spend, each hashing about 4.8 KiB.
- 1.08 MiB exceeds ordinary transaction size limits before it is priced at all.

**Off-chain verification works**, at 2.0 s, and stays publicly verifiable: the proof is a string of bytes anyone can check. What the on-chain limit removes is only the pool's own ability to check it.

## What We Did About It

Opaque verifies the proof off chain and enforces the result on chain. [`AttestedRingVerifier`](../../contracts/src/opaque/pool/AttestedRingVerifier.sol) accepts a spend when an attester's post-quantum signature approves it, and the pool still checks that all eight members are real deposits, the nullifier is fresh, and one denomination goes to the bound recipient. A dishonest attester could approve a spend no proof supports; it cannot learn who paid, and anyone can re-verify a published proof. [docs/settlement-paths.md](../../docs/settlement-paths.md) compares this with the alternatives.

The proof reaches the attester through the relay mesh in chunks of 32,640 bytes, about 35 per payment, reassembled at the exit ([docs/proof-transport.md](../../docs/proof-transport.md)).

## Deviations from the Written Spec

**The one-way function is AES-128, not keccak.** Proving a keccak preimage costs about 38,400 AND gates per call against AES-128's 5,760, and the statement needs two calls. That is Picnic's reasoning applied unchanged, and it is why the proof is 1 MiB rather than 8. Keccak still derives the public block constants, so domain separation and pool binding are untouched:

```
noteBlock  = keccak256(NOTE_DOMAIN,      poolId, denomination)[0..16]
nullBlock  = keccak256(NULLIFIER_DOMAIN, poolId)[0..16]
commitment = AES128(key = noteSecret, block = noteBlock)     -> bytes32, right-padded
nullifier  = AES128(key = noteSecret, block = nullBlock)     -> bytes32, right-padded
```

**Commitments and nullifiers are 128-bit**, right-padded into `bytes32` the way Solidity widens `bytes16`. That is AES-128's security level and the soundness target. `narrow()` rejects any value with data past 16 bytes rather than truncating it. Anything that derives notes must call `deriveCommitment` and `deriveNullifier` here rather than hash its own.

**The nullifier does not bind the recipient.** A nullifier that varied per recipient would let one note be spent once per recipient, without limit. Redirection is stopped instead by the Fiat-Shamir challenge, which binds `verifierId`, `poolId`, `chainId`, `denomination`, `recipient`, `paymentContext`, the ring and the nullifier.

## Folder Structure

```
backend/zk/
├── bits.ts          # The three evaluators: plain (and gate-counting), prover, verifier
├── aes.ts           # AES-128 as a circuit, written once against Gates
├── statement.ts     # Derivations, the ring statement, the 8-way multiplexer
├── zkboo.ts         # Prover, verifier, Fiat-Shamir, wire format
├── spend.ts         # PrivateSpend in and out
├── index.ts         # The public surface; everything else is internal
├── bench.ts         # The measurements above
├── *-vectors.ts     # Fixtures the Solidity tests check
└── test/zk.test.ts
```

The circuit is written **once**, against an interface, and run under a different backend for each role. A prover and a verifier written as two copies of "the same" circuit are one typo away from a system that accepts nothing, or one that accepts anything. It also means the FIPS-197 test vector is evidence about the prover itself.

The S-box is derived, not copied: GF(2^8) inversion by an Itoh-Tsujii addition chain, then the FIPS-197 affine map, at 108 AND gates. The published Boyar-Peralta circuit does it in 32 and would cut the proof to about 350 KiB. That is the obvious next optimisation, and it is about 115 hand-copied gates where a typo is a soundness bug, so it is worth doing deliberately.

## Integration Notes

- **Call `verifyRingSpend(spend, capabilities.verifierId)`.** `verifierId` includes the repetition count, so a 4-repetition proof is a different verifier, not a cheaper one. Without the second argument a self-consistent 2^-2.3 proof would pass. Both cases are tested.
- **Ring order is the canonical ascending sort**, and `verifyRingSpend` enforces it. Order can never encode the spender's index, and one spend cannot have two `spendHash`es.
- **Selection stays with the caller.** This module is handed seven decoys and never asks anyone to exclude or locate the real note.

## What This Does Not Claim

Off-chain verification is public, not trustless on chain. Every proof is the same size, but a payment is many mesh chunks and a query is one, so size and timing are not hidden by the proof. ZKBoo is honest-verifier zero-knowledge made non-interactive by Fiat-Shamir in the random-oracle model: standard, and worth stating rather than implying something stronger. And 219 repetitions give 128-bit soundness for this construction. The anonymity set is still 8.

## Usage

```bash
cd backend
npm test             # includes zk/test
node zk/bench.ts     # the measurements
```

# Getting a ring proof to the attester

**Status: open. Blocks every RING_8 payment.** Found while wiring the wallet.

## The problem

§6.3 measured the ring proof at 1.08 MiB, concluded it could not be verified
on chain, and routed verification off chain to an attester. Nobody checked
that the off-chain path can *carry* 1.08 MiB. It cannot. Every hop is capped
well below it:

| Hop | Cap | A ring spend |
|---|---|---|
| Mesh, largest size class | 64 KiB | 2,203 KiB |
| Sealed intent (enclave input) | 128 KiB | 2,203 KiB |
| Executor request body | 256 KiB | 2,203 KiB |

Measured (`buildRingSpend`, 219 reps, soundness 2⁻¹²⁸):

| | Size |
|---|---|
| Proof, binary | 1,101 KiB |
| Proof, as hex — how it travels today | 2,202 KiB |
| gzip / brotli | 1,101 KiB — **incompressible** |

The proof is essentially random seeds and commitments, so compression buys
nothing. Sending it as binary instead of hex halves it for free, but that still
leaves it 17× the largest mesh message.

## Not options

- **Fewer repetitions.** Soundness falls with every one removed. The attester
  now refuses anything below 219 — an unpinned check accepted a 4-rep proof,
  which is forgeable by guessing, and would have signed it.
- **The wallet verifies its own proof.** The attester is the party that has to
  verify; that is the entire trust model.

## Options

**1. Chunk it through the mesh — recommended.** Seal the whole spend to the CRE
key, split the *ciphertext* into ~18 messages at the 64 KiB class, reassemble
at the exit into one sealed intent, forward to CRE.

- Keeps the privacy model. Every chunk is byte-identical to any other message
  at its size class, and relays never see a group id — it sits in the innermost
  layer. The exit already sees the whole intent, so grouping there reveals
  nothing new.
- ~18 messages and ~3.4 MB relayed across three hops per payment.
- A burst of 18 from one client is a fingerprint. The scheduler's batching and
  delay has to spread them, or the wallet has to add cover traffic.
- The sealed-intent cap must rise to ~1.2 MiB, and the **enclave must be shown
  to cope**: CRE runs Javy/QuickJS, where memory is tight and a ZKBoo verify
  that takes 2 s in V8 has not been measured at all.

**2. Upload the sealed proof out of band; send the small intent through the
mesh.** Much less work. But the uploader's IP, a 1.1 MiB sealed blob and the
timing together say "this address is making a ring payment now" — the
network-layer metadata the mesh exists to hide. It spends the payer's network
privacy to save engineering.

**3. A smaller proof system.** KKW, Limbo and Ligero-style MPC-in-the-head
proofs are several times smaller than ZKBoo at the same 2⁻¹²⁸. That is the real
long-term fix, and it is a change to `backend/zk` needing its own review and
benchmarks — not something to rush.

## Recommendation

**Option 1 now, with binary encoding, and option 3 as the follow-up.** Option 2
gives away exactly the property the mesh was built for.

Before committing to option 1, measure the enclave: run a 1.1 MiB sealed intent
and a full ZKBoo verify through `cre workflow simulate`. If QuickJS cannot
verify it in time, that pushes toward option 3 regardless of transport.

## What already works

Everything either side of the transport: the attester
(`backend/cre/attest.ts`, checked against the deployed contracts' own view
functions), the CRE stand-in (`backend/cre/simulator.ts`), the RING_8 pool on
Arc, and the mesh itself. The tests blocked on this are marked `todo` in
`backend/cre/test/simulator.test.ts`, with this page as the reason.

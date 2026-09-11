# Deployed addresses — Arc Testnet

> **The source of truth is [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).**
> Code reads it, never this page. The backend, the frontend, the deploy scripts
> and the subgraph renderer all import that one file, and
> `backend/chain/test/deployments.test.ts` checks every address in it against
> the live chain. This page explains the deployment; it does not define it.

Chain **5042002**. Explorer: [testnet.arcscan.app](https://testnet.arcscan.app).

## The current stack — the one to use

Deployed by `script/DeployPQStack.s.sol`, then `script/DeployRingPool.s.sol`.
The registry, the ring verifier and the pool were redeployed together with the
PQ accounts, so that an attester key that runs out hands over to its
pre-committed successor instead of locking the pool (see *The attester* below).

| Contract | Address | Block |
|---|---|---|
| `PQKeyRegistry` | `0x6eb5b42373191121d31dfc4b5c8571c4eaf58e8f` | 61450879 |
| `PQValidator` (ERC-7579 validator) | `0xfad5b4149489eaf9bbe402eca4b26f9284046ea2` | 61450879 |
| `PQAccount` (implementation; accounts are EIP-1167 clones) | `0xeccec6b1e6a2e5367902675c49e577633f705012` | 61450879 |
| `PQAccountFactory` (1 USDC staked in EntryPoint v0.7) | `0x13beaec42922e3f63fa0dbe5bba270edf46ab214` | 61450880 |
| `RelayDirectory` | `0xcf588b5b8ab2fa11ccf28a5c0631da4269a36653` | 61450880 |
| `AttestedRingVerifier` | `0x1b501bbcb3bd32645da3508f7779f8c196a28c85` | 61451611 |
| `PrivatePool` (RING_8, 1 USDC) | `0x7e01b8a883b4dacc9063326a2e7d3eef0d679b63` | 61451614 |
| `PrivatePool` (RING_8, 2 USDC) | `0xa69bab9439c911fa31cfbe5138abdb2ae04d523a` | 61557097 |
| `PrivatePool` (RING_8, 5 USDC) | `0xf4855f6b0988ebf4f6bd203f284e0d370594da9c` | 61557167 |
| `PrivatePool` (RING_8, 10 USDC) | `0x2770e5c2f491fcf0c8a411f6c2c8064214e1e284` | 61487364 |
| `PrivatePool` (RING_8, 20 USDC) | `0x4d3ab56e38c6297030ea7c63d3ed046472cebde9` | 61557213 |
| `PrivatePool` (RING_8, 50 USDC) | `0xae69f3c02d0c98cd8b4a006353d117c8cea23af4` | 61557255 |
| `PrivatePool` (RING_8, 100 USDC) | `0x0d8dff9b4903a1b550037bac773e9757f1f4d823` | 61487385 |
| attester (account) | `0x8d47981ac51628fa19bf8b32afdda09f2d72d257` | registered in the registry above |

| Service | Where |
|---|---|
| Subgraph (Subgraph Studio, `arc-testnet`) | `https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0` |
| Stack: six relays, exit, egress | `https://opaque-stack-production.up.railway.app` ([hosting.md](hosting.md)) |
| CRE workflow `opaque-confidential-release` (decides every payment, in a Nitro enclave) | [`opaque-cre/`](../opaque-cre/README.md), polls the stack every 30 s |
| Bundler (EntryPoint v0.7) | Pimlico's keyless public endpoint, `https://public.pimlico.io/v2/5042002/rpc` |
| Relay operator (announces and reports health) | `0x07b31f4c273a2b034a57ab6c563d546cb2b56d20` |

Read back from the chain: `capabilities()` returns `RING_8`, ring size 8,
`requiresCommitReveal` **false**: one transaction per spend, and no two-block
wait.

### The attester

The verifier trusts exactly the attester above, whose FORS key is registered
with `maxUses = 32`. The stack keeps it alive (`backend/cre/attester-keys.ts`):

- Every generation derives from one master secret.
- When 4 signatures are left, it rotates to the pre-committed next key.
- If a key is ever exhausted anyway, for example by a crash at the wrong
  moment, `PQKeyRegistry.takeover` lets the next key take the account over.

The attester's address is immutable in the verifier, so this is what stands
between a busy pool and a locked one.

The attester registered from its own address, because the registry binds a
key to `msg.sender` at registration, and that is the only thing `msg.sender`
ever authorises there. Its ECDSA key has had no power since, and it is
deliberately not the deployer.

### PQ accounts

A wallet's account is a clone at a CREATE2 address that commits to its FORS
key commitments. Its keys never leave the browser, and anyone may deploy the
account, since it comes out the same whoever does. `PQValidator` checks
`registry.consume` against the whole v0.7 `userOpHash`; a bad signature
returns `SIG_VALIDATION_FAILED` instead of reverting, and burns nothing. The
registry reads `block.timestamp` only while a disable is pending, so ordinary
operations pass ERC-7562's opcode rules at a public bundler.

### The Graph and the relay directory (§8)

The stack announces its six relays to `RelayDirectory`. Each announcement
carries:

- the id, which is the directory's id right-padded to 32 bytes;
- `keccak256` of the relay's KEM key;
- a key epoch that only moves forward.

After that it reports aggregate health every 10 minutes: the share of messages
handed on, messages per batch, and how often the relay was picked.

The subgraph indexes that feed, plus the pools: deposits, `RingUsed` (the
whole ring, never the signer) and `DepositFrom`. `DepositFrom` is published
only as a 0–3 funding-concentration bucket, and only once 5 notes share a
funder.

At the exit:

- Ring **membership** comes from the chain, and the Graph's use counts and
  buckets weigh it.
- Relay **keys** come from the signed directory. Graph health only weighs
  them, clamped so it cannot exclude a relay.

### The relay directory's trust root

The wallet compiles in `mesh.trustRoot` from `deployments/arc-testnet.json`:
the FORS signer of the first weekly directory, derived from `MESH_MASTER`.
Every week the stack serves a new directory, signed by the key the previous
one committed to, and the wallet walks that chain from its compiled root.
Neither `stack.json` nor anything else from the network can substitute a
root. Genesis is `1789076990` (2026-09-10).

### Settled on this stack

| | Tx | |
|---|---|---|
| Private payment, from opaque.credit | `0xf83b2cf4e750b2dab07922b79449635f69a5ee98b7945268ff72087dee821170` | block 61452895, 559,566 gas, 9,764 bytes of calldata; `RingUsed` names all 8 members |
| Private payment of a note the page's PQ account deposited, from opaque.credit | `0x42b7f49ae1a3c1e9ab2138b440f6e27920e6ae7afc1fe77e1296edc193005936` | block 61459041, 560,604 gas; the deposit was a FORS-signed UserOperation and the note settled in an 8-member ring 73 s after the page loaded |
| PQ account deposit (`backend/chain/e2e-pq-account.ts`) | `0x7d5e9cbd35535018000f09193a3c07a8387f95ada94b857650fe44d510a5ea64` | a UserOperation signed by the account's FORS key alone, bundled by Pimlico, 666,729 gas paid by the account; key use 0 → 1 of 32 |

The pool was seeded with 8 decoy notes by `backend/chain/seed-ring.ts`, all
from one address. That does not reveal which member a spend used, because the
proof is zero knowledge. But it is a test ring, not an anonymity set. Their
secrets are in `backend/.env`.

One member is junk: an early `e2e-pq-account.ts` run deposited a fully random
bytes32, which can never sit in a ring of 128-bit images. The pool accepts any
bytes32, so anyone could do this on purpose. Decoy selection skips such
members (`packages/ring-client/src/selection.ts`) instead of failing the spend.

### Retired

The first RING_8 pool, `0x8B54Cc1B008eafA270740D847e45954f10DBf150`, and its
verifier, `0xA06A0488D2ddfb267cC6F090b97Bfc2Bd9870612`, trusted the same
attester under the first registry. That registry had no way out of an
exhausted key. Their first private settlement was
`0x33e7378cbd43796fb5915b75289dce899e3c645487c0d77667fe2164e6a073da`
(555,988 gas). The 5 unspent decoys there are kept, not reused.

**Do not deposit a RING_8 note into the SINGLE_NOTE_PQ pool below, or the
reverse.** A RING_8 commitment is AES-based; the single-note verifier recomputes
a keccak one and will never match it. That deposit is locked for good.
`poolFor()` requires the proof mode for exactly this reason.

## The original deployment — SINGLE_NOTE_PQ

| Contract | Address |
|---|---|
| `PQKeyRegistry` (the first one; this pool keeps it) | `0x7FC11e0f5d224439b2d710BB1c141913F454eF17` |
| `SingleNotePqVerifier` | `0x8ad3c8f52F17B0F62a4dA3c3A1905a04E114B015` |
| `PrivatePool` | `0x4cfa5843453E782924Bfa7cE6a9E3dAd713Da995` |

Deployed for ~0.173 native USDC across 3,842,743 gas.

## Read back from the chain, not from the deploy log

```
poolId()        0x8cb955f1f499121225a6486af6c148f8b55d7a97534c74aabb0e5fecb6118706
denomination()  1000000            1 USDC, six decimals
token()         0x3600…0000        Arc USDC: symbol "USDC", decimals 6
verifier()      0x8ad3…B015        matches the deployed verifier
capabilities()  proofMode=1  ringSize=1  requiresCommitReveal=true
```

## What this deployment is, stated plainly

**`proofMode = 1` is `SINGLE_NOTE_PQ`, and `ringSize = 1`.**

This pool is quantum-safe and **not anonymous on-chain**. It makes no
depositor-to-spend unlinkability claim, and an interface that renders
eight-member anonymity copy over it is lying about what a user is getting.
`capabilities()` exists precisely so a UI reads the answer instead of assuming
it.

This is §6.3's documented fallback, and **it is no longer the routing the
project has chosen.** The decision has since been made: verify the ring proof
off-chain, enforce the result through the contract. `AttestedRingVerifier`
implements it, reports `RING_8` / `ringSize 8` / `requiresCommitReveal false`,
and is fully tested — but the addresses above predate it, so **this deployment
still runs the single-note verifier**.

Moving to it means a new pool: `PrivatePool.verifier` is immutable, and
`poolId` derives from the pool's own address. That is the seam working as
intended rather than a problem — custody code does not change — but it is a
redeploy and a migration of deposits, not a switch to flip.

`requiresCommitReveal = true` follows from the same choice: a single-note spend
publishes enough to re-spend the note, so the reveal is front-runnable and the
pool's two-phase flow is mandatory. A ring proof binds its recipient into its
own challenge and would not need it.

## Swapping the verifier later

The pool reads its mode through the `ISpendVerifier` seam, so replacing the
verifier does not touch custody. What it does change is what `capabilities()`
reports, which is the value every interface is required to read.

Under `AttestedRingVerifier` those values become `proofMode RING_8`,
`ringSize 8`, `requiresCommitReveal false` — and that last one removes a
transaction and a two-block wait from every payment, because an attested spend
binds its recipient and has nothing left worth front-running.

`verifierId` is the field that carries the trust model. It commits to the
attester's address, so two pools differing only in who attests cannot be
confused for one another by anything reading capabilities.

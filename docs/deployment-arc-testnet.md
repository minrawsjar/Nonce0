# Deployed addresses — Arc Testnet

> **The source of truth is [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).**
> Code reads it, never this page. The backend, the frontend, the deploy scripts
> and the subgraph renderer all import that one file, and
> `backend/chain/test/deployments.test.ts` checks every address in it against
> the live chain. This page explains the deployment; it does not define it.

Chain **5042002**. Explorer: [testnet.arcscan.app](https://testnet.arcscan.app).

## The RING_8 path — the one to use

Deployed after the §6.3 routing decision, by `script/DeployRingPool.s.sol`.

| Contract | Address | Block |
|---|---|---|
| `AttestedRingVerifier` | `0xA06A0488D2ddfb267cC6F090b97Bfc2Bd9870612` | 61403357 |
| `PrivatePool` (RING_8, 1 USDC) | `0x8B54Cc1B008eafA270740D847e45954f10DBf150` | 61403359 |
| attester (account) | `0x8D47981aC51628FA19Bf8b32afDDa09f2d72d257` | registered 61403368 |

Read back from the chain: `capabilities()` returns `RING_8`, ring size 8,
`requiresCommitReveal` **false** — one transaction per spend, no two-block
wait. The verifier trusts exactly the attester above, and that attester's FORS
key is registered in `PQKeyRegistry` with `maxUses = 32`. **It must rotate
before its 33rd attestation**; the registry refuses the 33rd rather than
letting forgery odds climb.

The attester registered from its own address, because the registry binds a
key to `msg.sender` at registration — the only thing `msg.sender` ever
authorises there. Its ECDSA key has had no power since. It is deliberately not
the deployer.

**Do not deposit a RING_8 note into the SINGLE_NOTE_PQ pool below, or the
reverse.** A RING_8 commitment is AES-based; the single-note verifier recomputes
a keccak one and will never match it. That deposit is locked for good.
`poolFor()` requires the proof mode for exactly this reason.

## The original deployment — SINGLE_NOTE_PQ

| Contract | Address |
|---|---|
| `PQKeyRegistry` | `0x7FC11e0f5d224439b2d710BB1c141913F454eF17` |
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

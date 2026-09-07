# Uniswap v4 developer feedback

**Form:** https://forms.gle/  ← replace with the Uniswap Developer Feedback Form URL
**Status:** `[ ] submitted`

> This is a hard qualification requirement that lives outside the repo and is
> trivially forgotten at 4am. Tick the box above the moment it is sent, and do it
> before the videos, not after.

Append entries as friction is hit. Reconstructed-after-the-fact feedback reads
exactly like what it is, and it is the half of the submission that is actually
useful to the people receiving it.

---

## 2026-09-07 — hook address permission bits are the first wall

The thing that takes longest to internalise about v4 is that a hook's permissions
are not configuration, they are **the low bits of its own address**. The
consequence only lands a step later: a hook cannot be upgraded in place, because
changing which callbacks it implements changes which address it is allowed to
occupy.

For PQGuard this turned out to be load-bearing rather than an obstacle. We wanted
an interception point for outflows from a pool whose admin key is compromised, and
`beforeSwap` / `beforeRemoveLiquidity` in the hook is the only place that exists —
a Safe guard sits too high and an Ownable adapter sits to the side. So the design
constraint picked the integration point for us.

What cost time: mining a salt that yields an address with the right permission
bits is a build-time step with no obvious signpost from the "write a hook"
entry point. `HookMiner` in v4-periphery solves it, but the path from
"my hook reverts on deploy" to "my address does not encode the flags I declared"
is not short, and the revert does not say so.

*Docs path taken:* hooks overview → `Hooks.sol` permission bit constants →
`HookMiner` in v4-periphery test utils.

---

## Notes to expand before submitting

- [ ] Whether `beforeSwap` returning a delta is the right shape for a rate limiter
      that wants to *queue* excess rather than revert it.
- [ ] Duplicate OpenZeppelin resolution after `forge install Uniswap/v4-periphery`
      alongside a top-level OZ — run `forge remappings | grep openzeppelin`.
- [ ] Whether there is a supported way to enumerate deployed hooks other than
      `eth_getLogs` on PoolManager `Initialize`.

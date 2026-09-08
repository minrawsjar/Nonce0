# Handoff — Manan · PQ wallet (§5)

You own `packages/pq-wallet` (`@opaque/pq-wallet`) and, with Aditya,
`contracts/src/opaque/wallet/PQKeyRegistry.sol`.

Read [spec-v2.md §5](spec-v2.md) first. Everything below assumes it.

## What is already there

Two files, committed as `3ca4fe9`. **They typecheck under the strict config and
that is the only claim — there are no tests and no review yet.** Treat them as a
strong draft, not as done.

| File | State |
|---|---|
| `src/digest.ts` | Looks complete. The §5.3 digest over all six fields, keccak256, length-prefixed, inputs validated at the boundary. |
| `src/fors.ts` | `keyGen` / `sign` / `verify` / `pkCommitment` / `encodeSignature` / `decodeSignature`, with `FORS_C_DEFAULT = { k: 32, a: 8 }`. |

Two things in `digest.ts` are worth keeping when you refactor. It hashes
**keccak256 from `@noble/hashes/sha3.js`** — Node's `sha3-256` is a *different
function* with different padding, and the stub this replaced had exactly that
bug. And it encodes **length-prefixed**, never `a + ':' + b`: a separator that
can occur inside a field is not a separator, and `"a:b" + "c"` hashing the same
as `"a" + "b:c"` is a real forgery, not a style question.

## What is missing, in build order

1. **Tests for what exists.** Before anything new. At minimum: sign/verify round
   trip; a tampered signature fails; a tampered digest fails; a signature under
   one key does not verify under another; `encodeSignature`/`decodeSignature`
   round-trips and rejects truncated input.
2. **`src/registry.ts`** — the `PQKeyState` machine from §5.2, in memory.
3. **`src/wallet.ts`** — implement the `PqWallet` interface from
   `@opaque/protocol-types` exactly. It is frozen; do not add to it.
4. **`src/index.ts`** — the barrel. `package.json` already points `exports` at it.

## The three rules that actually matter

**Rotation is authenticated by the current PQ key and by nothing else.** No
owner, no admin, no ECDSA guardian, no upgrade hatch. A quantum adversary
holding any such fallback would rotate `pkCommitment` to a key it controls and
own the wallet — which defeats the entire point of the wallet existing. Write a
test asserting no such path exists, in TypeScript *and* in the Solidity registry.

**FORS is a *few*-time signature, so `maxUses` is a security parameter, not a
quota.** `fors.ts` already records the forgery bound in a comment:
`(1 - (1 - 2^-a)^q)^k` at `k=32, a=8` gives 2⁻²⁵⁶ at one signature, 2⁻¹⁶⁰ at
eight, 2⁻¹²¹ at thirty-two. Security **degrades with every signature**. So
`useCount` must be checked on every verification and the state machine must
*refuse* past `maxUses` rather than continue quietly.

**Never decrement `localSigningReservations` to match the chain.** The frozen
contract separates it from `chainUseCount` deliberately. If a signature was
issued but its transaction has not landed, the index is still burned — resetting
the local counter to the chain's view reissues that index, which is precisely
the reuse FORS degrades under.

## One number to get, early

§5.5 says benchmark rather than hand-wave, so: at `k=32, a=8` a signature is
**9,251 bytes** (`3 + 32 + k·32·(1+a)`), and verification is `k·(1+a)` = **288
keccak calls** plus the roots hash.

That is worth measuring on testnet soon, because — unlike the ring proof — it
looks *comfortably* affordable on-chain. Rough order: ~150k gas of calldata plus
the hashing, well inside Arc's 30M block. If that holds, the PQ wallet path is
the part of this protocol that genuinely works on-chain today, which is worth
knowing before the demo is scripted. Measure it; don't quote my estimate.

## Commands

```sh
cd packages/pq-wallet
npx tsc --noEmit
node --test test/*.test.ts
```

## Boundaries

`packages/protocol-types` is frozen — needing something added to it is a
cross-team change, not an edit. The ring module talks to you only through the
signature-scheme shape (`keyGen`/`sign`/`verify`/`pkCommitment`) plus the §5.3
digest; nothing outside §5 should reference FORS internals like `k`, `a` or the
tree structure. That boundary is what lets you re-parameterise after
benchmarking without touching anyone else's code.

FORS+C authenticates **wallet-level actions only** — deposits, intent
submission, key rotation. It plays **no part** in the anonymous spend: a note
secret is the spending authority there (§6.1). If you find yourself proving a
FORS signature inside the ring circuit, stop — that was the v1 design and it was
abandoned because it makes the circuit enormous.

# nonce0 + Project X — integration brief

**Decision: Project X is integrated into nonce0.** This brief records what is already
established, so nobody re-derives it. Written 2026-09-07.

## The product thesis the merge creates

nonce0 today ends in a warning. Merged, it ends in an action:

> **diagnosis → treatment → destination.**
> nonce0 finds the exposed keys. PQGuard protects the authority path.
> Project X is the only destination that is *permanently* post-quantum.

The argument that makes this non-decorative, and it is a strong one:

**A fresh EOA is safe for exactly one transaction.** Migrating an exposed key to a new
EOA has a half-life of one spend — nonce 0 today, exposed the moment it signs. A
shielded note authorized by a lattice ring signature has no ECDSA key to expose, ever.

**Mass migration is itself a deanonymization event.** At Q-day everyone moves at once
and every escape transaction is public: `0xABC -> 0xDEF`, ten million times. The
old-to-new mapping is a graph anyone builds in an afternoon, and every wallet's entire
history follows it to the new address. The largest forced address migration in crypto
history would also be the largest deanonymization event in crypto history. A shielded
pool is the only destination that severs that link, because ten million edges into one
pool address is not a mapping.

**Precision required in the threat model:** what is severed is **deposit -> spend**, not
**identity -> deposit**. The arm transaction and the deposit are public. All anonymity
lives in the ring at spend time. This is why ring integrity (below) is load-bearing
rather than a nice-to-have.

## VERIFIED findings — do not re-litigate

**1. The EIP-7702 migration tier does not hold.** Verified against the EIP text:
authorization is `[chain_id, address, nonce, y_parity, r, s]`, recovered by
`ecrecover(keccak(MAGIC || rlp([chain_id, address, nonce])), y_parity, r, s)` — ECDSA
over secp256k1, processed *before* the execution portion of the transaction, and the
spec provides no mechanism for delegated code to block a later re-delegation.

A quantum adversary holding the EOA key signs a fresh authorization at the next nonce
and replaces the PQ validator with their own contract. "7702 + PQ validator = permanent"
is FALSE. Use `PQOwnableAdapter` as the owner instead: the address that must stay stable
for integrations is the *protocol contract's*, not the admin EOA's, and that one does
not move.

**2. The arm/execute primitive already exists in the PQGuard spec.** `pqguard-spec.md`
§4 already binds the Ownable payload as
`abi.encode(target, selector, keccak256(callData), value, deadline)`, and §6.1's
two-phase `arm()` (on the KEEP list, not the cut list) already stores a PQ-authorized
authorization consumed later. "Destination fixed at arm time, cannot be redirected,
front-running gains nothing" describes the EXISTING design. There is no
`PQEscapeRegistry` to invent — it is `PQOwnableAdapter` with a long deadline.

The one deliberate change: §6.1 specifies arm() as short-lived (single-block or short
deadline). Migration wants arm-now / execute-at-Q-day. Long deadlines are safe because
the digest pins the target, but it is a real parameter change to make on purpose.

**3. Node has no keccak256** (verified, node 22.21.1 — only NIST SHA3, different
padding). Any client-side note commitment or digest work in the CLI hits this. The
scanner's zero-dependency claim is load-bearing product copy. Decide where commitment
hashing happens BEFORE writing it: Solidity gets keccak free; the CLI does not.

## The scanner-native seam: ring anonymity integrity

The one feature neither project has alone, and the one that needs no lattice crypto:

> Ring size 8 where 6 members are funded from long-lived, already-clustered EOAs gives
> **effective anonymity of 2 while reporting 8.**

Measuring that is exactly nonce0's exposure oracle plus authority traversal pointed at a
new target set — the same shape as the v4 hook ecosystem scan. It needs nothing from
Project X, and it works against Railgun, Aztec and Tornado today. This is the highest
value-per-hour item in the merge.

## Constraints on the pool that the migration use case imposes

- **Fixed denominations.** Deposit 13.47 ETH, withdraw 13.47 ETH, and the amounts link
  the two regardless of the ring. Migration deposits must round into standard
  denominations with the remainder handled separately. Far easier to build in than to
  retrofit.
- **The relay mesh becomes load-bearing at DEPOSIT, not just at spend.** In a panic
  everyone deposits inside the same short window and timing correlation defeats the pool
  on its own. Project X §3.3 currently describes the mesh as protecting the payment;
  it must also protect the entry.
- **What the pool cannot hold:** NFTs, LP positions, vesting contracts, long-tail
  tokens. Project X settles USDC over Arc, so anything else needs a transparent swap
  first — itself a linkable action. The CLI must say which tier each asset lands in
  rather than implying uniform protection.

## Tiered migration destinations

| Asset | Destination | Protection |
|---|---|---|
| USDC / supported tokens | Project X shielded note | permanent, PQ-authorized, unlinked |
| Contract ownership | `PQOwnableAdapter` as owner | permanent; protocol address unchanged, owner linkable |
| Everything else | fresh nonce-0 4337 account + PQ validator | permanent, linkable |

## The coupling risk, stated once

nonce0's sponsor selection was built around one doctrine: Uniswap was chosen over
higher-value tracks *specifically because it was uncorrelated with the riskiest
dependency*. Project X §4 calls its on-chain lattice verifier "the single hardest,
highest-risk engineering task in the whole build," with no existing EVM port and a
closest precedent (ETHFALCON/ETHDILITHIUM) burning 1.9M–8.8M gas for a *single signer*
with no ring aggregation.

The integration must therefore be designed so nonce0 still demos if that verifier does
not land. Target an address + calldata template, not a hard import: Project X is one
destination, a mock pool is another, Railgun is a third.

## Repo and calendar state

- Repo: day-zero scaffold committed and pushed. **Build step 2 of 13 is next** — the
  scanner engine does not exist yet. See `sponsor-plan.md` §5.
- Today is **2026-09-07**. ETHOnline runs Sept 4–16, so roughly **9 days remain**.
- nonce0 sponsor tracks: The Graph ($5,000), Hedera ($6,000), Uniswap ($3,000).
- Project X sponsor tracks: Chainlink ($1,000), Arc/Circle ($1,667), third undecided.
- **Conflict to resolve:** Project X §6 names The Graph as its leading third sponsor,
  and nonce0 is already submitting to The Graph.
- Project X is specced for a 4-person team; nonce0's plan was written for a fresh solo
  project. Two videos were already the floor before this merge.

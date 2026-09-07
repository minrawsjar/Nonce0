# PQGuard / nonce0 — three-sponsor plan

The Graph · Hedera · Uniswap Foundation. ETHGlobal Online, fresh project.
One track per organisation. ENS, Chainlink, Bazantic and Arc are out of scope.

## 1. Scope and the honest numbers

| Sponsor | Track | Pool | Split | Video |
|---|---|---|---|---|
| The Graph | Composable or Standardized Graph Products | $5,000 | $2,500 / $1,500 / $1,000 | 2–4 min |
| Hedera | AI & Agentic Payments | $6,000 | up to 3 teams at $2,000 | 5 min max |
| Uniswap | Best Uniswap Stack Contribution | $3,000 | up to 3 teams at $1,000 | unspecified |

$14,000 addressable. Realistic mid-case ~$5,500. All three pay multiple teams.

**Two videos minimum, and they are not the same video.** The Graph caps at four
minutes, Hedera at five. Budget three hours on the final day for recording.

### Why these three
- **ENS ($4,500) out** — ENSv2 is Sepolia-only, splits the demo across networks; text-record key commitments are not load-bearing.
- **Chainlink ($2,000) out** — the confidential scoring workflow's real home turned out to be the Uniswap hook.
- **Arc / Bazantic out** — Arc wants USDC payment flows the product does not have; Bazantic wraps an API already exposed.
- **Uniswap ($3,000) in** despite the smallest pool — the only track uncorrelated with the data layer. If Substreams fails, the hook still stands on the core contracts.

## 2. The test every integration passes

Removing it breaks the product, not just the pitch.

**The Graph — there is no other mechanism.** An address is a hash of a public key;
a quantum adversary cannot attack it until the key is published, which happens on
the first signed transaction. The same key controls the same address on every EVM
chain. There is no RPC path to "has this key ever signed anywhere, and what is the
key." Iterating eight chains block by block is days per scan. A streaming indexer
is the only mechanism that produces this dataset.

**Hedera — payment is access control, not monetisation.** A full kill-chain report
on a live protocol with unpatched exposure *is an attack plan*. Serving it free and
anonymous makes you an attack service. Tiering is a safety decision that happens to
be a payment integration. Payment also creates identity, and identity is what makes
the HCS audit trail mean anything.

**Uniswap — containment has nowhere else to live.** In v4 hook permissions are
encoded in the hook's own address, so a hook cannot be upgraded in place. The pool's
only interception point is the hook itself. Rate-limiting outflows must be
`beforeRemoveLiquidity` and `beforeSwap`. Not a Safe guard, not an Ownable adapter.

## 3. Product slices

Scanner (two modes), exposure oracle, scoring, CBOM, contracts. See
[scanner-design.md](scanner-design.md) and [pqguard-spec.md](pqguard-spec.md).

Overhead is roughly 89,000 gas per protected call (39k calldata, 35k verification,
15k state). Irrelevant for governance, prohibitive per swap. Scope to authority
paths and say so with confidence.

## 4. Per-sponsor requirements

### 4.1 The Graph — Composable or Standardized
| Requirement | How it is met |
|---|---|
| Compose 2+ Graph products, or build on a standardized schema | Both. Substreams module feeding a standardized subgraph schema. |
| Live data from a Graph provider (no mocks) | Subgraph Studio API key wired on day one. |
| Make the standards leverage clear | One query pattern across every protocol on every indexed chain. |
| Public repo + 2–4 min video | — |

Build `substreams-evm-pubkey`: chain-generic module recovering the signer public key
from `(r, s, v)` and the signing hash for every transaction, emitting
`(address, pubkey_hash, first_seen_block, chain_id)`. The same `.spkg` deploys
unchanged across every chain — that sameness *is* the composability claim.
Schema `QuantumExposure`: `Account`, `PubkeyExposure`, `AuthorityEdge`, `VerifierUsage`.

**Hedge, decided by end of day one.** If the module is not emitting, fall back to
direct RPC nonce scanning, keep the module as a contributed artifact, and switch the
submission to The Graph's AI Tooling track — same sponsor, same $5,000, MCP server
already built.

### 4.2 Hedera — AI & Agentic Payments
| Requirement | How it is met |
|---|---|
| Live x402-gated service, settled through Blocky402 | The scan API, tiered by traversal depth. |
| A platform/agent consuming it, one real paid request end to end | Budgeting monitor agent + MCP server paying for its own deep scans. |
| Public repo + README covering setup, architecture, payment flow | — |
| Demo video ≤5 min showing the paid request executing | — |

| Tier | Returns | Price |
|---|---|---|
| free | Severity tier only. "2 critical findings." | 0 |
| depth 1 | Direct authority edges, no traversal | metered |
| depth 3 | Full kill chain, nested Safes, value at risk | metered higher |
| simulate | Fork PoC execution | highest |

Extra points hit: pay-per-call metering by depth, HCS verifiable payment audit
trails, Scheduled Transactions for the monitor cadence. Skip A2A negotiation and
ERC-8004 identity unless ahead of schedule.

### 4.3 Uniswap — Stack Contribution
| Requirement | How it is met |
|---|---|
| Public repo, open source | — |
| `FEEDBACK.md` in the repo | Written during the build, not reconstructed after. |
| Submit the Uniswap Developer Feedback Form linking FEEDBACK.md | Hard requirement, trivially forgotten. Do it before the last hour. |
| README pointing to relevant contracts and lines | Direct file-and-line links to the hook. |

Build `PQContainmentHook`, plus an ecosystem scan nobody has run: for every deployed
v4 hook resolve its owner, check cross-chain exposure, rank by TVL of attached pools.

## 5. Build order

1. Substreams module and subgraph schema, live Studio key wired.
2. Rule catalog and finding schema, then repo mode tier 1 with the text reporter.
3. The Solidity lexer, tier 2. Accuracy jump.
4. Address extraction from deploy configs plus the nonce exposure oracle. **This is where it stops being a linter.**
5. `PQKeyRegistry` and `PQGuardCore` against a mock verifier. Fuzz the state machine before the crypto lands.
6. `FORSCVerifier` from an audited reference implementation.
7. `PQOwnableAdapter` end to end.
8. CRQC fork harness: an oracle returning the private key for any exposed public key, same exploit before and after. **This is the demo.**
9. Chain mode: RPC client, opcode walker, EIP-1967 slots, authority traversal.
10. x402 gateway and the HCS disclosure topic.
11. Monitor agent and MCP server.
12. `PQContainmentHook` and the v4 hook ecosystem scan.
13. Frontend: scan view and cross-chain exposure panel only.

**Cut without hesitation:** the Safe appended-envelope path (keep two-phase `arm()`),
WOTS+C, SLH-DSA, the ML-DSA stub, multi-chain contract deploys, recovery flows beyond
a timelock stub, the guard console, and SARIF if behind. Steps 1–4 alone produce a
tool people would install.

## 6. What will go wrong

- **Authority traversal returns an empty graph.** An unrecognised pattern silently yields a clean bill of health, which is worse than an error. Emit an explicit unresolved-authority finding; cache every RPC response to disk.
- **Substreams is a new toolchain under time pressure.** Take the day-one decision point seriously.
- **The Uniswap feedback form.** Hard qualification requirement living outside the repo.
- **Three submissions, three sets of paperwork.** Two videos of different lengths, three READMEs, one external form.

**Never claim.** You cannot restore privacy for shielded transactions already onchain.
You cannot make an immutable pairing verifier sound. The quantum adversary is an
oracle holding the keys — say that out loud on camera.

**The one-sentence pitch.** Point it at a repo or a deployed address and it tells you
which keys a quantum adversary would use to take your protocol, including the ones you
exposed on a chain you were not looking at, ranks them by what is actually unfixable,
and installs a hash-based second factor on the authority path in three transactions
without redeploying anything.

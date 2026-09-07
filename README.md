# nonce0

**Find out which of your keys a quantum computer would break, before it exists.**

Your address is not your public key — it is a hash of one, and a quantum computer
cannot attack a fingerprint. It needs the real key. The key becomes visible the
first time your account sends a transaction, because the signature on it reveals
the public key to anyone who looks.

In Ethereum the *nonce* counts how many transactions an account has sent. Nonce 0
means nothing has leaked. Anything above zero means the key is out there.

**The part nobody checks:** the same key controls the same address on every chain.
Your admin key can show nonce 0 on Ethereum, look completely safe, and be fully
exposed because a developer used it once on Sepolia two years ago.

```
npx nonce0 scan .              # your source code, before you deploy
npx nonce0 scan 0xProtocol     # a live protocol, after you deployed
```

No installation, no account, no configuration, and **zero runtime dependencies** —
a security tool that pulls four hundred transitive packages is asking you to trust
a supply chain in order to check your supply chain.

## Two names

| Name | What it is |
|---|---|
| **nonce0** | the scanner — this npm package, `npx nonce0` |
| **PQGuard** | the contract suite it installs — [`contracts/`](contracts/) |

The scanner finds the keys. The guard protects them.

## What it reports

A ranked list of findings, each with a file and line or a contract address, and a
specific next step. Ranking is by **what you can still do something about**:

```
risk = exposure x value_at_risk x (1 - fixability)
```

That inversion is the point. A critical finding you can close in three
transactions ranks *below* a medium one that is permanent. Every other
quantum-risk report is a wall of red that tells a team to panic without telling
them what to do first.

- **Fixable** — a key authorises an action. Add a hash-based second lock. It only
  ever adds a requirement, so it can never approve something on its own.
- **Not fixable, only containable** — an immutable verifier. Cap the outflow rate
  and delay large withdrawals; turn an instant drain into hours of warning.
- **Not fixable at all** — anything encrypted and already published on chain. An
  attacker copies it today and decrypts it later. No tool changes that, and
  anyone claiming otherwise is selling something.

## What repo mode cannot know

Source scanning has no value at risk, no knowledge of which contracts are actually
deployed, and no way to tell a live admin path from a test fixture. Chain mode is
what supplies those. This is stated here rather than left for you to discover.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | clean |
| `1` | findings at or above `--fail-on` (default `critical`) |
| `2` | tool error |

Distinguishing 1 from 2 is what makes this safe in CI: **a network failure must
never read as a clean scan.** The same rule governs the exposure oracle, which
reports `unknown` rather than `not exposed` when an RPC call fails.

## Development

```bash
git clone --recurse-submodules <repo>   # contracts/lib/* are submodules
npm test                                # node --test, no framework, no install
npm run smoke                           # pack, extract with no node_modules, run

node backend/server.js                  # http://localhost:8402, serves frontend/
```

| Directory | What runs there | Install needed |
|---|---|---|
| `src/`, `bin/` | the published scanner | never |
| `contracts/` | PQGuard, via `forge test` | `forge install` |
| `indexer/` | the Substreams module, via `cargo` | `cargo build` |
| `backend/` | the x402 scan API | `npm --prefix backend ci` |
| `frontend/` | the dashboard, served by `backend/` | none — no build step |

There is no `npm install` step for the scanner and there never will be. `api/` is
the only directory with a `node_modules`, and it is a sibling of `src/` so Node's
module resolution structurally cannot reach it from shipped code.

---

<a id="thegraph"></a>
## The Graph — Composable or Standardized Graph Products

**Demo video cap: 2–4 minutes.**

There is no RPC path to "has this key ever signed anywhere, and what is the key."
Iterating eight chains block by block is days of work per scan. A streaming
indexer is the only mechanism that produces this dataset, which is precisely why
the primitive does not exist yet.

| Their requirement | How it is met | Permalink |
|---|---|---|
| Compose 2+ Graph products, or build on a standardized schema | Both — a Substreams module feeding a standardized subgraph schema | _pending_ |
| Live data from a Graph provider; no mocked datasets | Subgraph Studio key wired day one | _pending_ |
| Make the standards leverage clear | One query pattern across every protocol on every indexed chain | _pending_ |
| Public repo + 2–4 min video | — | _pending_ |

`indexer/` holds `substreams-evm-pubkey`: a chain-generic module recovering the
signer public key from `(r, s, v)` and the signing hash, emitting
`(address, pubkey_hash, first_seen_block, chain_id)`. The same `.spkg` deploys
unchanged across every chain, and **that sameness is the composability claim** —
`subgraph.mainnet.yaml` and `subgraph.base.yaml` differ by one line.

- Studio subgraph id: _pending_
- Query URL: _pending_

<a id="hedera"></a>
## Hedera — AI & Agentic Payments

**Demo video cap: 5 minutes.**

A full kill-chain report on a live protocol with unpatched exposure **is an attack
plan**. Serving that free and anonymous makes you an attack service. The tiering is
a safety decision that happens to be a payment integration, not a payment
integration dressed as a feature.

| Tier | Returns | Price |
|---|---|---|
| `free` | severity counts only — "2 critical findings" | 0 |
| `depth1` | direct authority edges, no traversal | metered |
| `depth3` | full kill chain, nested Safes, value at risk | metered higher |

Metering by traversal depth is genuine per-call metering rather than a flat
charge, and price tracks both compute and sensitivity.

| Their requirement | How it is met | Permalink |
|---|---|---|
| Live x402-gated service settled through Blocky402 | the scan API, tiered by depth | _pending_ |
| An agent completing one real paid request end to end | `backend/agent.js`, the sole x402 payer | _pending_ |
| README covering setup, architecture, payment flow | this section + [`.env.example`](.env.example) | _pending_ |
| Demo video ≤5 min showing the paid request executing | — | _pending_ |

- HCS disclosure topic id: _pending_
- Deployed API: _pending_

<a id="uniswap"></a>
## Uniswap — Best Uniswap Stack Contribution

In v4, hook permissions are encoded in the hook's own address, so a hook cannot be
upgraded in place. The pool's only interception point for flows is the hook
itself. To rate-limit outflows from a pool whose admin key is compromised, it must
be `beforeRemoveLiquidity` and `beforeSwap`. **There is no alternative location.**

| Their requirement | How it is met | Permalink |
|---|---|---|
| Public repo, open source | — | _pending_ |
| `FEEDBACK.md` in the repo | [FEEDBACK.md](FEEDBACK.md), written during the build | _pending_ |
| Submit the Uniswap Developer Feedback Form | line 1 of FEEDBACK.md carries the checkbox | _pending_ |
| README pointing to relevant contracts and lines | — | _pending_ |

Plus an ecosystem scan nobody has run: for every deployed v4 hook, resolve its
owner, check cross-chain exposure, rank by attached pool count. LPs deposit into
pools governed by hooks they did not write, owned by keys they never inspected.

> Ranked by **attached pool count, not TVL**: in v4 all liquidity sits in the
> singleton PoolManager, so a per-hook balance lookup returns ~0 for every row. A
> TVL column that resolves to zero everywhere is worse than an honest one.

---

## Timing

Estimates for a capable quantum computer run from the 2030s onward, and Ethereum's
roadmap targets its core post-quantum work around 2029. That does not make this
early. Encrypted data is being harvested today to be decrypted later, and
migrations take years. The first step is knowing what you have.

MIT licensed.

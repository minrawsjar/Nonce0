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

npm run dev --prefix frontend           # http://localhost:8402, landing + dashboard + API
```

| Directory | What runs there | Install needed |
|---|---|---|
| `src/`, `bin/` | the published scanner | never |
| `contracts/` | PQGuard, via `forge test` | `forge install` |
| `indexer/` | the Substreams module, via `cargo` | `cargo build` |
| `backend/` | the x402 scan API | `npm --prefix backend ci` |
| `frontend/` | landing + dashboard, `npm run dev` | none — no build step |

There is no `npm install` step for the scanner and there never will be. `api/` is
the only directory with a `node_modules`, and it is a sibling of `src/` so Node's
module resolution structurally cannot reach it from shipped code.

---

MIT licensed.

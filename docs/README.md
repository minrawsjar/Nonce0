# nonce0 docs

Read in this order. Everything below is design; code lives above this directory.

## Start here

| Doc | What it is |
|---|---|
| **[nonce0-complete-design.md](nonce0-complete-design.md)** | **The whole system in one document.** Three layers, the Project X layer, `init`, `migrate`, the seam, contracts, threat model. Also as [PDF](nonce0-complete-design.pdf) (14pp) and [Excalidraw](nonce0-architecture.excalidraw). |
| [integration-brief.md](integration-brief.md) | Verified findings the design assumes and does not re-argue. Read before proposing changes. |
| [integration-design.md](integration-design.md) | Two-lane build structure, sponsor decisions, honesty guardrails. |
| [privacy-layer-design.md](privacy-layer-design.md) | PQ wallets, ring-authorized authority, network privacy. Adds the *target selection* threat class the others do not cover. Also as [PDF](privacy-layer-design.pdf) (6pp). |

## Source specs

| Doc | What it is |
|---|---|
| [value-proposition.md](value-proposition.md) | nonce0 in plain terms. The pitch, not the build. |
| [scanner-design.md](scanner-design.md) | The scanner engine, module by module. Rules, two-tier matching, exposure oracle, scoring. |
| [pqguard-spec.md](pqguard-spec.md) | The contract suite. Key state, digest construction, verifiers, adapters, failure modes. |
| [project-x-spec.md](project-x-spec.md) | The shielded destination. Ring signature, relay mesh, CRE, Arc. |
| [sponsor-plan.md](sponsor-plan.md) | The 13-step build order and the cut list. Authoritative for sequencing. |

## The three things most likely to be re-derived by mistake

1. **EIP-7702 is not a migration destination.** Delegation is ECDSA-signed and processed
   before execution, with no veto for delegated code. A broken key re-delegates. Verified
   against the EIP.
2. **`PQEscapeRegistry` does not need to exist.** `pqguard-spec.md` §4 already binds
   `(target, selector, keccak256(callData), value, deadline)` into the digest, and §6.1's
   `arm()` is on the keep list. Migration is `PQOwnableAdapter` with a long deadline.
3. **Node has no keccak256** — only NIST SHA3. It does have SHAKE256 with arbitrary
   output length, so PQ signing is native and dependency-free. Never define a commitment
   the CLI must compute over keccak; get the digest from `digestFor()` via `eth_call`.

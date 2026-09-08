# chaff docs

## The spec

[project-x-spec-v2.md](project-x-spec-v2.md) is the only authoritative document.
Build from it. It supersedes every earlier Project X and PQGuard spec, and it
says so in its own header.

[project-x-spec.md](project-x-spec.md) is v1, kept for the record. **Do not build
from it.** v1 specifies a Ring-LWE (lattice) ring signature; v2 replaced that
with FORS+C hash-based signatures and an MPC-in-the-head ring proof, because no
on-chain lattice verifier exists anywhere and it was the highest-risk task in the
build. If the two disagree, v2 wins.

## What used to be here

This directory held the design for nonce0, a cross-chain key-exposure scanner,
and PQGuard, its authorization layer. Both were dropped when the project narrowed
to the payment stack alone. Nothing was lost — recover any of it with:

```
git show 1dd4004:docs/<filename>      # read one file
git checkout 1dd4004 -- docs/         # restore the whole directory
```

Removed: `nonce0-complete-design.md` (+ `.pdf`), `nonce0-architecture.excalidraw`,
`pqguard-spec.md`, `privacy-layer-design.md` (+ `.pdf`), `scanner-design.md`,
`value-proposition.md`, `sponsor-plan.md`, `integration-brief.md`,
`integration-design.md`.

## Still to write

Nothing in here yet covers the Arc integration, the threat-model items Arc forces
(permissioned PoA validator set, runtime USDC blocklist), or the 30M gas
per-transaction ceiling that sets the go/no-go threshold for the §6.3 ring spike.

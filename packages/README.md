# Packages: Shared Libraries

> **Three TypeScript packages the wallet, the backend and the subgraph all build on. No build step.**

| Package | Folder | What it is | Tests |
|---|---|---|---|
| `@opaque/protocol-types` | [`protocol-types/`](protocol-types/) | The shared contract: types, runtime codecs, error codes | 16 |
| `@opaque/pq-wallet` | [`pq-wallet/`](pq-wallet/) | FORS+C signatures and the wallet SDK ([README](pq-wallet/README.md)) | 88, 2 skipped |
| `@opaque/ring-client` | [`ring-client/`](ring-client/) | The note vault and decoy selection | 6 |

## protocol-types

The contract every other module compiles against: immutable DTOs, branded identifiers (`PoolScope`, `NoteCommitment`, `UnixSeconds`, `PrivacyScore` and the rest), the ports each module implements, and `ProtocolFailure` with its finite error codes. It never holds a secret or a note witness.

A TypeScript brand is erased at runtime and proves nothing about a value that arrived over the wire, so every branded type has a runtime check in [`src/codecs.ts`](protocol-types/src/codecs.ts). Import the checkers, not just the types. Changing this package is a cross-team change, not an edit.

## ring-client

Everything about a note between its deposit and its spend.

| File | Purpose |
|---|---|
| [`note-vault.ts`](ring-client/src/note-vault.ts) | Notes and their secrets; commitments derived through `@opaque/zk`, never hashed locally |
| [`selection.ts`](ring-client/src/selection.ts) | Picks seven decoys from a pool snapshot, locally |
| [`greedy.ts`](ring-client/src/greedy.ts) | Splits an amount into notes of 1, 2, 5, 10, 20, 50 and 100 USDC |
| [`multi-note.ts`](ring-client/src/multi-note.ts) | Builds one spend per note for a multi-note payment |
| [`ring-client.ts`](ring-client/src/ring-client.ts) | Ties the vault, selection and the prover together |

Decoy selection runs in a fixed order, because the order is the defence against a pool flooded by one funder:

```
a. drop members used in rings too often
b. deprioritise members whose funder holds a large share of the pool
c. prefer members with other on-chain activity
d. only then, weight toward spread-out enrolment times
e. sample 7
```

Two rules the selection never breaks. The real note is excluded locally, from a snapshot already in hand; nothing ever asks a remote service to exclude or locate it. And a missing signal is unknown, never zero or false.

## Rules Across All Three

- **Commitments and nullifiers come from `@opaque/zk`**, because the ring proof proves exactly that derivation.
- **The nullifier binds the note secret and the pool only**, never the recipient.
- **The note secret and ring index never cross a module boundary.** They live in the vault and go to the prover.
- **Keccak-256 is `keccak_256` from `@noble/hashes/sha3.js`.** Node's `sha3-256` is a different function.

## Setup

```bash
for d in protocol-types pq-wallet ring-client; do npm ci --prefix "packages/$d" && npm --prefix "packages/$d" test; done
```

Run from the repository root. `ring-client` depends on `protocol-types` and on `backend/zk`.

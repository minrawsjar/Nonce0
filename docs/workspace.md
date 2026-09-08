# Opaque workspace

Opaque is scaffolded in the repository that began as the nonce0 scanner; `src/`
and `bin/` are still that scanner and are unrelated to the payment stack.

## Layout and ownership

| Directory | Package | Owner | What it is |
|---|---|---|---|
| `packages/protocol-types` | `@opaque/protocol-types` | Swarnim | The frozen §2 contract: DTOs, ports, error codes, and the runtime codecs. Everything compiles against this. |
| `packages/pq-wallet` | `@opaque/pq-wallet` | Manan | §5 — FORS+C few-time signatures, the §5.3 digest, `PQKeyRegistry` state. |
| `packages/ring-client` | `@opaque/ring-client` | Aditya | §6.6 NoteVault and §8.1 decoy selection. Spends are built by `@opaque/zk`. |
| `backend/zk` | `@opaque/zk` | Swarnim | §6 ring proof: MPC-in-the-head. Runs in Node *and* the browser — the prover is client-side by design. |
| `backend/mesh` | `@opaque/backend` | Swarnim | §7 three-hop onion transport. |
| `backend/cre` | `@opaque/backend` | Swarnim | §9/§10 confidential intent execution. |
| `graph` | `@opaque/graph` | Aditya | §8 subgraph schema, ring decoy selection and the §8.2 Markov hop chain. |
| `contracts` | Foundry | Aditya | `PQKeyRegistry`, `PrivatePool`, the verifier seam. |
| `frontend` | `opaque-frontend` | Manya | Landing page, wallet UI, and the adapter barrel the pages consume. |

Every package runs TypeScript directly — Node ≥22.18 strips types natively, so
there is no build step and no bundler anywhere except Vite for the frontend.

## Commands

```sh
npm run typecheck:all     # every package, strict
npm run test:all          # every suite
npm --prefix backend test # one package
cd contracts && forge test
node backend/zk/bench.ts  # the §6.3 spike, with real numbers
```

## Boundaries that are not style preferences

- **`packages/protocol-types` is frozen.** Adding to it is a cross-team change,
  not an edit. Modules talk through it and never through each other's internals.
- **Note commitments and nullifiers are derived by `@opaque/zk`**, because the
  ring proof proves that exact derivation. Anything that hashes its own
  commitment will not verify against anything.
- **The nullifier binds the note secret and the pool only** — never the
  recipient. A recipient-dependent nullifier lets one note be spent once per
  recipient, without limit.
- **Keccak-256 is `keccak_256` from `@noble/hashes/sha3.js`.** Node's
  `sha3-256` is a different function with different padding.
- **The note secret and the ring index never cross a module boundary.** They
  live in NoteVault and go to the prover; nothing else sees them.

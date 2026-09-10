# Aditya - Graph data products

`schema.graphql` is the public data boundary. Index eligible note commitments and aggregate pool/relay metrics only. Never index a real signer position or payment-to-decoy mapping.

The public Graph boundary exposes only bucket-level observations. It never
accepts a real commitment and never returns a ring or a payment path:

- `getRingSnapshot(scope)` returns the public denomination bucket; local code selects decoys.
- `getRelaySnapshot()` returns advisory health only after it matches the signed, pinned directory.
- `getPrivacyConditions(scope)` recomputes a versioned conservative readiness score locally.

`bun run subgraph:render graph-config.json` renders a deployable manifest from
the relay directory and each fixed-denomination pool. `scopeId` is the canonical
`poolId(scope)` calculated by the deployment script; passing it as context keeps
the mapping from accidentally reimplementing protocol hashing.

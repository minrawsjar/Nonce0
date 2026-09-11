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

## Deployed

Subgraph Studio, network `arc-testnet`, slug `opaque`:
`https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0` (also
`services.graphUrl` in `deployments/arc-testnet.json`). The locally generated
manifest now contains the seven RING_8 pools at 1/2/5/10/20/50/100 USDC (plus
the legacy single-note pool). To ship a new version:

```bash
bun run subgraph:render && bun run subgraph:codegen && bun run subgraph:build
graph auth <deploy key>          # once, in your own terminal
graph deploy opaque subgraph.yaml --version-label v0.3.1
```

Then point `services.graphUrl` at the new version. Only the backend's mesh
exit queries it (`backend/stack.ts`). A wallet reaches it through the mesh and
never directly (§7.5).

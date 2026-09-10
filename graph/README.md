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
`https://api.studio.thegraph.com/query/1760100/opaque/v0.1.0` (also
`services.graphUrl` in `deployments/arc-testnet.json`). To ship a new version:

```bash
node scripts/render-manifest.ts && npx graph codegen subgraph.yaml && npx graph build subgraph.yaml
npx graph auth <deploy key>          # once, in your own terminal
npx graph deploy opaque subgraph.yaml --version-label v0.1.1
```

Then point `services.graphUrl` at the new version. Only the backend's mesh
exit queries it (`backend/stack.ts`). A wallet reaches it through the mesh and
never directly (§7.5).

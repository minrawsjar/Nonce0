# Graph: The Opaque Subgraph

> **The Graph, Subgraph Studio, network `arc-testnet`. AssemblyScript mappings, TypeScript clients.**

Indexes the public side of Opaque on Arc: which deposits exist in each pool, how often each has been used in a ring, and how healthy each relay is. Three consumers decide from it: decoy selection, relay hop selection and the Chainlink CRE enclave's privacy score. The schema indexes pools and aggregates only, never which member or relay a payment used. The partner write-up is [partner-docs/the-graph.md](../partner-docs/the-graph.md).

## Deployed

| | |
|---|---|
| **Query URL** | [`https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0`](https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0) |
| **Slug** | `opaque`, version `v0.3.0` |
| **Network** | `arc-testnet` |
| **Data sources** | 8 `PrivatePool` contracts (7 RING_8 and the first single-note pool) and `RelayDirectory` |

The URL is also `services.graphUrl` in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json). The wallet never queries it directly: its questions go through the relay mesh, and the exit asks on its behalf.

## Folder Structure

```
graph/
├── schema.graphql              # Entities, and what they must never hold
├── subgraph.template.yaml      # Manifest template; one data source per pool
├── scripts/render-manifest.ts  # Renders subgraph.yaml from the deployment file
├── abis/                       # PrivatePool, RelayDirectory
├── src/
│   ├── mapping.ts              #   Event handlers (AssemblyScript)
│   ├── client.ts               #   Typed client, checked against the pinned relay directory
│   ├── path-policy.ts          #   Markov relay hop selection
│   ├── privacy-score.ts        #   The readiness score the enclave and the exit share
│   └── index.ts                #   Exports
└── test/                       # 8 tests: client, path policy, privacy score
```

## Events and Entities

| Contract | Event | Handler | Updates |
|---|---|---|---|
| `PrivatePool` | `Deposited` | `handleDeposited` | `RingMember`, `RingPool.poolSize` |
| `PrivatePool` | `DepositFrom` | `handleDepositFrom` | `FundingCluster`, `RingMember.fundingConcentrationBucket` |
| `PrivatePool` | `RingUsed` | `handleRingUsed` | `RingMember.timesUsedInRing`, `lastUsedAt` |
| `RelayDirectory` | `RelayAnnounced` | `handleRelayAnnounced` | `RelayNode`, `RelayDirectory` |
| `RelayDirectory` | `RelayHealth` | `handleRelayHealth` | `RelayNode` reliability, occupancy, selection count |

| Entity | Holds |
|---|---|
| `RingMember` | A note commitment, its pool, enrolment time, use count, last use, funding bucket, other activity |
| `RingPool` | Deposits per pool and denomination |
| `RelayNode` | Endpoint, key commitment, operator, reliability, batch occupancy, recent selections, last seen |
| `RelayDirectory` | The directory version and node count |
| `FundingCluster` | Notes per depositor per pool; bookkeeping only, never linked from `RingMember` |

## What the Schema Refuses to Hold

Nothing may record which ring member or relay a given payment used. Publishing that would undo the ring and the mesh from the indexing side.

An earlier version published a funding-cluster id per member, which groups notes by their common funder: the linkage the ring exists to destroy. It was replaced by `fundingConcentrationBucket`, a coarse 0 to 3 share of the pool, emitted only when at least five members share the funder. Null means unknown and must never be read as zero.

## The Client's Rules

- **`getRingSnapshot(scope)`** returns the public members of one denomination bucket. The wallet selects decoys locally; nothing ever asks a remote service to exclude or locate the real note.
- **`getRelaySnapshot()`** returns health only for relays in the signed, pinned directory, and only after the key commitments match. The Graph cannot add a relay.
- **`getPrivacyConditions(scope)`** recomputes the score locally with a versioned formula:

```
ring  = min(10000, poolSize × 10000 / 8)
mesh  = 0 if fewer than 3 operators, else min(relay capacity, mean reliability)
score = min(ring, mesh)
```

An index with errors, or one that is stale, gives no score, so payments wait for their deadlines rather than go early.

## Setup

### Build and deploy a new version

```bash
cd graph
npm ci
bun run subgraph:render      # subgraph.yaml from deployments/arc-testnet.json
bun run subgraph:codegen
bun run subgraph:build
graph auth <deploy key>      # once, in your own terminal
graph deploy opaque subgraph.yaml --version-label v0.3.1
```

Then point `services.graphUrl` at the new version. `render-manifest.ts` passes each pool's canonical `poolId` in as data-source context, so the mapping never reimplements protocol hashing in AssemblyScript.

### Test

```bash
npm test             # 8 tests
npm run typecheck
```

## Tech Stack

| Technology | Purpose |
|---|---|
| **The Graph** | Indexing, Subgraph Studio hosting |
| **AssemblyScript** | Mappings |
| **TypeScript** | Clients, path policy, score |
| **Bun** | Manifest rendering |

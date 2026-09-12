# The Graph: Privacy Signals for a Private Payment

> **Partner:** The Graph. A subgraph on Arc testnet, served live from Subgraph Studio.

Opaque hides a payment among eight deposits and routes it through three of six relays. Both choices need public data about the network: which deposits look like real spends, which pools are large enough, and which relays are healthy and not overused. The Opaque subgraph indexes exactly that, on Arc, and three parts of the system make live decisions from it, including the Chainlink CRE enclave that decides when a payment may settle.

## What We Built

One subgraph over eight pools and the relay directory, read by three consumers.

```
Arc testnet
  PrivatePool ×8 ── Deposited, DepositFrom, RingUsed ──┐
  RelayDirectory ── RelayAnnounced, RelayHealth ───────┤
                                                       ▼
                        Subgraph "opaque" (Subgraph Studio, arc-testnet)
                        RingMember · RingPool · RelayNode · RelayDirectory
                                                       │
            ┌──────────────────────────────────────────┼─────────────────────────┐
            ▼                                          ▼                         ▼
   Decoy selection                           Relay hop selection         CRE release decision
   which 7 notes hide yours                  which 3 of 6 relays         is this pool strong enough
   (wallet, per payment)                     (wallet, per message)       (enclave, every 30 s)
```

The wallet never queries The Graph directly. Its questions go through the relay mesh and the exit asks on its behalf, so The Graph never learns which wallet is about to pay.

## Deployment

| | |
|---|---|
| **Query URL** | [`https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0`](https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0) |
| **Network** | `arc-testnet` |
| **Data sources** | 8 `PrivatePool` contracts and `RelayDirectory`, rendered from `deployments/arc-testnet.json` |
| **Health** | Checked on 11 September 2026: synced to the chain head, `hasIndexingErrors: false`, all six relays reporting |

Try it:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"query":"{ ringPools { id poolSize } relayNodes { id reliabilityScore batchOccupancy lastSeenAt } }"}' \
  https://api.studio.thegraph.com/query/1760100/opaque/v0.3.0
```

## Where the Data Is Load-Bearing

### 1. Decoy selection

Every payment needs seven decoys from its pool. Picking them uniformly would favour a flood of fresh deposits from one funder. So the wallet ranks candidates with the subgraph's per-member signals, in an order that matters:

1. Drop members used in rings too often (`timesUsedInRing`).
2. Deprioritise members whose funder holds a large share of the pool (`fundingConcentrationBucket`).
3. Prefer members with other on-chain activity (`hasOtherActivity`).
4. Only then, spread the picks across enrolment times (`enrolledAt`).
5. Sample seven.

Membership itself always comes from the pool's own `Deposited` events. The subgraph only annotates members the chain already named. A member it names that the chain does not is dropped, because an index that could add members could hand a wallet seven decoys it owns.

### 2. Relay hop selection

The mesh draws three hops from six as a short Markov chain, weighted by the subgraph's relay health:

```
P(first hop = j) ∝ batchOccupancy(j) / (1 + recentSelectionCount(j))
P(i → j)         = 0 for any relay run by an operator already on the path,
                   0 below the reliability floor,
                   ∝ the same ratio otherwise
```

It is never a fixed top three: always taking the best three relays turns a random route into a permanent one. Relay identities and keys come from a signed directory pinned in the wallet. The Graph's values are clamped, so it can express a preference but cannot exclude a relay or force a route.

### 3. The CRE release decision

Inside the Chainlink CRE enclave, every 30 seconds, the workflow reads every pool's size and the relays' health in one query and scores each pool:

```
ring  = min(10000, poolSize × 10000 / 8)
mesh  = 0 if fewer than 3 operators, else min(relay capacity, mean reliability)
score = min(ring, mesh)
```

A payment whose score is below the payer's sealed minimum waits, until its deadline. The score is a minimum, not an average, so a large pool cannot hide a weak mesh. The same formula, [`readinessScores`](../graph/src/privacy-score.ts), runs in the enclave and at the exit.

### When The Graph is down or stale

An index with errors, or more than 5 minutes behind, gives no score, and payments wait for their deadlines rather than go early. Relay health older than 15 minutes counts as the neutral default. Missing member signals count as unknown, never as zero. Losing The Graph makes payments slower, never less private.

## Schema Built Around What Must Not Be Indexed

[`graph/schema.graphql`](../graph/schema.graphql) indexes eligible deposits and aggregate statistics only. It never records which member or which relay a given payment used, because publishing that would undo the ring and the mesh from the indexing side.

| Entity | Holds | Deliberately omits |
|---|---|---|
| `RingMember` | Commitment, pool, enrolment time, use count, last use, funding bucket, other activity | Which ring or payment used it |
| `RingPool` | Pool size per denomination | Anything per payment |
| `RelayNode` | Endpoint, key commitment, operator, reliability, occupancy, selection count | Any path a message took |
| `RelayDirectory` | Directory version and node count | |
| `FundingCluster` | Notes per depositor per pool, for bookkeeping | Never linked from `RingMember` |

An earlier version published a funding-cluster id per member. That groups notes by their common funder, which is the linkage the ring exists to destroy. It was replaced by `fundingConcentrationBucket`, a coarse share from 0 to 3, published only when at least five members share the funder.

## Relay Health, Reported On Chain

The Graph can only index what is on chain, so the relays put their health there. Every 10 minutes the backend's operator key reports the six relays' health to `RelayDirectory` on Arc, at about 0.0018 USDC a report. The subgraph indexes those events into `RelayNode`, and the two consumers above read them back.

## Source Code

| File | Purpose |
|---|---|
| [`graph/schema.graphql`](../graph/schema.graphql) | Entities, and the constraints on what they may hold |
| [`graph/src/mapping.ts`](../graph/src/mapping.ts) | Handlers for the five events |
| [`graph/subgraph.template.yaml`](../graph/subgraph.template.yaml) | Manifest template; one data source per pool |
| [`graph/scripts/render-manifest.ts`](../graph/scripts/render-manifest.ts) | Renders the manifest from the deployment file |
| [`graph/src/client.ts`](../graph/src/client.ts) | Typed client: ring snapshots and relay snapshots, checked against the pinned directory |
| [`graph/src/path-policy.ts`](../graph/src/path-policy.ts) | Markov hop selection |
| [`graph/src/privacy-score.ts`](../graph/src/privacy-score.ts) | The readiness score |
| [`packages/ring-client/src/selection.ts`](../packages/ring-client/src/selection.ts) | Decoy selection |
| [`backend/mesh/graph-health.ts`](../backend/mesh/graph-health.ts) | Clamps relay health before the mesh uses it |
| [`backend/cre/cre-release.ts`](../backend/cre/cre-release.ts) | `GRAPH_QUERY` and the scores the enclave computes |

## Product Feedback for The Graph

### What worked well

- **`arc-testnet` was available in Subgraph Studio**, so we indexed a new chain with no infrastructure of our own.
- **`_meta { hasIndexingErrors block { timestamp } }`** let every consumer refuse a stale or broken index with one extra field.
- **Templated manifests** kept eight pool data sources in sync with one deployment file.

### Suggestions

- **Studio's query endpoint is rate-limited**, and a privacy score is wanted often. We cache one read per pool per 30 seconds. A documented limit would have saved us finding it.
- **Sharing hashing code with AssemblyScript is hard.** Our pool id is a canonical keccak encoding in TypeScript; rather than reimplement it in the mapping, the renderer passes it in as data-source context. A supported way to share such code would remove that workaround.

## Future Plans with The Graph

1. **Substreams** for ring enrolment and relay metadata, as the original design planned, so the same pipeline can serve every chain Opaque deploys to.
2. **Publish to The Graph Network**, so no single indexer is trusted for the scores.
3. **More than one indexer in the enclave's query**, taking the most conservative score.

## Why Opaque and The Graph

A private payment is only as private as the crowd it hides in, and the crowd is public data. The Graph is how every part of Opaque reads that crowd the same way: the wallet choosing decoys, the mesh choosing routes, and the enclave deciding when a payment is safe to settle.

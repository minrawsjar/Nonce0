# Aditya taskboard — ring, Graph, settlement

Updated: 2026-09-10

## Ownership

```text
Aditya
├─ Ring-note protocol and ZKBoo integration
├─ Graph ring selection + mesh data integration
└─ Pool / CRE settlement contracts
```

## Board

| Area | Deliverable | Status | Evidence / next action |
|---|---|---|---|
| Ring | ZKBoo ring-8 proving and local verification | Done | `backend/zk`: 20 passing tests. Proof is MPC-in-the-head, verified in CRE—not Arc. |
| Ring | Correct nullifier rule | Done | Nullifier binds secret + pool only; recipient remains Fiat-Shamir/payment-context-bound. |
| Ring | Fixed public note buckets | Done | `1, 2, 5, 10, 20, 50, 100 USDC` in `packages/protocol-types`. |
| Ring | Greedy deposit decomposition | Done | `greedyDecompose`: descending maximum-count coin change. `47 → 20 + 20 + 5 + 2`. |
| Ring | Greedy eligible-note selection | Done | `greedySelectNotes` consumes largest eligible fixed notes first and fails closed if exact coverage is impossible. |
| Ring | Multi-note payment builder | Done | `buildGreedyMultiNoteSpends` reserves greedy notes and emits one ring-8 proof per fixed-value chunk. |
| Ring | Multi-note retry/reconciliation | Done | Builder releases all acquired reservations on any selection/proof failure; terminal reconciliation remains the existing NoteVault lifecycle. |
| Graph | Same-denomination decoy selection | Done | Local selection requires seven decoys; short candidate sets fail closed. |
| Graph | GraphQL ring snapshot client | Done | `graph/src/client.ts` queries only public pool + denomination; it never sends a real note/exclusion. |
| Graph | Subgraph schema for expanded buckets | Done | Schema already models a `denomination` bucket; client now queries that exact public bucket. |
| Graph | Graph-powered mesh selection integration | Done | Graph client supplies validated relay snapshots and privacy conditions to the existing mesh/path-policy boundary. |
| Contracts | CRE one-shot authorization gate | Done | `CREPolicyGate`: publisher-only, pool-bound, expiring, one-shot authorization. |
| Contracts | Fixed-bucket CRE-authorized pool | Done | `CREAuthorizedPool`: exact fee validation, nullifier burn before transfers, recipient + fee payouts. |
| Contracts | Multi-note atomic settlement | Done | `CREBatchSettlement.settleAll` calls all fixed-pool settlements in one transaction; any failure reverts the complete batch. |
| Contracts | Deployment wiring for Arc | Done | `DeployCrePools.s.sol` deploys one gate, batch settler, and seven fixed-bucket pools from Arc environment settings. |
| CRE integration | Verify each ZKBoo chunk inside CRE | Left | Call `verifyRingSpend` with pinned verifier id before issuing any authorization. |
| CRE integration | Publish on-chain authorization | Left | Replace HMAC-only egress release with Gate `publish` transaction payload. |
| CRE integration | Privacy/deadline policy for full multi-note intent | Left | Score/deadline applies to the whole intent; no chunk may bypass it. |
| Documentation | Honest security/trust claims | In progress | Update V2 docs: CRE is the release authority; Arc does not directly verify ZKBoo; final settlement amount is public. |
| Verification | Focused tests | Done | Protocol 16, ZKBoo 20, greedy/selection 3, CRE pool 2 passing. |
| Verification | Full suite | Blocked | Existing `contracts/test/fixtures/Deploy.s.sol` imports missing `forge-std/Script.sol`; targeted Foundry tests pass. |

## Critical path

```text
Graph bucket client
      ↓
multi-note builder + reservation lifecycle
      ↓
CRE verifies every ZKBoo chunk
      ↓
CRE publishes one-shot authorizations
      ↓
batch settlement + Arc deployment
      ↓
frontend adapter
```

## Rules locked by this board

- Every chunk uses a standard denomination and has its own ring of eight.
- Greedy means descending `floor(remainder / denomination)`, then move lower.
- “Eligible” means both locally available and backed by seven safe same-bucket decoys.
- A payment fails/waits as a whole if any required chunk is ineligible.
- CRE verifies proofs and policy before release; the pool exposes no direct proof spend route.
- No commit or push without Aditya’s explicit approval.

import { BigInt, dataSource } from '@graphprotocol/graph-ts';
import { RelayAnnounced, RelayHealth } from '../generated/RelayDirectory/RelayDirectory';
// All PrivatePool sources share the exact ABI. The renderer always creates
// PrivatePool0 when it creates at least one pool, so one generated event type
// is sufficient for the common handler.
import { Deposited } from '../generated/PrivatePool0/PrivatePool';
import { RelayDirectory, RelayNode, RingMember, RingPool } from '../generated/schema';

const DIRECTORY_ID = 'opaque-relay-directory-v1';

export function handleRelayAnnounced(event: RelayAnnounced): void {
  const id = event.params.nodeId.toHexString();
  const existed = RelayNode.load(id) != null;
  let node = new RelayNode(id);
  node.endpoint = event.params.endpoint;
  // This is advisory only; the client checks the actual key against its pinned set.
  node.kemKeyCommitment = event.params.kemKeyCommitment;
  node.keyEpoch = event.params.epoch;
  node.operatorId = event.params.operator.toHexString();
  node.reliabilityScore = BigInt.zero();
  node.batchOccupancy = BigInt.zero();
  node.recentSelectionCount = BigInt.zero();
  node.lastSeenAt = event.block.timestamp;
  node.save();

  let directory = RelayDirectory.load(DIRECTORY_ID);
  if (directory == null) { directory = new RelayDirectory(DIRECTORY_ID); directory.nodeCount = 0; directory.version = 'opaque-relay-v1'; }
  if (!existed) directory.nodeCount = directory.nodeCount + 1;
  directory.observedAt = event.block.timestamp;
  directory.save();
}

export function handleRelayHealth(event: RelayHealth): void {
  const node = RelayNode.load(event.params.nodeId.toHexString());
  if (node == null) return;
  node.reliabilityScore = BigInt.fromI32(event.params.reliabilityBps);
  node.batchOccupancy = BigInt.fromI32(event.params.batchOccupancy);
  node.recentSelectionCount = event.params.recentSelections;
  node.lastSeenAt = event.params.observedAt;
  node.save();
}

/**
 * Context is deployment configuration, not an on-chain inference. It binds a
 * data source to the same canonical `${poolId(scope)}-${denomination}` id the
 * application queries. This avoids recreating protocol hashing in mappings.
 */
export function handleDeposited(event: Deposited): void {
  const context = dataSource.context();
  const scopeId = context.getString('scopeId');
  const denomination = context.getString('denomination');
  if (scopeId == null || denomination == null) return;
  const poolId = scopeId + '-' + denomination;
  const memberId = event.params.commitment.toHexString();
  if (RingMember.load(memberId) != null) return;

  let pool = RingPool.load(poolId);
  if (pool == null) {
    pool = new RingPool(poolId);
    pool.poolSize = 0;
  }
  const member = new RingMember(memberId);
  member.pool = poolId;
  member.denomination = BigInt.fromString(denomination);
  member.enrolledAt = event.block.number;
  // The verifier emits no signer position, by design. Do not fabricate one.
  member.timesUsedInRing = 0;
  member.save();

  pool.poolSize = pool.poolSize + 1;
  pool.observedAt = event.block.timestamp;
  pool.save();
}

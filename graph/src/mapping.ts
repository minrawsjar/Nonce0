import { BigInt, Bytes, dataSource } from '@graphprotocol/graph-ts';
import { RelayAnnounced, RelayHealth } from '../generated/RelayDirectory/RelayDirectory';
// All PrivatePool sources share the exact ABI. The renderer always creates
// PrivatePool0 when it creates at least one pool, so one generated event type
// is sufficient for the common handler.
import { Deposited, DepositFrom, RingUsed } from '../generated/PrivatePool0/PrivatePool';
import { FundingCluster, RelayDirectory, RelayNode, RingMember, RingPool } from '../generated/schema';

const DIRECTORY_ID = 'opaque-relay-directory-v1';
/** A funding bucket is published only when this many members share the funder. */
const FUNDING_BUCKET_K = 5;

/**
 * RelayDirectory's nodeId is the signed directory's relay id, UTF-8,
 * right-padded to 32 bytes. Decoding it here is what lets the client match a
 * Graph health row to the relay its directory names, by the same id.
 */
function relayId(nodeId: Bytes): string {
  let out = '';
  for (let i = 0; i < nodeId.length; i++) {
    const c = nodeId[i];
    if (c == 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function touchDirectory(at: BigInt, newNode: boolean): void {
  let directory = RelayDirectory.load(DIRECTORY_ID);
  if (directory == null) {
    directory = new RelayDirectory(DIRECTORY_ID);
    directory.nodeCount = 0;
    directory.version = 'opaque-relay-v1';
  }
  if (newNode) directory.nodeCount = directory.nodeCount + 1;
  // Every report moves this, not only announcements: a feed that reports every
  // few minutes must not read as stale because no relay changed its key.
  directory.observedAt = at;
  directory.save();
}

export function handleRelayAnnounced(event: RelayAnnounced): void {
  const id = relayId(event.params.nodeId);
  let node = RelayNode.load(id);
  const existed = node != null;
  if (node == null) {
    node = new RelayNode(id);
    node.reliabilityScore = BigInt.zero();
    node.batchOccupancy = BigInt.zero();
    node.recentSelectionCount = BigInt.zero();
  }
  node.endpoint = event.params.endpoint;
  // Advisory only; the client takes the actual key from its pinned directory.
  node.kemKeyCommitment = event.params.kemKeyCommitment;
  node.keyEpoch = event.params.epoch;
  node.operatorId = event.params.operator.toHexString();
  node.lastSeenAt = event.block.timestamp;
  node.save();
  touchDirectory(event.block.timestamp, !existed);
}

export function handleRelayHealth(event: RelayHealth): void {
  const node = RelayNode.load(relayId(event.params.nodeId));
  if (node == null) return;
  node.reliabilityScore = BigInt.fromI32(event.params.reliabilityBps);
  node.batchOccupancy = BigInt.fromI32(event.params.batchOccupancy);
  node.recentSelectionCount = event.params.recentSelections;
  node.lastSeenAt = event.params.observedAt;
  node.save();
  touchDirectory(event.params.observedAt, false);
}

/** '' when the data source carries no scope — AssemblyScript does not narrow a nullable string. */
function poolIdOfContext(): string {
  const context = dataSource.context();
  if (!context.isSet('scopeId') || !context.isSet('denomination')) return '';
  return context.getString('scopeId') + '-' + context.getString('denomination');
}

/**
 * Context is deployment configuration, not an on-chain inference. It binds a
 * data source to the same canonical `${poolId(scope)}-${denomination}` id the
 * application queries. This avoids recreating protocol hashing in mappings.
 */
export function handleDeposited(event: Deposited): void {
  const poolId = poolIdOfContext();
  if (poolId.length == 0) return;
  const memberId = event.params.commitment.toHexString();
  if (RingMember.load(memberId) != null) return;

  let pool = RingPool.load(poolId);
  if (pool == null) {
    pool = new RingPool(poolId);
    pool.poolSize = 0;
  }
  const member = new RingMember(memberId);
  member.pool = poolId;
  member.denomination = BigInt.fromString(dataSource.context().getString('denomination'));
  member.enrolledAt = event.block.number;
  member.timesUsedInRing = 0;
  member.save();

  pool.poolSize = pool.poolSize + 1;
  pool.observedAt = event.block.timestamp;
  pool.save();
}

/**
 * §8.1 funding clustering, published as a coarse share bucket and nothing
 * else. Emitted after Deposited in the same transaction, so the member exists.
 */
export function handleDepositFrom(event: DepositFrom): void {
  const poolId = poolIdOfContext();
  if (poolId.length == 0) return;
  const member = RingMember.load(event.params.commitment.toHexString());
  const pool = RingPool.load(poolId);
  if (member == null || pool == null) return;

  const clusterId = poolId + '-' + event.params.depositor.toHexString();
  let cluster = FundingCluster.load(clusterId);
  if (cluster == null) {
    cluster = new FundingCluster(clusterId);
    cluster.memberCount = 0;
  }
  cluster.memberCount = cluster.memberCount + 1;
  cluster.save();

  if (cluster.memberCount >= FUNDING_BUCKET_K) {
    const sharePct = (cluster.memberCount * 100) / pool.poolSize;
    member.fundingConcentrationBucket = sharePct < 10 ? 0 : sharePct < 25 ? 1 : sharePct < 50 ? 2 : 3;
    member.save();
  }
}

/** §8.1 aggregate use counts. The event carries the ring and nothing else. */
export function handleRingUsed(event: RingUsed): void {
  const poolId = poolIdOfContext();
  const ring = event.params.ring;
  for (let i = 0; i < ring.length; i++) {
    const member = RingMember.load(ring[i].toHexString());
    if (member == null) continue;
    member.timesUsedInRing = member.timesUsedInRing + 1;
    member.lastUsedAt = event.block.timestamp;
    member.save();
  }
  if (poolId.length == 0) return;
  const pool = RingPool.load(poolId);
  if (pool == null) return;
  pool.observedAt = event.block.timestamp;
  pool.save();
}

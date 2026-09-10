import {
  ProtocolFailure,
  type GraphSelectionClient,
  type PoolScope,
  type PrivacyConditions,
  type RelaySnapshot,
  type RingSnapshot,
  type RelayNode,
} from '@opaque/protocol-types';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  asBytes32,
  asNoteCommitment,
  asPoolScope,
  asPrivacyScore,
  asUnixSeconds,
  decodeBigint,
  fromHex,
  poolId,
  toHex,
} from '@opaque/protocol-types/codecs.js';
import { evaluatePublicReadiness } from './privacy-score.ts';

export interface PinnedRelay {
  readonly id: RelayNode['id'];
  readonly endpoint: string;
  readonly kemPublicKey: RelayNode['kemPublicKey'];
  readonly keyEpoch: bigint;
  readonly operatorId: string;
}

export interface GraphHttpClientOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Relay identity comes from the signed, pinned directory — never from Graph. */
  readonly pinnedRelays?: readonly PinnedRelay[];
  /** Refuse old health/score observations rather than presenting them as live. */
  readonly maxObservationAgeSeconds?: bigint;
  readonly now?: () => bigint;
}

function asWireInteger(value: unknown, label: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ProtocolFailure('INVALID_INPUT', `${label} is not a valid bounded integer`);
  }
  return parsed;
}

/** Minimal validated GraphQL boundary. Selection stays local: no real note id crosses this API. */
export class GraphHttpClient implements GraphSelectionClient {
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #pins: ReadonlyMap<string, PinnedRelay>;
  readonly #maxAge: bigint;
  readonly #now: () => bigint;

  constructor(options: GraphHttpClientOptions) {
    this.#endpoint = options.endpoint;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pins = new Map((options.pinnedRelays ?? []).map((node) => [node.id, node]));
    this.#maxAge = options.maxObservationAgeSeconds ?? 300n;
    this.#now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  }
  async #query<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T; block: bigint }> {
    const response = await this.#fetch(this.#endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new ProtocolFailure('GRAPH_UNAVAILABLE', `Graph returned HTTP ${response.status}`, true);
    const body = await response.json() as { data?: T & { _meta?: { hasIndexingErrors?: unknown; block?: { number?: unknown } } }; errors?: unknown[] };
    if (body.errors !== undefined || body.data === undefined) throw new ProtocolFailure('GRAPH_UNAVAILABLE', 'Graph returned an invalid response', true);
    const meta = body.data._meta;
    if (meta?.hasIndexingErrors !== false || meta.block?.number === undefined) throw new ProtocolFailure('STALE_OBSERVATION', 'Graph indexing metadata is unavailable or unhealthy', true);
    return { data: body.data, block: decodeBigint(meta.block.number, 'indexed block') };
  }
  #fresh(observedAt: unknown, label: string) {
    const at = asUnixSeconds(observedAt);
    if (at > this.#now() || this.#now() - at > this.#maxAge) {
      throw new ProtocolFailure('STALE_OBSERVATION', `${label} observation is outside the freshness window`, true);
    }
    return at;
  }
  async getRingSnapshot(scope: PoolScope): Promise<RingSnapshot> {
    const safe = asPoolScope(scope);
    const result = await this.#query<{ ringPool: Record<string, unknown> | null; ringMembers: Array<Record<string, unknown>> }>(
      'query Ring($pool: String!, $denomination: BigInt!) { _meta { hasIndexingErrors block { number } } ringPool(id: $pool) { observedAt } ringMembers(where: { pool: $pool, denomination: $denomination }) { id enrolledAt timesUsedInRing fundingConcentrationBucket hasOtherActivity } }',
      { pool: `${poolId(safe)}-${safe.denomination}`, denomination: String(safe.denomination) },
    );
    const data = result.data;
    const observedAt = data.ringPool === null
      ? asUnixSeconds(this.#now()) // an empty bucket cannot satisfy a readiness threshold anyway
      : this.#fresh(data.ringPool.observedAt, 'ring pool');
    return { scope: safe, candidates: data.ringMembers.map((m) => ({
      commitment: asNoteCommitment(m.id), enrolledAtBlock: decodeBigint(m.enrolledAt, 'enrolledAt'),
      // The on-chain verifier intentionally never emits the selected member.
      // A public "usage" value would be invented data, so the mapping fixes it to 0.
      timesUsedInRing: Number(m.timesUsedInRing), fundingCluster: m.fundingConcentrationBucket === null ? null : String(m.fundingConcentrationBucket),
      hasOtherActivity: m.hasOtherActivity === null ? null : Boolean(m.hasOtherActivity),
    })), indexedThroughBlock: result.block, observedAt, policyVersion: 'opaque-privacy-v1' };
  }
  async getRelaySnapshot(): Promise<RelaySnapshot> {
    const result = await this.#query<{ relayDirectory: Record<string, unknown> | null; relayNodes: Array<Record<string, unknown>> }>(
      'query Relays { _meta { hasIndexingErrors block { number } } relayDirectory(id: "opaque-relay-directory-v1") { version observedAt } relayNodes { id endpoint kemKeyCommitment keyEpoch operatorId reliabilityScore batchOccupancy recentSelectionCount lastSeenAt } }', {},
    );
    const directory = result.data.relayDirectory;
    if (directory === null) throw new ProtocolFailure('STALE_OBSERVATION', 'no relay directory observation', true);
    const observedAt = this.#fresh(directory.observedAt, 'relay directory');
    const nodes = result.data.relayNodes.map((n) => {
      const id = String(n.id) as RelayNode['id'];
      const pin = this.#pins.get(id);
      if (pin === undefined) throw new ProtocolFailure('UNTRUSTED_DIRECTORY', `Graph returned unpinned relay ${id}`);
      const commitment = asBytes32(n.kemKeyCommitment);
      const expected = asBytes32(toHex(keccak_256(fromHex(pin.kemPublicKey))));
      if (commitment !== expected || String(n.endpoint) !== pin.endpoint || decodeBigint(n.keyEpoch, 'keyEpoch') !== pin.keyEpoch || String(n.operatorId) !== pin.operatorId) {
        throw new ProtocolFailure('UNTRUSTED_DIRECTORY', `Graph relay metadata disagrees with pinned relay ${id}`);
      }
      return {
        id, endpoint: pin.endpoint, kemPublicKey: pin.kemPublicKey, keyEpoch: pin.keyEpoch, operatorId: pin.operatorId,
        reliabilityScore: asPrivacyScore(asWireInteger(n.reliabilityScore, 'relay reliability', 10_000)),
        batchOccupancy: asWireInteger(n.batchOccupancy, 'relay batch occupancy', 65_535),
        recentSelectionCount: asWireInteger(n.recentSelectionCount, 'relay recent selections', 4_294_967_295),
        lastSeenAt: this.#fresh(n.lastSeenAt, `relay ${id}`),
      };
    });
    return { nodes, directoryVersion: String(directory.version), observedAt };
  }
  async getPrivacyConditions(scope: PoolScope): Promise<PrivacyConditions> {
    const safe = asPoolScope(scope);
    // No payment or candidate selection crosses this boundary. The browser/CRE
    // obtains two aggregate snapshots then recomputes the versioned policy
    // locally, making a stale or substituted published score non-authoritative.
    return evaluatePublicReadiness(await this.getRingSnapshot(safe), await this.getRelaySnapshot());
  }
}

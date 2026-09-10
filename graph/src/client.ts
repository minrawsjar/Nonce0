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
  async #query<T>(query: string, variables: Record<string, unknown>): Promise<{ data: T; block: bigint; blockTime: unknown }> {
    const response = await this.#fetch(this.#endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new ProtocolFailure('GRAPH_UNAVAILABLE', `Graph returned HTTP ${response.status}`, true);
    const body = await response.json() as { data?: T & { _meta?: { hasIndexingErrors?: unknown; block?: { number?: unknown; timestamp?: unknown } } }; errors?: unknown[] };
    if (body.errors !== undefined || body.data === undefined) throw new ProtocolFailure('GRAPH_UNAVAILABLE', 'Graph returned an invalid response', true);
    const meta = body.data._meta;
    if (meta?.hasIndexingErrors !== false || meta.block?.number === undefined) throw new ProtocolFailure('STALE_OBSERVATION', 'Graph indexing metadata is unavailable or unhealthy', true);
    // graph-node sends _meta's Int fields as JSON numbers; block heights and
    // seconds fit safely, so they are taken as decimal strings here.
    const decimal = (v: unknown): unknown => (Number.isSafeInteger(v) ? String(v) : v);
    return { data: body.data, block: decodeBigint(decimal(meta.block.number), 'indexed block'), blockTime: decimal(meta.block.timestamp) };
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
      'query Ring($pool: String!, $denomination: BigInt!) { _meta { hasIndexingErrors block { number timestamp } } ringMembers(first: 1000, where: { pool: $pool, denomination: $denomination }) { id enrolledAt timesUsedInRing fundingConcentrationBucket hasOtherActivity } }',
      { pool: `${poolId(safe)}-${safe.denomination}`, denomination: String(safe.denomination) },
    );
    // Fresh = the INDEX is current, not the pool busy: a quiet pool's last
    // event can be days old while every member count is still exact.
    const observedAt = this.#fresh(result.blockTime, 'ring index');
    return { scope: safe, candidates: result.data.ringMembers.map((m) => ({
      commitment: asNoteCommitment(m.id), enrolledAtBlock: decodeBigint(m.enrolledAt, 'enrolledAt'),
      // Counted from PrivatePool's RingUsed, which names every member of a
      // ring and never which one signed.
      timesUsedInRing: Number(m.timesUsedInRing),
      // selectDecoys groups members by EQUAL fundingCluster and penalises a
      // group over its share limit (20%). A bucket is a share, not a funder:
      // only buckets 2–3 (a funder over 25% of the pool) form that group.
      // 0–1 are known-small, which selection treats exactly like unknown.
      fundingCluster: m.fundingConcentrationBucket !== null && Number(m.fundingConcentrationBucket) >= 2 ? 'concentrated' : null,
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
      // operatorId is not compared: on chain it is the announcing account, in
      // the directory a label, and the pinned one is what is returned anyway.
      if (commitment !== expected || String(n.endpoint) !== pin.endpoint || decodeBigint(n.keyEpoch, 'keyEpoch') !== pin.keyEpoch) {
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

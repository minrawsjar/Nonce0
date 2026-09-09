import {
  ProtocolFailure,
  type GraphSelectionClient,
  type PoolScope,
  type PrivacyConditions,
  type RelaySnapshot,
  type RingSnapshot,
  type RelayNode,
} from '@opaque/protocol-types';
import { asNoteCommitment, asPoolScope, asPrivacyScore, asUnixSeconds, decodeBigint } from '@opaque/protocol-types/codecs.js';

export interface GraphHttpClientOptions { readonly endpoint: string; readonly fetch?: typeof globalThis.fetch; }

/** Minimal validated GraphQL boundary. Selection stays local: no real note id crosses this API. */
export class GraphHttpClient implements GraphSelectionClient {
  readonly #endpoint: string; readonly #fetch: typeof globalThis.fetch;
  constructor(options: GraphHttpClientOptions) { this.#endpoint = options.endpoint; this.#fetch = options.fetch ?? globalThis.fetch; }
  async #query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch(this.#endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new ProtocolFailure('GRAPH_UNAVAILABLE', `Graph returned HTTP ${response.status}`, true);
    const body = await response.json() as { data?: T; errors?: unknown[] };
    if (body.errors !== undefined || body.data === undefined) throw new ProtocolFailure('GRAPH_UNAVAILABLE', 'Graph returned an invalid response', true);
    return body.data;
  }
  async getRingSnapshot(scope: PoolScope): Promise<RingSnapshot> {
    const safe = asPoolScope(scope);
    const data = await this.#query<{ ringMembers: Array<Record<string, unknown>> }>(
      'query Ring($pool: String!, $denomination: BigInt!) { ringMembers(where: { pool: $pool, denomination: $denomination }) { id enrolledAt timesUsedInRing fundingConcentrationBucket hasOtherActivity } }',
      { pool: safe.pool, denomination: String(safe.denomination) },
    );
    return { scope: safe, candidates: data.ringMembers.map((m) => ({
      commitment: asNoteCommitment(m.id), enrolledAtBlock: decodeBigint(m.enrolledAt, 'enrolledAt'),
      timesUsedInRing: Number(m.timesUsedInRing), fundingCluster: m.fundingConcentrationBucket === null ? null : String(m.fundingConcentrationBucket),
      hasOtherActivity: m.hasOtherActivity === null ? null : Boolean(m.hasOtherActivity),
    })), indexedThroughBlock: 0n, observedAt: asUnixSeconds(String(Math.floor(Date.now() / 1000))), policyVersion: 'graph-v1' };
  }
  async getRelaySnapshot(): Promise<RelaySnapshot> {
    const data = await this.#query<{ relayNodes: Array<Record<string, unknown>> }>(
      'query Relays { relayNodes { id endpoint kemPublicKey keyEpoch operatorId reliabilityScore batchOccupancy recentSelectionCount lastSeenAt } }', {},
    );
    const nodes = data.relayNodes.map((n) => ({ id: String(n.id) as RelayNode['id'], endpoint: String(n.endpoint), kemPublicKey: String(n.kemPublicKey) as RelayNode['kemPublicKey'], keyEpoch: decodeBigint(n.keyEpoch, 'keyEpoch'), operatorId: String(n.operatorId), reliabilityScore: asPrivacyScore(Number(n.reliabilityScore)), batchOccupancy: Number(n.batchOccupancy), recentSelectionCount: Number(n.recentSelectionCount), lastSeenAt: asUnixSeconds(n.lastSeenAt) }));
    return { nodes, directoryVersion: 'graph-v1', observedAt: asUnixSeconds(String(Math.floor(Date.now() / 1000))) };
  }
  async getPrivacyConditions(scope: PoolScope): Promise<PrivacyConditions> {
    const safe = asPoolScope(scope);
    const data = await this.#query<{ privacyObservations: Array<Record<string, unknown>> }>(
      'query Privacy($pool: String!) { privacyObservations(where: { id: $pool }) { privacyScore ringFreshnessScore meshHealthScore formulaVersion observedAt } }', { pool: safe.pool },
    );
    const row = data.privacyObservations[0];
    if (row === undefined) throw new ProtocolFailure('STALE_OBSERVATION', 'no privacy observation for pool', true);
    return { scope: safe, privacyScore: asPrivacyScore(Number(row.privacyScore)), ringFreshnessScore: asPrivacyScore(Number(row.ringFreshnessScore)), meshHealthScore: asPrivacyScore(Number(row.meshHealthScore)), observedAt: asUnixSeconds(row.observedAt), formulaVersion: String(row.formulaVersion), source: 'LIVE' };
  }
}

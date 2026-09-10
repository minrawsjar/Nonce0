// Public readiness score used only for the early-execution branch:
//
//   execute early iff score >= user threshold
//   execute at deadline regardless of Graph availability
//
// It is deliberately a conservative readiness signal, not an anonymity proof
// and not an identity/Sybil classifier. The score uses only the denomination
// bucket's public population and aggregate relay health.

import {
  ProtocolFailure,
  type PrivacyConditions,
  type RelaySnapshot,
  type RingSnapshot,
} from '@opaque/protocol-types';
import { asPrivacyScore } from '@opaque/protocol-types/codecs.js';

export const PRIVACY_FORMULA_VERSION = 'opaque-public-readiness-v1';
export const REQUIRED_RING_SIZE = 8;
export const REQUIRED_RELAY_POOL = 6;

function bounded(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ProtocolFailure('INVALID_INPUT', `${label} must be an integer in 0..10000`);
  }
  return value;
}

/**
 * Computes an intentionally explainable score. Both components have to be
 * strong, so the final score is their minimum rather than an average that can
 * hide a weak mesh behind a large pool (or vice versa).
 */
export function evaluatePublicReadiness(ring: RingSnapshot, relays: RelaySnapshot): PrivacyConditions {
  const ringFreshness = asPrivacyScore(Math.min(10_000, Math.floor(ring.candidates.length * 10_000 / REQUIRED_RING_SIZE)));
  const eligible = relays.nodes.filter((node) => node.batchOccupancy > 0);
  const operators = new Set(eligible.map((node) => node.operatorId));
  const relayCapacity = Math.min(10_000, Math.floor(eligible.length * 10_000 / REQUIRED_RELAY_POOL));
  const reliability = eligible.length === 0
    ? 0
    : Math.floor(eligible.reduce((sum, node) => sum + bounded(node.reliabilityScore, 'relay reliability'), 0) / eligible.length);
  // Fewer than three independent operators cannot form a 3-hop path at all.
  const meshHealth = asPrivacyScore(operators.size < 3 ? 0 : Math.min(relayCapacity, reliability));

  return {
    scope: ring.scope,
    privacyScore: asPrivacyScore(Math.min(ringFreshness, meshHealth)),
    ringFreshnessScore: ringFreshness,
    meshHealthScore: meshHealth,
    observedAt: ring.observedAt < relays.observedAt ? ring.observedAt : relays.observedAt,
    formulaVersion: PRIVACY_FORMULA_VERSION,
    source: 'LIVE',
  };
}

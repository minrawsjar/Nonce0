export function buildPaymentSchedule({ minPrivacyScore, deadline, now }) {
  if (typeof minPrivacyScore !== 'bigint') throw new TypeError('minPrivacyScore must be bigint');
  if (!Number.isInteger(deadline) || !Number.isInteger(now)) throw new TypeError('deadline and now must be unix seconds');
  if (deadline < now) throw new RangeError('deadline cannot be in the past');
  return { minPrivacyScore, deadline, mode: deadline === now ? 'IMMEDIATE' : 'PRIVACY_TIMED' };
}

export const ERROR_CODES = Object.freeze([
  'INSUFFICIENT_ANONYMITY', 'GRAPH_UNAVAILABLE', 'POLICY_DENIED', 'POLICY_UNAVAILABLE',
  'MESH_UNAVAILABLE', 'PROOF_REJECTED', 'NULLIFIER_SPENT', 'UNSUPPORTED_DENOMINATION',
  'SETTLEMENT_REVERTED',
]);

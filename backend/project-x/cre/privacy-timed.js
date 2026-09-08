export function evaluatePrivacyTrigger({ compliant, privacyScore, minPrivacyScore, now, deadline }) {
  if (!compliant) return { fire: false, reason: 'POLICY_DENIED' };
  if (privacyScore >= minPrivacyScore) return { fire: true, reason: 'PRIVACY_THRESHOLD' };
  if (now >= deadline) return { fire: true, reason: 'DEADLINE' };
  return { fire: false, reason: 'WAITING_FOR_PRIVACY' };
}

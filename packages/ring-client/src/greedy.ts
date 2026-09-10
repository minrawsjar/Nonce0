import { DENOMINATIONS, ProtocolFailure, type Denomination } from '@opaque/protocol-types';

const descending = [...DENOMINATIONS].sort((a, b) => b - a);

/**
 * Standard greedy coin decomposition: take floor(remainder / denomination)
 * at each public bucket. Values are USDC6 integer units.
 */
export function greedyDecompose(amount: bigint): readonly Denomination[] {
  if (amount <= 0n) throw new ProtocolFailure('INVALID_INPUT', 'amount must be positive');
  let remainder = amount;
  const out: Denomination[] = [];
  for (const denomination of descending) {
    const count = remainder / BigInt(denomination);
    for (let i = 0n; i < count; i++) out.push(denomination);
    remainder -= count * BigInt(denomination);
  }
  if (remainder !== 0n) throw new ProtocolFailure('UNSUPPORTED_DENOMINATION', 'amount cannot be represented by note buckets');
  return out;
}

/**
 * Greedily selects the fewest caller-supplied eligible notes. The input must
 * already exclude notes lacking the required seven same-bucket Graph decoys.
 */
export function greedySelectNotes(amount: bigint, eligibleDenominations: readonly Denomination[]): readonly Denomination[] {
  if (amount <= 0n) throw new ProtocolFailure('INVALID_INPUT', 'amount must be positive');
  const available = new Map<Denomination, number>();
  for (const denomination of eligibleDenominations) {
    available.set(denomination, (available.get(denomination) ?? 0) + 1);
  }
  let remainder = amount;
  const out: Denomination[] = [];
  for (const denomination of descending) {
    const required = remainder / BigInt(denomination);
    const take = required < BigInt(available.get(denomination) ?? 0)
      ? Number(required)
      : (available.get(denomination) ?? 0);
    for (let i = 0; i < take; i++) out.push(denomination);
    remainder -= BigInt(take * denomination);
  }
  if (remainder !== 0n) {
    throw new ProtocolFailure('INSUFFICIENT_ANONYMITY', 'eligible notes cannot cover the requested amount exactly', true);
  }
  return out;
}

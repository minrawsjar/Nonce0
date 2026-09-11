export interface PaymentDeadlineInput {
  readonly waitForPrivacy: boolean;
  readonly selectedMs?: number;
  readonly nowMs: number;
}

/**
 * Immediate mode still uses the privacy-timed path. One second prevents the
 * executor receiving a deadline that became stale in transit.
 */
export function paymentDeadline(input: PaymentDeadlineInput): bigint {
  if (!input.waitForPrivacy) return BigInt(Math.floor(input.nowMs / 1_000) + 1);
  if (input.selectedMs === undefined || !Number.isFinite(input.selectedMs) || input.selectedMs <= input.nowMs) {
    throw new Error('Choose a future latest-settlement time.');
  }
  return BigInt(Math.floor(input.selectedMs / 1_000));
}

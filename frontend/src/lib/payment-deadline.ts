export interface PaymentDeadlineInput {
  readonly waitForPrivacy: boolean;
  readonly selectedMs?: number;
  readonly nowMs: number;
}

/**
 * How long an immediate payment's deadline leaves for the trip. Its proof and
 * ~35-chunk upload take 20–40 s, minutes under load, and the executor refuses
 * an intent whose deadline has passed when it arrives: at +1 s every payment
 * was refused. Immediate payments settle on arrival (minimum score 0), so
 * this is only a window for the upload, not a wait.
 */
export const IMMEDIATE_WINDOW_SECONDS = 600;

/**
 * Immediate mode still uses the privacy-timed path, with a window for the
 * trip; waiting mode takes the user's latest-settlement time.
 */
export function paymentDeadline(input: PaymentDeadlineInput): bigint {
  if (!input.waitForPrivacy) return BigInt(Math.floor(input.nowMs / 1_000) + IMMEDIATE_WINDOW_SECONDS);
  if (input.selectedMs === undefined || !Number.isFinite(input.selectedMs) || input.selectedMs <= input.nowMs) {
    throw new Error('Choose a future latest-settlement time.');
  }
  return BigInt(Math.floor(input.selectedMs / 1_000));
}

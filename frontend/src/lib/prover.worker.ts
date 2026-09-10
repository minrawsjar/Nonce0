// The ring proof, off the main thread. 219 ZKBoo repetitions take seconds, and
// on the main thread those seconds were a frozen tab.
//
// Same origin as the page, so the note secret never leaves it: it arrives by
// postMessage (a copy), is used once, and is zeroed here as the page zeroes
// its own copy.

import { buildRingSpend, verifyRingSpend } from '../../../backend/zk/index.ts';

type Request =
  | { readonly id: number; readonly op: 'prove'; readonly input: Parameters<typeof buildRingSpend>[0] }
  | { readonly id: number; readonly op: 'verify'; readonly input: Parameters<typeof verifyRingSpend>[0] };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, op, input } = event.data;
  try {
    const result = op === 'prove' ? buildRingSpend(input) : verifyRingSpend(input);
    self.postMessage({ id, result });
  } catch (error) {
    const e = error as { code?: string; publicMessage?: string; message?: string; retryable?: boolean };
    self.postMessage({ id, error: { code: e.code ?? 'PROOF_REJECTED', message: e.publicMessage ?? e.message ?? 'the prover failed', retryable: e.retryable ?? false } });
  } finally {
    if (op === 'prove') input.noteSecret.fill(0);
  }
};

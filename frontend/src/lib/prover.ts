// The page's side of prover.worker.ts: a RingProver whose work happens off
// the main thread.

import { ProtocolFailure, type PrivateSpend } from '@opaque/protocol-types';

import type { RingProver } from '../../../packages/ring-client/src/ring-client.ts';

export function createWorkerProver(): RingProver {
  const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let next = 0;

  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: { code: string; message: string; retryable: boolean } }>) => {
    const { id, result, error } = event.data;
    const waiting = pending.get(id);
    pending.delete(id);
    if (error !== undefined) waiting?.reject(new ProtocolFailure(error.code as never, error.message, error.retryable));
    else waiting?.resolve(result as never);
  };
  // A worker that fails to load fails every call waiting on it, not silently.
  worker.onerror = (event) => {
    for (const waiting of pending.values()) waiting.reject(new Error(`the prover worker failed: ${event.message}`));
    pending.clear();
  };

  // postMessage runs inside the Promise executor, synchronously: the secret is
  // copied before prove() returns and the vault zeroes the page's copy.
  const call = <T>(op: 'prove' | 'verify', input: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (value: never) => void, reject });
      worker.postMessage({ id, op, input });
    });

  return {
    prove: (input) => call<PrivateSpend>('prove', input),
    verify: (spend) => call<boolean>('verify', spend),
  };
}

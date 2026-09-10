import type { PrivateSpend, RingClient, RingSnapshot } from '@opaque/protocol-types';
import { buildRingSpend, verifyRingSpend, type BuildRingSpendInput } from '@opaque/zk';
import type { NoteVault } from './note-vault.ts';
import { selectDecoys } from './selection.ts';

/**
 * Where the ring proof is built and checked. The default runs in this thread;
 * a page passes a Web Worker, because 219 ZKBoo repetitions freeze a tab.
 *
 * prove() must take what it needs from `noteSecret` BEFORE it returns: the
 * vault zeroes that buffer the moment prove() returns, which for an async
 * prover is before it resolves. postMessage copies synchronously, so a worker
 * that posts inside prove() is safe.
 */
export interface RingProver {
  prove(input: BuildRingSpendInput): PrivateSpend | Promise<PrivateSpend>;
  verify(spend: PrivateSpend): boolean | Promise<boolean>;
}

const inThread: RingProver = { prove: buildRingSpend, verify: (spend) => verifyRingSpend(spend) };

/** Keeps secrets in NoteVault; callers receive only an opaque spend. */
export function createRingClient(vault: NoteVault, prover: RingProver = inThread): RingClient {
  return {
    createNote: (scope) => vault.create(scope),
    listNotes: (scope) => vault.list(scope),
    recordDeposit: (noteId, txHash) => vault.recordDeposit(noteId, txHash),
    reconcileNote: (noteId) => vault.reconcile(noteId),
    releaseReservation: (input) => vault.release(input),
    async buildSpend(input): Promise<PrivateSpend> {
      const notes = await vault.list(input.candidates.scope);
      const note = notes.find((n) => n.id === input.noteId);
      if (note === undefined) throw new Error('unknown note');
      await vault.reserve(input.noteId, input.reservation);
      const decoys = selectDecoys({
        scope: note.scope,
        snapshot: input.candidates as RingSnapshot,
        exclude: note.commitment,
      });
      return vault.useSecret(input.noteId, input.reservation, (noteSecret) =>
        prover.prove({ scope: note.scope, recipient: input.recipient, noteSecret, decoys }),
      );
    },
    async verifyLocally(spend) { return prover.verify(spend); },
  };
}

import type { PrivateSpend, RingClient, RingSnapshot } from '@opaque/protocol-types';
import { buildRingSpend, verifyRingSpend } from '@opaque/zk';
import type { NoteVault } from './note-vault.ts';
import { selectDecoys } from './selection.ts';

/** Keeps secrets in NoteVault; callers receive only an opaque spend. */
export function createRingClient(vault: NoteVault): RingClient {
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
        buildRingSpend({ scope: note.scope, recipient: input.recipient, noteSecret, decoys }),
      );
    },
    async verifyLocally(spend) { return verifyRingSpend(spend); },
  };
}

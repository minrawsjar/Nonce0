import { ProtocolFailure, type Address, type IdempotencyKey, type NoteSummary, type PrivateSpend, type RingSnapshot } from '@opaque/protocol-types';
import type { NoteVault } from './note-vault.ts';
import { buildRingSpend } from '@opaque/zk';
import { greedySelectNotes } from './greedy.ts';
import { selectDecoys } from './selection.ts';

export interface GreedyMultiNoteInput {
  readonly amount: bigint;
  readonly recipient: Address;
  readonly reservationPrefix: string;
  readonly snapshots: ReadonlyMap<number, RingSnapshot>;
}

/** Builds one anonymous ring spend per greedy fixed-value note; no partial result escapes. */
export async function buildGreedyMultiNoteSpends(vault: NoteVault, input: GreedyMultiNoteInput): Promise<readonly PrivateSpend[]> {
  const notes = (await vault.list()).filter((note) => note.state === 'AVAILABLE');
  const selectedDenoms = greedySelectNotes(input.amount, notes.map((n) => n.scope.denomination));
  const selected: NoteSummary[] = [];
  for (const denomination of selectedDenoms) {
    const note = notes.find((n) => n.scope.denomination === denomination && !selected.includes(n));
    if (note === undefined) throw new ProtocolFailure('INSUFFICIENT_ANONYMITY', 'eligible note disappeared during selection', true);
    selected.push(note);
  }
  const spends: PrivateSpend[] = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      const note = selected[i]!;
      const reservation = `${input.reservationPrefix}:${i}` as IdempotencyKey;
      const snapshot = input.snapshots.get(note.scope.denomination);
      if (snapshot === undefined) throw new ProtocolFailure('GRAPH_UNAVAILABLE', `missing ${note.scope.denomination} bucket`, true);
      await vault.reserve(note.id, reservation);
      const decoys = selectDecoys({ scope: note.scope, snapshot, exclude: note.commitment });
      spends.push(await vault.useSecret(note.id, reservation, (secret) => buildRingSpend({ scope: note.scope, recipient: input.recipient, noteSecret: secret, decoys })));
    }
    return spends;
  } catch (error) {
    await Promise.all(selected.map((note, i) => vault.release({ noteId: note.id, reservation: `${input.reservationPrefix}:${i}` as IdempotencyKey, terminalIntent: 'selection-failed' as never }).catch(() => undefined)));
    throw error;
  }
}

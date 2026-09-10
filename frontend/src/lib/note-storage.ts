// Notes in the browser, in localStorage.
//
// A note's secret IS the money: whoever holds it can spend it. This keeps
// secrets in localStorage because that is the stated V1 design (README, "There
// is no recovery for notes") — and so, stated plainly:
//
//   - Any script running on this origin can read every funded note. An XSS on
//     the wallet page is a theft of the whole balance, not a UI glitch.
//   - Clearing site data destroys them, and nothing can recover them.
//
// The real fix is notes encrypted under a key the user holds, derived so they
// can be rebuilt from a seed. That is a design change, not a storage swap.

import type { NoteId } from '@opaque/protocol-types';

import type { NoteStorage, StoredNote } from '../../../packages/ring-client/src/index.ts';

// JSON has no bigint. createdAtBlock and the scope's chainId round-trip as
// "<digits>n" — the same spelling the relay directory uses, so one reviver
// reads both.
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export function localNoteStorage(key = 'opaque:notes:v1'): NoteStorage {
  const load = (): Record<string, StoredNote> => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}', reviver) as Record<string, StoredNote>;
    } catch {
      // Corrupt storage is refused, not silently reset: an empty map here
      // would look like "no notes" to a user whose money is in there.
      throw new Error(`the note store at localStorage["${key}"] is unreadable — not overwriting it`);
    }
  };
  return {
    async read(id: NoteId) {
      return load()[id as string];
    },
    async write(note: StoredNote) {
      const all = load();
      all[note.id as string] = note;
      localStorage.setItem(key, JSON.stringify(all, replacer));
    },
    async all() {
      return Object.values(load());
    },
  };
}

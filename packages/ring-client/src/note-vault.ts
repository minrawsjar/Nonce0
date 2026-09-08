// Note custody and the note lifecycle (§6.6). Owner: Aditya, T1.
//
// This module is the ONLY place a note secret exists. Everything above it sees
// NoteSummary, which cannot carry one.
//
// Two rules the rest of the file exists to enforce:
//
//   1. A note is persisted BEFORE its deposit is submitted. The reverse order
//      loses the secret for money that is already in the pool — a crash
//      between the two must leave a recoverable record, not funded bytes
//      nobody can open.
//   2. AVAILABLE requires matching on-chain evidence. Never optimism, never a
//      transaction hash the caller supplied. recordDeposit only ever reaches
//      DEPOSIT_PENDING; only reconcile() can fund a note.
//
// §6.6 also says, plainly: notes live in local storage only and there is NO
// recovery. Storage is therefore an injected interface — a browser supplies
// IndexedDB or localStorage, this package ships a memory implementation for
// tests — and losing it loses the funds.

import {
  ProtocolFailure,
  type Hex,
  type IdempotencyKey,
  type IntentId,
  type NoteCommitment,
  type NoteId,
  type NoteState,
  type NoteSummary,
  type Nullifier,
  type PoolScope,
  type TxHash,
} from '@opaque/protocol-types';
import { asBytes32, asPoolScope, fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { createNoteSecret, deriveCommitment, deriveNullifier } from '@opaque/zk';

/**
 * What a storage backend holds. The secret is here and nowhere else; anything
 * that persists this record is holding spending authority for real money.
 *
 * Absent values are `null` rather than missing keys so a JSON-shaped backend
 * (localStorage) round-trips without an undefined/missing distinction.
 */
export interface StoredNote {
  readonly id: NoteId;
  readonly scope: PoolScope;
  readonly commitment: NoteCommitment;
  /** The spending authority. Never leaves this module. */
  readonly secret: Hex;
  readonly state: NoteState;
  readonly depositTx: TxHash | null;
  /** Set only from on-chain evidence. */
  readonly createdAtBlock: bigint | null;
  readonly reservation: IdempotencyKey | null;
}

/** Injected so a browser can supply its own local store (§6.6). */
export interface NoteStorage {
  read(id: NoteId): Promise<StoredNote | undefined>;
  write(note: StoredNote): Promise<void>;
  all(): Promise<readonly StoredNote[]>;
}

/** The on-chain evidence a note's state is allowed to depend on. */
export interface ChainObserver {
  /** Non-null when the pool actually holds this commitment. */
  observeCommitment(
    scope: PoolScope,
    commitment: NoteCommitment,
  ): Promise<{ readonly blockNumber: bigint } | null>;
  isNullifierSpent(scope: PoolScope, nullifier: Nullifier): Promise<boolean>;
}

export interface NoteVault {
  create(scope: PoolScope): Promise<NoteSummary>;
  list(scope?: PoolScope): Promise<readonly NoteSummary[]>;
  recordDeposit(noteId: NoteId, txHash: TxHash): Promise<NoteSummary>;
  reconcile(noteId: NoteId): Promise<NoteSummary>;
  reserve(noteId: NoteId, reservation: IdempotencyKey): Promise<NoteSummary>;
  release(input: {
    readonly noteId: NoteId;
    readonly reservation: IdempotencyKey;
    readonly terminalIntent: IntentId;
  }): Promise<NoteSummary>;
  /**
   * Lends the secret to a prover for the duration of one call. The reservation
   * is required, so only the holder of the reservation can spend the note, and
   * the copy handed out is zeroed on the way back — the secret is never a
   * return value anywhere in this package.
   */
  useSecret<T>(
    noteId: NoteId,
    reservation: IdempotencyKey,
    use: (secret: Uint8Array) => T,
  ): Promise<T>;
}

export interface NoteVaultDeps {
  readonly storage: NoteStorage;
  readonly chain: ChainObserver;
  readonly newId?: () => string;
  readonly randomBytes?: (bytes: number) => Uint8Array;
}

export function memoryNoteStorage(seed: readonly StoredNote[] = []): NoteStorage {
  const notes = new Map<NoteId, StoredNote>(seed.map((n) => [n.id, n]));
  return {
    read: async (id) => notes.get(id),
    write: async (note) => void notes.set(note.id, note),
    all: async () => [...notes.values()],
  };
}

const invalid = (message: string): never => {
  throw new ProtocolFailure('INVALID_INPUT', message);
};

function asIdempotencyKey(value: unknown): IdempotencyKey {
  if (typeof value !== 'string' || value.length === 0) invalid('reservation must be a non-empty key');
  return value as IdempotencyKey;
}

const sameScope = (a: PoolScope, b: PoolScope): boolean =>
  a.chainId === b.chainId && a.pool === b.pool && a.denomination === b.denomination;

/** The safe projection. Structurally incapable of carrying the secret. */
const summarise = (note: StoredNote): NoteSummary =>
  note.createdAtBlock === null
    ? { id: note.id, commitment: note.commitment, scope: note.scope, state: note.state }
    : {
        id: note.id,
        commitment: note.commitment,
        scope: note.scope,
        state: note.state,
        createdAtBlock: note.createdAtBlock,
      };

/**
 * The only state transition that reads the chain.
 *
 * `funded` is evidence the pool holds the commitment; `spent` is evidence the
 * nullifier is burnt. A note we believed was funded that the chain does not
 * show is a discrepancy, not something to quietly downgrade back to
 * DEPOSIT_PENDING — that would let a UI keep offering a note to spend.
 */
function nextState(current: NoteState, spent: boolean, funded: boolean): NoteState {
  if (spent) return 'SPENT';
  if (!funded) {
    return current === 'AVAILABLE' || current === 'RESERVED' ? 'RECONCILIATION_REQUIRED' : current;
  }
  switch (current) {
    case 'CREATED':
    case 'DEPOSIT_PENDING':
    case 'RECONCILIATION_REQUIRED':
      return 'AVAILABLE';
    // Locally SPENT is only ever set from chain evidence, so the chain
    // disagreeing now means a reorg — a human problem, not an automatic one.
    case 'SPENT':
      return 'RECONCILIATION_REQUIRED';
    default:
      return current;
  }
}

export function createNoteVault(deps: NoteVaultDeps): NoteVault {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());

  async function must(noteId: NoteId): Promise<StoredNote> {
    const note = await deps.storage.read(noteId);
    if (note === undefined) invalid(`unknown note ${String(noteId)}`);
    return note as StoredNote;
  }

  /** Derives inside the vault, so the caller never needs the secret to ask. */
  const nullifierOf = (note: StoredNote): Nullifier =>
    deriveNullifier(fromHex(note.secret), note.scope);

  async function save(note: StoredNote): Promise<NoteSummary> {
    await deps.storage.write(note);
    return summarise(note);
  }

  return {
    async create(scope) {
      const validated = asPoolScope(scope);
      const secret = createNoteSecret(deps.randomBytes);
      // §6.2 proves THIS derivation. Hashing our own commitment here would
      // produce a note no ring proof could ever open.
      const commitment = deriveCommitment(secret, validated);
      const note: StoredNote = {
        id: newId() as NoteId,
        scope: validated,
        commitment,
        secret: toHex(secret),
        state: 'CREATED',
        depositTx: null,
        createdAtBlock: null,
        reservation: null,
      };
      secret.fill(0);
      // Persisted BEFORE the caller can possibly submit a deposit: a crash
      // after this line is recoverable, a crash before it costs nothing.
      return save(note);
    },

    async list(scope) {
      const notes = await deps.storage.all();
      const wanted = scope === undefined ? undefined : asPoolScope(scope);
      return notes
        .filter((n) => wanted === undefined || sameScope(n.scope, wanted))
        .map(summarise);
    },

    async recordDeposit(noteId, txHash) {
      const tx = asBytes32(txHash) as unknown as TxHash;
      const note = await must(noteId);
      if (note.state === 'DEPOSIT_PENDING' && note.depositTx === tx) return summarise(note);
      if (note.state !== 'CREATED') {
        invalid(`a deposit can only be recorded against a CREATED note, this one is ${note.state}`);
      }
      // A transaction hash is a claim, not evidence. DEPOSIT_PENDING is as far
      // as it goes; reconcile() is what reads the chain.
      return save({ ...note, state: 'DEPOSIT_PENDING', depositTx: tx });
    },

    async reconcile(noteId) {
      const note = await must(noteId);
      const spent = await deps.chain.isNullifierSpent(note.scope, nullifierOf(note));
      const evidence = await deps.chain.observeCommitment(note.scope, note.commitment);
      const state = nextState(note.state, spent, evidence !== null);
      return save({
        ...note,
        state,
        createdAtBlock: evidence?.blockNumber ?? note.createdAtBlock,
        // A reservation only means anything while the note is RESERVED.
        reservation: state === 'RESERVED' ? note.reservation : null,
      });
    },

    async reserve(noteId, reservation) {
      const key = asIdempotencyKey(reservation);
      const note = await must(noteId);

      if (note.state === 'RESERVED') {
        // A different key means a second payment is trying to claim a note the
        // first one is already spending. That is the double-spend attempt.
        if (note.reservation !== key) {
          throw new ProtocolFailure('NOTE_RESERVED', 'note is reserved for another payment');
        }
      } else if (note.state === 'SPENT') {
        throw new ProtocolFailure('NULLIFIER_SPENT', 'note is already spent');
      } else if (note.state !== 'AVAILABLE') {
        invalid(`only an AVAILABLE note can be reserved, this one is ${note.state}`);
      }

      // §6.6: the local spent flag is a convenience. Always re-check the chain
      // before spending — a note spent from another device still looks
      // AVAILABLE here.
      if (await deps.chain.isNullifierSpent(note.scope, nullifierOf(note))) {
        await save({ ...note, state: 'SPENT', reservation: null });
        throw new ProtocolFailure('NULLIFIER_SPENT', 'note is already spent on chain');
      }

      return save({ ...note, state: 'RESERVED', reservation: key });
    },

    async release(input) {
      const key = asIdempotencyKey(input.reservation);
      // The intent id is the caller's evidence that the payment reached a
      // terminal state. We cannot verify that here, so we only require it to
      // be present — a release with no intent behind it is a caller bug.
      if (typeof input.terminalIntent !== 'string' || input.terminalIntent.length === 0) {
        invalid('releasing a reservation requires the terminal intent it belonged to');
      }
      const note = await must(input.noteId);
      if (note.state === 'AVAILABLE' && note.reservation === null) return summarise(note);
      if (note.state !== 'RESERVED') {
        invalid(`only a RESERVED note can be released, this one is ${note.state}`);
      }
      if (note.reservation !== key) {
        throw new ProtocolFailure('NOTE_RESERVED', 'reservation belongs to another payment');
      }
      return save({ ...note, state: 'AVAILABLE', reservation: null });
    },

    async useSecret(noteId, reservation, use) {
      const key = asIdempotencyKey(reservation);
      const note = await must(noteId);
      if (note.state !== 'RESERVED') {
        invalid(`the note must be RESERVED to be spent, this one is ${note.state}`);
      }
      if (note.reservation !== key) {
        throw new ProtocolFailure('NOTE_RESERVED', 'reservation belongs to another payment');
      }
      const secret = fromHex(note.secret);
      try {
        return use(secret);
      } finally {
        secret.fill(0);
      }
    },
  };
}

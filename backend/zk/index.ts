// The ZK module's public surface. Consumers import THIS FILE.
//
// bits.ts, aes.ts and zkboo.ts are internals: a caller that reaches past this
// barrel is either re-deriving a note commitment by hand — the one thing
// statement.ts exists to stop — or building a proof at a repetition count the
// pool never pinned.

export {
  buildRingSpend,
  createNoteSecret,
  deriveCommitment,
  deriveNullifier,
  SCHEME,
  verifierId,
  verifyRingSpend,
  type BuildRingSpendInput,
  type RingSpend,
} from './spend.ts';

export {
  countAnds,
  noteBlock,
  nullifierBlock,
  publicInputs,
  RING_SIZE,
  SECRET_BYTES,
  type StatementPublic,
} from './statement.ts';

export { proofSize, REPS_128 } from './zkboo.ts';

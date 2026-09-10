// The package barrel: the wallet SDK, plus the low-level exports the mesh
// builds on.
//
// IndexedDbSignerStore is NOT here, and is reached at '@opaque/pq-wallet/browser'
// instead. It is a browser store — its types are IDBFactory and IDBDatabase —
// and re-exporting it from the barrel put lib.DOM into the type graph of every
// consumer, including a Node backend that has no IndexedDB and never will.
// That broke `npm run typecheck:all`. Adding "DOM" to the backend's lib would
// have silenced it while quietly permitting `window` and `document` in server
// code, which is the opposite of the fix.
//
// `verify` is deliberately NOT re-exported under that bare name. It is one of
// three things a caller could reasonably mean in this codebase — a signature
// (fors.ts), a proof (zk/zkboo.ts) or a directory (mesh/directory.ts) — and an
// unqualified `verify` at a call site is the kind of ambiguity that gets
// resolved wrongly at 3am. Use forsVerify.
export { createPqWallet, type WalletOptions } from './wallet.ts';
export { createMockPqWallet } from './mock.ts';

export {
  PQ_DOMAIN,
  canonical,
  pqDigest,
  utf8,
  type DigestInput,
} from './digest.ts';

export {
  FORS_C_DEFAULT,
  assertForsParams,
  decodeSignature,
  deriveIndices,
  encodeSignature,
  forsSchemeId,
  keyGen,
  pkCommitment,
  randomSeed,
  sign,
  verify as forsVerify,
  type ForsParams,
  type ForsPublicKey,
  type ForsSecretKey,
  type ForsSignature,
} from './fors.ts';

// The package barrel. `exports` in package.json has always pointed here, but
// the file did not exist, so every consumer reached past it with a relative
// path into src/ — which is how backend/mesh/directory.ts ended up importing
// ../../packages/pq-wallet/src/fors.ts.
//
// Two modules, no overlap: digest.ts owns canonical encoding and the §5.3
// payload digest, fors.ts owns the few-time signature scheme.
//
// `verify` is deliberately NOT re-exported under that bare name. It is one of
// three things a caller could reasonably mean in this codebase (a signature, a
// proof, a directory), and an unqualified `verify` at a call site is the kind
// of ambiguity that gets resolved wrongly at 3am.

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

// Preserve the low-level exports used by the mesh alongside the wallet SDK.
export { createPqWallet, type WalletOptions } from './wallet.ts';
export { createMockPqWallet } from './mock.ts';
export { IndexedDbSignerStore } from './indexeddb-store.ts';

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
  verify,
  verify as forsVerify,
  type ForsParams,
  type ForsPublicKey,
  type ForsSecretKey,
  type ForsSignature,
} from './fors.ts';

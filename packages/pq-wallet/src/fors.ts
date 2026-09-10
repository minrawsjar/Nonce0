// §5.1 — FORS+C: a few-time, hash-based signature over Keccak256.
//
// Structure: k independent Merkle trees of height `a`, each over 2^a
// pseudorandom secret leaves. The message digest selects one leaf index per
// tree; a signature reveals that leaf secret plus its authentication path in
// every tree. The public key is a hash of the k roots.
//
// Why few-time and not one-time (WOTS+): reusing a WOTS+ key is catastrophic
// and immediate. FORS degrades — each extra signature under one key reveals
// more leaves, and forgery probability grows smoothly rather than hitting 1.
// §5.2's useCount cap is the thing that keeps it in the graceful region, and
// PqKeyRegistry refuses rather than continuing once it is spent.
//
// Domain separation: PRF, leaf, internal node, root-set and pk-commitment
// hashes each carry a distinct tag, and node hashes additionally bind the tree
// index and the level. One unseparated hash for both leaves and internal nodes
// is a real forgery vector — an attacker presents a revealed internal node as
// if it were a leaf preimage and shortens the path.

import { keccak_256 } from '@noble/hashes/sha3.js';

import { ProtocolFailure, type Bytes32, type Hex } from '@opaque/protocol-types';
import { asBytes32, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { canonical, utf8 } from './digest.ts';

const PRF_DOMAIN = 'opaque/v1/fors/prf';
const LEAF_DOMAIN = 'opaque/v1/fors/leaf';
const NODE_DOMAIN = 'opaque/v1/fors/node';
const ROOTS_DOMAIN = 'opaque/v1/fors/roots';
const PK_COMMITMENT_DOMAIN = 'opaque/v1/fors/pk-commitment';
const INDEX_DOMAIN = 'opaque/v1/fors/index';

const HASH_BYTES = 32;

export interface ForsParams {
  /** Number of trees. One leaf is revealed per tree per signature. */
  readonly k: number;
  /** Tree height: each tree covers 2^a leaves. */
  readonly a: number;
}

/**
 * The committed parameter set.
 *
 * k = 32 trees of height 8 (256 leaves each).
 *
 * Cost, so nobody has to hand-wave it into a pitch deck (§5.5):
 *   keyGen / sign   32 * 256 PRF + 32 * 256 leaf + 32 * 255 node ≈ 24.5k keccaks
 *   verify          32 * (1 + 8) + 1 ≈ 290 keccaks  (~12k gas of hashing)
 *   signature       35 + 32 * 32 * 9 = 9251 bytes → ~148k gas of calldata
 * Calldata dominates on-chain cost, not hashing. Larger `a` shrinks nothing
 * (paths grow); larger `k` buys forgery resistance linearly in the exponent
 * and costs calldata linearly.
 *
 * Forgery resistance after q signatures under one key is about
 * (1 - (1 - 2^-a)^q)^k: q=1 → 2^-256, q=8 → 2^-160, q=32 → 2^-121. That is why
 * maxUses is small and why exceeding it is refused rather than warned about.
 * These are the analytic numbers; §5.1 still wants them benchmarked on chain.
 */
export const FORS_C_DEFAULT: ForsParams = Object.freeze({ k: 32, a: 8 });

export interface ForsSecretKey {
  readonly params: ForsParams;
  /** 32-byte PRF seed. Every leaf secret is derived from it, so this is the whole key. */
  readonly seed: Uint8Array;
}

export interface ForsPublicKey {
  readonly params: ForsParams;
  /** keccak(ROOTS_DOMAIN, k, a, root_0 .. root_{k-1}). */
  readonly value: Uint8Array;
}

export interface ForsSignature {
  readonly params: ForsParams;
  /** One revealed leaf secret per tree. */
  readonly leaves: readonly Uint8Array[];
  /** One authentication path per tree, `a` sibling nodes each, leaf level first. */
  readonly paths: readonly (readonly Uint8Array[])[];
}

function fail(message: string): never {
  throw new ProtocolFailure('INVALID_INPUT', message);
}

export function assertForsParams(params: ForsParams): void {
  if (typeof params !== 'object' || params === null) fail('fors parameters are required');
  const { k, a } = params;
  if (!Number.isInteger(k) || k < 1 || k > 64) fail(`fors k must be an integer within 1..64, got ${String(k)}`);
  // a > 20 means a million leaves per tree: keyGen stops being a hackathon
  // operation long before it stops being expressible.
  if (!Number.isInteger(a) || a < 1 || a > 20) fail(`fors a must be an integer within 1..20, got ${String(a)}`);
}

/** Goes into the §5.3 digest, so a signature can never be reinterpreted under other parameters. */
export const forsSchemeId = (params: ForsParams): string => {
  assertForsParams(params);
  return `FORS+C/keccak256/k=${params.k},a=${params.a}`;
};

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
};

const h = (domain: string, fields: readonly Uint8Array[]): Uint8Array =>
  keccak_256(canonical([utf8(domain), ...fields]));

const leafSecret = (seed: Uint8Array, tree: number, index: number): Uint8Array =>
  h(PRF_DOMAIN, [seed, u32(tree), u32(index)]);

const leafNode = (tree: number, index: number, secret: Uint8Array): Uint8Array =>
  h(LEAF_DOMAIN, [u32(tree), u32(index), secret]);

/** `level` is the level of the two children, so a node's height is bound into its hash. */
const internalNode = (tree: number, level: number, left: Uint8Array, right: Uint8Array): Uint8Array =>
  h(NODE_DOMAIN, [u32(tree), u32(level), left, right]);

export function randomSeed(): Uint8Array {
  const seed = new Uint8Array(HASH_BYTES);
  crypto.getRandomValues(seed);
  return seed;
}

/**
 * One leaf index per tree, each `a` bits wide.
 *
 * FIPS 205 splits the message digest itself into k*a bits. That caps k*a at
 * 256; deriving each index by a separate domain-separated hash of the digest
 * keeps (k, a) a free parameter, which §5.1 requires so the set can move after
 * benchmarking. It stays a deterministic, uniform function of the digest.
 */
export function deriveIndices(digest: Bytes32, params: ForsParams): number[] {
  assertForsParams(params);
  const bytes = fromHex(asBytes32(digest));
  const mask = (1n << BigInt(params.a)) - 1n;
  const out: number[] = [];
  for (let i = 0; i < params.k; i++) {
    const stream = h(INDEX_DOMAIN, [u32(params.k), u32(params.a), bytes, u32(i)]);
    let acc = 0n;
    for (let b = 0; b < 8; b++) acc = (acc << 8n) | BigInt(stream[b]!);
    out.push(Number(acc & mask));
  }
  return out;
}

/** levels[0] is the leaf level, levels[a] holds the single root. */
function treeLevels(seed: Uint8Array, params: ForsParams, tree: number): Uint8Array[][] {
  const width = 1 << params.a;
  let level: Uint8Array[] = new Array<Uint8Array>(width);
  for (let j = 0; j < width; j++) level[j] = leafNode(tree, j, leafSecret(seed, tree, j));

  const levels: Uint8Array[][] = [level];
  for (let l = 0; l < params.a; l++) {
    const next: Uint8Array[] = new Array<Uint8Array>(level.length / 2);
    for (let j = 0; j < next.length; j++) {
      next[j] = internalNode(tree, l, level[2 * j]!, level[2 * j + 1]!);
    }
    level = next;
    levels.push(level);
  }
  return levels;
}

const rootsToValue = (params: ForsParams, roots: readonly Uint8Array[]): Uint8Array =>
  h(ROOTS_DOMAIN, [u32(params.k), u32(params.a), ...roots]);

export function keyGen(
  seed: Uint8Array = randomSeed(),
  params: ForsParams = FORS_C_DEFAULT,
): { readonly secretKey: ForsSecretKey; readonly publicKey: ForsPublicKey } {
  assertForsParams(params);
  if (!(seed instanceof Uint8Array) || seed.length !== HASH_BYTES) fail('fors seed must be 32 bytes');

  const roots: Uint8Array[] = [];
  for (let i = 0; i < params.k; i++) roots.push(treeLevels(seed, params, i)[params.a]![0]!);

  return {
    secretKey: { params, seed: Uint8Array.from(seed) },
    publicKey: { params, value: rootsToValue(params, roots) },
  };
}

/**
 * The bytes32 the registry stores. Binds the parameters as well as the key, so
 * a public key cannot be re-presented under a weaker (k, a).
 */
export const pkCommitment = (publicKey: ForsPublicKey): Bytes32 => {
  assertPublicKey(publicKey);
  return toHex(
    h(PK_COMMITMENT_DOMAIN, [u32(publicKey.params.k), u32(publicKey.params.a), publicKey.value]),
  ) as Bytes32;
};

export function sign(secretKey: ForsSecretKey, digest: Bytes32): ForsSignature {
  if (!(secretKey?.seed instanceof Uint8Array) || secretKey.seed.length !== HASH_BYTES) {
    fail('fors seed must be 32 bytes');
  }
  const params = secretKey.params;
  const indices = deriveIndices(digest, params);

  const leaves: Uint8Array[] = [];
  const paths: Uint8Array[][] = [];
  for (let i = 0; i < params.k; i++) {
    const index = indices[i]!;
    const levels = treeLevels(secretKey.seed, params, i);
    const path: Uint8Array[] = [];
    for (let l = 0; l < params.a; l++) path.push(levels[l]![((index >> l) ^ 1)]!);
    leaves.push(leafSecret(secretKey.seed, i, index));
    paths.push(path);
  }
  return { params, leaves, paths };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

function assertPublicKey(publicKey: ForsPublicKey): void {
  if (typeof publicKey !== 'object' || publicKey === null) fail('fors public key is required');
  assertForsParams(publicKey.params);
  if (!(publicKey.value instanceof Uint8Array) || publicKey.value.length !== HASH_BYTES) {
    fail('fors public key value must be 32 bytes');
  }
}

function assertSignature(publicKey: ForsPublicKey, signature: ForsSignature): void {
  assertPublicKey(publicKey);
  if (typeof signature !== 'object' || signature === null) fail('fors signature is required');
  assertForsParams(signature.params);
  const { k, a } = publicKey.params;
  if (signature.params.k !== k || signature.params.a !== a) fail('signature parameters do not match the public key');
  if (!Array.isArray(signature.leaves) || !Array.isArray(signature.paths) ||
      signature.leaves.length !== k || signature.paths.length !== k) fail('invalid fors signature shape');
  for (let i = 0; i < k; i++) {
    const leaf = signature.leaves[i];
    const path = signature.paths[i];
    if (!(leaf instanceof Uint8Array) || leaf.length !== HASH_BYTES || !Array.isArray(path) || path.length !== a) {
      fail('invalid fors leaf or authentication path');
    }
    for (let j = 0; j < a; j++) {
      if (!(path[j] instanceof Uint8Array) || path[j]!.length !== HASH_BYTES) fail('invalid fors sibling');
    }
  }
}

export function verify(publicKey: ForsPublicKey, digest: Bytes32, signature: ForsSignature): boolean {
  try { assertSignature(publicKey, signature); } catch { return false; }
  const params = publicKey.params;
  if (signature.params.k !== params.k || signature.params.a !== params.a) return false;
  if (signature.leaves.length !== params.k || signature.paths.length !== params.k) return false;

  const indices = deriveIndices(digest, params);
  const roots: Uint8Array[] = [];
  for (let i = 0; i < params.k; i++) {
    const secret = signature.leaves[i]!;
    const path = signature.paths[i]!;
    if (secret.length !== HASH_BYTES || path.length !== params.a) return false;

    const index = indices[i]!;
    let node = leafNode(i, index, secret);
    for (let l = 0; l < params.a; l++) {
      const sibling = path[l]!;
      if (sibling.length !== HASH_BYTES) return false;
      node = ((index >> l) & 1) === 0
        ? internalNode(i, l, node, sibling)
        : internalNode(i, l, sibling, node);
    }
    roots.push(node);
  }
  return sameBytes(rootsToValue(params, roots), publicKey.value);
}

// ── wire format ───────────────────────────────────────────────────────────
//
// The 4337 signature field is arbitrary bytes (§5.4), and pkCommitment is a
// hash, so the public key travels with the signature and the verifier checks
// it against the stored commitment. Fixed-width layout, exact length enforced:
//
//   k (uint16 BE) | a (uint8) | pk value (32) | k * (leaf 32 | path a*32)

const encodedLength = (params: ForsParams): number => 3 + HASH_BYTES + params.k * HASH_BYTES * (1 + params.a);

export function encodeSignature(publicKey: ForsPublicKey, signature: ForsSignature): Hex {
  assertSignature(publicKey, signature);
  const params = publicKey.params;
  assertForsParams(params);
  if (signature.params.k !== params.k || signature.params.a !== params.a) {
    fail('signature parameters do not match the public key');
  }
  const out = new Uint8Array(encodedLength(params));
  new DataView(out.buffer).setUint16(0, params.k, false);
  out[2] = params.a;
  out.set(publicKey.value, 3);

  let at = 3 + HASH_BYTES;
  for (let i = 0; i < params.k; i++) {
    out.set(signature.leaves[i]!, at);
    at += HASH_BYTES;
    for (const sibling of signature.paths[i]!) {
      out.set(sibling, at);
      at += HASH_BYTES;
    }
  }
  return toHex(out);
}

/** Trust boundary: this parses attacker-supplied bytes. Every length is checked. */
export function decodeSignature(value: Hex): {
  readonly publicKey: ForsPublicKey;
  readonly signature: ForsSignature;
} {
  const bytes = fromHex(value);
  if (bytes.length < 3 + HASH_BYTES) fail('fors signature is truncated');

  const params: ForsParams = { k: new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, false), a: bytes[2]! };
  assertForsParams(params);
  if (bytes.length !== encodedLength(params)) {
    fail(`fors signature must be ${encodedLength(params)} bytes for k=${params.k},a=${params.a}, got ${bytes.length}`);
  }

  const at = (offset: number): Uint8Array => bytes.slice(offset, offset + HASH_BYTES);
  const leaves: Uint8Array[] = [];
  const paths: Uint8Array[][] = [];
  let cursor = 3 + HASH_BYTES;
  for (let i = 0; i < params.k; i++) {
    leaves.push(at(cursor));
    cursor += HASH_BYTES;
    const path: Uint8Array[] = [];
    for (let l = 0; l < params.a; l++) {
      path.push(at(cursor));
      cursor += HASH_BYTES;
    }
    paths.push(path);
  }
  return {
    publicKey: { params, value: at(3) },
    signature: { params, leaves, paths },
  };
}

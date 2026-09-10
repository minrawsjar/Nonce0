// The attester: turns a verified RING_8 spend into one AttestedRingVerifier
// will accept on chain.
//
// A ring proof is 1.08 MiB and ~9 Arc blocks to verify, so it cannot go on
// chain (§6.3). It is verified HERE, off chain, and what goes on chain is this
// module's output instead: the nullifier and a FORS+C signature over the exact
// statement the contract checks — this ring, this nullifier, this payment
// context, this verifier.
//
// Used by the CRE workflow in the enclave and by the local stand-in until
// Confidential Workflows access lands. One module, so they cannot drift.
//
// ── Two rules this file exists to hold ───────────────────────────────────
//
//   1. Verify, then sign — never sign alone. The attester is trusted for
//      soundness and for nothing else; one that signed without checking the
//      proof would be an unconditional mint against the pool.
//
//   2. Compute the digest locally. Never sign bytes handed in by someone
//      else, and in particular never a digest read from an RPC: a hostile
//      endpoint could return the digest of a KEY ROTATION dressed as a spend,
//      and the attester would sign away its own identity. Everything signed
//      here is derived here, from values this module checked.

import { keccak_256 } from '@noble/hashes/sha3.js';

import {
  ProtocolFailure,
  type Address,
  type Bytes32,
  type Hex,
  type PrivateSpend,
} from '@opaque/protocol-types';
import { asChainId, derivePaymentContext, fromHex, poolId, toHex } from '@opaque/protocol-types/codecs.js';
import {
  canonical,
  encodeSignature,
  FORS_C_DEFAULT,
  forsSchemeId,
  keyGen,
  pqDigest,
  sign,
  utf8,
} from '@opaque/pq-wallet';

import { verifierId as zkVerifierId, verifyRingSpend } from '../zk/spend.ts';
import { REPS_128 } from '../zk/zkboo.ts';

// Pinned to AttestedRingVerifier.sol. Changing any of these is a protocol break.
const VERIFIER_DOMAIN = 'opaque/v1/spend-verifier';
const ATTEST_DOMAIN = 'opaque/v1/ring-attestation';
const SCHEME = 'attested-ring8/zkboo-aes128-ring8';
/** PQKeyRegistry.consume wraps every payload in this before digesting. */
const USER_ACTION_DOMAIN = 'opaque/v1/pq-wallet/action';
/** 219 repetitions, soundness 2^-128. The only ring proof an attester signs for. */
const ZK_VERIFIER_ID = zkVerifierId(REPS_128);

/** Who is attesting, and for which pool. All of it is committed to on chain. */
export interface AttesterIdentity {
  readonly chainId: bigint;
  readonly registry: Address;
  readonly attester: Address;
  readonly pool: Address;
  readonly denomination: number;
}

/** `abi.encode(bytes32[])`: offset, length, then the words. */
function abiEncodeRing(ring: readonly Bytes32[]): Uint8Array {
  const out = new Uint8Array(64 + ring.length * 32);
  new DataView(out.buffer).setUint32(28, 32, false);
  new DataView(out.buffer).setUint32(60, ring.length, false);
  ring.forEach((word, i) => out.set(fromHex(word), 64 + i * 32));
  return out;
}

/** `abi.encodePacked(uint32(20), addr)` — an address field, length-prefixed. */
function addressField(value: Address): Uint8Array {
  const out = new Uint8Array(24);
  new DataView(out.buffer).setUint32(0, 20, false);
  out.set(fromHex(value), 4);
  return out;
}

const scopeOf = (id: AttesterIdentity) =>
  ({ chainId: asChainId(id.chainId), pool: id.pool, denomination: id.denomination }) as never;

/** AttestedRingVerifier.verifierId(), computed rather than read. */
export function ringVerifierId(id: AttesterIdentity): Bytes32 {
  return toHex(
    keccak_256(
      new Uint8Array([
        ...canonical([
          utf8(VERIFIER_DOMAIN),
          utf8(SCHEME),
          fromHex(poolId(scopeOf(id))),
          utf8(String(id.denomination)),
        ]),
        ...addressField(id.registry),
        ...addressField(id.attester),
      ]),
    ),
  ) as Bytes32;
}

/** AttestedRingVerifier.attestation(ring, nullifier, paymentContext), byte for byte. */
export function attestationPayload(
  verifierId: Bytes32,
  ring: readonly Bytes32[],
  nullifier: Bytes32,
  paymentContext: Bytes32,
): Uint8Array {
  return canonical([
    utf8(ATTEST_DOMAIN),
    fromHex(verifierId),
    keccak_256(abiEncodeRing(ring)),
    fromHex(nullifier),
    fromHex(paymentContext),
  ]);
}

/**
 * The digest PQKeyRegistry.consume will recompute for this attestation. The
 * useCount is the attester's CURRENT index; a stale one only makes the
 * signature fail on chain, which is harmless — it can never make it valid for
 * something else, because every other input is computed here.
 */
export function attestationDigest(id: AttesterIdentity, payload: Uint8Array, useCount: bigint): Bytes32 {
  return pqDigest({
    chainId: asChainId(id.chainId),
    walletAddress: id.attester,
    schemeId: forsSchemeId(FORS_C_DEFAULT),
    useCount,
    payload: toHex(new Uint8Array([...utf8(USER_ACTION_DOMAIN), ...payload])) as Hex,
  });
}

/**
 * Verifies a RING_8 spend and returns it with the on-chain proof attached:
 * the nullifier, then a FORS+C signature under the attester's current key.
 * Throws PROOF_REJECTED rather than attesting anything it could not verify.
 */
export function attestRingSpend(input: {
  readonly spend: PrivateSpend;
  readonly identity: AttesterIdentity;
  readonly forsSeed: Uint8Array;
  readonly useCount: bigint;
}): PrivateSpend {
  const { spend, identity } = input;
  if (spend.mode !== 'RING_8') {
    throw new ProtocolFailure('UNSUPPORTED_PROOF_MODE', 'only a RING_8 spend can be attested');
  }
  // A spend for another pool would be attested under this pool's verifier id
  // and fail on chain — but refusing here says why, instead of burning an index.
  if (spend.scope.pool.toLowerCase() !== identity.pool.toLowerCase() || BigInt(spend.scope.chainId) !== identity.chainId) {
    throw new ProtocolFailure('INVALID_INPUT', 'the spend is scoped to a different pool than this attester serves');
  }
  if (spend.scope.denomination !== identity.denomination) {
    throw new ProtocolFailure('INVALID_INPUT', 'the spend is for a different denomination');
  }

  // RULE 1. The one check that makes this an attester and not a mint.
  //
  // PINNED to the full-strength verifier. verifyRingSpend reads the repetition
  // count out of the proof itself and, unpinned, accepts any count that is
  // self-consistent — so a 1-repetition proof, whose soundness error is a
  // constant fraction rather than 2^-128, verifies. Forging one for a note you
  // do not own takes a handful of guesses, and this function would sign it.
  // Found in review before anything used it; the test pins it.
  if (!verifyRingSpend(spend, ZK_VERIFIER_ID)) {
    throw new ProtocolFailure('PROOF_REJECTED', 'the ring proof does not verify at full strength');
  }

  // Recomputed, never read off the spend: the pool derives paymentContext
  // from the recipient it is given, so this is what it will actually check.
  const paymentContext = derivePaymentContext(spend.scope, spend.recipient);
  const nullifier = spend.nullifier as unknown as Bytes32;

  // RULE 2. Every byte signed below is derived here.
  const payload = attestationPayload(ringVerifierId(identity), spend.ring as unknown as Bytes32[], nullifier, paymentContext);
  const digest = attestationDigest(identity, payload, input.useCount);

  const key = keyGen(input.forsSeed);
  const signature = encodeSignature(key.publicKey, sign(key.secretKey, digest));

  // proof = 32-byte nullifier || FORS signature — AttestedRingVerifier.verifySpend.
  return { ...spend, paymentContext, proof: toHex(new Uint8Array([...fromHex(nullifier), ...fromHex(signature)])) as Hex };
}

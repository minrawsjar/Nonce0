// §5.3 — the PQ signing digest.
//
// Every field below is load-bearing. Dropping any one reopens a replay class:
//
//   PQ_DOMAIN        cross-protocol replay (a signature reused as some other
//                    Opaque hash preimage)
//   chainId          cross-chain replay
//   walletAddress    cross-account replay
//   schemeId         downgrade replay (a FORS+C signature reinterpreted under
//                    different (k, a), or as another scheme entirely)
//   useCount         one-time-index enforcement: a used signature never
//                    verifies again, because the registry has moved on
//   keccak256(payload) the call data actually being authorized
//
// Encoding is length-prefixed, never `a + ':' + b`. A separator that can occur
// inside a field is not a separator: with "a:b" + "c" and "a" + "b:c" hashing
// the same bytes, an attacker picks whichever split suits them. The 4-byte
// big-endian length prefix in `canonical` makes every field list a distinct
// byte string. This is the technique from protocol-types/src/codecs.ts, which
// keeps it private; it is copied here rather than reached into.

import { keccak_256 } from '@noble/hashes/sha3.js';

import { ProtocolFailure, type Address, type Bytes32, type ChainId, type Hex } from '@opaque/protocol-types';
import { asAddress, asChainId, assertHex, encodeBigint, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

/** Domain separation tag for everything a PQ key signs. Pinned; changing it is a protocol break. */
export const PQ_DOMAIN = 'opaque/v1/pq-wallet' as const;

/** Canonical length-prefixed concatenation: 4-byte big-endian length, then the field. */
export function canonical(fields: readonly Uint8Array[]): Uint8Array {
  const total = fields.reduce((n, f) => n + 4 + f.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const field of fields) {
    view.setUint32(at, field.length, false);
    out.set(field, at + 4);
    at += 4 + field.length;
  }
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface DigestInput {
  readonly chainId: ChainId;
  readonly walletAddress: Address;
  /** Identifies the scheme AND its parameters. See forsSchemeId in ./fors.ts. */
  readonly schemeId: string;
  /** The index this signature burns. Monotonic, never reused. */
  readonly useCount: bigint;
  /** The call data being authorized — a UserOperation, a rotation, a disable. */
  readonly payload: Hex;
}

/**
 * The §5.3 digest. Inputs are validated here rather than trusted: brands are
 * erased at runtime, and this function is a trust boundary — a wallet, a
 * relay-carried RPC and an on-chain validator all have to agree on these bytes.
 */
export function pqDigest(input: DigestInput): Bytes32 {
  const chainId = asChainId(input.chainId);
  const walletAddress = asAddress(input.walletAddress);
  assertHex(input.payload, 'payload');
  if (typeof input.schemeId !== 'string' || input.schemeId.length === 0) {
    throw new ProtocolFailure('INVALID_INPUT', 'schemeId must be a non-empty string');
  }
  if (typeof input.useCount !== 'bigint' || input.useCount < 0n) {
    throw new ProtocolFailure('INVALID_INPUT', 'useCount must be a non-negative bigint');
  }

  return toHex(
    keccak_256(
      canonical([
        utf8(PQ_DOMAIN),
        utf8(encodeBigint(chainId)),
        fromHex(walletAddress),
        utf8(input.schemeId),
        utf8(encodeBigint(input.useCount)),
        keccak_256(fromHex(input.payload)),
      ]),
    ),
  ) as Bytes32;
}

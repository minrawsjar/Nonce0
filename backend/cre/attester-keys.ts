// The attester's FORS key, kept alive across its budget.
//
// FORS+C is few-time: each key signs at most maxUses attestations, and the
// attester's ADDRESS is immutable in AttestedRingVerifier. A key that simply
// runs out would lock every note in the pool. So before each signature this
// looks at the registry and, near the end of the budget, rotates to the
// pre-committed next key; if the key is already exhausted (a crash at the
// wrong moment, a second process), the next key takes over instead —
// PQKeyRegistry.takeover allows that once the current key has nothing left.
//
// Every generation derives from ONE master secret:
//
//   seed(g) = keccak256(canonical(["opaque/v1/attester/fors-seed", master, g]))
//
// g=0 is registered with seed(1) committed as next; rotating to g+1 commits
// seed(g+2). Nothing new has to be stored after a rotation, and a restart
// finds its generation by matching the registry's pkCommitment.

import { keccak_256 } from '@noble/hashes/sha3.js';

import { ProtocolFailure, type Address, type Bytes32, type Hex } from '@opaque/protocol-types';
import { asChainId } from '@opaque/protocol-types/codecs.js';
import { canonical, encodeSignature, forsSchemeId, keyGen, pkCommitment, pqDigest, sign, utf8 } from '@opaque/pq-wallet';
// Not in pq-wallet's pinned public API; imported from source, as
// chain/test/registry-digest.test.ts does.
import { rotationPayload, takeoverPayload } from '../../packages/pq-wallet/src/registry.ts';

const SEED_DOMAIN = 'opaque/v1/attester/fors-seed';
const DAY = 86_400n;

export function attesterSeed(master: Uint8Array, generation: number): Uint8Array {
  return keccak_256(canonical([utf8(SEED_DOMAIN), master, utf8(String(generation))]));
}

export const attesterCommitment = (master: Uint8Array, generation: number): Bytes32 =>
  pkCommitment(keyGen(attesterSeed(master, generation)).publicKey) as Bytes32;

export interface AttesterKeyState {
  readonly pkCommitment: Bytes32;
  readonly useCount: bigint;
  readonly maxUses: bigint;
}

export interface AttesterKeysOptions {
  readonly master: Uint8Array;
  readonly attester: Address;
  readonly chainId: bigint;
  readonly readState: () => Promise<AttesterKeyState>;
  /** Submit PQKeyRegistry.rotate(attester, …) and wait for it. Anyone may send it. */
  readonly rotate: (next: Bytes32, maxUses: bigint, deadline: bigint, signature: Hex) => Promise<void>;
  /** Submit PQKeyRegistry.takeover(attester, …) and wait for it. */
  readonly takeover: (next: Bytes32, maxUses: bigint, signature: Hex) => Promise<void>;
  /** Budget of every new key. */
  readonly maxUses?: bigint;
  /** Rotate once this few signatures are left. Must be at least 1: rotation spends one. */
  readonly rotateWhenLeft?: bigint;
  readonly now?: () => bigint;
  /** How far past the last known generation a restart will look. */
  readonly searchGenerations?: number;
}

export interface AttesterKeys {
  /** The key to sign the NEXT attestation with, and the index it will use. */
  current(): Promise<{ readonly forsSeed: Uint8Array; readonly useCount: bigint; readonly generation: number }>;
}

export function createAttesterKeys(options: AttesterKeysOptions): AttesterKeys {
  const maxUses = options.maxUses ?? 32n;
  const rotateWhenLeft = options.rotateWhenLeft ?? 4n;
  if (rotateWhenLeft < 1n) throw new ProtocolFailure('INVALID_INPUT', 'rotation needs a signature left to spend');
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const search = options.searchGenerations ?? 256;

  const commitments = new Map<number, Bytes32>();
  const commitment = (g: number): Bytes32 => {
    let c = commitments.get(g);
    if (c === undefined) commitments.set(g, (c = attesterCommitment(options.master, g)));
    return c;
  };
  let known = 0;
  const generationOf = (pk: Bytes32): number => {
    for (let g = known; g < known + search; g++) {
      if (commitment(g) === pk.toLowerCase()) return (known = g);
    }
    // Not ours. Signing anyway would burn an index on a signature the
    // registry rejects, so refuse instead.
    throw new ProtocolFailure('SIGNER_STATE_UNSAFE', 'the registered attester key is not derived from this master');
  };

  const signAt = (generation: number, useCount: bigint, payload: Hex): Hex => {
    const key = keyGen(attesterSeed(options.master, generation));
    const digest = pqDigest({
      chainId: asChainId(options.chainId),
      walletAddress: options.attester,
      schemeId: forsSchemeId(key.publicKey.params),
      useCount,
      payload,
    });
    return encodeSignature(key.publicKey, sign(key.secretKey, digest));
  };

  return {
    async current() {
      let state = await options.readState();
      let g = generationOf(state.pkCommitment);

      if (state.useCount >= state.maxUses) {
        // rotate() would spend a signature this key no longer has.
        const next = commitment(g + 2);
        await options.takeover(next, maxUses, signAt(g + 1, 0n, takeoverPayload(next, maxUses)));
      } else if (state.maxUses - state.useCount <= rotateWhenLeft) {
        const next = commitment(g + 2);
        const deadline = now() + 30n * DAY;
        await options.rotate(next, maxUses, deadline, signAt(g, state.useCount, rotationPayload(next, maxUses, deadline)));
      }
      if (state.useCount >= state.maxUses || state.maxUses - state.useCount <= rotateWhenLeft) {
        state = await options.readState();
        g = generationOf(state.pkCommitment);
      }
      if (state.useCount >= state.maxUses) {
        throw new ProtocolFailure('KEY_EXHAUSTED', 'the attester key has no signature left', true);
      }
      return { forsSeed: attesterSeed(options.master, g), useCount: state.useCount, generation: g };
    },
  };
}

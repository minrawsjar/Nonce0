// §7.5 — how an answer gets back to a wallet that has no inbound address.
//
// A browser cannot be dialled. It has no port, no stable address, and opening
// one would defeat the point: an inbound connection is exactly the identifier
// three hops exist to remove. So a reply is not sent back — it is LEFT
// somewhere, and collected later through a fresh path.
//
//   client   generates a ONE-TIME ML-KEM keypair and an unguessable drop id,
//            and puts the public half plus the drop location in the innermost
//            payload, where only the final hop can read it.
//   hop 3    encapsulates to that one-time key and deposits the sealed answer
//            at the drop. It never learns who asked.
//   client   collects the drop over a NEW path and opens it locally.
//
// Two properties this file is responsible for:
//
//   1. The drop id is the only credential. It is 16 bytes of OS randomness,
//      single-use, and unrelated to the intent it answers. There is no
//      "look up the reply for intent X" — that lookup would be the linkage.
//   2. The reply is readable by the client alone. The drop relay stores
//      ciphertext sealed to a key it does not have, so a relay operator who
//      keeps every drop forever still learns nothing but its size.
//
// NOT encrypted twice. The return route rides inside the innermost onion
// layer, which only hop 3 can open, so hops 1 and 2 already cannot see it and
// hop 3 must read it to do its job. A second layer here would encrypt the
// route to the party that has to act on it.
//
// The one-time key is used for exactly one reply. It is generated per channel,
// never stored, and never reused across queries — reuse would let the relay
// that saw two drops know they were the same client.

import { gcm } from '@noble/ciphers/aes.js';
import { concatBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import { ProtocolFailure, type Hex, type RelayId } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import type { DropStore, ResponseChannel, ReturnPathModule, ReturnRouteTarget } from './contracts.ts';

const KEM_CIPHERTEXT_BYTES = 1088; // ML-KEM-768
const KEM_PUBLIC_KEY_BYTES = 1184;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DROP_ID_BYTES = 16;
const HKDF_INFO = 'opaque/v1/mesh/return-key';

/** Sealed replies are bounded so a drop store cannot be filled by one message. */
const MAX_SEALED_BYTES = 256 * 1024;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** OS randomness through the global — the client half of this file runs in a browser. */
const osRandom = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/**
 * Salted with the KEM ciphertext, which is fresh for every seal. The reply is
 * then bound to its own encapsulation: swapping in a different ciphertext
 * derives a different key and the GCM tag fails, so a relay cannot graft one
 * client's encapsulation onto another's body.
 */
const replyKey = (sharedSecret: Uint8Array, kemCiphertext: Uint8Array): Uint8Array =>
  hkdf(sha256, sharedSecret, kemCiphertext, utf8(HKDF_INFO), 32);

// ── the route ─────────────────────────────────────────────────────────────

/**
 * JSON, matching FinalPayload's own encoding rather than introducing a second
 * format for two short strings. This is read by hop 3 out of an already
 * decrypted payload, so compactness buys nothing and a decoder that can be
 * read at 3am buys something.
 */
export function encodeRoute(target: ReturnRouteTarget): Hex {
  return toHex(utf8(JSON.stringify({ dropRelay: target.dropRelay, dropId: target.dropId })));
}

export function decodeRoute(returnRoute: Hex): ReturnRouteTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromHex(returnRoute)));
  } catch {
    throw new ProtocolFailure('INVALID_INPUT', 'return route is not decodable');
  }
  // Validated, not cast. This arrives from a payload a client authored, and
  // dropRelay decides where hop 3 sends a request next — an unchecked string
  // there is an egress the allowlist never sees.
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolFailure('INVALID_INPUT', 'return route must be an object');
  }
  const { dropRelay, dropId } = parsed as Record<string, unknown>;
  if (typeof dropRelay !== 'string' || dropRelay.length === 0 || dropRelay.length > 32) {
    throw new ProtocolFailure('INVALID_INPUT', 'return route has no usable drop relay');
  }
  if (typeof dropId !== 'string' || !/^[0-9a-f]{32}$/.test(dropId)) {
    throw new ProtocolFailure('INVALID_INPUT', 'return route has no usable drop id');
  }
  return { dropRelay: dropRelay as RelayId, dropId };
}

// ── sealing ───────────────────────────────────────────────────────────────

/** Hop 3 side. Seals an answer to the client's one-time key. */
export function seal(responseKey: Hex, body: Uint8Array): Hex {
  const publicKey = fromHex(responseKey);
  if (publicKey.length !== KEM_PUBLIC_KEY_BYTES) {
    throw new ProtocolFailure('INVALID_INPUT', 'response key is not an ML-KEM-768 encapsulation key');
  }
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
  const nonce = osRandom(NONCE_BYTES);
  // kemCiphertext || nonce || ciphertext || tag — unchanged from node:crypto.
  const sealed = concatBytes(
    cipherText,
    nonce,
    gcm(replyKey(sharedSecret, cipherText), nonce, cipherText).encrypt(body),
  );
  return toHex(sealed);
}

// ── the client's channel ──────────────────────────────────────────────────

export function createChannel(
  dropRelay: RelayId,
  random: (n: number) => Uint8Array = osRandom,
): ResponseChannel {
  // ml_kem768 wants 64 bytes of seed. Injected so a test reproduces; a real
  // client leaves this defaulted to the OS.
  const { publicKey, secretKey } = ml_kem768.keygen(random(64));
  const dropId = toHex(random(DROP_ID_BYTES)).slice(2);

  return {
    responseKey: toHex(publicKey),
    returnRoute: encodeRoute({ dropRelay, dropId }),
    dropId,
    open(sealed: Hex): Uint8Array {
      const bytes = fromHex(sealed);
      const min = KEM_CIPHERTEXT_BYTES + NONCE_BYTES + GCM_TAG_BYTES;
      if (bytes.length < min) {
        throw new ProtocolFailure('INVALID_INPUT', 'sealed reply is too short to be one');
      }
      const cipherText = bytes.subarray(0, KEM_CIPHERTEXT_BYTES);
      const nonce = bytes.subarray(KEM_CIPHERTEXT_BYTES, KEM_CIPHERTEXT_BYTES + NONCE_BYTES);

      // ML-KEM decapsulation is implicit-rejection: a corrupt ciphertext
      // yields a wrong-but-well-formed shared secret rather than an error, so
      // the GCM tag below is what actually rejects it. That is by design and
      // the reason this must never be "if decapsulate throws".
      const sharedSecret = ml_kem768.decapsulate(cipherText, secretKey);
      // gcm wants ciphertext and tag together, which is exactly bytes[..].
      const sealedBody = bytes.subarray(KEM_CIPHERTEXT_BYTES + NONCE_BYTES);
      try {
        return gcm(replyKey(sharedSecret, cipherText), nonce, cipherText).decrypt(sealedBody);
      } catch {
        throw new ProtocolFailure('INVALID_INPUT', 'sealed reply does not authenticate');
      }
    },
  };
}

export const returnPathModule: ReturnPathModule = { createChannel, decodeRoute, seal };

// ── the drop store ────────────────────────────────────────────────────────

export interface DropStoreOptions {
  /** Bounded. An unbounded store is a memory oracle describing its traffic. */
  readonly maxDrops: number;
}

/**
 * In-memory, per relay. Restart loses undelivered replies, which is the right
 * trade for V1: a client that finds nothing re-queries over a fresh path, and
 * persisting sealed replies to disk creates a durable artefact of who asked
 * something that memory does not.
 *
 * ponytail: in-memory Map. Swap for Redis with TTL if a relay ever needs to
 * survive a restart without losing in-flight answers.
 */
export function createDropStore(options: DropStoreOptions): DropStore {
  const { maxDrops } = options;
  if (!Number.isInteger(maxDrops) || maxDrops < 1) {
    throw new ProtocolFailure('INVALID_INPUT', 'maxDrops must be at least 1');
  }
  const drops = new Map<string, { sealed: Hex; expiresAt: bigint }>();

  const store: DropStore = {
    put(dropId, sealed, expiresAt) {
      if (!/^[0-9a-f]{32}$/.test(dropId)) {
        throw new ProtocolFailure('INVALID_INPUT', 'a drop id must be 16 bytes of hex');
      }
      if (fromHex(sealed).length > MAX_SEALED_BYTES) {
        throw new ProtocolFailure('INVALID_INPUT', 'sealed reply exceeds the per-drop limit');
      }
      // WRITE-ONCE. Overwriting would let anyone who guesses or observes a
      // drop id replace a real answer with one of their own, and the client
      // has no way to tell the two apart.
      if (drops.has(dropId)) {
        throw new ProtocolFailure('INVALID_INPUT', 'that drop is already occupied');
      }
      if (drops.size >= maxDrops) {
        // Evict only what is already dead, then refuse. Dropping a live entry
        // to make room silently discards an answer someone is still waiting
        // for, and does it precisely when the relay is busiest.
        store.sweep(expiresAt);
        if (drops.size >= maxDrops) {
          throw new ProtocolFailure('MESH_UNAVAILABLE', 'the drop store is full', true);
        }
      }
      drops.set(dropId, { sealed, expiresAt });
    },

    take(dropId, now) {
      const held = drops.get(dropId);
      if (held === undefined) return undefined;
      // SINGLE-USE either way: an expired drop is removed on the way out, so a
      // stale reply cannot be collected twice while its id is still known.
      drops.delete(dropId);
      return held.expiresAt <= now ? undefined : held.sealed;
    },

    sweep(now) {
      for (const [dropId, held] of drops) if (held.expiresAt <= now) drops.delete(dropId);
    },

    get size() {
      return drops.size;
    },
  };
  return store;
}

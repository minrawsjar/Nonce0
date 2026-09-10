// §7.8 — the client side: what makes "route everything through the mesh" true
// rather than aspirational.
//
// The adapter already calls ports.transport for every sensitive read. Until
// now nothing implemented that port, so the routing was a shape with no
// substance. This is the substance: it builds the onion, posts it to hop 1,
// and collects the answer from a drop.
//
// The rule it exists to enforce: THE BROWSER MAKES NO DIRECT REQUEST to a
// graph, an RPC, an executor or a pool. Every one of those is a connection
// from the user's address to a service that knows what was asked, and one such
// request undoes three hops of work. A bypass is not a shortcut, it is the
// deanonymisation.
//
// Each call draws its own path and its own one-time keys. Two reads by one
// wallet therefore share no route, no drop and no key, so a relay sitting on
// both learns two unrelated messages rather than one client's session.
//
// DISCLOSED: collecting from a drop is a direct connection to the drop relay.
// That relay learns an IP asked for one unguessable id, and nothing about what
// the answer says or which intent it belongs to — but it is a connection, and
// V1 does not route the collection itself through a second onion. Fixing it
// needs relay-to-relay drop deposit. See "Deliberate gaps" in protocol.md.

import {
  ProtocolFailure,
  type EncryptedIntent,
  type Hex,
  type IntentRef,
  type MeshQuery,
  type MeshQueryResult,
  type MeshStatusEvent,
  type MessageHandle,
  type PrivacyTransport,
  type RelayPath,
} from '@opaque/protocol-types';
import { asMeshQueryResult, encodeBigint, toHex } from '@opaque/protocol-types/codecs.js';

import { createChannel } from './return-path.ts';
import { buildOnion, encodeFrame, type FinalPayload, type MeshMessageKind } from './transport.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Bigints cross as decimal strings. JSON.stringify throws outright on a
 * bigint, and a PoolScope carries a chainId, so without this every
 * RING_SNAPSHOT and PRIVACY_CONDITIONS query — most of them — fails at the
 * point of encoding. Decimal is encodeBigint's format, which is what
 * asChainId and asUnixSeconds already accept on the far side, so nothing has
 * to be revived here.
 */
const wire = (value: unknown): string =>
  JSON.stringify(value, (_key, held) => (typeof held === 'bigint' ? encodeBigint(held) : held));

export interface MeshClientOptions {
  /** How long a message may live in the mesh. Seconds, matching the frame. */
  readonly ttlSeconds?: bigint;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  /** Injected for tests and for a browser that must use its own fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => bigint;
  /** Draws a fresh path. Required only by subscribe(), which polls. */
  readonly pathFor?: () => Promise<RelayPath>;
}

/**
 * `https://relay/v1/relay` → `https://relay/v1/status/<id>`. Derived rather
 * than configured, so a drop can only ever be collected from the relay the
 * verified directory named — there is no second endpoint field to point
 * somewhere else.
 */
function statusUrl(endpoint: string, dropId: string): string {
  const suffix = '/v1/relay';
  if (!endpoint.endsWith(suffix)) {
    throw new ProtocolFailure('UNTRUSTED_DIRECTORY', 'relay endpoint is not a /v1/relay URL');
  }
  return `${endpoint.slice(0, -suffix.length)}/v1/status/${dropId}`;
}

export function createMeshTransport(options: MeshClientOptions = {}): PrivacyTransport {
  const {
    ttlSeconds = 600n,
    pollIntervalMs = 250,
    pollTimeoutMs = 30_000,
    fetchImpl = fetch,
    now = () => BigInt(Math.floor(Date.now() / 1000)),
    pathFor,
  } = options;

  /**
   * One round trip. Builds a fresh channel and a fresh onion, posts to hop 1,
   * then collects the sealed answer from the drop.
   */
  async function roundTrip(kind: MeshMessageKind, body: Hex, path: RelayPath): Promise<Uint8Array> {
    // The drop must be the hop that answers: V1 has no relay-to-relay deposit,
    // and server.ts refuses loudly rather than misdelivering.
    const channel = createChannel(path[2].id);
    const payload: FinalPayload = {
      kind,
      body,
      responseKey: channel.responseKey,
      returnRoute: channel.returnRoute,
    };
    const frame = encodeFrame(
      buildOnion({
        path: path.map((n) => ({ id: n.id, kemPublicKey: n.kemPublicKey, keyEpoch: n.keyEpoch })) as never,
        payload,
        expiresAt: now() + ttlSeconds,
      }),
    );

    const accepted = await fetchImpl(path[0].endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/octet-stream' },
      body: frame,
    });
    if (accepted.status !== 202) {
      throw new ProtocolFailure('MESH_UNAVAILABLE', `hop 1 answered ${accepted.status}`, true);
    }

    const url = statusUrl(path[2].endpoint, channel.dropId);
    const deadline = Date.now() + pollTimeoutMs;
    // Polling, because the mesh delays on purpose. There is nothing to push
    // to: the client has no inbound address, which is the whole premise.
    while (Date.now() < deadline) {
      const response = await fetchImpl(url, { redirect: 'error' });
      if (response.status === 200) {
        const { sealed } = (await response.json()) as { sealed: Hex };
        // Opened locally. The drop relay held ciphertext it could not read.
        return channel.open(sealed);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new ProtocolFailure('MESH_UNAVAILABLE', 'no answer arrived before the deadline', true);
  }

  return {
    async query(request: MeshQuery, path: RelayPath): Promise<MeshQueryResult> {
      const answer = await roundTrip('QUERY', toHex(utf8(wire(request))), path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text(answer));
      } catch {
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'the mesh returned an unreadable answer');
      }
      // DECODED here, at the trust boundary — not cast. These bytes came off a
      // relay: the kind must match what was asked, and every bigint arrives as
      // a decimal string that has to be revived before anyone does arithmetic
      // on it. A cast used to return strings typed as bigints.
      return asMeshQueryResult(request, parsed);
    },

    async submitIntent(input: EncryptedIntent, path: RelayPath): Promise<IntentRef> {
      const answer = await roundTrip('PAYMENT', toHex(utf8(wire(input))), path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text(answer));
      } catch {
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'the executor returned an unreadable answer');
      }
      const ref = parsed as Partial<IntentRef>;
      if (typeof ref.intentId !== 'string' || typeof ref.statusHandle !== 'string') {
        throw new ProtocolFailure('MESH_UNAVAILABLE', 'the executor returned no usable intent ref');
      }
      return { intentId: ref.intentId, statusHandle: ref.statusHandle } as IntentRef;
    },

    subscribe(handle: MessageHandle, listener: (event: MeshStatusEvent) => void): () => void {
      if (pathFor === undefined) {
        throw new ProtocolFailure('INVALID_INPUT', 'subscribe needs pathFor to draw a fresh path');
      }
      let live = true;
      // A FRESH path per poll, deliberately. Reusing one would make a
      // subscription a standing circuit that one relay could watch for the
      // life of the payment.
      void (async () => {
        while (live) {
          try {
            const result = await this.query({ kind: 'MESH_STATUS', handle }, await pathFor());
            if (live && result.kind === 'MESH_STATUS') listener(result.value);
            if (result.kind === 'MESH_STATUS' && ['SUBMITTED', 'FAILED'].includes(result.value.state)) {
              return;
            }
          } catch {
            // Swallowed on purpose: a subscription that throws into an
            // unhandled rejection takes the page with it, and the next poll
            // is the retry.
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      })();
      return () => {
        live = false;
      };
    },
  };
}



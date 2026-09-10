// §7 — the relay itself: the HTTP surface, and the loop that moves messages.
//
// Everything hard already happened elsewhere. transport.ts peels a layer,
// directory.ts says whose key that is, scheduler.ts decides when it leaves,
// return-path.ts gets an answer home. This file is the thin, boring shell that
// an operator actually runs — and the thinner it is, the fewer places there
// are to leak something the other four were careful about.
//
// Two endpoints, exactly as protocol.md says:
//
//   POST /v1/relay        accepts one frame. Answers with a bare
//                         acknowledgement: no id, no hop-local id, nothing a
//                         caller could later correlate against a log line.
//   GET  /v1/status/:id   collects a drop. The id IS the capability — 16
//                         unguessable bytes, single-use, tied to no intent.
//                         There is no public intent-to-transaction lookup,
//                         because that lookup would be the linkage.
//
// THE EGRESS OPERATION IS NOT IN THE PAYLOAD. It is the message kind, and the
// allowlist has one entry per kind. A client cannot name a destination, so
// there is no URL to smuggle and no redirect to walk out of — only two places
// this relay can ever send anything.
//
// A FINAL message is queued like any other. Answering the instant the last
// layer opens would make hop 3's response time a direct readout of when the
// client asked, which is the correlation the whole queue exists to break.
//
// LOGGING: nothing here logs. Not the id, not the peer, not on the error path.
// A reverse proxy in front of this that writes X-Forwarded-For beside a
// request id undoes property 1 without touching a line of this file, so the
// deployment notes say so too.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ProtocolFailure, type ErrorCode, type Hex, type RelayId } from '@opaque/protocol-types';
import { toHex } from '@opaque/protocol-types/codecs.js';

import type { DropStore } from './contracts.ts';
import type { RelayDirectory } from './contracts.ts';
import { createBatchScheduler, type MeshBatchScheduler } from './scheduler.ts';
import { createDropStore, decodeRoute, seal } from './return-path.ts';
import {
  LAYER_OVERHEAD,
  MemoryReplayCache,
  SIZE_CLASSES,
  decodeFrame,
  encodeFrame,
  peelLayer,
  type FinalPayload,
  type MeshEnvelope,
  type MeshMessageKind,
  type PeelResult,
  type ReplayCache,
} from './transport.ts';

/** The largest legitimate frame: biggest size class under three layers. */
const MAX_FRAME_BYTES = SIZE_CLASSES[SIZE_CLASSES.length - 1]! + 3 * LAYER_OVERHEAD;
/** How long a sealed reply waits at a drop before it is swept. */
const DROP_TTL_MS = 900_000n; // 15 minutes

/** What a client is told. Deliberately coarse: a status code and a safe string. */
const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNSUPPORTED_VERSION: 400,
  EXPIRED: 400,
  UNTRUSTED_DIRECTORY: 403,
  MESH_UNAVAILABLE: 503,
  INSUFFICIENT_RELAYS: 503,
};

export interface RelayOptions {
  readonly relayId: RelayId;
  readonly secretKey: Hex;
  readonly keyEpoch: bigint;
  /** Verified upstream. Used only to resolve the NEXT hop's endpoint. */
  readonly directory: RelayDirectory;
  /**
   * One destination per message kind. A missing kind is a relay that refuses
   * to carry it, which is a legitimate operator policy.
   */
  readonly egress: ReadonlyMap<MeshMessageKind, string>;
  readonly batchWindowMs?: number;
  readonly maxExtraDelayMs?: number;
  readonly maxQueue?: number;
  readonly maxDrops?: number;
  readonly random?: () => number;
  /** Injected so tests need no network. Defaults to a real POST. */
  readonly deliver?: (url: string, body: Uint8Array) => Promise<void>;
  /** Injected likewise: what the final hop actually calls out to. */
  readonly callEgress?: (url: string, payload: FinalPayload) => Promise<Uint8Array>;
  readonly now?: () => bigint;
  readonly drops?: DropStore;
  readonly replayCache?: ReplayCache;
}

export interface Relay {
  readonly relayId: RelayId;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Moves everything due. Returns how many left, so a caller can assert. */
  drainOnce(now?: bigint): Promise<number>;
  /**
   * Messages a drain could not hand on: a dead next hop, a refusing egress, a
   * return route this relay cannot honour. A COUNT and nothing else — an
   * operator needs to know the relay is failing without a log line that says
   * which message it was.
   */
  readonly undelivered: number;
  /** `host` unset binds every interface; a public box passes 127.0.0.1 and fronts it. */
  listen(port: number, host?: string): Promise<Server>;
  close(): Promise<void>;
  readonly queued: number;
  readonly drops: DropStore;
}

const defaultDeliver = async (url: string, body: Uint8Array): Promise<void> => {
  const response = await fetch(url, {
    method: 'POST',
    // No redirect is ever followed: the allowlist is the destination, and an
    // allowlist a 302 can walk out of is not an allowlist.
    redirect: 'error',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  if (!response.ok) {
    throw new ProtocolFailure('MESH_UNAVAILABLE', `next hop answered ${response.status}`, true);
  }
};

const defaultCallEgress = async (url: string, payload: FinalPayload): Promise<Uint8Array> => {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    // Only the body crosses. responseKey and returnRoute stay in the mesh —
    // an egress service that saw them could deposit its own reply.
    body: JSON.stringify({ kind: payload.kind, body: payload.body }),
  });
  if (!response.ok) {
    throw new ProtocolFailure('MESH_UNAVAILABLE', `egress answered ${response.status}`, true);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/** Bounded read. An unbounded one lets a single request exhaust the relay. */
async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_FRAME_BYTES) {
      throw new ProtocolFailure('INVALID_INPUT', 'frame exceeds the maximum size');
    }
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    // Nothing here is cacheable, and a cached drop would defeat single-use.
    'cache-control': 'no-store',
  });
  res.end(json);
}

function sendFailure(res: ServerResponse, error: unknown): void {
  // publicMessage is safe to render by contract; a raw Error is not, so an
  // unexpected one becomes a flat 500 with no detail rather than a stack.
  if (error instanceof ProtocolFailure) {
    send(res, HTTP_STATUS[error.code] ?? 400, {
      code: error.code,
      message: error.publicMessage,
      retryable: error.retryable,
    });
    return;
  }
  send(res, 500, { code: 'MESH_UNAVAILABLE', message: 'relay error', retryable: true });
}

export function createRelay(options: RelayOptions): Relay {
  const {
    relayId,
    secretKey,
    keyEpoch,
    directory,
    egress,
    batchWindowMs = 250,
    maxExtraDelayMs = 250,
    maxQueue = 4096,
    maxDrops = 4096,
    random = Math.random,
    deliver = defaultDeliver,
    callEgress = defaultCallEgress,
    now = () => BigInt(Date.now()),
    replayCache = new MemoryReplayCache(),
  } = options;

  const drops = options.drops ?? createDropStore({ maxDrops });
  const scheduler: MeshBatchScheduler = createBatchScheduler({
    batchWindowMs,
    maxExtraDelayMs,
    maxQueue,
    random,
  });

  // Peeling IS validation (protocol.md property 4), so it happens before a
  // slot is taken — but the result is needed again at release. Keyed by
  // hopLocalId, which is already local to this hop and on the wire only in the
  // layer this relay just consumed, so it introduces no new identifier.
  const peeled = new Map<string, PeelResult>();
  let undelivered = 0;

  const endpointOf = (id: RelayId): string => {
    const entry = directory.entries.find((e) => e.id === id);
    if (entry === undefined) {
      throw new ProtocolFailure('INSUFFICIENT_RELAYS', 'next hop is not in this directory');
    }
    return entry.endpoint;
  };

  /** Final hop: call out, then leave the answer at the client's drop. */
  async function finish(payload: FinalPayload, at: bigint): Promise<void> {
    const target = egress.get(payload.kind);
    if (target === undefined) {
      throw new ProtocolFailure('INVALID_INPUT', 'this relay does not carry that kind');
    }
    const answer = await callEgress(target, payload);

    // No return route is a fire-and-forget PAYMENT. Nothing to deposit.
    if (payload.responseKey === undefined || payload.returnRoute === undefined) return;

    const route = decodeRoute(payload.returnRoute);
    if (route.dropRelay !== relayId) {
      // V1 LIMITATION, and a loud one rather than a silent misdelivery: there
      // is no relay-to-relay drop deposit, so a client must name the hop that
      // answers as its drop. See "Deliberate gaps" in protocol.md.
      throw new ProtocolFailure('INVALID_INPUT', 'this relay only holds drops it answered');
    }
    drops.put(route.dropId, seal(payload.responseKey, answer), at + DROP_TTL_MS);
  }

  async function drainOnce(at: bigint = now()): Promise<number> {
    const due = scheduler.drain(at);
    // Settled, not all: one dead next hop must not discard the rest of a
    // batch. There is nowhere to report a failure to — the sender was
    // acknowledged when the message was accepted — so it is counted instead.
    // Counted, never logged: which message failed is the correlation.
    const outcomes = await Promise.allSettled(
      due.map(async (message) => {
        const result = peeled.get(message.envelope.hopLocalId);
        peeled.delete(message.envelope.hopLocalId);
        if (result === undefined) return;
        if (result.kind === 'FORWARD') {
          await deliver(endpointOf(result.next), encodeFrame(result.envelope));
        } else {
          await finish(result.payload, at);
        }
      }),
    );
    undelivered += outcomes.filter((o) => o.status === 'rejected').length;
    return due.length;
  }

  async function accept(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const envelope: MeshEnvelope = decodeFrame(await readBody(req));
    const at = now();
    // Seconds on the wire, milliseconds in the queue. peelLayer takes seconds.
    const result = peelLayer({
      envelope,
      hopId: relayId,
      secretKey,
      keyEpoch,
      now: at / 1000n,
      replayCache,
    });

    const next = result.kind === 'FORWARD' ? result.next : null;
    const inner = result.kind === 'FORWARD' ? result.envelope : envelope;
    peeled.set(inner.hopLocalId, result);

    if (!scheduler.offer(inner, next, at)) {
      peeled.delete(inner.hopLocalId);
      throw new ProtocolFailure('MESH_UNAVAILABLE', 'relay queue is full', true);
    }
    // A bare acknowledgement. No id: anything returned here is something the
    // caller and this relay both hold, which is a correlation handle.
    send(res, 202, { status: 'ACCEPTED' });
  }

  function collect(res: ServerResponse, dropId: string): void {
    const sealed = drops.take(dropId, now());
    // An unknown drop, an expired one and an already-collected one are the
    // same 404. Distinguishing them would turn this into an oracle for which
    // drop ids ever existed.
    if (sealed === undefined) {
      send(res, 404, { code: 'INVALID_INPUT', message: 'no such drop', retryable: false });
      return;
    }
    send(res, 200, { sealed });
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    // A browser wallet is the client, and without these it cannot reach a
    // relay at all: the POST carries application/octet-stream, which forces a
    // preflight, and the drop collection is cross-origin. Set once here so
    // every response path carries them — Node merges setHeader into writeHead.
    //
    // `*` weakens nothing. There are no cookies or credentials to protect; the
    // onion is the protection, and any client may already POST one. Relays
    // only — the mesh exit is reached by hop 3, server to server, and stays
    // off the browser-facing surface entirely.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    void (async () => {
      try {
        if (path === '/v1/relay') {
          if (req.method !== 'POST') return send(res, 405, { code: 'INVALID_INPUT', message: 'POST only' });
          return await accept(req, res);
        }
        if (path.startsWith('/v1/status/')) {
          if (req.method !== 'GET') return send(res, 405, { code: 'INVALID_INPUT', message: 'GET only' });
          return collect(res, path.slice('/v1/status/'.length));
        }
        send(res, 404, { code: 'INVALID_INPUT', message: 'no such endpoint' });
      } catch (error) {
        sendFailure(res, error);
      }
    })();
  };

  let server: Server | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    relayId,
    handler,
    drainOnce,
    drops,
    get queued() {
      return scheduler.size;
    },
    get undelivered() {
      return undelivered;
    },
    listen(port: number, host?: string): Promise<Server> {
      server = createServer(handler);
      // Batches leave on their own clock, never in response to a request:
      // draining on arrival would make release time a function of arrival.
      timer = setInterval(() => {
        void drainOnce().catch(() => {});
        drops.sweep(now());
      }, batchWindowMs);
      timer.unref();
      return new Promise((resolve) => server!.listen(port, host, () => resolve(server!)));
    },
    close(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      const running = server;
      server = undefined;
      return running === undefined
        ? Promise.resolve()
        : new Promise((resolve) => running.close(() => resolve()));
    },
  };
}

/** Hex of a body, for an egress stub that wants to echo what it received. */
export const echoEgress = async (_url: string, payload: FinalPayload): Promise<Uint8Array> =>
  new TextEncoder().encode(toHex(new TextEncoder().encode(payload.body)));

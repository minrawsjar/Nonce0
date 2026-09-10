// The executor as a service.
//
// createExecutor is a library: submit an intent, get a handle back. This is the
// HTTP surface the mesh's final hop actually reaches, plus the forward to the
// confidential workflow's trigger.
//
// ── Where this sits ──────────────────────────────────────────────────────
//
//   wallet ──onion──> relay 1 ──> relay 2 ──> relay 3 ──egress──> THIS
//   THIS ──HTTP trigger──> CRE workflow (in the enclave)
//   workflow ──ApprovedRelease──> mesh/egress.ts ──> PrivatePool
//
// The wallet never talks to this directly. It arrives from hop 3, so this
// service sees a sealed intent and the relay's address — never the payer's.
//
// ── What it must not do ──────────────────────────────────────────────────
//
// It holds ciphertext and never a key. The ML-KEM secret lives in the Vault
// DON and is released into the enclave; nothing here can open an intent, which
// is what makes it safe for this to be the one component with a public address
// and a queue.
//
// It also does not log. An intent id beside a source address rebuilds the link
// three hops removed, and this is the one place both are momentarily present.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  ProtocolFailure,
  type EncryptedIntent,
  type ErrorCode,
  type GraphSelectionClient,
  type Hex,
  type IntentRef,
  type StatusHandle,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { assertHex, fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { ChunkStore, decodeChunkFrame, isChunkFrame, uploadIdFromHex } from '../mesh/chunks.ts';
import { createQueryAnswerer, decodeMeshQuery, encodeAnswer, type QueryAnswererDeps } from '../mesh/queries.ts';
import { createExecutor, type OpaqueExecutor } from './executor.ts';

const MAX_BODY_BYTES = 256 * 1024;

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  EXPIRED: 400,
  UNSUPPORTED_VERSION: 400,
  MESH_UNAVAILABLE: 503,
};

export interface ExecutorServerOptions {
  readonly executor?: OpaqueExecutor;
  readonly now?: () => UnixSeconds;
  /**
   * The confidential workflow's HTTP trigger. Optional: without it the intent
   * is queued and nothing forwards it, which is a legitimate configuration
   * while awaiting Confidential Workflows enrolment — and is visibly a queue
   * that is not draining, rather than a payment that silently vanished.
   */
  readonly triggerUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /**
   * Answers mesh QUERY messages. Without it the query route refuses, which is
   * a visible gap rather than a relay quietly dropping every read.
   */
  readonly graph?: GraphSelectionClient;
  /** eth_getTransactionReceipt for POOL_RECEIPT. Optional. */
  readonly receipt?: (txHash: TxHash) => Promise<Hex>;
  /** WALLET_RPC (chain/wallet-rpc.ts). Optional; absent, it is refused. */
  readonly walletRpc?: QueryAnswererDeps['walletRpc'];
}

export interface ExecutorServer {
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  readonly executor: OpaqueExecutor;
  /** `host` unset binds every interface; a public box passes 127.0.0.1 and fronts it. */
  listen(port: number, host?: string): Promise<Server>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new ProtocolFailure('INVALID_INPUT', 'body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

/** Bigints arrive as decimal strings. Validated, not cast: this is untrusted. */
function reviveIntent(raw: unknown): EncryptedIntent {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolFailure('INVALID_INPUT', 'an intent must be an object');
  }
  const held = raw as Record<string, unknown>;
  const decimal = (key: string): bigint => {
    const value = held[key];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new ProtocolFailure('INVALID_INPUT', `${key} must be a decimal string`);
    }
    return BigInt(value);
  };
  const scope = held['scope'];
  if (typeof scope !== 'object' || scope === null) {
    throw new ProtocolFailure('INVALID_INPUT', 'an intent must carry a scope');
  }
  const heldScope = scope as Record<string, unknown>;
  if (typeof held['encryptedPayload'] !== 'string' || !/^0x[0-9a-f]*$/.test(held['encryptedPayload'])) {
    throw new ProtocolFailure('INVALID_INPUT', 'encryptedPayload must be hex');
  }
  return {
    ...held,
    deadline: decimal('deadline') as UnixSeconds,
    scope: { ...heldScope, chainId: BigInt(String(heldScope['chainId'] ?? '0')) },
  } as unknown as EncryptedIntent;
}

/**
 * What hop 3 actually sends: `{"kind", "body"}` with the message as hex. The
 * relay's contract is shared by both egress kinds, so this unwraps it rather
 * than asking the relay to special-case the executor.
 *
 * This is the envelope /v1/intent never accepted. It parsed the body as a raw
 * intent, so an intent that crossed the mesh arrived as {kind, body} and was
 * refused — the mesh-to-executor hop had never once delivered anything. The
 * local-mesh test used a stub egress that recorded bytes, so it never tried.
 */
function meshBody(raw: unknown, expected: 'PAYMENT' | 'QUERY'): Uint8Array {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolFailure('INVALID_INPUT', 'a mesh delivery must be an object');
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope['kind'] !== expected) {
    throw new ProtocolFailure('INVALID_INPUT', `this route carries ${expected} only`);
  }
  const body = envelope['body'];
  assertHex(body, 'mesh body');
  return fromHex(body);
}

const jsonOf = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProtocolFailure('INVALID_INPUT', 'mesh body is not JSON');
  }
};

export function createExecutorServer(options: ExecutorServerOptions = {}): ExecutorServer {
  const executor = options.executor ?? createExecutor(options.now === undefined ? {} : { now: options.now });
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const fetchImpl = options.fetchImpl ?? fetch;

  /** Queues an intent and forwards its ciphertext to the confidential workflow. */
  async function submitIntent(intent: EncryptedIntent): Promise<IntentRef> {
    const ref = await executor.submit(intent);

    if (options.triggerUrl !== undefined) {
      const record = executor.store.get(ref.intentId)!;
      // Ciphertext out. This service cannot read what it forwards.
      await fetchImpl(options.triggerUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intentId: ref.intentId,
          sealedIntent: record.intent.encryptedPayload,
          spendHash: record.intent.spendHash,
          deadline: record.intent.deadline.toString(10),
          minPrivacyScore: record.intent.minPrivacyScore,
          idempotencyKey: record.intent.idempotencyKey,
          scope: {
            chainId: record.intent.scope.chainId.toString(10),
            pool: record.intent.scope.pool,
            denomination: record.intent.scope.denomination,
          },
        }),
      });
    }
    return ref;
  }

  async function submit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    send(res, 202, await submitIntent(reviveIntent(JSON.parse(await readBody(req)))));
  }

  // The executor's own status lookup answers INTENT_STATUS, so a status read
  // crosses the mesh and never becomes a per-intent connection to this host.
  const answer = options.graph === undefined
    ? undefined
    : createQueryAnswerer({
        graph: options.graph,
        intentStatus: (handle) => executor.getStatus(handle),
        ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
        ...(options.walletRpc === undefined ? {} : { walletRpc: options.walletRpc }),
      });

  // Reassembles intents too large for one mesh message. See mesh/chunks.ts.
  const chunks = new ChunkStore();

  async function meshPayment(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = meshBody(JSON.parse(await readBody(req)), 'PAYMENT');

    // A chunk: stored, acknowledged. The relay discards the ack — chunks are
    // one-way — so there is nothing to say beyond "accepted".
    if (isChunkFrame(body)) {
      chunks.put(decodeChunkFrame(body));
      return send(res, 200, { status: 'CHUNK_ACCEPTED' });
    }

    const message = jsonOf(body) as Record<string, unknown>;
    const commit = message['commit'];
    if (typeof commit === 'object' && commit !== null) {
      const c = commit as Record<string, unknown>;
      if (typeof c['uploadId'] !== 'string' || typeof c['total'] !== 'number' || typeof c['payloadHash'] !== 'string') {
        throw new ProtocolFailure('INVALID_INPUT', 'a commit needs uploadId, total and payloadHash');
      }
      const done = chunks.take(uploadIdFromHex(c['uploadId']), c['total'], c['payloadHash'] as never);
      // Not yet: tell the client which to resend. 200 rather than an error,
      // because an incomplete upload is a normal state of a chunked send.
      if (done.kind === 'MISSING') return send(res, 200, { missing: done.missing });
      // The hash already matched inside take(). The intent is the committed
      // header plus the reassembled ciphertext, revived like any other.
      const intent = reviveIntent({ ...(c['intent'] as object), encryptedPayload: toHex(done.payload) });
      return send(res, 200, await submitIntent(intent));
    }

    // A single-message intent, exactly as before chunking existed.
    send(res, 200, await submitIntent(reviveIntent(message)));
  }

  async function meshQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (answer === undefined) {
      throw new ProtocolFailure('MESH_UNAVAILABLE', 'this exit answers no queries: no graph configured', true);
    }
    const query = decodeMeshQuery(jsonOf(meshBody(JSON.parse(await readBody(req)), 'QUERY')));
    const bytes = encodeAnswer(await answer(query));
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': bytes.length,
      'cache-control': 'no-store',
    });
    res.end(bytes);
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    void (async () => {
      try {
        if (path === '/v1/intent' && req.method === 'POST') return await submit(req, res);
        // What relays call. Point --egress-payment and --egress-query here.
        if (path === '/v1/mesh/payment' && req.method === 'POST') return await meshPayment(req, res);
        if (path === '/v1/mesh/query' && req.method === 'POST') return await meshQuery(req, res);
        if (path.startsWith('/v1/intent/') && req.method === 'GET') {
          // The handle is the capability. An unknown one and a wrong one are
          // the same refusal, so this is not an oracle for which exist.
          const status = await executor.getStatus(
            path.slice('/v1/intent/'.length) as StatusHandle,
          );
          return send(res, 200, status);
        }
        send(res, 404, { code: 'INVALID_INPUT', message: 'no such endpoint' });
      } catch (error) {
        if (error instanceof ProtocolFailure) {
          return send(res, HTTP_STATUS[error.code] ?? 400, {
            code: error.code,
            message: error.publicMessage,
            retryable: error.retryable,
          });
        }
        send(res, 502, { code: 'MESH_UNAVAILABLE', message: 'executor error', retryable: true });
      }
    })();
  };

  let server: Server | undefined;
  void now;
  return {
    handler,
    executor,
    listen(port: number, host?: string): Promise<Server> {
      server = createServer(handler);
      return new Promise((resolve) => server!.listen(port, host, () => resolve(server!)));
    },
    close(): Promise<void> {
      const running = server;
      server = undefined;
      return running === undefined
        ? Promise.resolve()
        : new Promise((resolve) => running.close(() => resolve()));
    },
  };
}

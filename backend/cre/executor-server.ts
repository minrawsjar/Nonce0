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
  type StatusHandle,
  type UnixSeconds,
} from '@opaque/protocol-types';

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
}

export interface ExecutorServer {
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  readonly executor: OpaqueExecutor;
  listen(port: number): Promise<Server>;
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

export function createExecutorServer(options: ExecutorServerOptions = {}): ExecutorServer {
  const executor = options.executor ?? createExecutor(options.now === undefined ? {} : { now: options.now });
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function submit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const intent = reviveIntent(JSON.parse(await readBody(req)));
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
    send(res, 202, ref);
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    void (async () => {
      try {
        if (path === '/v1/intent' && req.method === 'POST') return await submit(req, res);
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
    listen(port: number): Promise<Server> {
      server = createServer(handler);
      return new Promise((resolve) => server!.listen(port, () => resolve(server!)));
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

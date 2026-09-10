// The managed egress: where an approved release becomes a transaction.
//
// approved-release.ts holds the rule — verify the tag, then submit, never both
// for one intent. Nothing ran it, so the workflow's output landed nowhere.
// This is the service that runs it.
//
// ── Why this is not a relay ──────────────────────────────────────────────
//
// A relay carries an onion and learns nothing. This component sees a spend in
// the clear, which is exactly why it is a SEPARATE service on a SEPARATE port
// and not another route on /v1/relay. Anyone who can reach this endpoint and
// forge a tag can submit a spend of their choosing, so the shared secret is
// the whole access control and it lives in one place.
//
// ── What this does NOT do ────────────────────────────────────────────────
//
// It is not pool-wide policy enforcement. The pool verifies a proof and a
// nullifier and nothing else, so anyone holding a valid spend can submit
// directly and never pass through here. That is deferred decision D1, and it
// is disclosed rather than papered over: describing this as compliance
// enforcement would be false.
//
// ── Duplicate delivery ───────────────────────────────────────────────────
//
// One intent settles once. A repeat with a known transaction returns that
// transaction; a repeat with no recorded outcome is a retryable outage, never
// a second broadcast, because double-broadcasting a payment is worse than
// making a caller reconcile.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  ProtocolFailure,
  type Address,
  type ApprovedRelease,
  type Bytes32,
  type ErrorCode,
  type IntentId,
  type TxHash,
  type UnixSeconds,
} from '@opaque/protocol-types';

import { MemoryReleaseSeenSet, type ReleaseSeenSet } from '../cre/release.ts';
import { deliverApprovedRelease, releaseAuditLine, type EgressSubmitter } from './approved-release.ts';

/**
 * One batch settlement is one transaction, and a transaction has a gas limit.
 * An unbounded list is a release that cannot settle after the sender has been
 * told it would.
 */
const MAX_AUTHORIZATIONS = 32;

/** A release is small. Anything larger is not one. */
const MAX_BODY_BYTES = 256 * 1024;

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  EXPIRED: 400,
  POLICY_DENIED: 403,
  MESH_UNAVAILABLE: 503,
  SETTLEMENT_REVERTED: 502,
};

export interface EgressOptions {
  /** Shared with the confidential workflow, and with nothing else. */
  readonly secret: Uint8Array;
  readonly submitter: EgressSubmitter;
  readonly seen?: ReleaseSeenSet;
  readonly now?: () => UnixSeconds;
  /**
   * Audit sink. Receives intentId, policyVersion and a timestamp — never a
   * recipient, an amount, or a spend. Defaults to discarding, so an operator
   * who wants an audit trail opts in rather than getting one by accident.
   */
  readonly audit?: (line: ReturnType<typeof releaseAuditLine>) => void;
}

export interface Egress {
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** `host` unset binds every interface; a public box passes 127.0.0.1 and fronts it. */
  listen(port: number, host?: string): Promise<Server>;
  close(): Promise<void>;
  /** Transactions delivered, by intent. Lets a restart answer a duplicate. */
  readonly delivered: ReadonlyMap<IntentId, TxHash>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new ProtocolFailure('INVALID_INPUT', 'release exceeds the maximum size');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Bigints arrive as decimal strings, because JSON.stringify throws on a
 * bigint outright. Revived here, at the boundary, and the MAC is computed over
 * the revived values — so a release whose timestamps did not survive the wire
 * fails to authenticate rather than being silently accepted with wrong ones.
 */
function reviveRelease(raw: unknown): ApprovedRelease {
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolFailure('INVALID_INPUT', 'a release must be an object');
  }
  const held = raw as Record<string, unknown>;
  const at = (key: string): bigint => {
    const value = held[key];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new ProtocolFailure('INVALID_INPUT', `${key} must be a decimal string`);
    }
    return BigInt(value);
  };
  return {
    ...held,
    issuedAt: at('issuedAt') as UnixSeconds,
    expiresAt: at('expiresAt') as UnixSeconds,
    ...(held['authorizations'] === undefined
      ? {}
      : { authorizations: authorizationsOf(held['authorizations']) }),
  } as unknown as ApprovedRelease;
}

/**
 * Checked here because a TypeScript brand is erased at runtime and proves
 * nothing about a value that arrived over a wire — protocol-types says so at
 * the top of the file, and this is the case it means. `authorizations` used to
 * be spread through unvalidated, so an attacker-shaped string reached both the
 * MAC and the settlement submitter.
 *
 * Shape only. Whether these authorizations exist and are consumable is the
 * gate's business on chain; this refuses anything that is not a pool address
 * and a 32-byte id, which is what makes the MAC's encoding unambiguous.
 */
function authorizationsOf(raw: unknown): readonly { readonly id: Bytes32; readonly pool: Address }[] {
  if (!Array.isArray(raw)) {
    throw new ProtocolFailure('INVALID_INPUT', 'authorizations must be an array');
  }
  if (raw.length > MAX_AUTHORIZATIONS) {
    throw new ProtocolFailure('INVALID_INPUT', 'too many authorizations in one release');
  }
  return raw.map((entry): { readonly id: Bytes32; readonly pool: Address } => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ProtocolFailure('INVALID_INPUT', 'an authorization must be an object');
    }
    const { id, pool } = entry as Record<string, unknown>;
    if (typeof pool !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(pool)) {
      throw new ProtocolFailure('INVALID_INPUT', 'authorization pool must be an address');
    }
    if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
      throw new ProtocolFailure('INVALID_INPUT', 'authorization id must be 32 bytes of hex');
    }
    return { id: id as Bytes32, pool: pool as Address };
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

export function createEgress(options: EgressOptions): Egress {
  const {
    secret,
    submitter,
    seen = new MemoryReleaseSeenSet(),
    now = () => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds,
    audit,
  } = options;

  const delivered = new Map<IntentId, TxHash>();

  async function accept(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // A SyntaxError would otherwise fall through to the generic handler and
      // come back as a retryable 502, telling the caller to keep resending a
      // body that will never parse.
      throw new ProtocolFailure('INVALID_INPUT', 'release is not valid JSON');
    }
    const release = reviveRelease(parsed);
    const at = now();

    const prior = delivered.get(release.intentId);
    const result = await deliverApprovedRelease({
      release,
      secret,
      now: at,
      seen,
      submitter,
      ...(prior === undefined ? {} : { priorTxHash: prior }),
    });

    delivered.set(release.intentId, result.txHash);
    // Audited only AFTER the tag verified. Recording a forged release would
    // fill the trail with entries for payments that never existed.
    audit?.(releaseAuditLine(release, at));
    send(res, result.deduplicated ? 200 : 202, {
      txHash: result.txHash,
      deduplicated: result.deduplicated,
    });
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    void (async () => {
      try {
        if (path !== '/v1/release') {
          return send(res, 404, { code: 'INVALID_INPUT', message: 'no such endpoint' });
        }
        if (req.method !== 'POST') {
          return send(res, 405, { code: 'INVALID_INPUT', message: 'POST only' });
        }
        await accept(req, res);
      } catch (error) {
        if (error instanceof ProtocolFailure) {
          return send(res, HTTP_STATUS[error.code] ?? 400, {
            code: error.code,
            message: error.publicMessage,
            retryable: error.retryable,
          });
        }
        // Never the underlying message: a submitter's error can carry an
        // address, a nonce, or a node URL.
        send(res, 502, { code: 'SETTLEMENT_REVERTED', message: 'submission failed', retryable: true });
      }
    })();
  };

  let server: Server | undefined;
  return {
    handler,
    delivered,
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

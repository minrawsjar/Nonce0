// The query side of the mesh exit: what answers a QUERY once hop 3 has peeled
// the last layer.
//
// Nothing did, until this. The client could build an onion, three relays could
// carry it, and hop 3 would POST it to an egress URL that nothing served — so
// every ring snapshot, relay list and intent-status read the wallet depends on
// failed at the far end of the mesh.
//
// ── What this sees, and why that is acceptable ───────────────────────────
//
// It sees the query in the clear: "the ring for pool X", "the status of handle
// H". It does NOT see who asked — the request arrives from hop 3, three
// operators removed from the client. That is the whole trade: the exit learns
// the question, never the questioner.
//
// Two things keep the question itself harmless:
//   - A RING_SNAPSHOT names a pool and a denomination, never a note. Selection
//     happens on the client (T6); no remote party is asked to locate or
//     exclude the real member.
//   - It does not log. A query beside a timestamp is the start of a
//     correlation, and this is the one place the plaintext exists.

import {
  ProtocolFailure,
  type GraphSelectionClient,
  type Hex,
  type IntentStatus,
  type MeshQuery,
  type MeshQueryResult,
  type StatusHandle,
  type TxHash,
  type WalletRpcOperation,
} from '@opaque/protocol-types';
import { asPoolScope, assertHex, encodeBigint, fromHex } from '@opaque/protocol-types/codecs.js';

/**
 * Every kind the exit will answer. MESH_STATUS is absent on purpose: it has no
 * backing store yet, and asking for it is refused, not silently ignored.
 * WALLET_RPC is answered only by an exit configured with a walletRpc, and only
 * for its four operations, each an allowlist of its own (chain/wallet-rpc.ts):
 * a list of questions, not a general RPC proxy.
 */
const ANSWERED = new Set<MeshQuery['kind']>([
  'RING_SNAPSHOT',
  'RELAY_SNAPSHOT',
  'PRIVACY_CONDITIONS',
  'INTENT_STATUS',
  'POOL_RECEIPT',
  'WALLET_RPC',
]);
const WALLET_OPERATIONS = new Set<WalletRpcOperation>(['STATE', 'ESTIMATE', 'SUBMIT_USER_OPERATION', 'USER_OPERATION_RECEIPT']);

const refuse = (message: string): never => {
  throw new ProtocolFailure('INVALID_INPUT', message);
};

/**
 * Decodes a query that arrived off the mesh. Strict, because the bytes were
 * written by whichever client sent them — any client, sending anything.
 */
export function decodeMeshQuery(raw: unknown): MeshQuery {
  if (typeof raw !== 'object' || raw === null) refuse('a query must be an object');
  const q = raw as Record<string, unknown>;
  const kind = q['kind'];
  if (typeof kind !== 'string' || !ANSWERED.has(kind as MeshQuery['kind'])) {
    refuse(`this exit does not answer ${String(kind)}`);
  }
  switch (kind) {
    case 'RING_SNAPSHOT':
    case 'PRIVACY_CONDITIONS':
      return { kind, scope: asPoolScope(q['scope']) };
    case 'RELAY_SNAPSHOT':
      return { kind: 'RELAY_SNAPSHOT' };
    case 'INTENT_STATUS': {
      const handle = q['handle'];
      // 32 bytes of hex: the executor mints handles from OS randomness.
      if (typeof handle !== 'string' || !/^[0-9a-f]{64}$/.test(handle)) refuse('bad status handle');
      return { kind: 'INTENT_STATUS', handle: handle as StatusHandle };
    }
    case 'POOL_RECEIPT': {
      const tx = q['txHash'];
      assertHex(tx, 'txHash');
      if (fromHex(tx).length !== 32) refuse('txHash must be 32 bytes');
      return { kind: 'POOL_RECEIPT', txHash: tx as TxHash };
    }
    case 'WALLET_RPC': {
      const operation = q['operation'];
      if (typeof operation !== 'string' || !WALLET_OPERATIONS.has(operation as WalletRpcOperation)) refuse(`no wallet operation ${String(operation)}`);
      assertHex(q['encodedRequest'], 'encodedRequest');
      return { kind: 'WALLET_RPC', operation: operation as WalletRpcOperation, encodedRequest: q['encodedRequest'] as Hex };
    }
  }
  return refuse('unreachable');
}

export interface QueryAnswererDeps {
  readonly graph: GraphSelectionClient;
  readonly intentStatus: (handle: StatusHandle) => Promise<IntentStatus>;
  /** Optional: eth_getTransactionReceipt against Arc, returned as hex JSON. */
  readonly receipt?: (txHash: TxHash) => Promise<Hex>;
  /** Optional: chain/wallet-rpc.ts createWalletRpcAnswerer. Absent, WALLET_RPC is refused. */
  readonly walletRpc?: (operation: WalletRpcOperation, encodedRequest: Hex) => Promise<Hex>;
}

export function createQueryAnswerer(deps: QueryAnswererDeps): (query: MeshQuery) => Promise<MeshQueryResult> {
  return async (query) => {
    switch (query.kind) {
      case 'RING_SNAPSHOT':
        return { kind: 'RING_SNAPSHOT', value: await deps.graph.getRingSnapshot(query.scope) };
      case 'RELAY_SNAPSHOT':
        return { kind: 'RELAY_SNAPSHOT', value: await deps.graph.getRelaySnapshot() };
      case 'PRIVACY_CONDITIONS':
        return { kind: 'PRIVACY_CONDITIONS', value: await deps.graph.getPrivacyConditions(query.scope) };
      case 'INTENT_STATUS':
        return { kind: 'INTENT_STATUS', value: await deps.intentStatus(query.handle) };
      case 'POOL_RECEIPT': {
        if (deps.receipt === undefined) {
          throw new ProtocolFailure('MESH_UNAVAILABLE', 'this exit has no chain RPC configured', true);
        }
        return { kind: 'POOL_RECEIPT', value: await deps.receipt(query.txHash) };
      }
      case 'WALLET_RPC': {
        if (deps.walletRpc === undefined) refuse('this exit does not answer WALLET_RPC');
        return { kind: 'WALLET_RPC', value: await deps.walletRpc!(query.operation, query.encodedRequest) };
      }
      default:
        return refuse(`this exit does not answer ${query.kind}`);
    }
  };
}

/**
 * JSON with every bigint as a canonical decimal string — the form
 * asMeshQueryResult revives on the client. JSON.stringify throws on a bigint
 * outright, so without this the first answer carrying a timestamp fails here.
 */
export const encodeAnswer = (result: MeshQueryResult): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? encodeBigint(v) : v)),
  );

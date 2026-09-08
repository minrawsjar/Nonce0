// The application adapter barrel. Pages import THIS FILE and nothing else.
//
// No raw GraphQL, RPC, ABI or relay calls in pages. If something a page needs
// is missing here, it is reported to the adapter's owner and added — never
// worked around by reaching past the barrel, because every bypass is a
// direct request from the browser that the mesh was supposed to carry.
//
// ConfidentialPolicyAdapter is deliberately absent: it is server/internal only,
// so a page cannot obtain an authorization on its own or skip the executor.

import {
  ProtocolFailure,
  type Address,
  type EncryptedIntent,
  type GraphSelectionClient,
  type IntentRef,
  type IntentStatus,
  type MeshQuery,
  type MeshQueryResult,
  type NoteSummary,
  type PathSelectionPolicy,
  type PaymentApplication,
  type PaymentRequest,
  type PoolScope,
  type PqWallet,
  type PqWalletState,
  type PrivacyTimedExecutor,
  type PrivacyTransport,
  type PrivatePoolContract,
  type ProtocolCapabilities,
  type RelayPath,
  type RingClient,
  type StatusHandle,
  type TxHash,
} from '@chaff/protocol-types';
import { asPrivateSpend, assertRelayPath, spendHash } from '@chaff/protocol-types/codecs.js';

export type { ProtocolCapabilities, IntentStatus, NoteSummary, PaymentRequest, PoolScope };

/**
 * Verifies the result's discriminant matches the request before anything is
 * read off it. The alternative — `query<T>()` with a caller-supplied type
 * parameter — is an unchecked cast wearing a type annotation, and a relay that
 * returns a RELAY_SNAPSHOT where a PRIVACY_CONDITIONS was asked for would be
 * read as whatever the caller hoped for.
 */
export function decodeQueryResult<K extends MeshQuery['kind']>(
  request: Extract<MeshQuery, { kind: K }>,
  result: MeshQueryResult,
): Extract<MeshQueryResult, { kind: K }> {
  if (result.kind !== request.kind) {
    throw new ProtocolFailure(
      'INVALID_INPUT',
      `asked for ${request.kind} and received ${result.kind}`,
    );
  }
  return result as Extract<MeshQueryResult, { kind: K }>;
}

export interface AdapterPorts {
  readonly wallet: PqWallet;
  readonly ring: RingClient;
  readonly pool: PrivatePoolContract;
  readonly graph: GraphSelectionClient;
  readonly transport: PrivacyTransport;
  readonly executor: PrivacyTimedExecutor;
  readonly pathPolicy: PathSelectionPolicy;
  /** Seals the complete spend and the policy credential to the CRE key. */
  readonly sealIntent: (input: {
    readonly scope: PoolScope;
    readonly spendHash: ReturnType<typeof spendHash>;
    readonly spend: unknown;
    readonly request: PaymentRequest;
  }) => Promise<EncryptedIntent>;
  /**
   * Which pool a note belongs to. Not part of the frozen §2 contract — the
   * ring module owns notes and NoteSummary already carries its scope, so this
   * is a local lookup the adapter owner supplies rather than a new export
   * consumers would have to absorb.
   */
  readonly resolveNoteScope: (noteId: PaymentRequest['noteId']) => Promise<PoolScope>;
}

/**
 * Every sensitive read goes through the mesh. A path is drawn per request, so
 * two reads by one wallet do not share a route and cannot be joined by a relay
 * that happens to sit on both.
 */
async function meshPath(ports: AdapterPorts): Promise<RelayPath> {
  const snapshot = await ports.graph.getRelaySnapshot();
  const { nodes } = ports.pathPolicy.selectPath(snapshot);
  assertRelayPath(nodes);
  return nodes;
}

export function createPaymentApplication(ports: AdapterPorts): PaymentApplication {
  const query = async <K extends MeshQuery['kind']>(
    request: Extract<MeshQuery, { kind: K }>,
  ): Promise<Extract<MeshQueryResult, { kind: K }>> =>
    decodeQueryResult(request, await ports.transport.query(request, await meshPath(ports)));

  return {
    async capabilities(scope: PoolScope): Promise<ProtocolCapabilities> {
      // Read from the pool, never assumed. A SINGLE_NOTE_PQ deployment must
      // never be rendered with eight-member anonymity copy (T12).
      return ports.pool.capabilities(scope.pool);
    },

    createWallet: (): Promise<PqWalletState> => ports.wallet.create(),
    registerWallet: (): Promise<TxHash> => ports.wallet.register(),
    walletState: (): Promise<PqWalletState> => ports.wallet.getState(),
    rotateWallet: (): Promise<TxHash> => ports.wallet.rotate(),
    disableWallet: (): Promise<TxHash> => ports.wallet.disable(),

    async deposit(scope: PoolScope): Promise<NoteSummary> {
      // The note and its commitment are persisted BEFORE the deposit is
      // submitted. A crash between the two leaves a recoverable local record,
      // where the reverse order would lose the secret for funded money.
      const note = await ports.ring.createNote(scope);
      const txHash = await ports.pool.deposit({ scope, commitment: note.commitment });
      // Pending, not funded. AVAILABLE waits for matching pool evidence.
      return ports.ring.recordDeposit(note.id, txHash);
    },

    listNotes: (scope: PoolScope): Promise<readonly NoteSummary[]> => ports.ring.listNotes(scope),

    /**
     * The one path a payment takes. Immediate mode is not a second path: the
     * page sets `deadline = now` and this same sequence runs, so there is no
     * bypass to keep in sync or to forget to gate.
     */
    async submitPayment(request: PaymentRequest): Promise<IntentRef> {
      const scope = await ports.resolveNoteScope(request.noteId);
      return createPaymentFlow(ports, request, scope, request.recipient);
    },

    async getStatus(handle: StatusHandle): Promise<IntentStatus> {
      // Status is fetched through the mesh, not by a direct call to CRE. A
      // per-intent connection to the executor would associate this browser
      // with this payment at exactly the moment it is being watched.
      return (await query({ kind: 'INTENT_STATUS', handle })).value;
    },
  };
}

/**
 * The payment sequence, kept separate from the facade until the ring and
 * wallet modules land so that the shape is reviewable now and the wiring is a
 * substitution later. Order is load-bearing:
 *
 *   snapshot → local ring selection → local verify → seal → executor
 *
 * Selection runs LOCALLY (T6). The real note never appears in a query
 * parameter, and no remote selector is ever asked to exclude or locate it.
 */
export async function createPaymentFlow(
  ports: AdapterPorts,
  request: PaymentRequest,
  scope: PoolScope,
  recipient: Address = request.recipient,
): Promise<IntentRef> {
  const path = await meshPath(ports);
  const snapshot = decodeQueryResult(
    { kind: 'RING_SNAPSHOT', scope },
    await ports.transport.query({ kind: 'RING_SNAPSHOT', scope }, path),
  ).value;

  const spend = asPrivateSpend(
    await ports.ring.buildSpend({
      noteId: request.noteId,
      recipient,
      reservation: request.idempotencyKey,
      candidates: snapshot,
    }),
  );

  // Verify before sealing. A spend that cannot satisfy its own verifier must
  // fail here, where the note reservation can still be released cleanly.
  if (!(await ports.ring.verifyLocally(spend))) {
    throw new ProtocolFailure('PROOF_REJECTED', 'the locally built spend does not verify');
  }

  const sealed = await ports.sealIntent({
    scope,
    spendHash: spendHash(spend),
    spend,
    request,
  });
  return ports.executor.submit(sealed);
}

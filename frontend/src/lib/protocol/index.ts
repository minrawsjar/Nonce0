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
} from '@opaque/protocol-types';
import { asPrivateSpend, assertRelayPath, spendHash } from '@opaque/protocol-types/codecs.js';

import type { DepositMany } from '../../../../backend/chain/wallet-chain.ts';

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

/**
 * The protocol ceiling is 27 notes. With the approved seven buckets a greedy
 * amount up to 999 USDC needs no more than 17, leaving room under the Arc
 * account-operation budget for future policy changes.
 */
export const MAX_NOTES_PER_DEPOSIT = 27;

/**
 * The fewest notes that make `amount` exactly, largest first: denomination →
 * count, all in whole USDC. At most `have` of each when given. undefined when
 * nothing makes it — a note is spent whole, with no change (§6.6).
 *
 * Without `have` (a deposit, any number of each) greedy is the fewest: the
 * 1/2/5/10/20/50/100 system is canonical, checked to 1000 in ring-client's
 * greedy test. With `have` (a send, from what is held) greedy is not even
 * exact — a 50 and three 20s make 60 only as 3×20 — so that case is solved
 * outright: the fewest notes by dynamic programming over the amount.
 */
export function makeAmount(amount: number, denominations: readonly number[], have?: ReadonlyMap<number, number>): Map<number, number> | undefined {
  const sizes = [...denominations].sort((a, b) => b - a);
  if (have === undefined) {
    const out = new Map<number, number>();
    let rest = amount;
    for (const d of sizes) {
      const take = Math.floor(rest / d);
      if (take > 0) out.set(d, take);
      rest -= take * d;
    }
    return rest === 0 ? out : undefined;
  }
  // best[x]: fewest notes making x from the sizes so far; take[i][x]: how many
  // of sizes[i] that used. ponytail: O(amount × notes held), fine to thousands.
  let best = Array<number>(amount + 1).fill(Infinity);
  best[0] = 0;
  const take: number[][] = [];
  for (const d of sizes) {
    const next = Array<number>(amount + 1).fill(Infinity);
    const used = Array<number>(amount + 1).fill(0);
    for (let x = 0; x <= amount; x++) {
      for (let k = 0; k <= (have.get(d) ?? 0) && k * d <= x; k++) {
        if (best[x - k * d]! + k < next[x]!) [next[x], used[x]] = [best[x - k * d]! + k, k];
      }
    }
    best = next;
    take.push(used);
  }
  if (best[amount] === Infinity) return undefined;
  const counts: [number, number][] = [];
  for (let i = sizes.length - 1, x = amount; i >= 0; i--) {
    if (take[i]![x]! > 0) counts.unshift([sizes[i]!, take[i]![x]!]);
    x -= take[i]![x]! * sizes[i]!;
  }
  return new Map(counts);
}

export interface AdapterPorts {
  readonly wallet: PqWallet;
  readonly ring: RingClient;
  readonly pool: PrivatePoolContract & { readonly depositMany: DepositMany };
  /**
   * getRelaySnapshot() MUST return relay keys from the VERIFIED, PINNED
   * directory — createMeshBootstrap(...).snapshot() — and never from a network
   * Graph client. meshPath() below encrypts every onion layer to the keys this
   * returns, so a snapshot fetched from the Graph would let whoever answers
   * that request choose the keys every payment is sealed to. Health may come
   * from the Graph (see backend/mesh/graph-health.ts); keys may not.
   */
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

export function createPaymentApplication(ports: AdapterPorts): PaymentApplication & {
  /** `count` notes in each pool, all deposited in one transaction. */
  depositNotes(parts: readonly { readonly scope: PoolScope; readonly count: number }[]): Promise<readonly NoteSummary[]>;
} {
  const query = async <K extends MeshQuery['kind']>(
    request: Extract<MeshQuery, { kind: K }>,
  ): Promise<Extract<MeshQueryResult, { kind: K }>> =>
    decodeQueryResult(request, await ports.transport.query(request, await meshPath(ports)));

  const app = {
    async capabilities(scope: PoolScope): Promise<ProtocolCapabilities> {
      // Read from the pool, never assumed (T12). A SINGLE_NOTE_PQ deployment
      // must never be rendered with eight-member anonymity copy, and an
      // ATTESTED_OFFCHAIN one must be presented as trust in a named attester
      // rather than as a number — the chain cannot check its anonymity set at
      // all. docs/settlement-paths.md has the comparison.
      return ports.pool.capabilities(scope.pool);
    },

    createWallet: (): Promise<PqWalletState> => ports.wallet.create(),
    registerWallet: (): Promise<TxHash> => ports.wallet.register(),
    walletState: (): Promise<PqWalletState> => ports.wallet.getState(),
    rotateWallet: (): Promise<TxHash> => ports.wallet.rotate(),
    disableWallet: (): Promise<TxHash> => ports.wallet.disable(),

    async deposit(scope: PoolScope): Promise<NoteSummary> {
      return (await app.depositNotes([{ scope, count: 1 }]))[0]!;
    },

    async depositNotes(parts: readonly { readonly scope: PoolScope; readonly count: number }[]): Promise<readonly NoteSummary[]> {
      const count = parts.reduce((n, p) => n + p.count, 0);
      if (parts.some((p) => !Number.isInteger(p.count) || p.count < 1) || count < 1 || count > MAX_NOTES_PER_DEPOSIT) {
        throw new ProtocolFailure('INVALID_INPUT', `deposit 1 to ${MAX_NOTES_PER_DEPOSIT} notes at a time`);
      }
      // Every note and its commitment are persisted BEFORE the deposit is
      // submitted. A crash between the two leaves a recoverable local record,
      // where the reverse order would lose the secret for funded money.
      const notes: NoteSummary[] = [];
      const groups: { scope: PoolScope; commitments: NoteSummary['commitment'][] }[] = [];
      for (const { scope, count: n } of parts) {
        const group = { scope, commitments: [] as NoteSummary['commitment'][] };
        for (let i = 0; i < n; i++) {
          const note = await ports.ring.createNote(scope);
          notes.push(note);
          group.commitments.push(note.commitment);
        }
        groups.push(group);
      }
      const hash = await ports.pool.depositMany(groups);
      // Recorded as pending first: a tx hash is a claim, not evidence.
      for (const note of notes) await ports.ring.recordDeposit(note.id, hash);
      // Then reconciled against the chain. Without this a deposit stopped at
      // DEPOSIT_PENDING forever — and reserve() requires AVAILABLE, so a note
      // the user had paid for could never be spent. The pool port returns once
      // the deposit is mined — but Arc's public RPC is load-balanced, and the
      // node that answers the next read can be a block behind the one that
      // returned the receipt. So the evidence is looked for a few times before
      // a note is left pending (listNotes keeps looking after that).
      const summaries: NoteSummary[] = [];
      for (const note of notes) summaries.push(await ports.ring.reconcileNote(note.id));
      for (let attempt = 0; attempt < 10 && summaries.some((n) => n.state === 'DEPOSIT_PENDING'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        for (const [i, n] of summaries.entries()) if (n.state === 'DEPOSIT_PENDING') summaries[i] = await ports.ring.reconcileNote(n.id);
      }
      return summaries;
    },

    async listNotes(scope: PoolScope): Promise<readonly NoteSummary[]> {
      // A note not yet known funded is re-checked against the chain every time
      // the wallet looks: one missed read must not leave paid-for money
      // unspendable. CREATED too: a deposit that landed without being recorded
      // (a wallet popup rejected halfway through a multi-note deposit, an
      // operation whose receipt never arrived) is still found and funded here.
      const notes = await ports.ring.listNotes(scope);
      const pending = notes.filter((n) => n.state === 'DEPOSIT_PENDING' || n.state === 'CREATED');
      if (pending.length === 0) return notes;
      await Promise.all(pending.map((n) => ports.ring.reconcileNote(n.id).catch(() => undefined)));
      return ports.ring.listNotes(scope);
    },

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
  return app;
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

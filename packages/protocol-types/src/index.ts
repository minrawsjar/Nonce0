// Opaque V1 — shared protocol contract (§2).
//
// T2. This package is the contract every other module compiles against. It
// holds immutable DTOs, semantic identifiers and finite error types — never
// secrets, never mutable domain roots, never a note witness.
//
// Types here describe shape only. A TypeScript brand is erased at runtime and
// proves nothing about a value that arrived over a wire, so every semantic
// value has a matching runtime check in ./codecs.ts. Import the checkers, not
// just the types.

// ── brands ────────────────────────────────────────────────────────────────

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type Hex = `0x${string}`;
export type Address = Brand<Hex, 'Address'>;
export type Bytes32 = Brand<Hex, 'Bytes32'>;
export type NoteId = Brand<string, 'NoteId'>;
export type NoteCommitment = Brand<Hex, 'NoteCommitment'>;
export type Nullifier = Brand<Hex, 'Nullifier'>;
export type TxHash = Brand<Hex, 'TxHash'>;
export type IntentId = Brand<string, 'IntentId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type CredentialHandle = Brand<string, 'CredentialHandle'>;
export type StatusHandle = Brand<string, 'StatusHandle'>;
export type MessageHandle = Brand<string, 'MessageHandle'>;
export type RelayId = Brand<string, 'RelayId'>;
export type ChainId = Brand<bigint, 'ChainId'>;
export type UnixSeconds = Brand<bigint, 'UnixSeconds'>;

/** Integer 0..10000. A published heuristic, never a measured anonymity probability. */
export type PrivacyScore = Brand<number, 'PrivacyScore'>;

// ── money ─────────────────────────────────────────────────────────────────
//
// Pool amounts are the six-decimal USDC ERC-20 interface. Arc's NATIVE USDC
// carries 18 decimals and is used for gas; the two are the same asset through
// two interfaces, and confusing them is a factor of 10^12. Native quantities
// use the separate NativeWei type below and may only cross via toNativeWei /
// toUsdc6 in ./codecs.ts — never by assignment.

export type Usdc6 = Brand<bigint, 'Usdc6'>;
export type NativeWei = Brand<bigint, 'NativeWei'>;

/** Public value buckets. A ring is formed only within one bucket. */
export type Denomination = 1_000_000 | 2_000_000 | 5_000_000 | 10_000_000 | 20_000_000 | 50_000_000 | 100_000_000;
export const DENOMINATIONS: readonly Denomination[] = Object.freeze([
  1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000,
]);

// ── domain separation ─────────────────────────────────────────────────────
//
// Pinned constants. Both the prover and the verifier hash these exact bytes,
// so changing one is a breaking protocol change requiring a version bump and
// new test vectors — not an edit.
//
// NOTE_DOMAIN and NULLIFIER_DOMAIN are declared here so every module agrees on
// them, but the derivations that consume a noteSecret belong to ring-client's
// NoteVault (T1) and must not be performed anywhere else:
//
//   commitment     = H(NOTE_DOMAIN, noteSecret, poolId, denomination)
//   nullifier      = H(NULLIFIER_DOMAIN, noteSecret, poolId)
//   paymentContext = H(PAYMENT_DOMAIN, poolId, chainId, recipient, denomination)
//
// The nullifier binds ONLY the secret and the pool. Recipient and
// paymentContext must never enter it: a nullifier that varies with the
// recipient lets one note be spent once per recipient, without limit.
export const NOTE_DOMAIN = 'opaque/v1/note' as const;
export const NULLIFIER_DOMAIN = 'opaque/v1/nullifier' as const;
export const PAYMENT_DOMAIN = 'opaque/v1/payment' as const;
export const POOL_ID_DOMAIN = 'opaque/v1/pool-id' as const;
export const SPEND_ENCODING_DOMAIN = 'opaque/v1/spend' as const;

export const PROTOCOL_VERSION = '1-review' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

// ── scope and capabilities ────────────────────────────────────────────────

export interface PoolScope {
  readonly chainId: ChainId;
  readonly pool: Address;
  readonly denomination: Denomination;
}

export type ProofMode = 'RING_8' | 'SINGLE_NOTE_PQ';

/**
 * What a deployment actually is, read from the pool rather than assumed.
 * SINGLE_NOTE_PQ makes no depositor-to-spend unlinkability claim, and the UI
 * is required to say so (T12). Never pad a single-note spend to eight and
 * present the padding as anonymity.
 */
export interface ProtocolCapabilities {
  readonly protocolVersion: ProtocolVersion;
  readonly proofMode: ProofMode;
  readonly ringSize: 8 | 1;
  readonly verifierId: Bytes32;
  readonly pqWallet: 'LIVE' | 'MOCK';
  readonly graph: 'LIVE' | 'FIXTURE';
  readonly confidentialExecution: 'ATTESTED' | 'SIMULATED';
  readonly policyScope: 'CRE_WORKFLOW_ONLY';
}

// ── notes ─────────────────────────────────────────────────────────────────

export type NoteState =
  | 'CREATED'
  | 'DEPOSIT_PENDING'
  | 'AVAILABLE'
  | 'RESERVED'
  | 'SPENT'
  | 'RECONCILIATION_REQUIRED';

/** The safe projection of a note. The secret stays inside NoteVault (T1). */
export interface NoteSummary {
  readonly id: NoteId;
  readonly commitment: NoteCommitment;
  readonly scope: PoolScope;
  readonly state: NoteState;
  readonly createdAtBlock?: bigint;
}

export interface PaymentRequest {
  readonly noteId: NoteId;
  readonly recipient: Address;
  readonly minPrivacyScore: PrivacyScore;
  readonly deadline: UnixSeconds;
  readonly credentialHandle: CredentialHandle;
  readonly idempotencyKey: IdempotencyKey;
}

// ── spends ────────────────────────────────────────────────────────────────

export type Ring8 = readonly [
  NoteCommitment, NoteCommitment, NoteCommitment, NoteCommitment,
  NoteCommitment, NoteCommitment, NoteCommitment, NoteCommitment,
];

export interface SpendContext {
  readonly scope: PoolScope;
  readonly recipient: Address;
  readonly nullifier: Nullifier;
  readonly paymentContext: Bytes32;
  readonly verifierId: Bytes32;
  readonly proof: Hex;
}

export type PrivateSpend = SpendContext &
  (
    | { readonly mode: 'RING_8'; readonly ring: Ring8 }
    | { readonly mode: 'SINGLE_NOTE_PQ'; readonly commitment: NoteCommitment }
  );

// ── errors ────────────────────────────────────────────────────────────────

export const ERROR_CODES = Object.freeze([
  'INVALID_INPUT', 'UNSUPPORTED_VERSION', 'INSUFFICIENT_ANONYMITY',
  'GRAPH_UNAVAILABLE', 'STALE_OBSERVATION', 'POLICY_DENIED',
  'POLICY_UNAVAILABLE', 'MESH_UNAVAILABLE', 'INSUFFICIENT_RELAYS',
  'UNTRUSTED_DIRECTORY', 'EXPIRED', 'PROOF_REJECTED', 'NULLIFIER_SPENT',
  'NOTE_RESERVED', 'UNSUPPORTED_DENOMINATION', 'UNSUPPORTED_PROOF_MODE',
  'SETTLEMENT_REVERTED', 'SIGNER_STATE_UNSAFE', 'KEY_EXHAUSTED',
] as const);

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolError {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** Safe to render. Never contains a secret, a witness or a source address. */
  readonly publicMessage: string;
}

/** Thrown across module boundaries so a caller can switch on `code`. */
export class ProtocolFailure extends Error implements ProtocolError {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly publicMessage: string;

  constructor(code: ErrorCode, publicMessage: string, retryable = false) {
    super(`${code}: ${publicMessage}`);
    this.name = 'ProtocolFailure';
    this.code = code;
    this.retryable = retryable;
    this.publicMessage = publicMessage;
  }
}

// ── intents ───────────────────────────────────────────────────────────────

export type IntentState =
  | 'WAITING_FOR_PRIVACY'
  | 'POLICY_CHECKING'
  | 'READY_TO_RELEASE'
  | 'RELEASING'
  | 'SETTLEMENT_PENDING'
  | 'RETRYING'
  | 'SETTLED'
  | 'FAILED';

export const TERMINAL_INTENT_STATES: readonly IntentState[] = Object.freeze([
  'SETTLED',
  'FAILED',
]);

export interface IntentStatus {
  readonly state: IntentState;
  /** A flag, never an alternative terminal state. */
  readonly deadlineReached: boolean;
  readonly privacyScore?: PrivacyScore;
  readonly scoreObservedAt?: UnixSeconds;
  readonly updatedAt: UnixSeconds;
  readonly txHash?: TxHash;
  readonly error?: ProtocolError;
}

export interface IntentRef {
  readonly intentId: IntentId;
  /** An unguessable bearer capability held by the adapter, not a public URL. */
  readonly statusHandle: StatusHandle;
}

export interface EncryptedIntent {
  readonly version: ProtocolVersion;
  readonly scope: PoolScope;
  readonly encryptedPayload: Hex;
  readonly encryptionKeyId: string;
  readonly spendHash: Bytes32;
  readonly minPrivacyScore: PrivacyScore;
  readonly deadline: UnixSeconds;
  readonly idempotencyKey: IdempotencyKey;
}

/**
 * The internal CRE → managed-egress handoff (T7). `authenticationTag` is a
 * MAC over the canonical fields, verified by the egress before it submits.
 *
 * This is a service trust contract, NOT a public on-chain authorization proof.
 * The pool is independently proof-gated and does not check it, so a holder of
 * a valid spend can always submit directly. Deferred decision D1.
 */
export interface ApprovedRelease {
  readonly intentId: IntentId;
  readonly spend: PrivateSpend;
  readonly spendHash: Bytes32;
  readonly policyVersion: string;
  readonly issuedAt: UnixSeconds;
  /** Delivery validity window — separate from the scheduling deadline. */
  readonly expiresAt: UnixSeconds;
  readonly authenticationTag: Hex;
}

/** Public, one-shot CRE result posted to Arc; proof bytes remain in CRE. */
export interface SpendAuthorization {
  readonly authorizationId: Bytes32;
  readonly intentIdHash: Bytes32;
  readonly spendHash: Bytes32;
  readonly nullifier: Nullifier;
  readonly pool: Address;
  readonly recipient: Address;
  readonly feeCollector: Address;
  readonly grossAmount: Usdc6;
  readonly feeAmount: Usdc6;
  readonly feeBps: number;
  readonly issuedAt: UnixSeconds;
  readonly expiresAt: UnixSeconds;
  readonly policyVersion: Bytes32;
}

// ── observations ──────────────────────────────────────────────────────────

export interface RingCandidate {
  readonly commitment: NoteCommitment;
  readonly enrolledAtBlock: bigint;
  readonly timesUsedInRing: number;
  /** Optional heuristic. Nullable means unknown — never treat null as zero. */
  readonly fundingCluster: string | null;
  readonly hasOtherActivity: boolean | null;
}

export interface RingSnapshot {
  readonly scope: PoolScope;
  readonly candidates: readonly RingCandidate[];
  readonly indexedThroughBlock: bigint;
  readonly observedAt: UnixSeconds;
  readonly policyVersion: string;
}

export interface RelayNode {
  readonly id: RelayId;
  readonly endpoint: string;
  readonly kemPublicKey: Hex;
  readonly keyEpoch: bigint;
  readonly operatorId: string;
  readonly reliabilityScore: PrivacyScore;
  readonly batchOccupancy: number;
  readonly recentSelectionCount: number;
  readonly lastSeenAt: UnixSeconds;
}

export type RelayPath = readonly [RelayNode, RelayNode, RelayNode];

export interface RelaySnapshot {
  readonly nodes: readonly RelayNode[];
  readonly directoryVersion: string;
  readonly observedAt: UnixSeconds;
}

export interface PrivacyConditions {
  readonly scope: PoolScope;
  readonly privacyScore: PrivacyScore;
  readonly ringFreshnessScore: PrivacyScore;
  readonly meshHealthScore: PrivacyScore;
  readonly observedAt: UnixSeconds;
  readonly formulaVersion: string;
  readonly source: 'LIVE' | 'FIXTURE';
}

// ── transport ─────────────────────────────────────────────────────────────

export interface MeshStatusEvent {
  /** SUBMITTED means a broadcast attempt. It does not mean SETTLED. */
  readonly state: 'QUEUED' | 'BATCHED' | 'FORWARDED' | 'SUBMITTED' | 'FAILED';
  readonly updatedAt: UnixSeconds;
  readonly error?: ProtocolError;
}

export type WalletRpcOperation =
  | 'STATE' | 'DIGEST' | 'ESTIMATE'
  | 'SUBMIT_USER_OPERATION' | 'USER_OPERATION_RECEIPT';

export type MeshQuery =
  | { readonly kind: 'RING_SNAPSHOT'; readonly scope: PoolScope }
  | { readonly kind: 'RELAY_SNAPSHOT' }
  | { readonly kind: 'PRIVACY_CONDITIONS'; readonly scope: PoolScope }
  | { readonly kind: 'WALLET_RPC'; readonly operation: WalletRpcOperation; readonly encodedRequest: Hex }
  | { readonly kind: 'INTENT_STATUS'; readonly handle: StatusHandle }
  | { readonly kind: 'MESH_STATUS'; readonly handle: MessageHandle }
  | { readonly kind: 'POOL_RECEIPT'; readonly txHash: TxHash };

export type MeshQueryResult =
  | { readonly kind: 'RING_SNAPSHOT'; readonly value: RingSnapshot }
  | { readonly kind: 'RELAY_SNAPSHOT'; readonly value: RelaySnapshot }
  | { readonly kind: 'PRIVACY_CONDITIONS'; readonly value: PrivacyConditions }
  | { readonly kind: 'WALLET_RPC'; readonly value: Hex }
  | { readonly kind: 'INTENT_STATUS'; readonly value: IntentStatus }
  | { readonly kind: 'MESH_STATUS'; readonly value: MeshStatusEvent }
  | { readonly kind: 'POOL_RECEIPT'; readonly value: Hex };

// ── ports ─────────────────────────────────────────────────────────────────

export interface PqWalletState {
  readonly accountAddress: Address;
  readonly pkCommitment: Bytes32;
  readonly keyEpoch: bigint;
  /** Accepted on-chain authority transitions. */
  readonly chainUseCount: bigint;
  /** Locally reserved signing capacity. Never decremented to match the chain. */
  readonly localSigningReservations: bigint;
  readonly maxUses: bigint;
  readonly rotationDeadline: UnixSeconds;
  readonly active: boolean;
}

export interface PqWallet {
  create(): Promise<PqWalletState>;
  register(): Promise<TxHash>;
  getState(): Promise<PqWalletState>;
  signUserOperation(encodedUserOperation: Hex): Promise<{
    readonly digest: Bytes32;
    readonly signature: Hex;
    readonly keyEpoch: bigint;
    readonly signingReservation: bigint;
  }>;
  rotate(): Promise<TxHash>;
  disable(): Promise<TxHash>;
}

export interface RingClient {
  createNote(scope: PoolScope): Promise<NoteSummary>;
  listNotes(scope: PoolScope): Promise<readonly NoteSummary[]>;
  recordDeposit(noteId: NoteId, txHash: TxHash): Promise<NoteSummary>;
  reconcileNote(noteId: NoteId): Promise<NoteSummary>;
  releaseReservation(input: {
    readonly noteId: NoteId;
    readonly reservation: IdempotencyKey;
    readonly terminalIntent: IntentId;
  }): Promise<NoteSummary>;
  /** Resolves and reserves the note internally. No witness crosses this API. */
  buildSpend(input: {
    readonly noteId: NoteId;
    readonly recipient: Address;
    readonly reservation: IdempotencyKey;
    readonly candidates: RingSnapshot;
  }): Promise<PrivateSpend>;
  verifyLocally(spend: PrivateSpend): Promise<boolean>;
}

export interface PrivatePoolContract {
  capabilities(pool: Address): Promise<ProtocolCapabilities>;
  deposit(input: { readonly scope: PoolScope; readonly commitment: NoteCommitment }): Promise<TxHash>;
  spend(spend: PrivateSpend): Promise<TxHash>;
  isNullifierSpent(scope: PoolScope, value: Nullifier): Promise<boolean>;
}

export interface GraphSelectionClient {
  getRingSnapshot(scope: PoolScope): Promise<RingSnapshot>;
  getRelaySnapshot(): Promise<RelaySnapshot>;
  getPrivacyConditions(scope: PoolScope): Promise<PrivacyConditions>;
}

export interface PathSelectionPolicy {
  selectPath(snapshot: RelaySnapshot): {
    readonly nodes: RelayPath;
    readonly probabilities: readonly [number, number, number];
  };
}

export interface PrivacyTransport {
  submitIntent(input: EncryptedIntent, path: RelayPath): Promise<IntentRef>;
  query(request: MeshQuery, path: RelayPath): Promise<MeshQueryResult>;
  subscribe(handle: MessageHandle, listener: (event: MeshStatusEvent) => void): () => void;
}

export interface PrivacyTimedExecutor {
  submit(input: EncryptedIntent): Promise<IntentRef>;
  getStatus(handle: StatusHandle): Promise<IntentStatus>;
}

/** Internal CRE → managed mesh egress. Never reachable from a page. */
export interface ApprovedReleaseTransport {
  submit(release: ApprovedRelease, path: RelayPath): Promise<MessageHandle>;
}

export interface CredentialInput {
  capture(): Promise<CredentialHandle>;
}

/** The single facade pages consume, through the adapter barrel. */
export interface PaymentApplication {
  capabilities(scope: PoolScope): Promise<ProtocolCapabilities>;
  createWallet(): Promise<PqWalletState>;
  registerWallet(): Promise<TxHash>;
  walletState(): Promise<PqWalletState>;
  rotateWallet(): Promise<TxHash>;
  disableWallet(): Promise<TxHash>;
  deposit(scope: PoolScope): Promise<NoteSummary>;
  listNotes(scope: PoolScope): Promise<readonly NoteSummary[]>;
  submitPayment(request: PaymentRequest): Promise<IntentRef>;
  getStatus(handle: StatusHandle): Promise<IntentStatus>;
}

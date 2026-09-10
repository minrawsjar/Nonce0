// Runtime validation and canonical encoding for the §2 contract.
//
// The rule this file exists to enforce: *a TypeScript assertion alone is not
// validation*. Every brand in ./index.ts is erased at runtime, so a value that
// arrived from a relay, a page, an RPC or a fixture has exactly the type its
// bytes deserve. Nothing crosses a module boundary without passing through a
// checker here.

import { keccak_256 } from '@noble/hashes/sha3.js';

import {
  DENOMINATIONS,
  PAYMENT_DOMAIN,
  POOL_ID_DOMAIN,
  PROTOCOL_VERSION,
  ProtocolFailure,
  SPEND_ENCODING_DOMAIN,
  type Address,
  type Bytes32,
  type ChainId,
  type Denomination,
  type Hex,
  type NativeWei,
  type NoteCommitment,
  type PoolScope,
  type PrivacyScore,
  type IntentState,
  type IntentStatus,
  type MeshQuery,
  type MeshQueryResult,
  type PrivacyConditions,
  type PrivateSpend,
  type ProofMode,
  type RelayId,
  type RelayNode,
  type RelayPath,
  type RelaySnapshot,
  type Ring8,
  type RingCandidate,
  type RingSnapshot,
  type TxHash,
  type UnixSeconds,
  type Usdc6,
} from './index.ts';

function fail(message: string): never {
  throw new ProtocolFailure('INVALID_INPUT', message);
}

// ── hex ───────────────────────────────────────────────────────────────────
//
// Lower-case is canonical. An upper-case address is not "the same value" for
// hashing purposes, and accepting both would let two encodings of one spend
// produce two different spendHashes.

const HEX = /^0x[0-9a-f]*$/;

export function assertHex(value: unknown, label: string): asserts value is Hex {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (!HEX.test(value as string)) fail(`${label} must be lower-case 0x-prefixed hex`);
  if ((value as string).length % 2 !== 0) fail(`${label} must have whole bytes`);
}

function assertHexBytes(value: unknown, bytes: number, label: string): void {
  assertHex(value, label);
  const actual = ((value as string).length - 2) / 2;
  if (actual !== bytes) fail(`${label} must be ${bytes} bytes, got ${actual}`);
}

export function asAddress(value: unknown): Address {
  assertHexBytes(value, 20, 'address');
  return value as Address;
}

export function asBytes32(value: unknown): Bytes32 {
  assertHexBytes(value, 32, 'bytes32');
  return value as Bytes32;
}

export const asNoteCommitment = (value: unknown): NoteCommitment =>
  asBytes32(value) as unknown as NoteCommitment;

export const toHex = (bytes: Uint8Array): Hex =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export function fromHex(value: Hex): Uint8Array {
  assertHex(value, 'hex');
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

// ── bounded integers ──────────────────────────────────────────────────────

export function asPrivacyScore(value: unknown): PrivacyScore {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('privacyScore must be an integer');
  if ((value as number) < 0 || (value as number) > 10_000) fail('privacyScore must be within 0..10000');
  return value as PrivacyScore;
}

export function asDenomination(value: unknown): Denomination {
  if (!DENOMINATIONS.includes(value as Denomination)) {
    throw new ProtocolFailure('UNSUPPORTED_DENOMINATION', `denomination ${String(value)} is not supported`);
  }
  return value as Denomination;
}

// ── bigint on the wire ────────────────────────────────────────────────────
//
// JSON numbers lose precision above 2^53, and a chainId, a block height or a
// UnixSeconds can all exceed it. Canonical decimal strings round-trip
// losslessly and compare byte-for-byte, so "0042" and "+42" are rejected
// rather than silently normalised into a second encoding of one value.

const DECIMAL = /^(0|-?[1-9][0-9]*)$/;

export const encodeBigint = (value: bigint): string => value.toString(10);

export function decodeBigint(value: unknown, label: string): bigint {
  if (typeof value !== 'string') fail(`${label} must be a decimal string, not a JSON number`);
  if (!DECIMAL.test(value as string)) fail(`${label} is not canonical decimal`);
  return BigInt(value as string);
}

export function asUnixSeconds(value: unknown, label = 'timestamp'): UnixSeconds {
  const n = typeof value === 'bigint' ? value : decodeBigint(value, label);
  if (n < 0n) fail(`${label} must not be negative`);
  return n as UnixSeconds;
}

export const asChainId = (value: unknown): ChainId => {
  const n = typeof value === 'bigint' ? value : decodeBigint(value, 'chainId');
  if (n <= 0n) fail('chainId must be positive');
  return n as ChainId;
};

// ── money conversions ─────────────────────────────────────────────────────
//
// The ONLY sanctioned crossing between Arc's two USDC interfaces. Everywhere
// else the brands keep them apart. 18 - 6 = 12 decimal places.

const USDC_TO_NATIVE = 1_000_000_000_000n;

export const toNativeWei = (amount: Usdc6): NativeWei => (amount * USDC_TO_NATIVE) as NativeWei;

/** Truncates toward zero, as EVM integer division does. */
export const toUsdc6 = (amount: NativeWei): Usdc6 => (amount / USDC_TO_NATIVE) as Usdc6;

// ── scope ─────────────────────────────────────────────────────────────────

export function asPoolScope(value: unknown): PoolScope {
  if (typeof value !== 'object' || value === null) fail('scope must be an object');
  const raw = value as Record<string, unknown>;
  return {
    chainId: asChainId(raw['chainId']),
    pool: asAddress(raw['pool']),
    denomination: asDenomination(raw['denomination']),
  };
}

/** Domain-separated canonical identity of (chain, pool). */
export const poolId = (scope: PoolScope): Bytes32 =>
  toHex(keccak_256(canonical([
    utf8(POOL_ID_DOMAIN),
    utf8(encodeBigint(scope.chainId)),
    fromHex(scope.pool),
  ]))) as Bytes32;

/**
 * The public binding a spend proves against. Contains the recipient — which is
 * exactly why it must never enter the nullifier derivation (see index.ts).
 */
export const derivePaymentContext = (scope: PoolScope, recipient: Address): Bytes32 =>
  toHex(keccak_256(canonical([
    utf8(PAYMENT_DOMAIN),
    fromHex(poolId(scope)),
    utf8(encodeBigint(scope.chainId)),
    fromHex(recipient),
    utf8(String(scope.denomination)),
  ]))) as Bytes32;

// ── canonical encoding ────────────────────────────────────────────────────
//
// Length-prefixed concatenation, never ad hoc JSON. Every field is preceded by
// its 4-byte big-endian length, so no two distinct field lists can produce the
// same byte string — which is what stops a spend being re-encoded to collide
// with a different one.

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function canonical(fields: readonly Uint8Array[]): Uint8Array {
  const total = fields.reduce((n, f) => n + 4 + f.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const field of fields) {
    view.setUint32(at, field.length, false);
    out.set(field, at + 4);
    at += 4 + field.length;
  }
  return out;
}

export function encodeSpend(spend: PrivateSpend): Uint8Array {
  const members =
    spend.mode === 'RING_8' ? spend.ring : ([spend.commitment] as readonly NoteCommitment[]);

  return canonical([
    utf8(SPEND_ENCODING_DOMAIN),
    utf8(PROTOCOL_VERSION),
    utf8(spend.mode),
    utf8(encodeBigint(spend.scope.chainId)),
    fromHex(spend.scope.pool),
    utf8(String(spend.scope.denomination)),
    fromHex(spend.recipient),
    fromHex(spend.nullifier),
    fromHex(spend.paymentContext),
    fromHex(spend.verifierId),
    // Members are already canonically sorted by ring-client; encoding the
    // count explicitly stops an 8-member and a 1-member spend ever colliding.
    utf8(String(members.length)),
    ...members.map((m) => fromHex(m)),
    fromHex(spend.proof),
  ]);
}

/**
 * A transport binding — it identifies which spend an intent or a release
 * refers to. It is NOT a substitute for verifying the proof, and nothing
 * downstream may treat a matching spendHash as evidence of validity.
 */
export const spendHash = (spend: PrivateSpend): Bytes32 =>
  toHex(keccak_256(encodeSpend(spend))) as Bytes32;

// ── structural validation ─────────────────────────────────────────────────

export function asRing8(value: unknown): Ring8 {
  if (!Array.isArray(value)) fail('ring must be an array');
  if (value.length !== 8) {
    throw new ProtocolFailure('INVALID_INPUT', `ring must hold exactly 8 members, got ${value.length}`);
  }
  const members = value.map(asNoteCommitment);
  if (new Set(members).size !== 8) fail('ring members must be distinct');
  return members as unknown as Ring8;
}

/**
 * Validates the spend AND the mode/ring-size relationship, which is the pair
 * that lets a single-note fallback masquerade as an eight-member ring if only
 * one of them is checked.
 */
export function asPrivateSpend(value: unknown, expected?: ProofMode): PrivateSpend {
  if (typeof value !== 'object' || value === null) fail('spend must be an object');
  const raw = value as Record<string, unknown>;
  const mode = raw['mode'];

  if (mode !== 'RING_8' && mode !== 'SINGLE_NOTE_PQ') {
    throw new ProtocolFailure('UNSUPPORTED_PROOF_MODE', `unknown proof mode ${String(mode)}`);
  }
  if (expected !== undefined && mode !== expected) {
    throw new ProtocolFailure('UNSUPPORTED_PROOF_MODE', `pool is pinned to ${expected}, spend claims ${mode}`);
  }

  const scope = asPoolScope(raw['scope']);
  const recipient = asAddress(raw['recipient']);
  const context: Omit<PrivateSpend, 'mode' | 'ring' | 'commitment'> = {
    scope,
    recipient,
    nullifier: asBytes32(raw['nullifier']) as unknown as PrivateSpend['nullifier'],
    paymentContext: asBytes32(raw['paymentContext']),
    verifierId: asBytes32(raw['verifierId']),
    proof: (assertHex(raw['proof'], 'proof'), raw['proof'] as Hex),
  };

  // The recipient and scope are already bound into paymentContext; recomputing
  // it here means a spend whose context does not match its own stated
  // recipient is rejected at the boundary rather than at the verifier.
  const expectedContext = derivePaymentContext(scope, recipient);
  if (context.paymentContext !== expectedContext) {
    fail('paymentContext does not match scope and recipient');
  }

  return mode === 'RING_8'
    ? { ...context, mode, ring: asRing8(raw['ring']) }
    : { ...context, mode, commitment: asNoteCommitment(raw['commitment']) };
}

export function assertKnownVersion(value: unknown): void {
  if (value !== PROTOCOL_VERSION) {
    throw new ProtocolFailure('UNSUPPORTED_VERSION', `expected ${PROTOCOL_VERSION}, got ${String(value)}`);
  }
}

/** Three distinct nodes, run by three distinct operators. */
export function assertRelayPath(path: unknown): asserts path is RelayPath {
  if (!Array.isArray(path) || path.length !== 3) {
    throw new ProtocolFailure('INSUFFICIENT_RELAYS', 'a path must hold exactly 3 relays');
  }
  const ids = new Set(path.map((n) => (n as { id?: unknown }).id));
  if (ids.size !== 3) {
    throw new ProtocolFailure('INSUFFICIENT_RELAYS', 'a path must not repeat a relay');
  }
  const operators = new Set(path.map((n) => (n as { operatorId?: unknown }).operatorId));
  if (operators.size !== 3) {
    throw new ProtocolFailure('INSUFFICIENT_RELAYS', 'a path must not repeat an operator');
  }
}


// ── mesh query answers ────────────────────────────────────────────────────
//
// A query answer crosses the mesh as JSON, and JSON has no bigint: the far end
// sends observedAt, indexedThroughBlock, keyEpoch and chainId as decimal
// strings. Casting the parsed object to MeshQueryResult therefore produced
// values TYPED as bigint that were actually strings — and the first piece of
// arithmetic on one (`now - observedAt`) throws "Cannot mix BigInt and other
// types". Nothing caught it because nothing had ever received a real answer.
//
// So each answer is decoded, not cast. These accept a value already in native
// form as well, so an in-process answerer and a wire one decode identically.

const obj = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const str = (value: unknown, label: string): string => {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value as string;
};
const int = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value as number;
};
const arr = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value as readonly unknown[];
};
const big = (value: unknown, label: string): bigint =>
  typeof value === 'bigint' ? value : decodeBigint(value, label);

function asRingCandidate(value: unknown): RingCandidate {
  const c = obj(value, 'ring candidate');
  const cluster = c['fundingCluster'];
  const activity = c['hasOtherActivity'];
  return {
    commitment: asNoteCommitment(c['commitment']),
    enrolledAtBlock: big(c['enrolledAtBlock'], 'enrolledAtBlock'),
    timesUsedInRing: int(c['timesUsedInRing'], 'timesUsedInRing'),
    // Null means unknown and must stay null — never coerced to zero or false.
    fundingCluster: cluster === null ? null : str(cluster, 'fundingCluster'),
    hasOtherActivity: activity === null ? null : Boolean(activity),
  };
}

export function asRingSnapshot(value: unknown): RingSnapshot {
  const r = obj(value, 'ring snapshot');
  return {
    scope: asPoolScope(r['scope']),
    candidates: arr(r['candidates'], 'candidates').map(asRingCandidate),
    indexedThroughBlock: big(r['indexedThroughBlock'], 'indexedThroughBlock'),
    observedAt: asUnixSeconds(r['observedAt'], 'observedAt'),
    policyVersion: str(r['policyVersion'], 'policyVersion'),
  };
}

function asRelayNode(value: unknown): RelayNode {
  const n = obj(value, 'relay node');
  const kem = n['kemPublicKey'];
  assertHex(kem, 'kemPublicKey');
  return {
    id: str(n['id'], 'relay id') as RelayId,
    endpoint: str(n['endpoint'], 'endpoint'),
    kemPublicKey: kem,
    keyEpoch: big(n['keyEpoch'], 'keyEpoch'),
    operatorId: str(n['operatorId'], 'operatorId'),
    reliabilityScore: asPrivacyScore(n['reliabilityScore']),
    batchOccupancy: typeof n['batchOccupancy'] === 'number' && Number.isFinite(n['batchOccupancy'])
      ? (n['batchOccupancy'] as number)
      : fail('batchOccupancy must be a finite number'),
    recentSelectionCount: int(n['recentSelectionCount'], 'recentSelectionCount'),
    lastSeenAt: asUnixSeconds(n['lastSeenAt'], 'lastSeenAt'),
  };
}

export function asRelaySnapshot(value: unknown): RelaySnapshot {
  const r = obj(value, 'relay snapshot');
  return {
    nodes: arr(r['nodes'], 'nodes').map(asRelayNode),
    directoryVersion: str(r['directoryVersion'], 'directoryVersion'),
    observedAt: asUnixSeconds(r['observedAt'], 'observedAt'),
  };
}

export function asPrivacyConditions(value: unknown): PrivacyConditions {
  const p = obj(value, 'privacy conditions');
  const source = p['source'];
  if (source !== 'LIVE' && source !== 'FIXTURE') fail('privacy conditions source must be LIVE or FIXTURE');
  return {
    scope: asPoolScope(p['scope']),
    privacyScore: asPrivacyScore(p['privacyScore']),
    ringFreshnessScore: asPrivacyScore(p['ringFreshnessScore']),
    meshHealthScore: asPrivacyScore(p['meshHealthScore']),
    observedAt: asUnixSeconds(p['observedAt'], 'observedAt'),
    formulaVersion: str(p['formulaVersion'], 'formulaVersion'),
    source: source as 'LIVE' | 'FIXTURE',
  };
}

const INTENT_STATES: readonly IntentState[] = [
  'WAITING_FOR_PRIVACY', 'POLICY_CHECKING', 'READY_TO_RELEASE', 'RELEASING',
  'SETTLEMENT_PENDING', 'RETRYING', 'SETTLED', 'FAILED',
];

export function asIntentStatus(value: unknown): IntentStatus {
  const s = obj(value, 'intent status');
  const state = s['state'];
  if (!INTENT_STATES.includes(state as IntentState)) fail(`unknown intent state ${String(state)}`);
  const out: Record<string, unknown> = {
    state,
    deadlineReached: s['deadlineReached'] === true,
    updatedAt: asUnixSeconds(s['updatedAt'], 'updatedAt'),
  };
  if (s['privacyScore'] !== undefined) out['privacyScore'] = asPrivacyScore(s['privacyScore']);
  if (s['scoreObservedAt'] !== undefined) out['scoreObservedAt'] = asUnixSeconds(s['scoreObservedAt'], 'scoreObservedAt');
  if (s['txHash'] !== undefined) {
    const tx = s['txHash'];
    assertHex(tx, 'txHash');
    out['txHash'] = tx as TxHash;
  }
  if (s['error'] !== undefined) out['error'] = s['error'];
  return out as unknown as IntentStatus;
}

/**
 * Decodes an answer for the query that was actually asked. The kind is checked
 * FIRST: a relay that returns a RELAY_SNAPSHOT where a RING_SNAPSHOT was asked
 * for must not be read as whatever the caller hoped for.
 */
export function asMeshQueryResult(request: MeshQuery, value: unknown): MeshQueryResult {
  const r = obj(value, 'query answer');
  if (r['kind'] !== request.kind) {
    throw new ProtocolFailure('INVALID_INPUT', `asked for ${request.kind} and got ${String(r['kind'])}`);
  }
  const v = r['value'];
  switch (request.kind) {
    case 'RING_SNAPSHOT': return { kind: 'RING_SNAPSHOT', value: asRingSnapshot(v) };
    case 'RELAY_SNAPSHOT': return { kind: 'RELAY_SNAPSHOT', value: asRelaySnapshot(v) };
    case 'PRIVACY_CONDITIONS': return { kind: 'PRIVACY_CONDITIONS', value: asPrivacyConditions(v) };
    case 'INTENT_STATUS': return { kind: 'INTENT_STATUS', value: asIntentStatus(v) };
    case 'WALLET_RPC':
    case 'POOL_RECEIPT': {
      assertHex(v, `${request.kind} value`);
      return { kind: request.kind, value: v } as MeshQueryResult;
    }
    case 'MESH_STATUS': {
      const m = obj(v, 'mesh status');
      return { kind: 'MESH_STATUS', value: { ...m, updatedAt: asUnixSeconds(m['updatedAt'], 'updatedAt') } as never };
    }
  }
}

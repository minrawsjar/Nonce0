import { ProtocolFailure, type Address, type Bytes32, type ChainId, type Hex } from '@opaque/protocol-types';
import { asAddress, asBytes32, asChainId, assertHex, toHex } from '@opaque/protocol-types/codecs.js';
import { pqDigest, utf8 } from './digest.ts';
import { decodeSignature, forsSchemeId, pkCommitment, verify } from './fors.ts';

export const UINT64_MAX = (1n << 64n) - 1n;
export const DISABLE_TIMELOCK = 30n * 24n * 60n * 60n;
const ZERO = `0x${'00'.repeat(32)}`;

/** Exactly the original §5.2/Solidity fields; epoch is not invented here. */
export interface PQKeyState {
  readonly pkCommitment: Bytes32;
  readonly nextCommitment: Bytes32;
  readonly useCount: bigint;
  readonly maxUses: bigint;
  readonly rotationDeadline: bigint;
  readonly disableAfter: bigint;
}

/** Unsettled timing semantics must be selected explicitly by the integrating owner. */
export interface RegistryPolicy {
  readonly deadline: 'observe-only' | 'reject-actions';
  readonly allowLateRotation: boolean;
  readonly pendingDisableOnRotation: 'preserve' | 'clear';
  readonly repeatedDisable: 'preserve' | 'restart';
}

export function validateRegistryPolicy(p: RegistryPolicy): void {
  if (!p || !['observe-only', 'reject-actions'].includes(p.deadline) || typeof p.allowLateRotation !== 'boolean' ||
      !['preserve', 'clear'].includes(p.pendingDisableOnRotation) || !['preserve', 'restart'].includes(p.repeatedDisable)) {
    throw new ProtocolFailure('INVALID_INPUT', 'Explicit registry timing policy is required');
  }
}

export function uint64(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
    throw new ProtocolFailure('INVALID_INPUT', 'Expected a uint64 value');
  }
  return value;
}

function commitment(value: Bytes32): Bytes32 {
  const checked = asBytes32(value);
  if (checked === ZERO) throw new ProtocolFailure('INVALID_INPUT', 'Zero commitment is not permitted');
  return checked;
}

export function validateKeyState(state: PQKeyState): void {
  commitment(state.pkCommitment); commitment(state.nextCommitment);
  uint64(state.useCount); uint64(state.maxUses); uint64(state.rotationDeadline); uint64(state.disableAfter);
  if (state.maxUses === 0n) throw new ProtocolFailure('INVALID_INPUT', 'Signing capacity must be positive');
}

/** Reject at and beyond the limit, including an invalid imported state. */
export function assertUsable(state: PQKeyState, now: bigint): void {
  validateKeyState(state); uint64(now);
  if (state.disableAfter !== 0n && now >= state.disableAfter) throw new ProtocolFailure('EXPIRED', 'PQ key is disabled');
  if (state.useCount >= state.maxUses) throw new ProtocolFailure('KEY_EXHAUSTED', 'PQ key signing capacity is exhausted');
}

const join = (domain: string, data: Hex = '0x'): Hex => {
  assertHex(data, 'action data');
  return `${toHex(utf8(domain))}${data.slice(2)}`;
};
const word = (value: bigint): string => uint64(value).toString(16).padStart(64, '0');

/** These payloads match existing Solidity abi.encodePacked(domain, abi.encode(...)). */
export const userActionPayload = (payload: Hex): Hex => join('opaque/v1/pq-wallet/action', payload);
export const disablePayload = (): Hex => join('opaque/v1/pq-wallet/disable');
export function rotationPayload(next: Bytes32, maxUses: bigint, deadline: bigint): Hex {
  return join('opaque/v1/pq-wallet/rotate', `0x${commitment(next).slice(2)}${word(maxUses)}${word(deadline)}`);
}
export function takeoverPayload(next: Bytes32, maxUses: bigint): Hex {
  return join('opaque/v1/pq-wallet/takeover', `0x${commitment(next).slice(2)}${word(maxUses)}`);
}

/** In-memory reference only. It does not impersonate an RPC-backed registry. */
export class PQKeyRegistry {
  #states = new Map<Address, PQKeyState>();
  #chainId: ChainId;
  #now: () => bigint;
  #policy: RegistryPolicy;

  constructor(input: { chainId: ChainId; now: () => bigint; policy: RegistryPolicy }) {
    this.#chainId = asChainId(input.chainId); this.#now = input.now;
    const p = input.policy;
    validateRegistryPolicy(p);
    this.#policy = Object.freeze({ ...p });
  }

  stateOf(account: Address): PQKeyState | undefined {
    const state = this.#states.get(asAddress(account));
    return state && Object.freeze({ ...state });
  }

  /** caller is the authenticated account identity supplied by the execution boundary. */
  register(caller: Address, input: Omit<PQKeyState, 'useCount' | 'disableAfter'>): void {
    const account = asAddress(caller);
    if (this.#states.has(account)) throw new ProtocolFailure('INVALID_INPUT', 'Account already registered');
    const state = { ...input, useCount: 0n, disableAfter: 0n };
    validateKeyState(state);
    // Copy exactly the specified fields, never arbitrary properties from callers.
    this.#states.set(account, { pkCommitment: state.pkCommitment, nextCommitment: state.nextCommitment,
      useCount: 0n, maxUses: state.maxUses, rotationDeadline: state.rotationDeadline, disableAfter: 0n });
  }

  consume(account: Address, payload: Hex, signature: Hex): Bytes32 {
    const state = this.#require(account);
    const digest = this.#authorize(account, state, userActionPayload(payload), signature, false);
    this.#states.set(account, { ...state, useCount: state.useCount + 1n });
    return digest;
  }

  rotate(account: Address, next: Bytes32, maxUses: bigint, deadline: bigint, signature: Hex): void {
    const state = this.#require(account);
    const updated = { ...state, pkCommitment: state.nextCommitment, nextCommitment: next,
      useCount: 0n, maxUses, rotationDeadline: deadline,
      disableAfter: this.#policy.pendingDisableOnRotation === 'preserve' ? state.disableAfter : 0n };
    validateKeyState(updated);
    this.#authorize(account, state, rotationPayload(next, maxUses, deadline), signature, true);
    this.#states.set(account, updated);
  }

  initiateDisable(account: Address, signature: Hex): void {
    const state = this.#require(account);
    const now = uint64(this.#now());
    const at = state.disableAfter !== 0n && this.#policy.repeatedDisable === 'preserve'
      ? state.disableAfter : uint64(now + DISABLE_TIMELOCK);
    this.#authorize(account, state, disablePayload(), signature, true, now);
    this.#states.set(account, { ...state, useCount: state.useCount + 1n, disableAfter: at });
  }

  /** The pre-committed next key takes over once the current key can no longer
   *  act: its disable timelock has elapsed, or it has used every signature.
   *  Mirrors PQKeyRegistry.takeover — see there for why exhaustion counts. */
  takeover(account: Address, next: Bytes32, maxUses: bigint, signature: Hex): void {
    const state = this.#require(account);
    const now = uint64(this.#now());
    const disabled = state.disableAfter !== 0n && now >= state.disableAfter;
    if (!disabled && state.useCount < state.maxUses) {
      throw new ProtocolFailure('EXPIRED', 'Takeover needs an elapsed disable or an exhausted key');
    }
    const updated = { ...state, pkCommitment: state.nextCommitment, nextCommitment: next,
      useCount: 1n, maxUses, disableAfter: 0n };
    validateKeyState(updated);
    this.#verify(account, state.nextCommitment, 0n, takeoverPayload(next, maxUses), signature);
    this.#states.set(account, updated);
  }

  #require(account: Address): PQKeyState {
    const state = this.#states.get(asAddress(account));
    if (!state) throw new ProtocolFailure('INVALID_INPUT', 'Account is not registered');
    return state;
  }

  #authorize(account: Address, state: PQKeyState, payload: Hex, signature: Hex, lifecycle: boolean, now = uint64(this.#now())): Bytes32 {
    assertUsable(state, now);
    if (now >= state.rotationDeadline && this.#policy.deadline === 'reject-actions' &&
        !(lifecycle && this.#policy.allowLateRotation)) throw new ProtocolFailure('EXPIRED', 'Rotation deadline reached');
    return this.#verify(account, state.pkCommitment, state.useCount, payload, signature);
  }

  #verify(account: Address, expected: Bytes32, useCount: bigint, payload: Hex, signature: Hex): Bytes32 {
    const decoded = decodeSignature(signature);
    const digest = pqDigest({ chainId: this.#chainId, walletAddress: account,
      schemeId: forsSchemeId(decoded.publicKey.params), useCount, payload });
    if (pkCommitment(decoded.publicKey) !== expected || !verify(decoded.publicKey, digest, decoded.signature)) {
      throw new ProtocolFailure('PROOF_REJECTED', 'PQ authorization rejected');
    }
    return digest;
  }
}

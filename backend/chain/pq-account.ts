// The PQ account's byte-level contract with Solidity, in one place: what a
// wallet signs for a UserOperation, and where its account lives before it
// exists. PQValidator.sol and PQAccountFactory.sol are the other half;
// contracts/test/PQAccount.t.sol checks the two agree on vectors made here.

import { keccak_256 } from '@noble/hashes/sha3.js';

import type { Address, Bytes32, Hex } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { canonical, utf8 } from '@opaque/pq-wallet';

/** PQValidator.USER_OPERATION_DOMAIN. */
export const USER_OPERATION_DOMAIN = 'opaque/v1/pq-account/user-operation';

/**
 * §5.3's payload for a UserOperation: the whole v0.7 userOpHash, which commits
 * to every field of the operation plus the EntryPoint and chain. The registry
 * then prefixes its user-action domain before digesting.
 */
export const userOperationPayload = (userOpHash: Bytes32): Hex =>
  toHex(canonical([utf8(USER_OPERATION_DOMAIN), fromHex(userOpHash)])) as Hex;

const word = (value: bigint): Uint8Array => fromHex(`0x${value.toString(16).padStart(64, '0')}` as Hex);

/** PQAccountFactory.accountSalt: keccak256(abi.encode(pk, next, maxUses, deadline)). */
export function accountSalt(pkCommitment: Bytes32, nextCommitment: Bytes32, maxUses: bigint, rotationDeadline: bigint): Bytes32 {
  return toHex(keccak_256(new Uint8Array([
    ...fromHex(pkCommitment), ...fromHex(nextCommitment), ...word(maxUses), ...word(rotationDeadline),
  ]))) as Bytes32;
}

const CLONE_PREFIX = fromHex('0x3d602d80600a3d3981f3363d3d373d3d3d363d73');
const CLONE_SUFFIX = fromHex('0x5af43d82803e903d91602b57fd5bf3');

/** Where PQAccountFactory.createAccount puts the clone: plain CREATE2. */
export function predictAccount(factory: Address, implementation: Address, salt: Bytes32): Address {
  const initCodeHash = keccak_256(new Uint8Array([...CLONE_PREFIX, ...fromHex(implementation), ...CLONE_SUFFIX]));
  const hash = keccak_256(new Uint8Array([0xff, ...fromHex(factory), ...fromHex(salt), ...initCodeHash]));
  return toHex(hash.slice(12)) as Address;
}

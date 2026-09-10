import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Bytes32, Hex } from '@opaque/protocol-types';

import {
  disablePayload,
  rotationPayload,
  takeoverPayload,
  userActionPayload,
} from '../src/registry.ts';

// PQKeyRegistry does NOT hash the payload you hand it. `consume` wraps that
// payload in its own action domain first, and `rotate`, `initiateDisable` and
// `takeover` each wrap it in theirs — then digests the result.
//
// So agreeing with the deployed `digest()` view function is not enough, and
// the live test in backend/chain/test/registry-digest.test.ts cannot see this:
// it passes the same payload to both sides, so a wrong domain agrees with
// itself perfectly and the signature is still rejected on chain.
//
// These pin the exact byte prefixes instead. The strings are copied from
// PQKeyRegistry.sol and contracts/test/PQKeyRegistry.t.sol pins those against
// the deployed bytecode, so the chain is reached in two hops rather than none.
const prefix = (domain: string, payload: Hex): Hex =>
  `0x${Buffer.from(domain, 'utf8').toString('hex')}${payload.slice(2)}` as Hex;

test('a user action carries the registry action domain and nothing else', () => {
  assert.equal(userActionPayload('0x1234'), prefix('opaque/v1/pq-wallet/action', '0x1234'));
  // Empty is the case a naive implementation gets wrong by appending a
  // separator that is then absent from the Solidity side.
  assert.equal(userActionPayload('0x'), prefix('opaque/v1/pq-wallet/action', '0x'));
});

test('a disable is its own domain over an empty body', () => {
  assert.equal(disablePayload(), prefix('opaque/v1/pq-wallet/disable', '0x'));
});

test('a rotation is the rotate domain over abi.encode(bytes32,uint64,uint64)', () => {
  const next = `0x${'ab'.repeat(32)}` as Bytes32;
  const body = `0x${'ab'.repeat(32)}${(8n).toString(16).padStart(64, '0')}${(1_900_000_000n).toString(16).padStart(64, '0')}` as Hex;
  assert.equal(rotationPayload(next, 8n, 1_900_000_000n), prefix('opaque/v1/pq-wallet/rotate', body));
});

test('a takeover is the takeover domain over abi.encode(bytes32,uint64)', () => {
  const next = `0x${'cd'.repeat(32)}` as Bytes32;
  const body = `0x${'cd'.repeat(32)}${(4n).toString(16).padStart(64, '0')}` as Hex;
  assert.equal(takeoverPayload(next, 4n), prefix('opaque/v1/pq-wallet/takeover', body));
});

test('no two domains share a prefix, so one action never reads as another', () => {
  // A rotation payload offered as an ordinary action must not produce the
  // bytes a genuine action would: that is how a signed transfer becomes a
  // signed key rotation.
  const rotation = rotationPayload(`0x${'ab'.repeat(32)}` as Bytes32, 8n, 1_900_000_000n);
  assert.notEqual(userActionPayload(rotation), rotation);
  // Non-zero: a zero commitment is refused outright, matching the Solidity.
  const all = [userActionPayload('0x'), disablePayload(), takeoverPayload(`0x${'ef'.repeat(32)}` as Bytes32, 1n)];
  assert.equal(new Set(all).size, all.length);
});

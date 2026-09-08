// T2 verification: malformed hex, out-of-range scores, ambiguous times, wrong
// path length and unsupported wire variants reject; big integers round-trip
// losslessly.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  asAddress,
  asBytes32,
  asDenomination,
  asPrivacyScore,
  asPrivateSpend,
  asRing8,
  assertRelayPath,
  decodeBigint,
  derivePaymentContext,
  encodeBigint,
  encodeSpend,
  fromHex,
  poolId,
  spendHash,
  toHex,
  toNativeWei,
  toUsdc6,
} from '../src/codecs.ts';
import { ProtocolFailure, type Address, type PoolScope, type PrivateSpend } from '../src/index.ts';

const b32 = (fill: string) => `0x${fill.repeat(64).slice(0, 64)}` as const;
const SCOPE: PoolScope = {
  chainId: 5_042_002n as PoolScope['chainId'],
  pool: '0x3600000000000000000000000000000000000000' as Address,
  denomination: 1_000_000,
};
const RECIPIENT = '0x00000000000000000000000000000000000000aa' as Address;

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as ProtocolFailure).code ?? 'THREW';
  }
  return 'NO_THROW';
};

// ── hex ───────────────────────────────────────────────────────────────────

test('hex rejects the shapes that actually arrive off a wire', () => {
  assert.equal(code(() => asAddress('0x1234')), 'INVALID_INPUT', 'short');
  assert.equal(code(() => asAddress(`${SCOPE.pool}00`)), 'INVALID_INPUT', 'long');
  assert.equal(code(() => asAddress('3600000000000000000000000000000000000000')), 'INVALID_INPUT', 'no 0x');
  assert.equal(code(() => asAddress('0x36000000000000000000000000000000000000AA')), 'INVALID_INPUT', 'upper-case');
  assert.equal(code(() => asAddress('0xzz00000000000000000000000000000000000000')), 'INVALID_INPUT', 'non-hex');
  assert.equal(code(() => asAddress(null)), 'INVALID_INPUT', 'null');
  assert.equal(code(() => asAddress(SCOPE.pool)), 'NO_THROW', 'a real address passes');
});

test('hex round-trips byte-exactly', () => {
  const bytes = Uint8Array.from([0x00, 0x0f, 0xff, 0xa5]);
  assert.equal(toHex(bytes), '0x000fffa5');
  assert.deepEqual(fromHex('0x000fffa5'), bytes);
});

// ── bounded integers ──────────────────────────────────────────────────────

test('privacy score is a bounded integer, not any number', () => {
  assert.equal(asPrivacyScore(0), 0);
  assert.equal(asPrivacyScore(10_000), 10_000);
  assert.equal(code(() => asPrivacyScore(-1)), 'INVALID_INPUT');
  assert.equal(code(() => asPrivacyScore(10_001)), 'INVALID_INPUT');
  assert.equal(code(() => asPrivacyScore(52.5)), 'INVALID_INPUT');
  assert.equal(code(() => asPrivacyScore('70')), 'INVALID_INPUT');
});

test('denomination rejects anything off the fixed list', () => {
  assert.equal(asDenomination(5_000_000), 5_000_000);
  assert.equal(code(() => asDenomination(2_000_000)), 'UNSUPPORTED_DENOMINATION');
  assert.equal(code(() => asDenomination(1_000_000n)), 'UNSUPPORTED_DENOMINATION', 'bigint is not the number');
});

// ── bigint ────────────────────────────────────────────────────────────────

test('big integers round-trip losslessly past 2^53', () => {
  const big = 2n ** 200n + 12345n;
  assert.equal(decodeBigint(encodeBigint(big), 'x'), big);
  assert.equal(decodeBigint(encodeBigint(-big), 'x'), -big);
  assert.equal(decodeBigint('0', 'x'), 0n);
});

test('a JSON number is refused where a decimal string is required', () => {
  // 2^53 + 1 is the first integer a JSON number cannot represent. Accepting it
  // as a number would silently round it to 2^53.
  assert.equal(code(() => decodeBigint(9_007_199_254_740_993, 'x')), 'INVALID_INPUT');
  assert.equal(code(() => decodeBigint('0042', 'x')), 'INVALID_INPUT', 'leading zeros are a second encoding');
  assert.equal(code(() => decodeBigint('+42', 'x')), 'INVALID_INPUT');
  assert.equal(code(() => decodeBigint('4.2', 'x')), 'INVALID_INPUT');
  assert.equal(code(() => decodeBigint('', 'x')), 'INVALID_INPUT');
});

// ── money ─────────────────────────────────────────────────────────────────

test('the two USDC interfaces convert by exactly 10^12', () => {
  const fifty = 50_000_000n as Parameters<typeof toNativeWei>[0]; // 50 USDC, 6dp
  assert.equal(toNativeWei(fifty), 50_000_000_000_000_000_000n);
  assert.equal(toUsdc6(toNativeWei(fifty)), fifty);
  // Truncates toward zero like EVM division: sub-micro-USDC dust is not money.
  assert.equal(toUsdc6(999_999_999_999n as Parameters<typeof toUsdc6>[0]), 0n);
});

// ── ring ──────────────────────────────────────────────────────────────────

test('ring shape and distinctness are enforced, not assumed', () => {
  const eight = Array.from({ length: 8 }, (_, i) => b32(String(i)));
  assert.equal(asRing8(eight).length, 8);

  assert.equal(code(() => asRing8(eight.slice(0, 7))), 'INVALID_INPUT', '7 members');
  assert.equal(code(() => asRing8([...eight, b32('9')])), 'INVALID_INPUT', '9 members');
  // A padded ring: eight slots, one real member repeated. This is precisely the
  // "do not pad it to eight and present padding as anonymity" failure.
  assert.equal(code(() => asRing8(Array.from({ length: 8 }, () => b32('1')))), 'INVALID_INPUT', 'repeated');
});

// ── spends ────────────────────────────────────────────────────────────────

function ringSpend(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    mode: 'RING_8',
    scope: { chainId: encodeBigint(SCOPE.chainId), pool: SCOPE.pool, denomination: SCOPE.denomination },
    recipient: RECIPIENT,
    nullifier: b32('a'),
    paymentContext: derivePaymentContext(SCOPE, RECIPIENT),
    verifierId: b32('b'),
    proof: '0xdeadbeef',
    ring: Array.from({ length: 8 }, (_, i) => b32(String(i))),
    ...overrides,
  };
}

test('a spend whose context disagrees with its own recipient is rejected', () => {
  assert.equal(code(() => asPrivateSpend(ringSpend())), 'NO_THROW');

  const other = '0x00000000000000000000000000000000000000bb' as Address;
  assert.equal(
    code(() => asPrivateSpend(ringSpend({ recipient: other }))),
    'INVALID_INPUT',
    'recipient swapped after the context was built',
  );
  assert.equal(
    code(() => asPrivateSpend(ringSpend({ paymentContext: b32('c') }))),
    'INVALID_INPUT',
    'context forged',
  );
});

test('proof mode and ring size cannot disagree', () => {
  assert.equal(code(() => asPrivateSpend(ringSpend(), 'RING_8')), 'NO_THROW');
  assert.equal(
    code(() => asPrivateSpend(ringSpend(), 'SINGLE_NOTE_PQ')),
    'UNSUPPORTED_PROOF_MODE',
    'a ring spend offered to a single-note pool',
  );
  assert.equal(code(() => asPrivateSpend(ringSpend({ mode: 'RING_16' }))), 'UNSUPPORTED_PROOF_MODE');
});

test('spendHash is canonical, and changes with every public input', () => {
  const base = asPrivateSpend(ringSpend());
  const hash = spendHash(base);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(spendHash(asPrivateSpend(ringSpend())), hash, 'deterministic');

  const mutations: Array<[string, PrivateSpend]> = [
    ['proof', asPrivateSpend(ringSpend({ proof: '0xdeadbeee' }))],
    ['verifierId', asPrivateSpend(ringSpend({ verifierId: b32('c') }))],
    ['nullifier', asPrivateSpend(ringSpend({ nullifier: b32('9') }))],
    ['ring order', asPrivateSpend(ringSpend({
      ring: Array.from({ length: 8 }, (_, i) => b32(String(7 - i))),
    }))],
  ];
  for (const [label, mutated] of mutations) {
    assert.notEqual(spendHash(mutated), hash, `${label} must change the hash`);
  }
});

test('a single-note spend can never collide with a ring spend', () => {
  // Length-prefixing plus an explicit member count is what rules this out. A
  // naive concatenation of eight identical members and one member could
  // otherwise produce the same bytes.
  const single = asPrivateSpend(ringSpend({ mode: 'SINGLE_NOTE_PQ', commitment: b32('0'), ring: undefined }));
  assert.notEqual(spendHash(single), spendHash(asPrivateSpend(ringSpend())));
  assert.ok(encodeSpend(single).length < encodeSpend(asPrivateSpend(ringSpend())).length);
});

test('the nullifier derivation cannot see the recipient', () => {
  // Read as a guard on the source, not the value: derivePaymentContext is the
  // only exported derivation that takes a recipient, and it is not the
  // nullifier. The nullifier needs a secret and so lives in NoteVault (T1).
  const a = derivePaymentContext(SCOPE, RECIPIENT);
  const b = derivePaymentContext(SCOPE, '0x00000000000000000000000000000000000000bb' as Address);
  assert.notEqual(a, b, 'paymentContext must vary with the recipient');
  assert.notEqual(poolId(SCOPE), a, 'poolId must not vary with it');
});

test('poolId is domain-separated from the payment context', () => {
  const other: PoolScope = { ...SCOPE, denomination: 5_000_000 };
  assert.equal(poolId(SCOPE), poolId({ ...SCOPE }), 'stable');
  assert.equal(poolId(SCOPE), poolId(other), 'poolId binds chain and pool, not denomination');
  assert.notEqual(derivePaymentContext(SCOPE, RECIPIENT), derivePaymentContext(other, RECIPIENT));
});

// ── relay paths ───────────────────────────────────────────────────────────

test('a path needs three distinct relays under three distinct operators', () => {
  const node = (id: string, operatorId: string) => ({ id, operatorId });
  assert.equal(code(() => assertRelayPath([node('a', '1'), node('b', '2'), node('c', '3')])), 'NO_THROW');
  assert.equal(code(() => assertRelayPath([node('a', '1'), node('b', '2')])), 'INSUFFICIENT_RELAYS', '2 hops');
  assert.equal(code(() => assertRelayPath([node('a', '1'), node('a', '1'), node('c', '3')])), 'INSUFFICIENT_RELAYS', 'repeat');
  // Three distinct relays run by one operator is one observer, not three.
  assert.equal(
    code(() => assertRelayPath([node('a', '1'), node('b', '1'), node('c', '1')])),
    'INSUFFICIENT_RELAYS',
    'one operator behind three ids',
  );
});

test('bytes32 helpers reject 20-byte addresses and vice versa', () => {
  assert.equal(code(() => asBytes32(SCOPE.pool)), 'INVALID_INPUT');
  assert.equal(code(() => asAddress(b32('a'))), 'INVALID_INPUT');
});

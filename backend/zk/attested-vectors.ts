// Generates contracts/test/fixtures/attested-ring-vectors.json.
//
//   node zk/attested-vectors.ts
//
// Every value below is produced by the SAME TypeScript the client runs — the
// AES ring commitments from statement.ts, the FORS signature from
// @opaque/pq-wallet — and then checked by Solidity in
// contracts/test/AttestedRingVerifier.t.sol. Two implementations that agree by
// inspection agree by luck; this is what makes them agree on bytes.
//
// Addresses are FIXED CONSTANTS rather than predicted from a deploy nonce. The
// verifier id commits to the registry and the attester, and the pool id to the
// pool, so a fixture pinned to a deploy ORDER breaks the moment a test grows a
// line. The Solidity side places each contract at its constant with
// deployCodeTo and asserts the ids agree.

import { keccak_256 } from '@noble/hashes/sha3.js';

import type { Address, Bytes32, Hex, PoolScope } from '@opaque/protocol-types';
import {
  asAddress,
  asChainId,
  derivePaymentContext,
  encodeBigint,
  fromHex,
  poolId,
  toHex,
} from '@opaque/protocol-types/codecs.js';
import {
  canonical,
  encodeSignature,
  forsSchemeId,
  FORS_C_DEFAULT,
  keyGen,
  pkCommitment,
  pqDigest,
  sign,
  utf8,
} from '@opaque/pq-wallet';

import { deriveCommitment, deriveNullifier, SECRET_BYTES } from './statement.ts';

// ── the fixed world both sides agree on ───────────────────────────────────

const CHAIN_ID = 31337n;
const DENOMINATION = 1_000_000;

const USDC = asAddress('0x0000000000000000000000000000000000001111');
const REGISTRY = asAddress('0x0000000000000000000000000000000000002222');
const VERIFIER = asAddress('0x0000000000000000000000000000000000003333');
const POOL = asAddress('0x0000000000000000000000000000000000004444');
const ATTESTER = asAddress('0x0000000000000000000000000000000000005555');
const BOB = asAddress('0x0000000000000000000000000000000000000b0b');

const VERIFIER_DOMAIN = 'opaque/v1/spend-verifier';
const ATTEST_DOMAIN = 'opaque/v1/ring-attestation';
const SCHEME = 'attested-ring8/zkboo-aes128-ring8';
const USER_ACTION_DOMAIN = 'opaque/v1/pq-wallet/action';

const scope: PoolScope = { chainId: asChainId(CHAIN_ID), pool: POOL, denomination: DENOMINATION };
const POOL_ID = poolId(scope);

// ── derivations that mirror AttestedRingVerifier.sol exactly ──────────────

/** `abi.encode(bytes32[])`: offset, length, then the words. */
const abiEncodeRing = (ring: readonly Bytes32[]): Uint8Array => {
  const out = new Uint8Array(64 + ring.length * 32);
  new DataView(out.buffer).setUint32(28, 32, false); // head: offset to the array
  new DataView(out.buffer).setUint32(60, ring.length, false);
  ring.forEach((word, i) => out.set(fromHex(word), 64 + i * 32));
  return out;
};

/** `abi.encodePacked(uint32(20), addr)` — an address field, length-prefixed. */
const addressField = (value: Address): Uint8Array => {
  const out = new Uint8Array(24);
  new DataView(out.buffer).setUint32(0, 20, false);
  out.set(fromHex(value), 4);
  return out;
};

const verifierId = (): Bytes32 =>
  toHex(
    keccak_256(
      new Uint8Array([
        ...canonical([utf8(VERIFIER_DOMAIN), utf8(SCHEME), fromHex(POOL_ID), utf8(String(DENOMINATION))]),
        ...addressField(REGISTRY),
        ...addressField(ATTESTER),
      ]),
    ),
  ) as Bytes32;

const attestation = (ring: readonly Bytes32[], nullifier: Bytes32, paymentContext: Bytes32): Uint8Array =>
  canonical([
    utf8(ATTEST_DOMAIN),
    fromHex(verifierId()),
    keccak_256(abiEncodeRing(ring)),
    fromHex(nullifier),
    fromHex(paymentContext),
  ]);

// ── the attester's post-quantum key ───────────────────────────────────────

const attesterKey = keyGen(keccak_256(utf8('opaque/fixture/attester/v1')));
const attesterNext = keyGen(keccak_256(utf8('opaque/fixture/attester/v2')));
const impostor = keyGen(keccak_256(utf8('opaque/fixture/impostor')));

const SCHEME_ID = forsSchemeId(FORS_C_DEFAULT);

/** The registry wraps our payload in its own action domain before digesting. */
const attest = (
  key: typeof attesterKey,
  useCount: bigint,
  ring: readonly Bytes32[],
  nullifier: Bytes32,
  recipient: Address,
): Hex => {
  const payload = new Uint8Array([
    ...utf8(USER_ACTION_DOMAIN),
    ...attestation(ring, nullifier, derivePaymentContext(scope, recipient)),
  ]);
  const digest = pqDigest({
    chainId: asChainId(CHAIN_ID),
    walletAddress: ATTESTER,
    schemeId: SCHEME_ID,
    useCount,
    payload: toHex(payload) as Hex,
  });
  return encodeSignature(key.publicKey, sign(key.secretKey, digest));
};

// ── two real spends against one ring ──────────────────────────────────────

const secrets = Array.from({ length: 8 }, (_, i) =>
  keccak_256(utf8(`opaque/fixture/note/${i}`)).slice(0, SECRET_BYTES),
);

// Sorted, because spend.ts sorts before it proves: ring order is public, so an
// order that tracked the spender's index would leak it in plain sight.
const ring = secrets
  .map((s) => deriveCommitment(s, scope) as unknown as Bytes32)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// Two different notes, neither of them ring[0]. A verifier only ever exercised
// on the first member hides an off-by-one until mainnet finds it.
const nullifierA = deriveNullifier(secrets[5]!, scope) as unknown as Bytes32;
const nullifierB = deriveNullifier(secrets[2]!, scope) as unknown as Bytes32;

const vectors = {
  _comment: 'Generated by backend/zk/attested-vectors.ts. Do not hand-edit; regenerate.',
  chainId: encodeBigint(CHAIN_ID),
  denomination: String(DENOMINATION),
  schemeId: SCHEME_ID,

  usdc: USDC,
  registry: REGISTRY,
  verifier: VERIFIER,
  pool: POOL,
  attester: ATTESTER,
  recipient: BOB,

  poolId: POOL_ID,
  verifierId: verifierId(),
  paymentContext: derivePaymentContext(scope, BOB),

  pkAttester: pkCommitment(attesterKey.publicKey),
  pkAttesterNext: pkCommitment(attesterNext.publicKey),

  ring,
  nullifierA,
  nullifierB,

  // useCount 0 and 1: the registry burns the index between them, which is the
  // whole reason a few-time key can sign more than one payment safely.
  sigA: attest(attesterKey, 0n, ring, nullifierA, BOB),
  sigB: attest(attesterKey, 1n, ring, nullifierB, BOB),
  // Same statement, signed by a key the registry has never heard of.
  sigImpostor: attest(impostor, 0n, ring, nullifierA, BOB),
} as const;

const out = new URL('../../contracts/test/fixtures/attested-ring-vectors.json', import.meta.url);
const { writeFileSync } = await import('node:fs');
writeFileSync(out, `${JSON.stringify(vectors, null, 1)}\n`);
console.log(`wrote ${out.pathname}`);
console.log(`  poolId      ${POOL_ID}`);
console.log(`  verifierId  ${vectors.verifierId}`);
console.log(`  ring        ${ring.length} sorted members, two of them spendable`);

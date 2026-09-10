import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { asAddress, asChainId, fromHex, toHex } from '@opaque/protocol-types/codecs.js';
import { canonical, pqDigest, PQ_DOMAIN, utf8, type DigestInput } from '../src/digest.ts';

const input: DigestInput = {
  chainId: asChainId(5042002n), walletAddress: asAddress(`0x${'aa'.repeat(20)}`),
  schemeId: 'FORS+C/keccak256/k=32,a=8', useCount: 3n, payload: '0x1234',
};

test('digest_matches_pinned_keccak_vector_not_node_sha3_256', () => {
  assert.equal(toHex(keccak_256(new Uint8Array())), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  // Existing Solidity conformance fixture, pinned independently of this test's encoder.
  assert.equal(pqDigest(input), '0xa8a2fe2fe6d5309d6a683d74d4c3a75926f4405db13f608fa487595ba8584492');
  const preimage = canonical([utf8(PQ_DOMAIN), utf8('5042002'), fromHex(input.walletAddress),
    utf8(input.schemeId), utf8('3'), keccak_256(fromHex(input.payload))]);
  assert.notEqual(pqDigest(input), `0x${createHash('sha3-256').update(preimage).digest('hex')}`);
});

test('length_prefix_distinguishes_ambiguous_field_splits', () => {
  const left = canonical([utf8('a:b'), utf8('c')]);
  const right = canonical([utf8('a'), utf8('b:c')]);
  assert.notDeepEqual(left, right);
  assert.notDeepEqual(keccak_256(left), keccak_256(right));
  assert.equal(toHex(canonical([utf8('a'), utf8('bc')])), '0x0000000161000000026263');
});

test('digest_binds_each_of_the_six_spec_fields', () => {
  for (const change of [
    { chainId: asChainId(1n) }, { walletAddress: asAddress(`0x${'bb'.repeat(20)}`) },
    { schemeId: 'other' }, { useCount: 4n }, { payload: '0x1235' as const },
  ]) assert.notEqual(pqDigest({ ...input, ...change }), pqDigest(input));
  const otherDomain = canonical([utf8(`${PQ_DOMAIN}/other`), utf8('5042002'), fromHex(input.walletAddress),
    utf8(input.schemeId), utf8('3'), keccak_256(fromHex(input.payload))]);
  assert.notEqual(toHex(keccak_256(otherDomain)), pqDigest(input));
});

test('digest_rejects_invalid_boundary_values', () => {
  for (const change of [{ chainId: 0n }, { walletAddress: '0x00' }, { schemeId: '' },
    { useCount: -1n }, { useCount: 1 }, { payload: '0x1' }, { payload: '0xAB' }]) {
    assert.throws(() => pqDigest({ ...input, ...change } as DigestInput), { code: 'INVALID_INPUT' });
  }
});

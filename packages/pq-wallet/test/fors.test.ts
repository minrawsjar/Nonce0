import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
import type { Hex } from '@opaque/protocol-types';
import { keyGen, sign, verify, pkCommitment, encodeSignature, decodeSignature } from '../src/fors.ts';

const digest = asBytes32(`0x${'12'.repeat(32)}`);
const key = keyGen(new Uint8Array(32).fill(1));
const other = keyGen(new Uint8Array(32).fill(2));
const signature = sign(key.secretKey, digest);

test('sign_verify_round_trip', () => assert.equal(verify(key.publicKey, digest, signature), true));
test('tampered_signature_rejected', () => {
  const bad = structuredClone(signature); bad.leaves[0]![0] = bad.leaves[0]![0]! ^ 1;
  assert.equal(verify(key.publicKey, digest, bad), false);
});
test('tampered_digest_rejected', () => assert.equal(verify(key.publicKey, asBytes32(`0x${'13'.repeat(32)}`), signature), false));
test('cross_key_verification_rejected', () => assert.equal(verify(other.publicKey, digest, signature), false));
test('signature_codec_round_trip_and_size', () => {
  const encoded = encodeSignature(key.publicKey, signature);
  assert.equal((encoded.length - 2) / 2, 9251);
  assert.deepEqual(decodeSignature(encoded), { publicKey: key.publicKey, signature });
});
test('signature_codec_rejects_truncation_and_trailing_bytes', () => {
  const encoded = encodeSignature(key.publicKey, signature);
  for (const bad of ['0x', '0x002008', encoded.slice(0, -2), `${encoded}00`]) {
    assert.throws(() => decodeSignature(bad as Hex), { code: 'INVALID_INPUT' });
  }
});
test('signature_codec_rejects_malformed_parameters', () => {
  const encoded = encodeSignature(key.publicKey, signature);
  for (const header of ['000008', '002000', 'ffff08']) {
    assert.throws(() => decodeSignature(`0x${header}${encoded.slice(8)}`), { code: 'INVALID_INPUT' });
  }
});
test('existing_solidity_signature_fixture_verifies', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/fors-vectors.json', import.meta.url), 'utf8'));
  const decoded = decodeSignature(fixture.signature);
  assert.equal(verify(decoded.publicKey, asBytes32(fixture.digest), decoded.signature), true);
  assert.equal(pkCommitment(decoded.publicKey), fixture.pkCommitment);
});
test('encoder_rejects_incomplete_paths_instead_of_zero_padding', () => {
  const bad = { ...signature, paths: signature.paths.map((path, i) => i === 0 ? path.slice(0, -1) : path) };
  assert.throws(() => encodeSignature(key.publicKey, bad), { code: 'INVALID_INPUT' });
});
test('encoder_and_commitment_reject_malformed_public_key', () => {
  const bad = { ...key.publicKey, value: new Uint8Array(31) };
  assert.throws(() => encodeSignature(bad, signature), { code: 'INVALID_INPUT' });
  assert.throws(() => pkCommitment(bad), { code: 'INVALID_INPUT' });
});
test('sign_rejects_malformed_secret_seed', () => {
  assert.throws(() => sign({ ...key.secretKey, seed: new Uint8Array(31) }, digest), { code: 'INVALID_INPUT' });
});
test('verify_rejects_missing_or_invalid_signature_nodes', () => {
  const bad = { ...signature, leaves: [...signature.leaves] }; delete bad.leaves[0];
  assert.equal(verify(key.publicKey, digest, bad), false);
});

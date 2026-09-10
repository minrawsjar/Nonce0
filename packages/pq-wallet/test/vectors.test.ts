import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { asAddress, asBytes32, asChainId } from '@opaque/protocol-types/codecs.js';
import { decodeSignature, verify, pkCommitment } from '../src/fors.ts';
import { pqDigest } from '../src/digest.ts';
import { generateVectors } from '../scripts/generate-vectors.ts';

test('published_synthetic_authority_vectors_verify_and_match_pinned_fields', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/authority-vectors.json', import.meta.url), 'utf8')) as ReturnType<typeof generateVectors>;
  assert.equal(fixture.version, 1);
  for (const action of fixture.actions) {
    const digest = pqDigest({ chainId: asChainId(BigInt(fixture.chainId)), walletAddress: asAddress(fixture.walletAddress),
      schemeId: fixture.schemeId, useCount: BigInt(action.useCount), payload: action.payload });
    assert.equal(digest, action.digest);
    const decoded = decodeSignature(action.signature);
    assert.equal(pkCommitment(decoded.publicKey), fixture.commitments[action.key]);
    assert.equal(verify(decoded.publicKey, asBytes32(digest), decoded.signature), true);
  }
});

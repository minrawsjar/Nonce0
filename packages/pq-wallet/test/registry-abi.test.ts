import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('registry_abi_snapshot_matches_source_and_original_six_fields', () => {
  const provenance = JSON.parse(readFileSync(new URL('../abi/provenance.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../../contracts/src/opaque/wallet/PQKeyRegistry.sol', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), provenance.sourceSha256, 'Refresh ABI with the contract owner after registry changes');
  const abi = JSON.parse(readFileSync(new URL('../abi/PQKeyRegistry.json', import.meta.url), 'utf8')) as Array<{
    type: string; name?: string; outputs?: Array<{ components?: Array<{ name: string }> }>;
  }>;
  const state = abi.find(item => item.name === 'stateOf');
  assert.deepEqual(state?.outputs?.[0]?.components?.map(item => item.name),
    ['pkCommitment', 'nextCommitment', 'useCount', 'maxUses', 'rotationDeadline', 'disableAfter']);
  assert.equal(abi.some(item => ['setOwner', 'upgradeTo', 'recover'].includes(item.name ?? '')), false);
});

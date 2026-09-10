import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PqWallet } from '@opaque/protocol-types';
import * as api from '@opaque/pq-wallet';

test('package_root_imports_and_export_map_remains_unchanged', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).exports, { '.': './src/index.ts' });
  assert.deepEqual(Object.keys(api).sort(), ['createPqWallet', 'createMockPqWallet', 'IndexedDbSignerStore',
    'keyGen', 'sign', 'verify', 'pkCommitment', 'pqDigest', 'PQ_DOMAIN'].sort());
  assert.equal('randomSeed' in api || 'deriveIndices' in api || 'FORS_C_DEFAULT' in api, false);
});
test('mock_exposes_frozen_six_method_interface', () => {
  const wallet: PqWallet = api.createMockPqWallet();
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(wallet)).filter(name => name !== 'constructor');
  assert.deepEqual(names.sort(), ['create', 'register', 'getState', 'signUserOperation', 'rotate', 'disable'].sort());
});

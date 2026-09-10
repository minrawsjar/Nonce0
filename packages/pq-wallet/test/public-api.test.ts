import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PqWallet } from '@opaque/protocol-types';
import * as api from '@opaque/pq-wallet';

test('package_root_imports_and_export_map_remains_unchanged', () => {
  // The browser store lives behind its own subpath so a Node consumer never
  // pulls lib.DOM into its type graph by importing the barrel.
  assert.deepEqual(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).exports, {
    '.': './src/index.ts',
    './browser': './src/indexeddb-store.ts',
  });
  assert.deepEqual(Object.keys(api).sort(), ['createPqWallet', 'createMockPqWallet',
    'keyGen', 'sign', 'forsVerify', 'pkCommitment', 'pqDigest', 'PQ_DOMAIN',
    'canonical', 'utf8', 'FORS_C_DEFAULT', 'assertForsParams', 'decodeSignature',
    'deriveIndices', 'encodeSignature', 'forsSchemeId', 'randomSeed'].sort());
  // Bare `verify` stays off the barrel: a signature, a proof and a directory
  // all have one in this repo, and the name alone does not say which.
  assert.equal((api as Record<string, unknown>)['verify'], undefined);
  assert.equal(typeof api.forsVerify, 'function');
});
test('mock_exposes_frozen_six_method_interface', () => {
  const wallet: PqWallet = api.createMockPqWallet();
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(wallet)).filter(name => name !== 'constructor');
  assert.deepEqual(names.sort(), ['create', 'register', 'getState', 'signUserOperation', 'rotate', 'disable'].sort());
});

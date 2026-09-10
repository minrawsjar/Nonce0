import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UnixSeconds } from '@opaque/protocol-types';

import { accept, chainTo } from '../directory.ts';
import { buildLocalMesh, GENERATION_SECONDS, meshRootAt } from '../local-mesh.ts';

const master = new Uint8Array(32).fill(7);
const genesis = 1_800_000_000n;
const at = (now: bigint) => buildLocalMesh({ master, genesis, now });

test('a derived mesh is the same bytes on every boot of one generation', () => {
  const a = at(genesis + 100n);
  const b = at(genesis + 5_000n);
  assert.deepEqual(a.signed, b.signed, 'a restart serves the same directory, so the same keys');
  assert.deepEqual([...a.secretKeys], [...b.secretKeys]);
  assert.equal(a.chain.length, 1);
  assert.equal(a.generationEndsAt, genesis + GENERATION_SECONDS);
});

test('a wallet that compiled in the genesis root reaches every later generation', () => {
  const later = at(genesis + 2n * GENERATION_SECONDS + 10n);
  assert.equal(later.chain.length, 3);
  assert.deepEqual(later.root, meshRootAt(master), 'the chain starts at the pinned root');

  const { signed, root } = chainTo(later.chain, meshRootAt(master));
  const now = (genesis + 2n * GENERATION_SECONDS + 10n) as UnixSeconds;
  const { directory } = accept(signed, root, now);
  assert.equal(directory.version, 3n);
  assert.notDeepEqual([...later.secretKeys], [...at(genesis + 1n).secretKeys], 'relay keys turn over with the week');

  // A browser pins the root that signed what it accepted, and reads only what came after.
  assert.deepEqual(chainTo(later.chain, root).signed, signed);
  assert.throws(() => chainTo(later.chain.slice(0, 2), root), /no directory newer/, 'and a chain that stops short of it is a rollback');
});

test('a root from another master verifies nothing', () => {
  const other = meshRootAt(new Uint8Array(32).fill(8));
  const mesh = at(genesis + 10n);
  assert.throws(() => accept(chainTo(mesh.chain, other).signed, chainTo(mesh.chain, other).root, (genesis + 10n) as UnixSeconds), /pinned signer/);
});

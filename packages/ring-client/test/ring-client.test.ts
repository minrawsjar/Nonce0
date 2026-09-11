import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolScope, RingSnapshot } from '@opaque/protocol-types';
import { createNoteVault, memoryNoteStorage } from '../src/note-vault.ts';
import { createRingClient } from '../src/ring-client.ts';

// A new pool starts empty and fills from anyone's deposits. Until it holds a
// ring's worth, a spend from it must refuse and leave the note spendable.
test('a pool too small for a ring refuses the spend without reserving the note', async () => {
  const scope = { chainId: 5042002n, pool: `0x${'ab'.repeat(20)}`, denomination: 100_000_000 } as unknown as PoolScope;
  const vault = createNoteVault({
    storage: memoryNoteStorage(),
    chain: { observeCommitment: async () => ({ blockNumber: 1n }), isNullifierSpent: async () => false },
  });
  const note = await vault.create(scope);
  await vault.recordDeposit(note.id, `0x${'11'.repeat(32)}` as never);
  assert.equal((await vault.reconcile(note.id)).state, 'AVAILABLE');

  const snapshot = {
    scope,
    candidates: [{ commitment: note.commitment, enrolledAtBlock: 1n, timesUsedInRing: 0, fundingCluster: null, hasOtherActivity: null }],
    indexedThroughBlock: 1n, observedAt: 1n, policyVersion: 'test',
  } as unknown as RingSnapshot;
  const ring = createRingClient(vault, { prove: () => { throw new Error('never reached'); }, verify: () => false });
  await assert.rejects(
    ring.buildSpend({ noteId: note.id, recipient: `0x${'cd'.repeat(20)}` as never, reservation: 'pay-1' as never, candidates: snapshot }),
    /usable decoys/,
  );
  assert.equal((await vault.list(scope))[0]!.state, 'AVAILABLE');
});

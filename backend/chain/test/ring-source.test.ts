import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolScope, RelaySnapshot, UnixSeconds } from '@opaque/protocol-types';

import { createChainRingSource } from '../ring-source.ts';

// Offline: a fake RPC with one deposit per 10,000-block window.
const scope = { chainId: 5042002n, pool: `0x${'ab'.repeat(20)}`, denomination: 1_000_000 } as unknown as PoolScope;
function fakeRpc() {
  const rpc = { head: 20_000n, fail: false, calls: 0 };
  const client = {
    getBlockNumber: async () => { rpc.calls++; if (rpc.fail) throw new Error('Request exceeds defined limit'); return rpc.head; },
    getLogs: async ({ fromBlock }: { fromBlock: bigint }) => {
      await new Promise((r) => setTimeout(r, 5));
      if (rpc.fail) throw new Error('Request exceeds defined limit');
      return [{ args: { commitment: `0x${fromBlock.toString(16).padStart(32, '0')}${'0'.repeat(32)}` }, blockNumber: fromBlock }];
    },
  };
  return { rpc, client };
}
const relays = (): RelaySnapshot => ({ nodes: [], directoryVersion: '1', observedAt: 1n as UnixSeconds });

test('reads at once share one scan, so no deposit is listed twice', async () => {
  const { client } = fakeRpc();
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays });
  const snaps = await Promise.all(Array.from({ length: 7 }, () => source.getRingSnapshot(scope)));
  for (const snap of snaps) assert.equal(snap.candidates.length, 2);
});

test('a scan the RPC refuses serves the last good ring, dated when it ran', async () => {
  let clock = 100n;
  const { rpc, client } = fakeRpc();
  const source = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays, now: () => clock as UnixSeconds });
  const first = await source.getRingSnapshot(scope);
  [rpc.fail, clock] = [true, 130n];
  const second = await source.getRingSnapshot(scope);
  assert.equal(second.candidates.length, first.candidates.length);
  assert.equal(second.observedAt, 100n);
  // With nothing to fall back on, the refusal is the answer.
  const fresh = createChainRingSource({ publicClient: client as never, scope, deployedAtBlock: 1n, relaySnapshot: relays });
  await assert.rejects(fresh.getRingSnapshot(scope), /exceeds defined limit/);
});

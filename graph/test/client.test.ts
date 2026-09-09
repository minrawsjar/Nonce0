import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address } from '@opaque/protocol-types';
import { asChainId } from '@opaque/protocol-types/codecs.js';
import { GraphHttpClient } from '../src/client.ts';

test('Graph client requests only the public pool denomination bucket', async () => {
  let body = '';
  const client = new GraphHttpClient({
    endpoint: 'https://example.invalid/graphql',
    fetch: async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ data: { ringMembers: [] } }), { status: 200 });
    },
  });
  await client.getRingSnapshot(
    { chainId: asChainId(5_042_002n), pool: `0x${'11'.repeat(20)}` as Address, denomination: 20_000_000 },
  );
  assert.match(body, /20000000/);
  assert.doesNotMatch(body, /realCommitment|exclude/);
});

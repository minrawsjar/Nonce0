import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpRpc, RpcError } from '../src/bundler-client.ts';

test('RPC errors retain the provider reason and code without URLs or operation bytes', async () => {
  const fetcher = (async (_url, options) => {
    const request = JSON.parse(options!.body as string);
    return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32500,
      message: `AA21 didn't pay prefund https://rpc.example/?apikey=private token=private 0x${'ab'.repeat(100)}` } });
  }) as typeof fetch;
  await assert.rejects(httpRpc('https://rpc.example', fetcher)('eth_estimateUserOperationGas', []), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(error.code, -32500);
    assert.match(error.message, /AA21 didn't pay prefund/);
    assert.doesNotMatch(error.message, /private|ababab/);
    return true;
  });
});

test('RPC responses with unrelated IDs cannot supply a trusted error', async () => {
  const fetcher = (async () => Response.json({ jsonrpc: '2.0', id: 999,
    error: { code: -32500, message: 'unrelated error' } })) as typeof fetch;
  await assert.rejects(httpRpc('https://rpc.example', fetcher)('eth_chainId', []), /Invalid RPC response/);
});
